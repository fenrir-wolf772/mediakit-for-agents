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

if (problems.length) {
  console.error("check-docs FAILED:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-docs OK: ${serverTools.length} tools in server.js and README`);
