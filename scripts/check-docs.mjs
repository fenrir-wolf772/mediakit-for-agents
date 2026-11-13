// Docs drift guard — the ffmpeg-micro version-sync guard, adapted:
// fail loudly when two sources of truth diverge instead of letting
// them drift silently. Here the two sources are the MCP tool list in
// src/server.js and the tools table in README.md: same count, same
// names. Run by `npm run check`, so CI fails on drift.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const serverSrc = await readFile(path.join(root, "src/server.js"), "utf8");
const readme = await readFile(path.join(root, "README.md"), "utf8");

const serverTools = [...serverSrc.matchAll(/server\.tool\(\s*"([a-z0-9_]+)"/g)].map((m) => m[1]);
const readmeTools = [...readme.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map((m) => m[1]);

const problems = [];
if (serverTools.length !== readmeTools.length) {
  problems.push(`tool count drift: server.js has ${serverTools.length}, README table has ${readmeTools.length}`);
}
for (const t of serverTools) {
  if (!readmeTools.includes(t)) problems.push(`tool "${t}" is in server.js but missing from the README table`);
}
for (const t of readmeTools) {
  if (!serverTools.includes(t)) problems.push(`tool "${t}" is in the README table but missing from server.js`);
}
if (new Set(serverTools).size !== serverTools.length) problems.push("duplicate tool names in server.js");

// Batch enum guard (lượt 38): the MCP batch tool's operation enum must
// cover every key of BATCH_OPERATIONS in src/core.js. Lượt 36 added
// chroma_key to the table but not the enum, so MCP callers could not
// batch it while the CLI could — the drift was invisible until a
// caller tried. Same check in reverse: an enum value with no table
// entry would fail at runtime instead of at validation.
const batchEnumMatch = serverSrc.match(/server\.tool\(\s*"batch"[\s\S]{0,4000}?z\.enum\(\[([^\]]+)\]\)/);
const batchEnum = batchEnumMatch ? [...batchEnumMatch[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]) : [];
const coreSrc = await readFile(path.join(root, "src/core.js"), "utf8");
const batchTableMatch = coreSrc.match(/export const BATCH_OPERATIONS = \{([\s\S]*?)\n\};/);
const batchOps = batchTableMatch ? [...batchTableMatch[1].matchAll(/^  ([a-z0-9_]+): \{/gm)].map((m) => m[1]) : [];
if (!batchEnum.length) problems.push("could not find the MCP batch operation enum in server.js");
if (!batchOps.length) problems.push("could not find BATCH_OPERATIONS in src/core.js");
for (const op of batchOps) {
  if (!batchEnum.includes(op)) problems.push(`batch operation "${op}" is in BATCH_OPERATIONS but missing from the MCP batch enum`);
}
for (const op of batchEnum) {
  if (!batchOps.includes(op)) problems.push(`batch operation "${op}" is in the MCP batch enum but missing from BATCH_OPERATIONS`);
}

if (problems.length) {
  console.error("check-docs FAILED:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-docs OK: ${serverTools.length} tools in server.js and README; batch enum covers ${batchOps.length} operations`);
