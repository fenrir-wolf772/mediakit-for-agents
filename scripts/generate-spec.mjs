// Machine-readable contract (SPEC) generator — lượt 149.
//
// The backlog item "Contract machine-readable (SPEC kiểu
// ffmpeg-skill) + CI fail khi drift": a single SPEC.json at the repo
// root that an agent (or a CI job, or another tool) can read without
// paying for a tools/list dump or a README parse. It is GENERATED
// from the same TOOL_DEFS registry the stdio + HTTP transports
// register — never hand-edited — so the file cannot drift from the
// server: `npm run check` runs this script with --check and fails
// when the committed SPEC.json does not match a fresh regeneration
// (a new tool, a renamed parameter, a tier change — any of those
// must come with a regenerated SPEC.json in the same commit).
//
// Shape (spec_version 1):
//   spec_version, mediakit_version, tool_count,
//   transports: ["stdio", "http"],
//   families: [{ name, description, count }],
//   tools: [{ name, family, tier, summary, description, inputSchema }],
//   spec_hash: sha256 of the canonical JSON of the tools array, so a
//   consumer can detect a contract change by comparing one string.
//
// Deterministic by construction: no timestamps, registry order kept,
// JSON 2-space indent + trailing newline. `buildSpec()` is exported
// so test/mcp-test.mjs can assert the committed file equals a fresh
// build without shelling out.
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";
import {
  TOOL_DEFS,
  TOOL_FAMILY_DESCRIPTIONS,
  TOOL_FAMILY_OF,
  toolSummary,
} from "../src/tools.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const SPEC_PATH = path.join(root, "SPEC.json");
export const SPEC_VERSION = 1;

export function specHash(tools) {
  return createHash("sha256").update(JSON.stringify(tools)).digest("hex");
}

export async function buildSpec() {
  const pkg = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  // A tool without a family breaks discovery (test asserts the map
  // covers every def) — fail the generation loudly instead of
  // writing a SPEC with an undefined family.
  const missing = TOOL_DEFS.filter((t) => TOOL_FAMILY_OF[t.name] === undefined).map((t) => t.name);
  if (missing.length) throw new Error(`tools without a family in TOOL_FAMILY_OF: ${missing.join(", ")}`);
  const tools = TOOL_DEFS.map((t) => ({
    name: t.name,
    family: TOOL_FAMILY_OF[t.name],
    tier: t.tier,
    summary: toolSummary(t),
    description: t.description,
    inputSchema: zodToJsonSchema(z.object(t.schema), { target: "jsonSchema7" }),
  }));
  return {
    spec_version: SPEC_VERSION,
    mediakit_version: pkg.version,
    tool_count: tools.length,
    transports: ["stdio", "http"],
    families: Object.entries(TOOL_FAMILY_DESCRIPTIONS).map(([name, description]) => ({
      name,
      description,
      count: tools.filter((t) => t.family === name).length,
    })),
    tools,
    spec_hash: specHash(tools),
  };
}

export function specText(spec) {
  return `${JSON.stringify(spec, null, 2)}\n`;
}

// What changed between the committed file and a fresh build, in one
// line per tool — the --check failure message, not a full JSON diff.
export function specDiff(oldSpec, newSpec) {
  const problems = [];
  if (oldSpec.spec_version !== newSpec.spec_version) problems.push(`spec_version ${oldSpec.spec_version} -> ${newSpec.spec_version}`);
  if (oldSpec.mediakit_version !== newSpec.mediakit_version) problems.push(`mediakit_version ${oldSpec.mediakit_version} -> ${newSpec.mediakit_version}`);
  if (oldSpec.tool_count !== newSpec.tool_count) problems.push(`tool_count ${oldSpec.tool_count} -> ${newSpec.tool_count}`);
  const oldByName = new Map((oldSpec.tools ?? []).map((t) => [t.name, t]));
  const newByName = new Map((newSpec.tools ?? []).map((t) => [t.name, t]));
  for (const name of newByName.keys()) {
    if (!oldByName.has(name)) problems.push(`tool added: ${name}`);
  }
  for (const name of oldByName.keys()) {
    if (!newByName.has(name)) problems.push(`tool removed: ${name}`);
  }
  for (const [name, fresh] of newByName) {
    const old = oldByName.get(name);
    if (!old) continue;
    for (const field of ["family", "tier", "summary", "description"]) {
      if (old[field] !== fresh[field]) problems.push(`tool ${name}: ${field} changed`);
    }
    if (JSON.stringify(old.inputSchema) !== JSON.stringify(fresh.inputSchema)) problems.push(`tool ${name}: inputSchema changed`);
  }
  if (oldSpec.spec_hash !== newSpec.spec_hash && !problems.length) problems.push("spec_hash changed with no visible tool diff (hash input changed)");
  return problems;
}

async function main() {
  const args = process.argv.slice(2);
  const checkMode = args.includes("--check");
  const specIdx = args.indexOf("--spec");
  const outPath = specIdx >= 0 && args[specIdx + 1] ? path.resolve(args[specIdx + 1]) : SPEC_PATH;

  const spec = await buildSpec();
  if (checkMode) {
    let onDisk;
    try {
      onDisk = JSON.parse(await readFile(outPath, "utf8"));
    } catch (err) {
      console.error(`generate-spec --check FAILED: cannot read ${outPath} (${err.code ?? err.message}) — run \`node scripts/generate-spec.mjs\` to (re)generate it`);
      process.exit(1);
    }
    const problems = specDiff(onDisk, spec);
    if (problems.length || specText(onDisk) !== specText(spec)) {
      console.error("generate-spec --check FAILED: SPEC.json is stale — regenerate with `node scripts/generate-spec.mjs` and commit it with the code change:");
      for (const p of problems.length ? problems : ["formatting differs (regenerate to normalise)"]) console.error(`  - ${p}`);
      process.exit(1);
    }
    console.log(`generate-spec --check OK: SPEC.json matches the registry (${spec.tool_count} tools, spec_hash ${spec.spec_hash.slice(0, 12)}…)`);
  } else {
    await writeFile(outPath, specText(spec), "utf8");
    console.log(`wrote ${outPath} (${spec.tool_count} tools, spec_hash ${spec.spec_hash.slice(0, 12)}…)`);
  }
}

// Importing this file (test/mcp-test.mjs does, to assert the
// committed SPEC.json equals a fresh build) must not run the CLI —
// only run main() when executed directly.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
