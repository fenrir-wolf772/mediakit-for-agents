#!/usr/bin/env node
/**
 * mediakit-for-agents — MCP server (stdio transport).
 * Exposes the ffmpeg core as tools for Claude Code / Cursor / Codex.
 * Tool definitions live in src/tools.js (shared with the HTTP mode);
 * this file only registers them on the stdio server and adds the
 * workspace resources.
 */
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import * as core from "./core.js";
import { TOOL_DEFS } from "./tools.js";

const server = new McpServer({
  name: "mediakit-for-agents",
  version: "0.1.0",
});

// Errors end with the exact retry command (kinocut's eyes-free design
// law, backlog since turn 2): every tool error carries
// `retry: {tool, arguments}` so an agent can re-issue the identical
// call instead of reconstructing it from the message. One choke point
// here — the per-tool handlers keep calling safe() unchanged, and this
// wrapper enriches any isError result with the tool name + the exact
// arguments the call carried (zod defaults already applied).
const registerTool = server.tool.bind(server);
server.tool = (name, description, schema, handler) => registerTool(name, description, schema, async (a) => {
  const res = await handler(a);
  if (res && res.isError) {
    try {
      const body = JSON.parse(res.content?.[0]?.text ?? "");
      if (body && typeof body === "object" && body.error) {
        body.retry = { tool: name, arguments: a };
        return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], isError: true };
      }
    } catch { /* error text is not JSON — leave it as-is */ }
  }
  return res;
});

for (const tool of TOOL_DEFS) {
  server.tool(tool.name, tool.description, tool.schema, tool.handler);
}


// ---------------------------------------------------------------- MCP resources
// Workspace-scoped reads (idea: conneroisu/vfx-mcp's videos:// URIs):
// a client can list the workspace's media, read one file's probe, and
// read workspace info — without guessing paths and without a tool
// call. All three are confined to the workspace root (MEDIAKIT_WORKDIR
// or the process cwd); `..` and symlink escapes are refused in core.
// The metadata template uses {+filename} (reserved expansion) so
// nested paths such as test/nested/deep-clip.mp4 match — a plain
// {filename} only matches one path segment.
function resourceResult(uri, obj) {
  return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(obj, null, 2) }] };
}

server.resource(
  "workspace-media-list",
  "videos://list",
  { description: "List every media file in the workspace (recursive, sorted, capped at 200) with size and extension — read this before guessing a path.", mimeType: "application/json" },
  async (uri) => resourceResult(uri, await core.listWorkspaceFiles()),
);

server.resource(
  "workspace-file-metadata",
  new ResourceTemplate("videos://{+filename}/metadata", { list: undefined }),
  { description: "Probe one workspace media file by relative path (e.g. test/source.mp4, nested paths allowed): duration, dimensions, codecs, streams.", mimeType: "application/json" },
  async (uri, { filename }) => resourceResult(uri, await core.workspaceMetadata(filename)),
);

server.resource(
  "workspace-info",
  "videos://workspace/info",
  { description: "Workspace root, ffmpeg/ffprobe versions, tool availability, media file count, GPU state.", mimeType: "application/json" },
  async (uri) => resourceResult(uri, await core.workspaceInfo()),
);

const transport = new StdioServerTransport();
await server.connect(transport);
