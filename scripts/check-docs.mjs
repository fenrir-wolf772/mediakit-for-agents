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
if (!/import \{[^}]*\bTOOL_DEFS\b[^}]*\} from "\.\/tools\.js"/.test(serverSrc)) problems.push("src/server.js no longer imports TOOL_DEFS from src/tools.js");
if (!/import \{[^}]*\bTOOL_DEFS\b[^}]*\} from "\.\/tools\.js"/.test(httpSrc)) problems.push("src/http.js no longer imports TOOL_DEFS from src/tools.js");

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
const probedMuxers = probeList("DOCTOR_MUXERS");
const reqMatch = coreSrc.match(/const TOOL_REQUIREMENTS = \{([\s\S]*?)\n\};/);
if (!reqMatch) problems.push("could not find TOOL_REQUIREMENTS in src/core.js");
if (reqMatch) {
  // Coverage guard (lượt 163): every TOOL_DEFS entry must have a
  // TOOL_REQUIREMENTS entry — a tool missing here is invisible to
  // doctor, so videos://workspace/info undercounts tools_total
  // (list_templates shipped as tool 90 while doctor still reported
  // 89, caught only by the resource test). A pure tool takes `{}`.
  const reqNames = [...reqMatch[1].matchAll(/^  ([a-z0-9_]+): \{/gm)].map((m) => m[1]);
  for (const t of serverTools) {
    if (!reqNames.includes(t)) problems.push(`tool "${t}" is in TOOL_DEFS but missing from TOOL_REQUIREMENTS — doctor would not report it (use {} for a pure tool)`);
  }
  for (const t of reqNames) {
    if (!serverTools.includes(t)) problems.push(`TOOL_REQUIREMENTS names "${t}" but it is not in TOOL_DEFS`);
  }
  for (const [, list, kind] of [...reqMatch[1].matchAll(/(filters|encoders|decoders|muxers): \[([^\]]*)\]/g)]) {
    const probed = kind === "filters" ? probedFilters : kind === "encoders" ? probedEncoders : kind === "decoders" ? probedDecoders : probedMuxers;
    for (const name of [...list.matchAll(/"([a-z0-9_]+)"/g)].map((x) => x[1])) {
      if (!probed.has(name)) problems.push(`TOOL_REQUIREMENTS names ${kind.slice(0, -1)} "${name}" but it is not in DOCTOR_${kind.toUpperCase()} — doctor would report its tool missing on a healthy machine`);
    }
  }
}

// CI tool-count guard (lượt 113): the smoke test in
// .github/workflows/ci.yml asserts the HTTP /mcp endpoint reports
// `"tools": N`. That N is a third copy of the tool count, and it
// drifted twice before (lượt 89/91: 71 vs 73; lượt 112: 74 vs 75 —
// verify_cuts shipped as tool 75 while CI still asserted 74, so
// both CI runs on the lượt 112 commit failed at the HTTP curl after
// every other smoke command had passed). Derive it here instead:
// any `"tools": N` assertion in ci.yml must equal TOOL_DEFS length,
// so `npm run check` fails locally the moment a new tool ships
// without the CI bump — the smoke step never gets to be the one
// that discovers it.
const ciYml = await readFile(path.join(root, ".github/workflows/ci.yml"), "utf8");
const ciCounts = [...ciYml.matchAll(/"tools": (\d+)/g)].map((m) => Number(m[1]));
if (!ciCounts.length) problems.push("could not find a \"tools\": N assertion in .github/workflows/ci.yml");
for (const n of ciCounts) {
  if (n !== serverTools.length) problems.push(`CI asserts "tools": ${n} but src/tools.js has ${serverTools.length} tools — bump the ci.yml assertion when a tool ships`);
}

// Safety-tier guard (lượt 141): every TOOL_DEFS entry must carry
// exactly one tier from the EncodeX set, and the tier must match the
// annotations the transports publish — a tool without a tier would
// silently default to WRITE in toolAnnotations, which is the wrong
// direction (a probe tool must never look mutative).
const TIERS = ["READ", "PLAN", "WRITE", "DESTRUCTIVE"];
const tierLines = [...toolsSrc.matchAll(/^\s+tier: "([A-Z]+)",$/gm)].map((m) => m[1]);
if (tierLines.length !== serverTools.length) {
  problems.push(`tier count drift: ${tierLines.length} tier fields for ${serverTools.length} tools — every TOOL_DEFS entry needs exactly one tier`);
}
for (const t of tierLines) {
  if (!TIERS.includes(t)) problems.push(`unknown safety tier "${t}" (must be one of ${TIERS.join(", ")})`);
}
const destructiveTools = serverTools.filter((_, i) => tierLines[i] === "DESTRUCTIVE");
if (!destructiveTools.includes("patch_manifest")) problems.push("patch_manifest must stay DESTRUCTIVE — it rewrites a user artifact in place");
if (!destructiveTools.includes("edit_session")) problems.push("edit_session must stay DESTRUCTIVE — its commit rewrites a user artifact in place");
// DESTRUCTIVE is a closed set, not a count: exactly the two tools
// whose guarded write replaces a user artifact in place
// (patch_manifest: expected_revision + .bak; edit_session commit:
// base sha256 + revision stale check + session checkpoint). A third
// DESTRUCTIVE claim is a design decision, not a typo — update this
// allowlist deliberately, with its guard named, when one ships.
const DESTRUCTIVE_ALLOWLIST = ["patch_manifest", "edit_session"];
for (const t of destructiveTools) {
  if (!DESTRUCTIVE_ALLOWLIST.includes(t)) problems.push(`unexpected DESTRUCTIVE tool "${t}" — the allowlist is ${DESTRUCTIVE_ALLOWLIST.join(", ")}; a new in-place writer needs its guard named here first`);
}
if (destructiveTools.length !== DESTRUCTIVE_ALLOWLIST.length) problems.push(`expected exactly ${DESTRUCTIVE_ALLOWLIST.length} DESTRUCTIVE tools (${DESTRUCTIVE_ALLOWLIST.join(", ")}), got ${destructiveTools.length}: ${destructiveTools.join(", ")}`);

// Tool-count prose guard (lượt 177, idea: nexu-io/openmotion's
// template-runtime-check — the catalog count must match everywhere
// it is stated, not just in the README table and ci.yml). The table
// guard above missed prose: when this guard was written, SKILL.md
// said "69 tools", src/http.js "55 tools" and bin/mediakit.js
// "79 tools" while the catalog was 98 — three stale counts no
// table/CI guard could ever see. Every "N tools" that states
// MediaKit's own catalog size must equal TOOL_DEFS length.
const proseFiles = ["README.md", path.join("skills", "mediakit", "SKILL.md"), path.join("src", "tools.js"), path.join("src", "http.js"), path.join("src", "server.js"), path.join("bin", "mediakit.js")];
for (const rel of proseFiles) {
  const text = await readFile(path.join(root, rel), "utf8");
  for (const line of text.split("\n")) {
    // Tier prose ("READ (30 tools)", "READ tools only probe ...
    // (30 tools)") states a tier count, not the catalog total —
    // checked by the tier guard below, not here.
    if (/READ\s*\(|READ tools/.test(line)) continue;
    // The hot-list comment ("The 18 tools a director reaches for
    // first") states the HOT_TOOLS length, not the catalog total —
    // checked by the hot-list guard below.
    if (/director reaches for first/.test(line)) continue;
    for (const m of line.matchAll(/(\d+) tools\b/g)) {
      if (Number(m[1]) !== serverTools.length) {
        problems.push(`${rel}: prose says "${m[1]} tools" but src/tools.js has ${serverTools.length} tools — bump the prose when a tool ships`);
      }
    }
  }
}

// Tier-count prose guard (lượt 177): the tier numbers stated in the
// README safety row and the SKILL.md safety paragraph must equal the
// tier counts derived from TOOL_DEFS above. The README row was stale
// once (lượt 176 fixed 24/4/57 → 30/5/62 by hand); the guard makes
// the next drift fail here instead of in a reader's head.
const tierCounts = Object.fromEntries(TIERS.map((t) => [t, tierLines.filter((x) => x === t).length]));
const readmeText = await readFile(path.join(root, "README.md"), "utf8");
const skillText = await readFile(path.join(root, "skills", "mediakit", "SKILL.md"), "utf8");
const tierProse = [
  ["README.md", readmeText, /READ tools only probe and write nothing \((\d+) tools\)/, "READ"],
  ["README.md", readmeText, /PLAN tools answer a question by transient work and leave no artifact \((\d+):/, "PLAN"],
  ["README.md", readmeText, /WRITE tools produce a file the caller asked for and never overwrite their own input \((\d+)\)/, "WRITE"],
  ["skills/mediakit/SKILL.md", skillText, /READ \((\d+) tools\)/, "READ"],
  ["skills/mediakit/SKILL.md", skillText, /PLAN \((\d+)\)/, "PLAN"],
  ["skills/mediakit/SKILL.md", skillText, /WRITE\s*\((\d+)\)/, "WRITE"],
  ["skills/mediakit/SKILL.md", skillText, /DESTRUCTIVE \((\d+) —/, "DESTRUCTIVE"],
];
for (const [file, text, re, tier] of tierProse) {
  const m = text.match(re);
  if (!m) {
    problems.push(`could not find the ${tier} tier count in ${file} — the prose guard pattern no longer matches; update the pattern or restore the count`);
  } else if (Number(m[1]) !== tierCounts[tier]) {
    problems.push(`${file}: prose says ${tier} has ${m[1]} tools but TOOL_DEFS has ${tierCounts[tier]} — bump the prose when a tool ships or changes tier`);
  }
}

// Hot-list guard (lượt 177): the "The N tools a director reaches
// for first" comment above HOT_TOOLS must equal the array's length
// (18 + 2 discovery tools = 20 in hot mode — the 20 is prose, the
// 18 is the array).
const hotMatch = toolsSrc.match(/export const HOT_TOOLS = \[([\s\S]*?)\];/);
if (!hotMatch) {
  problems.push("could not find HOT_TOOLS in src/tools.js");
} else {
  const hotCount = [...hotMatch[1].matchAll(/"([a-z0-9_]+)"/g)].length;
  const hotComment = toolsSrc.match(/The (\d+) tools a director reaches for first/);
  if (!hotComment) {
    problems.push("could not find the hot-list count comment in src/tools.js");
  } else if (Number(hotComment[1]) !== hotCount) {
    problems.push(`hot-list comment says ${hotComment[1]} tools but HOT_TOOLS has ${hotCount} entries`);
  }
}

if (problems.length) {
  console.error("check-docs FAILED:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}
console.log(`check-docs OK: ${serverTools.length} tools in src/tools.js and README; batch enum covers ${batchOps.length} operations; stdio + HTTP share TOOL_DEFS`);
