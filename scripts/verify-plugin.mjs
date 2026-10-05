import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  ASSET_LIMITS,
  assertSubmissionShape,
  canonicalLicense,
  githubGet,
  identifyLicenseText,
  isOsiLicense,
  isSubset,
  licensesMatch,
  loadPluginApi,
  parseRepositoryUrl,
  readJsonBody,
  sameIdentity,
  sameStringSet,
  scanPluginScript,
  sha256Hex,
} from "./registry-lib.mjs";

const SOURCE_FILE = /\.(?:ts|tsx|js|jsx|mjs|cjs|vue|svelte|rs|go|py|kt|swift|java)$/i;
const DOC_FILE = /(?:^|\/)(?:readme|build|building)(?:\.|$)/i;
const LICENSE_FILES = ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING", "COPYING.md"];

const textOf = async (response, maximum) => {
  if (!response.ok) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maximum) throw new Error("Downloaded file exceeds the allowed size.");
  return { bytes, text: new TextDecoder().decode(bytes) };
};

const fetchReleaseAsset = async (request, repository, tag, name) => {
  const url = `https://github.com/${repository.owner}/${repository.repo}/releases/download/${encodeURIComponent(tag)}/${name}`;
  const response = await request(url, { redirect: "follow", headers: { "User-Agent": "edgeever-plugins" } });
  return textOf(response, ASSET_LIMITS[name]);
};

const fetchRawFile = async (request, repository, revision, path) => {
  const url = `https://raw.githubusercontent.com/${repository.owner}/${repository.repo}/${revision}/${path}`;
  const response = await request(url, { redirect: "follow", headers: { "User-Agent": "edgeever-plugins" } });
  if (!response.ok) return null;
  return response.text();
};

const resolveTagCommit = async (request, repository, tag, token) => {
  const encoded = encodeURIComponent(tag);
  const ref = await githubGet(
    request,
    `https://api.github.com/repos/${repository.owner}/${repository.repo}/git/ref/tags/${encoded}`,
    { token },
  );
  if (!ref.ok) throw new Error(`Release tag ${tag} does not point at a Git ref.`);
  const body = await ref.json();
  if (body.object?.type === "commit" && typeof body.object.sha === "string") return body.object.sha.toLocaleLowerCase();
  if (body.object?.type === "tag" && typeof body.object.sha === "string") {
    const annotated = await githubGet(
      request,
      `https://api.github.com/repos/${repository.owner}/${repository.repo}/git/tags/${body.object.sha}`,
      { token },
    );
    const tagObject = await readJsonBody(annotated);
    if (tagObject.object?.type === "commit" && typeof tagObject.object.sha === "string") {
      return tagObject.object.sha.toLocaleLowerCase();
    }
  }
  throw new Error(`Release tag ${tag} does not point at an immutable commit.`);
};

const detectLicense = async (request, repository, revision) => {
  const api = await githubGet(
    request,
    `https://api.github.com/repos/${repository.owner}/${repository.repo}/license`,
    { token: null },
  );
  if (api.ok) {
    const body = await api.json();
    const spdx = body.license?.spdx_id;
    if (typeof spdx === "string" && spdx !== "NOASSERTION" && isOsiLicense(spdx)) return canonicalLicense(spdx);
  }
  for (const name of LICENSE_FILES) {
    const text = await fetchRawFile(request, repository, revision, name);
    if (!text) continue;
    const identified = identifyLicenseText(text);
    if (identified) return identified;
  }
  return null;
};

const listTree = async (request, repository, revision, token) => {
  const response = await githubGet(
    request,
    `https://api.github.com/repos/${repository.owner}/${repository.repo}/git/trees/${revision}?recursive=1`,
    { token },
  );
  const body = await readJsonBody(response);
  return (body.tree ?? []).map((item) => item.path).filter((path) => typeof path === "string");
};

const confirmWriteAccess = async (request, repository, { author, token, prUrl, revision }) => {
  if (author && author.toLocaleLowerCase() === repository.owner.toLocaleLowerCase()) return "owner";
  if (token && author) {
    const response = await githubGet(
      request,
      `https://api.github.com/repos/${repository.owner}/${repository.repo}/collaborators/${encodeURIComponent(author)}/permission`,
      { token },
    );
    if (response.ok) {
      const body = await response.json();
      if (["admin", "maintain", "write"].includes(body.permission)) return "api";
    }
  }
  if (prUrl) {
    const claim = await fetchRawFile(request, repository, revision, ".edgeever/marketplace-claim");
    if (claim?.trim() === prUrl.trim()) return "claim";
  }
  return null;
};

const checksumsFromAssets = ({ manifest, main, styles }) => ({
  manifestJson: sha256Hex(manifest.bytes),
  ...(main ? { mainJs: sha256Hex(main.bytes) } : {}),
  ...(styles ? { stylesCss: sha256Hex(styles.bytes) } : {}),
});

/**
 * Read one GitHub release from repositoryUrl. Callers pass releaseTag for a
 * pinned submission. The refresh job omits it and reads releases/latest.
 */
export const loadReleaseCandidate = async (repositoryUrl, {
  request = fetch,
  token = null,
  releaseTag = "",
  requireMain = true,
  requireStyles = false,
} = {}) => {
  const repository = parseRepositoryUrl(repositoryUrl);
  if (!repository) return { ok: false, errors: ["repositoryUrl must be a GitHub repository."] };
  let tag = releaseTag;
  try {
    if (!tag) {
      const latest = await githubGet(
        request,
        `https://api.github.com/repos/${repository.owner}/${repository.repo}/releases/latest`,
        { token },
      );
      if (!latest.ok) return { ok: false, errors: [`Latest release lookup returned HTTP ${latest.status}.`] };
      const body = await latest.json();
      if (typeof body.tag_name !== "string" || !body.tag_name.trim()) {
        return { ok: false, errors: ["Latest release has no tag."] };
      }
      tag = body.tag_name;
    }
    const commit = await resolveTagCommit(request, repository, tag, token);
    const manifestAsset = await fetchReleaseAsset(request, repository, tag, "manifest.json");
    if (!manifestAsset) return { ok: false, errors: ["Release is missing manifest.json."] };
    const pluginApi = await loadPluginApi();
    let manifest;
    try {
      manifest = pluginApi.parseExtensionManifest(JSON.parse(manifestAsset.text));
    } catch (error) {
      return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
    }
    const wantsMain = requireMain && manifest.type === "plugin";
    const mainAsset = wantsMain ? await fetchReleaseAsset(request, repository, tag, "main.js") : null;
    if (wantsMain && !mainAsset) return { ok: false, errors: ["Release is missing main.js."] };
    let stylesAsset = null;
    if (requireStyles) {
      stylesAsset = await fetchReleaseAsset(request, repository, tag, "styles.css");
      if (!stylesAsset) return { ok: false, errors: ["Release is missing styles.css."] };
    } else {
      stylesAsset = await fetchReleaseAsset(request, repository, tag, "styles.css");
    }
    const license = await detectLicense(request, repository, commit);
    return {
      ok: true,
      errors: [],
      repository,
      releaseTag: tag,
      sourceRevision: commit,
      manifest,
      manifestAsset,
      mainAsset,
      stylesAsset,
      license,
      checksums: checksumsFromAssets({ manifest: manifestAsset, main: mainAsset, styles: stylesAsset }),
    };
  } catch (error) {
    return { ok: false, errors: [error instanceof Error ? error.message : String(error)] };
  }
};

export const verifySubmission = async (submission, {
  request = fetch,
  token = process.env.GITHUB_TOKEN || "",
  prUrl = "",
  prAuthor = "",
  requireSubmissionAuth = false,
  previous = null,
} = {}) => {
  const errors = assertSubmissionShape(submission, { allowRevokedShortcut: true });
  const warnings = [];
  if (errors.length > 0) return { ok: false, errors, warnings };
  if (submission.status === "revoked") return { ok: true, errors, warnings, revoked: true };

  const shapeErrors = assertSubmissionShape(submission);
  if (shapeErrors.length > 0) return { ok: false, errors: shapeErrors, warnings };

  const repository = parseRepositoryUrl(submission.repositoryUrl);
  const visibility = await githubGet(
    request,
    `https://api.github.com/repos/${repository.owner}/${repository.repo}`,
    { token: null },
  );
  if (visibility.status !== 200) {
    return { ok: false, errors: [`Anonymous repository lookup returned HTTP ${visibility.status}.`], warnings };
  }

  const candidate = await loadReleaseCandidate(submission.repositoryUrl, {
    request,
    token: token || null,
    releaseTag: submission.releaseTag,
    requireMain: Boolean(submission.apiVersion),
    requireStyles: Boolean(submission.verification.checksums.stylesCss),
  });
  if (!candidate.ok) return { ok: false, errors: candidate.errors, warnings };
  if (candidate.sourceRevision !== submission.sourceRevision.toLocaleLowerCase()) {
    errors.push("Release tag does not point at sourceRevision.");
  }
  if (!candidate.license) errors.push("Could not identify an OSI-approved license.");
  else if (!licensesMatch(candidate.license, submission.licenseSpdx)) {
    errors.push(`Detected license ${candidate.license} does not match ${submission.licenseSpdx}.`);
  }

  const manifest = candidate.manifest;
  if (manifest.id !== submission.id) errors.push("Manifest id does not match the submission.");
  if (manifest.version !== submission.verification.version) errors.push("Manifest version does not match the submission.");
  if (submission.apiVersion && (manifest.type !== "plugin" || manifest.apiVersion !== submission.apiVersion)) {
    errors.push("Manifest apiVersion does not match the submission.");
  }
  if (submission.themeApiVersion && (manifest.type !== "theme" || manifest.themeApiVersion !== submission.themeApiVersion)) {
    errors.push("Manifest themeApiVersion does not match the submission.");
  }
  const pinned = submission.verification.checksums;
  if (candidate.checksums.manifestJson !== pinned.manifestJson) errors.push("manifest.json checksum does not match the release asset.");
  if (submission.apiVersion && candidate.checksums.mainJs !== pinned.mainJs) errors.push("main.js checksum does not match the release asset.");
  if (pinned.stylesCss && candidate.checksums.stylesCss !== pinned.stylesCss) errors.push("styles.css checksum does not match the release asset.");

  const permissions = manifest.type === "plugin" ? manifest.permissions ?? [] : [];
  const networkHosts = manifest.type === "plugin" ? manifest.networkHosts ?? [] : [];
  const admittedUnchanged = Boolean(previous) && sameIdentity(previous, submission);
  if (admittedUnchanged) {
    if (!isSubset(permissions, submission.admitted.permissions) || !isSubset(networkHosts, submission.admitted.networkHosts)) {
      errors.push("Manifest permissions or networkHosts exceed the admitted snapshot.");
    }
  } else if (!sameStringSet(permissions, submission.admitted.permissions) || !sameStringSet(networkHosts, submission.admitted.networkHosts)) {
    errors.push("admitted permissions or networkHosts do not match the manifest.");
  }

  const paths = await listTree(request, repository, submission.sourceRevision, token || null);
  if (!paths.some((path) => DOC_FILE.test(path))) errors.push("Repository needs a README or build document.");
  if (submission.apiVersion) {
    const sourcePaths = paths.filter((path) => SOURCE_FILE.test(path) && path !== "main.js" && path !== "styles.css");
    if (sourcePaths.length === 0) errors.push("Repository needs human-readable source besides the packaged main.js.");
    if (candidate.mainAsset) {
      warnings.push(...scanPluginScript(candidate.mainAsset.text).map((warning) => `static scan ${warning.id} at line ${warning.line}`));
    }
  }

  if (requireSubmissionAuth && !admittedUnchanged) {
    const access = await confirmWriteAccess(request, repository, {
      author: prAuthor,
      token: token || null,
      prUrl,
      revision: submission.sourceRevision,
    });
    if (!access) errors.push("Submitter write access was not confirmed. Add .edgeever/marketplace-claim containing the pull request URL.");
  }

  return { ok: errors.length === 0, errors, warnings };
};

export const readBaselineSubmission = (baselineRef, file) => {
  if (!baselineRef) return null;
  try {
    const text = execFileSync("git", ["show", `${baselineRef}:${file}`], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const readArgs = (argv) => {
  const options = { files: [], prUrl: "", prAuthor: "", requireSubmissionAuth: false, baselineRef: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--pr-url") options.prUrl = argv[++index] ?? "";
    else if (arg === "--pr-author") options.prAuthor = argv[++index] ?? "";
    else if (arg === "--baseline-ref") options.baselineRef = argv[++index] ?? "";
    else if (arg === "--require-submission-auth") options.requireSubmissionAuth = true;
    else options.files.push(arg);
  }
  return options;
};

if (import.meta.main) {
  const options = readArgs(process.argv.slice(2));
  if (options.files.length === 0) {
    console.error("Usage: bun scripts/verify-plugin.mjs plugins/<id>.json [--require-submission-auth --pr-url URL --pr-author login --baseline-ref REF]");
    process.exit(2);
  }
  let failed = false;
  for (const file of options.files) {
    const submission = JSON.parse(readFileSync(file, "utf8"));
    const previous = readBaselineSubmission(options.baselineRef, file);
    const result = await verifySubmission(submission, { ...options, previous });
    console.log(JSON.stringify({ file, ...result }, null, 2));
    if (!result.ok) failed = true;
  }
  if (failed) process.exit(1);
}
