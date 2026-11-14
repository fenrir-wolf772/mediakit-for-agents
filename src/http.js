#!/usr/bin/env node
/**
 * mediakit-for-agents — MCP over HTTP (REST + JSON-RPC).
 *
 * The same 54 tools as the stdio server (src/tools.js is the single
 * source of truth), reachable with curl instead of an MCP client —
 * for hand-testing, for agents that can only speak HTTP, and for
 * debugging a tool call without launching a client:
 *
 *   mediakit mcp --http [--port 3000] [--host 127.0.0.1]
 *
 *   GET  /mcp                        server metadata
 *   GET  /mcp/tools                  every tool + its JSON input schema
 *   POST /mcp/tools/{name}/invoke    {"arguments": {...}} -> the tool result
 *   POST /                            JSON-RPC 2.0 (initialize, ping,
 *                                     tools/list, tools/call)
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

const NAME = "mediakit-for-agents";
const VERSION = "0.1.0";
const MAX_BODY_BYTES = 1_000_000;

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
  const tool = TOOL_DEFS.find((t) => t.name === name);
  if (!tool) {
    const err = new Error(`unknown tool: ${name}`);
    err.code = "TOOL_NOT_FOUND";
    err.status = 404;
    throw err;
  }
  const parsed = z.object(tool.schema).safeParse(args ?? {});
  if (!parsed.success) {
    const detail = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ");
    const err = new Error(`invalid arguments for ${name}: ${detail}`);
    err.code = "INVALID_ARG";
    err.status = 400;
    err.retry = { tool: name, arguments: args ?? {} };
    throw err;
  }
  const res = await tool.handler(parsed.data);
  const body = JSON.parse(res.content?.[0]?.text ?? "{}");
  if (res.isError) {
    const err = new Error(body.error ?? `tool ${name} failed`);
    err.code = body.code ?? "ERROR";
    err.status = STATUS_BY_CODE[err.code] ?? 500;
    err.retry = { tool: name, arguments: parsed.data };
    throw err;
  }
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
