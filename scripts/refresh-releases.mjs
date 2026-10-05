import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { compareVersions, stableRegistryJson } from "./registry-lib.mjs";
import { loadReleaseCandidate, verifySubmission } from "./verify-plugin.mjs";

const pluginFiles = (directory) => readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => ({ name, submission: JSON.parse(readFileSync(join(directory, name), "utf8")) }));

export const planReleaseRefresh = async (submissions, {
  request = fetch,
  token = process.env.GITHUB_TOKEN || "",
} = {}) => {
  const updates = [];
  for (const submission of submissions) {
    if (submission.status === "revoked") continue;
    const candidate = await loadReleaseCandidate(submission.repositoryUrl, {
      request,
      token: token || null,
      requireMain: Boolean(submission.apiVersion),
      requireStyles: Boolean(submission.verification?.checksums?.stylesCss),
    });
    if (!candidate.ok) {
      updates.push({ id: submission.id, action: "skip", errors: candidate.errors });
      continue;
    }
    if (compareVersions(candidate.manifest.version, submission.verification.version) <= 0) {
      updates.push({ id: submission.id, action: "current" });
      continue;
    }
    const next = {
      ...submission,
      releaseTag: candidate.releaseTag,
      sourceRevision: candidate.sourceRevision,
      verification: {
        ...submission.verification,
        version: candidate.manifest.version,
        checksums: candidate.checksums,
      },
    };
    const verified = await verifySubmission(next, {
      request,
      token,
      previous: submission,
      requireSubmissionAuth: false,
    });
    updates.push({
      id: submission.id,
      action: verified.ok ? "auto" : "review",
      from: submission.verification.version,
      to: candidate.manifest.version,
      next,
      errors: verified.errors,
      warnings: verified.warnings,
    });
  }
  const proposed = updates.filter((item) => item.action === "auto" || item.action === "review");
  const eligibleForAutoMerge = proposed.length > 0 && proposed.every((item) => item.action === "auto");
  const summary = updates.map((item) => {
    const detail = item.errors?.length ? ` (${item.errors.join("; ")})` : "";
    return `${item.id}: ${item.action}${detail}`;
  }).join("\n");
  return { updates, eligibleForAutoMerge, summary };
};

export const applyReleaseRefresh = (directory, plan) => {
  const written = [];
  for (const update of plan.updates) {
    if (!update.next) continue;
    const file = join(directory, `${update.id}.json`);
    writeFileSync(file, `${JSON.stringify(update.next, null, 2)}\n`);
    written.push(file);
  }
  return written;
};

const readArgs = (argv) => {
  const options = { directory: "plugins", plan: "", write: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") options.write = true;
    else if (arg === "--plugins") options.directory = argv[++index] ?? options.directory;
    else if (arg === "--plan") options.plan = argv[++index] ?? "";
    else throw new Error(`Unknown argument ${arg}.`);
  }
  return options;
};

if (import.meta.main) {
  const options = readArgs(process.argv.slice(2));
  const submissions = pluginFiles(options.directory).map((file) => file.submission);
  const plan = await planReleaseRefresh(submissions);
  const publicPlan = {
    eligibleForAutoMerge: plan.eligibleForAutoMerge,
    summary: plan.summary,
    updates: plan.updates.map(({ id, action, from, to, errors, warnings }) => ({
      id, action, from, to, errors, warnings,
    })),
  };
  if (options.plan) writeFileSync(options.plan, stableRegistryJson(publicPlan));
  if (options.write) applyReleaseRefresh(options.directory, plan);
  console.log(plan.summary || "No community plugins to refresh.");
  console.log(plan.eligibleForAutoMerge ? "Eligible for auto-merge." : "Not eligible for auto-merge.");
}
