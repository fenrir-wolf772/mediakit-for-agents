// Docs drift guard — the ffmpeg-micro version-sync guard, adapted:
// fail loudly when two sources of truth diverge instead of letting
// them drift silently. Here the two sources are the MCP tool list in
// src/tools.js (the single registry shared by the stdio server and
// the HTTP mode) and the tools table in README.md: same count, same
// names. Run by `npm run check`, so CI fails on drift.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const toolsSrc = await readFile(path.join(root, "src/tools.js"), "utf8");
const readme = await readFile(path.join(root, "README.md"), "utf8");

const serverTools = [...toolsSrc.matchAll(/^\s+name: "([a-z0-9_]+)",$/gm)].map((m) => m[1]);
const readmeTools = [...readme.matchAll(/^\| `([a-z0-9_]+)` \|/gm)].map((m) => m[1]);

const problems = [];
if (serverTools.length !== readmeTools.length) {
  problems.push(`tool count drift: src/tools.js has ${serverTools.length}, README table has ${readmeTools.length}`);
}
for (const t of serverTools) {
  if (!readmeTools.includes(t)) problems.push(`tool "${t}" is in src/tools.js but missing from the README table`);
}
for (const t of readmeTools) {
  if (!serverTools.includes(t)) problems.push(`tool "${t}" is in the README table but missing from src/tools.js`);
}
if (new Set(serverTools).size !== serverTools.length) problems.push("duplicate tool names in src/tools.js");

// The stdio server and the HTTP mode must both register the same
// registry — a hand-written second list would drift. Both files
// import TOOL_DEFS from src/tools.js; fail here if either stops
// doing so (e.g. someone inlines a copy).
const serverSrc = await readFile(path.join(root, "src/server.js"), "utf8");
const httpSrc = await readFile(path.join(root, "src/http.js"), "utf8");
if (!/import \{ TOOL_DEFS \} from "\.\/tools\.js"/.test(serverSrc)) problems.push("src/server.js no longer imports TOOL_DEFS from src/tools.js");
if (!/import \{ TOOL_DEFS \} from "\.\/tools\.js"/.test(httpSrc)) problems.push("src/http.js no longer imports TOOL_DEFS from src/tools.js");

// Batch enum guard (lượt 38): the MCP batch tool's operation enum must
// cover every key of BATCH_OPERATIONS in src/core.js. Lượt 36 added
// chroma_key to the table but not the enum, so MCP callers could not
// batch it while the CLI could — the drift was invisible until a
// caller tried. Same check in reverse: an enum value with no table
// entry would fail at runtime instead of at validation.
const batchEnumMatch = toolsSrc.match(/name: "batch"[\s\S]{0,4000}?z\.enum\(\[([^\]]+)\]\)/);
const batchEnum = batchEnumMatch ? [...batchEnumMatch[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]) : [];
const coreSrc = await readFile(path.join(root, "src/core.js"), "utf8");
const batchTableMatch = coreSrc.match(/export const BATCH_OPERATIONS = \{([\s\S]*?)\n\};/);
const batchOps = batchTableMatch ? [...batchTableMatch[1].matchAll(/^  ([a-z0-9_]+): \{/gm)].map((m) => m[1]) : [];
if (!batchEnum.length) problems.push("could not find the MCP batch operation enum in src/tools.js");
if (!batchOps.length) problems.push("could not find BATCH_OPERATIONS in src/core.js");
for (const op of batchOps) {
  if (!batchEnum.includes(op)) problems.push(`batch operation "${op}" is in BATCH_OPERATIONS but missing from the MCP batch enum`);
}
for (const op of batchEnum) {
  if (!batchOps.includes(op)) problems.push(`batch operation "${op}" is in the MCP batch enum but missing from BATCH_OPERATIONS`);
}

// Doctor probe guard (lượt 46): every filter/encoder/decoder a
// TOOL_REQUIREMENTS entry names must also be in the matching
// DOCTOR_* probe list — otherwise doctor reports the tool missing
// on a healthy machine (loudness named "acompressor" while the
// probe list did not include it, so doctor said loudness was
// unavailable even though ffmpeg has the filter).
const probeList = (name) => {
  const m = coreSrc.match(new RegExp(`const ${name} = \\[([\\s\\S]*?)\\];`));
  return m ? new Set([...m[1].matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1])) : new Set();
};
const probedFilters = probeList("DOCTOR_FILTERS");
const probedEncoders = probeList("DOCTOR_ENCODERS");
const probedDecoders = probeList("DOCTOR_DECODERS");
const reqMatch = coreSrc.match(/const TOOL_REQUIREMENTS = \{([\s\S]*?)\n\};/);
if (!reqMatch) problems.push("could not find TOOL_REQUIREMENTS in src/core.js");
if (reqMatch) {
  for (const [, list, kind] of [...reqMatch[1].matchAll(/(filters|encoders|decoders): \[([^\]]*)\]/g)]) {
    const probed = kind === "filters" ? probedFilters : kind === "encoders" ? probedEncoders : probedDecoders;
    for (const name of [...list.matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1])) {
      if (!probed.has(name)) problems.push(`TOOL_REQUIREMENTS names ${kind.slice(0, -1)} "${name}" but it is not in DOCTOR_${kind.toUpperCase()} — doctor would report its tool missing on a healthy machine`);
    }
  }
}

if (problems.length) {
  console.error("check-docs FAILED:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-docs OK: ${serverTools.length} tools in src/tools.js and README; batch enum covers ${batchOps.length} operations; stdio + HTTP share TOOL_DEFS`);
