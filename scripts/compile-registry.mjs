import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  assertSubmissionShape,
  compiledEntry,
  compiledRevocation,
  loadPluginApi,
  stableRegistryJson,
} from "./registry-lib.mjs";

export const readPublishedIds = (value) => {
  const ids = value?.ids;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string")) {
    throw new Error("published-ids.json must be an object with a string ids array.");
  }
  return [...new Set(ids)];
};

export const assertPublishedIdsAppendOnly = (historyIds, nextIds) => {
  const next = new Set(nextIds);
  const removed = historyIds.filter((id) => !next.has(id));
  if (removed.length > 0) {
    throw new Error(`published-ids cannot drop ${removed.join(", ")}.`);
  }
};

export const compileRegistry = ({ files, historyIds = [], updatedAt }) => {
  const errors = [];
  const submissions = [];
  const seen = new Set();
  for (const file of files) {
    const name = basename(file.name);
    let data;
    try {
      data = JSON.parse(file.text);
    } catch {
      errors.push(`${name} is not valid JSON.`);
      continue;
    }
    if (data && typeof data.id === "string" && name !== `${data.id}.json`) {
      errors.push(`${name} must be named ${data.id}.json.`);
    }
    const shapeErrors = assertSubmissionShape(data, { allowRevokedShortcut: data?.status === "revoked" });
    if (shapeErrors.length > 0) {
      errors.push(...shapeErrors.map((error) => `${name}: ${error}`));
      continue;
    }
    if (data.status !== "revoked" && data.apiVersion && !data.verification.checksums.mainJs) {
      errors.push(`${name}: a plugin must pin main.js.`);
      continue;
    }
    if (seen.has(data.id)) errors.push(`Duplicate plugin id ${data.id}.`);
    seen.add(data.id);
    submissions.push(data);
  }
  const missing = historyIds.filter((id) => !seen.has(id));
  if (missing.length > 0) errors.push(`Published plugin file is missing: ${missing.join(", ")}.`);
  if (errors.length > 0) return { ok: false, errors };

  const entries = submissions
    .filter((submission) => submission.status !== "revoked")
    .map(compiledEntry)
    .sort((left, right) => left.id.localeCompare(right.id));
  const revocations = submissions
    .filter((submission) => submission.status === "revoked")
    .map(compiledRevocation)
    .sort((left, right) => left.id.localeCompare(right.id));
  const ids = [...new Set([...historyIds, ...submissions.map((submission) => submission.id)])].sort((left, right) => left.localeCompare(right));
  const registry = {
    registryVersion: "1",
    updatedAt,
    entries,
    ...(revocations.length > 0 ? { revocations } : {}),
  };
  return { ok: true, errors, registry, ids, json: stableRegistryJson(registry) };
};

export const assertClientRegistry = async (registry) => {
  const pluginApi = await loadPluginApi();
  pluginApi.parseMarketplaceRegistry(registry);
};

const readPluginFiles = (directory) => readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => ({ name, text: readFileSync(join(directory, name), "utf8") }));

const readGitPublishedIds = (baselineRef) => {
  const text = execFileSync("git", ["show", `${baselineRef}:published-ids.json`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return readPublishedIds(JSON.parse(text));
};

const readArgs = (argv) => {
  const options = {
    directory: "plugins",
    historyPath: "published-ids.json",
    declaredPath: "published-ids.json",
    out: "dist/community-registry.json",
    idsOut: "published-ids.json",
    updatedAt: new Date().toISOString(),
    baselineRef: "",
    check: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") options.check = true;
    else if (arg === "--plugins") options.directory = argv[++index] ?? options.directory;
    else if (arg === "--previous" || arg === "--history") options.historyPath = argv[++index] ?? options.historyPath;
    else if (arg === "--out") options.out = argv[++index] ?? options.out;
    else if (arg === "--ids-out") options.idsOut = argv[++index] ?? options.idsOut;
    else if (arg === "--updated-at") options.updatedAt = argv[++index] ?? options.updatedAt;
    else if (arg === "--baseline-ref") options.baselineRef = argv[++index] ?? "";
    else throw new Error(`Unknown argument ${arg}.`);
  }
  return options;
};

if (import.meta.main) {
  const options = readArgs(process.argv.slice(2));
  const declaredIds = readPublishedIds(JSON.parse(readFileSync(options.declaredPath, "utf8")));
  const historyIds = options.baselineRef
    ? readGitPublishedIds(options.baselineRef)
    : readPublishedIds(JSON.parse(readFileSync(options.historyPath, "utf8")));
  if (options.baselineRef) assertPublishedIdsAppendOnly(historyIds, declaredIds);
  const compiled = compileRegistry({
    files: readPluginFiles(options.directory),
    historyIds,
    updatedAt: options.updatedAt,
  });
  if (!compiled.ok) {
    for (const error of compiled.errors) console.error(error);
    process.exit(1);
  }
  await assertClientRegistry(compiled.registry);
  assertPublishedIdsAppendOnly(historyIds, compiled.ids);
  if (options.check) process.exit(0);
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, compiled.json);
  writeFileSync(options.idsOut, `${JSON.stringify({ ids: compiled.ids }, null, 2)}\n`);
  console.log(`Wrote ${compiled.registry.entries.length} entries and ${compiled.registry.revocations?.length ?? 0} revocations.`);
}
