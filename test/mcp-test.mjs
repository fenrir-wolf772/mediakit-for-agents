// MCP stdio smoke test: initialize, tools/list, call probe + trim.
// Run: node test/mcp-test.mjs
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(root, "src/server.js")],
  stderr: "ignore",
});
const client = new Client({ name: "mediakit-test", version: "0.1.0" }, { capabilities: {} });
await client.connect(transport);

const tools = await client.listTools();
const names = tools.tools.map((t) => t.name);
console.log("tools/list:", names.join(", "));
const expected = ["probe", "trim", "crop", "resize", "extract_audio", "extract_frame", "thumbnail", "loudness", "concat", "burn_captions", "convert", "reframe", "check"];
const missing = expected.filter((n) => !names.includes(n));
console.log(missing.length ? `MISSING: ${missing.join(", ")}` : "all 13 tools present");

const probeRes = await client.callTool({
  name: "probe",
  arguments: { input: path.join(root, "test/source.mp4") },
});
console.log("probe call:", probeRes.content[0].text.slice(0, 200).replace(/\n/g, " "), "...");

const trimRes = await client.callTool({
  name: "trim",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output: path.join(root, "outputs/mcp-trim.mp4"),
    start: 1,
    duration: 2,
  },
});
console.log("trim call:", trimRes.content[0].text.replace(/\n/g, " "));

const reframeRes = await client.callTool({
  name: "reframe",
  arguments: {
    input: path.join(root, "test/source.mp4"),
    output: path.join(root, "outputs/mcp-reframe.mp4"),
    width: 1080,
    height: 1920,
    mode: "crop",
  },
});
console.log("reframe call:", reframeRes.content[0].text.replace(/\n/g, " "));

const checkRes = await client.callTool({
  name: "check",
  arguments: {
    input: path.join(root, "outputs/mcp-reframe.mp4"),
    platform: "tiktok",
  },
});
console.log("check call:", checkRes.content[0].text.replace(/\n/g, " "));
await client.close();
console.log("MCP test done");
