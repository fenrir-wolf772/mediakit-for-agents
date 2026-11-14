#!/usr/bin/env node
/**
 * mediakit-for-agents — MCP over HTTP (REST + JSON-RPC).
 *
 * The same 55 tools as the stdio server (src/tools.js is the single
 * source of truth), reachable with curl instead of an MCP client —
 * for hand-testing, for agents that can only speak HTTP, and for
 * debugging a tool call without launching a client:
 *
 *   mediakit mcp --http [--port 3000] [--host 127.0.0.1]
 *
 *   GET  /mcp                        server metadata
 *   GET  /mcp/tools                  every tool + its JSON input schema
 *   POST /mcp/tools/{name}/invoke    {"arguments": {...}} -> the tool result
 *   GET  /mcp/jobs                   durable async render jobs, newest first
 *   GET  /mcp/jobs/{id}              one job: status + stage/percent progress
 *   GET  /mcp/jobs/{id}/events       Server-Sent Events: the same job
 *                                    record pushed live as it changes —
 *                                    no polling loop on the client side
 *   POST /mcp/jobs/{id}/cancel       stop a queued/running job
 *   POST /                            JSON-RPC 2.0 (initialize, ping,
 *                                     tools/list, tools/call)
 *
 * The job endpoints are the HTTP form of progress notifications: an
 * MCP client gets progress pushed inside a long call, but a curl
 * caller cannot — so it starts a render with
 * POST /mcp/tools/assemble/invoke {"arguments": {..., "async": true}}
 * and either polls GET /mcp/jobs/{id} for stage + percent until the
 * job is done/failed/cancelled, or opens GET /mcp/jobs/{id}/events
 * and reads `event: job` records as they are pushed. Same job store
 * (and same job_id format) as the `job` tool over stdio — one
 * registry, two transports. The events stream watches the durable
 * job.json on disk (the worker is a separate process, so no
 * in-process pub/sub could see its writes): it re-reads the record
 * every 500 ms and pushes an event only when the record changed,
 * sends a `: heartbeat` comment every 15 s, and closes itself when
 * the job reaches a terminal status (done/failed/cancelled) or after
 * `?timeout_s=` seconds (default 600, clamp 1-3600) with an
 * `event: timeout`. An unknown id fails before any SSE header, as a
 * plain JSON 404 — the same JOB_NOT_FOUND as GET /mcp/jobs/{id}.
 *
 * Shape follows vinayakbhati/ffmpeg-mcp-server's REST trio (studied
 * turn 52): the same three endpoints, but every tool is intent-level
 * (no raw ffmpeg_execute), and every error carries the same
 * `retry: {tool, arguments}` the stdio server attaches.
 *
 * Safety: binds 127.0.0.1 by default — this is a local debug/agent
 * surface, not a public service. Pass --host explicitly to bind
 * elsewhere, and only on a network you trust: there is no auth, and
 * the tools read/write files in the workspace. Request bodies are
 * capped at 1 MB.
 */
import { createServer } from "node:http";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import { TOOL_DEFS } from "./tools.js";
import { getJob, listJobs, cancelJob } from "./core.js";
import { recordToolCall } from "./audit.js";

const NAME = "mediakit-for-agents";
const VERSION = "0.1.0";
const MAX_BODY_BYTES = 1_000_000;

// SSE job-events tuning: the stream re-reads job.json on this cadence
// (a 500 ms poll of one small file is cheap; the worker writes it
// only when progress actually moves), keeps proxies alive with a
// comment heartbeat, and closes itself after this long so a forgotten
// curl cannot hold a connection forever.
const SSE_POLL_MS = 500;
const SSE_HEARTBEAT_MS = 15000;
const SSE_DEFAULT_TIMEOUT_S = 600;
const SSE_MAX_TIMEOUT_S = 3600;
const JOB_TERMINAL_STATUSES = new Set(["done", "failed", "cancelled"]);

function sseEvent(res, name, obj) {
  res.write(`event: ${name}\n`);
  res.write(`data: ${JSON.stringify(obj)}\n\n`);
}

// GET /mcp/jobs/{id}/events — push the job record as SSE. The first
// event is the current record, sent immediately, so a client that
// connects to an already-terminal job still gets exactly one event
// and a clean close. Later events fire only when the record changed
// (same text as the previous send means no write). A terminal status
// ends the stream after its event; a timeout ends it with an
// `event: timeout` carrying the last record. Errors before the first
// header (unknown id) propagate to the shared sendError path as JSON;
// after the headers, a vanished job record becomes an `event: error`
// and a close, so the stream is never left half-open or malformed.
async function handleJobEvents(res, jobId, searchParams) {
  const first = await getJob(jobId);
  const rawTimeoutParam = searchParams.get("timeout_s");
  // Absent/non-numeric -> the 600s default. (Bug caught 2026-11-14 by
  // the suite's live-SSE test: `Number(param ?? "")` turned a missing
  // param into Number("") === 0, which is finite, so the stream
  // silently died after 1s with `event: timeout` instead of 600s.)
  const rawTimeout = rawTimeoutParam === null ? SSE_DEFAULT_TIMEOUT_S : Number(rawTimeoutParam);
  const timeoutS = Number.isFinite(rawTimeout)
    ? Math.min(SSE_MAX_TIMEOUT_S, Math.max(1, Math.floor(rawTimeout)))
    : SSE_DEFAULT_TIMEOUT_S;
  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  let lastSent = JSON.stringify(first);
  sseEvent(res, "job", first);
  if (JOB_TERMINAL_STATUSES.has(first.status)) {
    res.end();
    return;
  }
  let lastHeartbeat = Date.now();
  let closed = false;
  let timer;
  let deadline;
  const cleanup = () => {
    if (closed) return;
    closed = true;
    clearInterval(timer);
    clearTimeout(deadline);
  };
  deadline = setTimeout(() => {
    if (closed) return;
    try {
      sseEvent(res, "timeout", JSON.parse(lastSent));
      res.end();
    } catch { /* client already gone — cleanup below is enough */ }
    cleanup();
  }, timeoutS * 1000);
  timer = setInterval(async () => {
    if (closed) return;
    try {
      const now = Date.now();
      if (now - lastHeartbeat >= SSE_HEARTBEAT_MS) {
        lastHeartbeat = now;
        res.write(": heartbeat\n\n");
      }
      let record;
      try {
        record = await getJob(jobId);
      } catch (e) {
        sseEvent(res, "error", { error: e.message ?? String(e), code: e.code ?? "ERROR" });
        res.end();
        cleanup();
        return;
      }
      const text = JSON.stringify(record);
      if (text !== lastSent) {
        lastSent = text;
        sseEvent(res, "job", record);
      }
      if (JOB_TERMINAL_STATUSES.has(record.status)) {
        res.end();
        cleanup();
      }
    } catch { /* write to a dead socket — 'close' cleans up */ cleanup(); }
  }, SSE_POLL_MS);
  // res 'close' fires both on a clean end and on a client disconnect;
  // it is the only disconnect signal trusted here (a req 'close' can
  // fire as soon as the GET headers are read, which would kill the
  // stream before its first event).
  res.on("close", cleanup);
}

// Client-error codes (bad call, not a broken server) map to 4xx;
// everything else is a 500. Mirrors the CLI's exit-2 convention for
// the same failures.
const STATUS_BY_CODE = {
  INVALID_ARG: 400,
  INVALID_INPUT: 400,
  INVALID_OUTPUT: 400,
  OUTPUT_OVERWRITES_INPUT: 400,
  PRESET_LIBRARY_INVALID: 400,
  STYLE_LIBRARY_INVALID: 400,
  NO_MATCH: 400,
  INPUT_NOT_FOUND: 404,
  JOB_NOT_FOUND: 404,
  SANDBOX_ESCAPE: 403,
  RESOURCE_ESCAPE: 403,
  SIZE_LIMIT: 413,
  DOWNLOAD_TIMEOUT: 408,
};

export function toolInputSchema(tool) {
  return zodToJsonSchema(z.object(tool.schema), { target: "jsonSchema7" });
}

export function listTools() {
  return TOOL_DEFS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: toolInputSchema(t),
  }));
}

// One choke point for running a tool: zod-validate the arguments
// (defaults applied, same as the stdio SDK does), call the shared
// handler, and unwrap the MCP-shaped result into plain JSON. Errors
// carry `retry` so a caller can re-issue the identical call — the
// same eyes-free law as the stdio server.
export async function invokeTool(name, args) {
  const startedAt = Date.now();
  // Audit log, same as the stdio server: fire-and-forget, so hashing
  // a big output never delays the HTTP reply. Failures are recorded
  // too (unknown tool, bad arguments, tool error) — a failed call is
  // still a call worth tracing.
  const record = (body, status, errorCode) => recordToolCall({
    tool: name, via: "mcp-http", args: args ?? {}, result: body,
    status, errorCode, durationMs: Date.now() - startedAt,
  });
  const tool = TOOL_DEFS.find((t) => t.name === name);
  if (!tool) {
    const err = new Error(`unknown tool: ${name}`);
    err.code = "TOOL_NOT_FOUND";
    err.status = 404;
    record(null, "error", "TOOL_NOT_FOUND");
    throw err;
  }
  const parsed = z.object(tool.schema).safeParse(args ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    const err = new Error(`invalid arguments for ${name}: ${detail}`);
    err.code = "INVALID_ARG";
    err.status = 400;
    err.retry = { tool: name, arguments: args ?? {} };
    record(null, "error", "INVALID_ARG");
    throw err;
  }
  const res = await tool.handler(parsed.data);
  const body = JSON.parse(res.content?.[0]?.text ?? "{}");
  if (res.isError) {
    const err = new Error(body.error ?? `tool ${name} failed`);
    err.code = body.code ?? "ERROR";
    err.status = STATUS_BY_CODE[err.code] ?? 500;
    err.retry = { tool: name, arguments: parsed.data };
    record(body, "error", err.code);
    throw err;
  }
  record(body, "ok", null);
  return body;
}

function sendJson(res, status, obj) {
  const text = JSON.stringify(obj, null, 2);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

function sendError(res, err) {
  const status = err.status ?? STATUS_BY_CODE[err.code] ?? 500;
  const body = { error: err.message, code: err.code ?? "ERROR" };
  if (err.retry) body.retry = err.retry;
  sendJson(res, status, body);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const err = new Error(`request body exceeds ${MAX_BODY_BYTES} bytes`);
      err.code = "BODY_TOO_LARGE";
      err.status = 413;
      throw err;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    const err = new Error("request body is not valid JSON");
    err.code = "INVALID_ARG";
    err.status = 400;
    throw err;
  }
}

const METADATA = {
  name: NAME,
  version: VERSION,
  transport: "http",
  tools: TOOL_DEFS.length,
  endpoints: {
    metadata: "GET /mcp",
    tools: "GET /mcp/tools",
    invoke: "POST /mcp/tools/{name}/invoke",
    jobs: "GET /mcp/jobs",
    job: "GET /mcp/jobs/{id}",
    jobEvents: "GET /mcp/jobs/{id}/events",
    jobCancel: "POST /mcp/jobs/{id}/cancel",
    jsonrpc: "POST /",
  },
};

// JSON-RPC 2.0 over POST /: the same four methods an MCP stdio
// client uses (initialize, ping, tools/list, tools/call), so a plain
// curl call can do what the client does. Notifications (no `id`)
// get no response body (204). Unknown methods fail -32601, a tool
// call for an unknown tool fails -32602, malformed JSON fails -32700.
async function handleJsonRpc(body) {
  const isNotification = body.id === undefined;
  const respond = (payload) => (isNotification ? { notification: true } : payload);
  if (typeof body !== "object" || body === null || body.jsonrpc !== "2.0" || typeof body.method !== "string") {
    return respond({ jsonrpc: "2.0", id: body?.id ?? null, error: { code: -32600, message: "Invalid Request" } });
  }
  const { method, params, id } = body;
  try {
    switch (method) {
      case "initialize":
        return respond({
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: "2024-11-05",
            capabilities: { tools: {} },
            serverInfo: { name: NAME, version: VERSION },
          },
        });
      case "ping":
        return respond({ jsonrpc: "2.0", id, result: {} });
      case "tools/list":
        return respond({ jsonrpc: "2.0", id, result: { tools: listTools() } });
      case "tools/call": {
        const toolName = params?.name;
        if (typeof toolName !== "string") {
          return respond({ jsonrpc: "2.0", id, error: { code: -32602, message: "tools/call needs params.name" } });
        }
        const result = await invokeTool(toolName, params?.arguments ?? {});
        return respond({
          jsonrpc: "2.0",
          id,
          result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] },
        });
      }
      default:
        if (method.startsWith("notifications/")) return respond(null);
        return respond({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
    }
  } catch (err) {
    if (err.code === "TOOL_NOT_FOUND") {
      return respond({ jsonrpc: "2.0", id, error: { code: -32602, message: err.message } });
    }
    // A tool that ran and failed reports isError in the result (as
    // over stdio), not a JSON-RPC error — the caller still gets the
    // failure detail, with the retry attached.
    if (err.retry) {
      return respond({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: JSON.stringify({ error: err.message, code: err.code, retry: err.retry }, null, 2) }],
          isError: true,
        },
      });
    }
    return respond({ jsonrpc: "2.0", id, error: { code: -32603, message: err.message } });
  }
}

export function createHttpServer() {
  return createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://localhost");
      const path = url.pathname;
      if (req.method === "GET" && (path === "/" || path === "/mcp")) {
        sendJson(res, 200, METADATA);
        return;
      }
      if (req.method === "GET" && path === "/mcp/tools") {
        sendJson(res, 200, { tools: listTools() });
        return;
      }
      // Durable async render jobs (started by assemble async:true):
      // list newest-first, one job's status + stage/percent progress,
      // cancel a queued/running job. Unknown ids are 404 JOB_NOT_FOUND;
      // cancelling a terminal job is a 400 — same errors as the `job`
      // tool over stdio, via sendError's STATUS_BY_CODE map.
      if (req.method === "GET" && path === "/mcp/jobs") {
        const rawLimit = Number(url.searchParams.get("limit") ?? "50");
        const limit = Number.isFinite(rawLimit) ? Math.min(200, Math.max(1, Math.floor(rawLimit))) : 50;
        sendJson(res, 200, await listJobs({ limit }));
        return;
      }
      const jobEventsMatch = path.match(/^\/mcp\/jobs\/([^/]+)\/events$/);
      if (jobEventsMatch) {
        if (req.method !== "GET") {
          sendJson(res, 405, { error: `method ${req.method} not allowed here, use GET`, code: "INVALID_ARG" });
          return;
        }
        // handleJobEvents owns the response once the first header is
        // written; it returns after setup, and the stream lives on
        // its timers until the job ends, times out, or disconnects.
        await handleJobEvents(res, decodeURIComponent(jobEventsMatch[1]), url.searchParams);
        return;
      }
      const jobMatch = path.match(/^\/mcp\/jobs\/([^/]+)$/);
      if (jobMatch) {
        if (req.method !== "GET") {
          sendJson(res, 405, { error: `method ${req.method} not allowed here, use GET`, code: "INVALID_ARG" });
          return;
        }
        sendJson(res, 200, await getJob(decodeURIComponent(jobMatch[1])));
        return;
      }
      const jobCancelMatch = path.match(/^\/mcp\/jobs\/([^/]+)\/cancel$/);
      if (jobCancelMatch) {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: `method ${req.method} not allowed here, use POST`, code: "INVALID_ARG" });
          return;
        }
        sendJson(res, 200, await cancelJob(decodeURIComponent(jobCancelMatch[1])));
        return;
      }
      const invokeMatch = path.match(/^\/mcp\/tools\/([a-z0-9_]+)\/invoke$/);
      if (invokeMatch) {
        if (req.method !== "POST") {
          sendJson(res, 405, { error: `method ${req.method} not allowed here, use POST`, code: "INVALID_ARG" });
          return;
        }
        const body = await readBody(req);
        const result = await invokeTool(invokeMatch[1], body.arguments ?? {});
        sendJson(res, 200, result);
        return;
      }
      if (path === "/" && req.method === "POST") {
        const body = await readBody(req);
        const reply = await handleJsonRpc(body);
        if (reply.notification) {
          res.writeHead(204);
          res.end();
          return;
        }
        // A malformed-JSON body never reaches handleJsonRpc (readBody
        // throws first): report it as the JSON-RPC parse error -32700.
        sendJson(res, 200, reply);
        return;
      }
      sendJson(res, 404, { error: `not found: ${req.method} ${path}`, code: "NOT_FOUND" });
    } catch (err) {
      // readBody's JSON failure on POST / is a JSON-RPC parse error,
      // not a plain HTTP error.
      if (req.method === "POST" && req.url === "/" && err.code === "INVALID_ARG" && /not valid JSON/.test(err.message)) {
        sendJson(res, 200, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        return;
      }
      sendError(res, err);
    }
  });
}

// Run standalone: `node src/http.js [--port N] [--host H]`.
// Binds 127.0.0.1 unless --host says otherwise; a non-loopback bind
// is warned about on stderr, because there is no auth.
const isMain = process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
  const args = process.argv.slice(2);
  const opt = (flag, fallback) => {
    const i = args.indexOf(flag);
    if (i === -1) return fallback;
    const eq = args.find((a) => a.startsWith(`${flag}=`));
    if (eq) return eq.slice(flag.length + 1);
    return args[i + 1] ?? fallback;
  };
  const port = Number(opt("--port", "3000"));
  const host = opt("--host", "127.0.0.1");
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`invalid --port: ${opt("--port", "3000")} (want 1-65535)`);
    process.exit(2);
  }
  const server = createHttpServer();
  server.on("error", (err) => {
    if (err.code === "EADDRINUSE") {
      console.error(`port ${port} is already in use on ${host} — another mediakit HTTP server may still be running`);
      process.exit(2);
    }
    throw err;
  });
  server.listen(port, host, () => {
    const addr = server.address();
    console.log(`mediakit MCP over HTTP on http://${addr.address}:${addr.port} (${TOOL_DEFS.length} tools)`);
    if (addr.address !== "127.0.0.1" && addr.address !== "::1") {
      console.error(`warning: bound to ${addr.address} — no auth on this server, only bind it on a trusted network`);
    }
  });
}
