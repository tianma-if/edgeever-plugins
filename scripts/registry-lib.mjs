import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export const ID_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)+$/;
export const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
export const SHA256_PATTERN = /^[0-9a-f]{64}$/;
export const REPOSITORY_PATTERN = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)\/?$/i;
export const ASSET_LIMITS = {
  "manifest.json": 256 * 1024,
  "main.js": 5 * 1024 * 1024,
  "styles.css": 1024 * 1024,
};

const LICENSE_ALIASES = {
  "AGPL-3.0": "AGPL-3.0-only",
  "GPL-2.0": "GPL-2.0-only",
  "GPL-3.0": "GPL-3.0-only",
  "LGPL-2.1": "LGPL-2.1-only",
  "LGPL-3.0": "LGPL-3.0-only",
};

const OSI_IDS = new Set(JSON.parse(readFileSync(new URL("./osi-spdx-ids.json", import.meta.url), "utf8")));

const LICENSE_FINGERPRINTS = [
  ["MIT", "permission is hereby granted, free of charge"],
  ["Apache-2.0", "apache license"],
  ["BSD-3-Clause", "neither the name of the copyright holder"],
  ["BSD-2-Clause", "redistribution and use in source and binary forms"],
  ["ISC", "permission to use, copy, modify, and/or distribute this software"],
  ["MPL-2.0", "mozilla public license, version 2.0"],
  ["GPL-3.0-only", "gnu general public license"],
  ["AGPL-3.0-only", "gnu affero general public license"],
  ["Unlicense", "this is free and unencumbered software released into the public domain"],
  ["0BSD", "permission to use, copy, modify, and/or distribute this software for any purpose"],
];

export const isReservedPluginId = (id) => id === "org.edgeever" || id.startsWith("org.edgeever.");

export const canonicalLicense = (value) => LICENSE_ALIASES[value] ?? value;

export const licensesMatch = (left, right) => canonicalLicense(left) === canonicalLicense(right);

export const isOsiLicense = (value) => OSI_IDS.has(value) || OSI_IDS.has(canonicalLicense(value));

export const parseRepositoryUrl = (value) => {
  const match = REPOSITORY_PATTERN.exec(String(value ?? "").trim());
  if (!match) return null;
  return {
    owner: match[1],
    repo: match[2].replace(/\.git$/i, ""),
    repositoryUrl: `https://github.com/${match[1]}/${match[2].replace(/\.git$/i, "")}`,
  };
};

export const sha256Hex = (bytes) => createHash("sha256").update(bytes).digest("hex");

export const compareVersions = (left, right) => {
  const parse = (value) => String(value).split("-")[0].split(".").map((part) => Number(part));
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

export const stableRegistryJson = (value) => `${JSON.stringify(value, null, 2)}\n`;

export const sameStringSet = (left, right) => {
  const a = [...new Set(left ?? [])].sort();
  const b = [...new Set(right ?? [])].sort();
  return a.length === b.length && a.every((item, index) => item === b[index]);
};

export const isSubset = (next, admitted) => {
  const allowed = new Set(admitted ?? []);
  return [...new Set(next ?? [])].every((item) => allowed.has(item));
};

export const sameIdentity = (previous, submission) => {
  if (!previous || previous.id !== submission.id) return false;
  const before = parseRepositoryUrl(previous.repositoryUrl);
  const after = parseRepositoryUrl(submission.repositoryUrl);
  if (!before || !after) return false;
  if (before.owner.toLocaleLowerCase() !== after.owner.toLocaleLowerCase()) return false;
  if (before.repo.toLocaleLowerCase() !== after.repo.toLocaleLowerCase()) return false;
  if (!licensesMatch(previous.licenseSpdx ?? "", submission.licenseSpdx ?? "")) return false;
  if ((previous.apiVersion ?? "") !== (submission.apiVersion ?? "")) return false;
  if ((previous.themeApiVersion ?? "") !== (submission.themeApiVersion ?? "")) return false;
  return sameStringSet(previous.admitted?.permissions, submission.admitted?.permissions)
    && sameStringSet(previous.admitted?.networkHosts, submission.admitted?.networkHosts);
};

export const scanPluginScript = (source) => {
  const rules = [
    ["eval", /\beval\s*\(/g],
    ["function-constructor", /\bnew\s+Function\s*\(/g],
    ["remote-import", /\bimport\s*\(\s*['"]https?:/g],
    ["script-element", /createElement\s*\(\s*['"]script['"]\s*\)/g],
  ];
  const warnings = [];
  const lines = String(source).split(/\r?\n/);
  for (const [id, pattern] of rules) {
    lines.forEach((line, index) => {
      if (pattern.test(line)) warnings.push({ id, line: index + 1, text: line.trim().slice(0, 180) });
      pattern.lastIndex = 0;
    });
  }
  return warnings;
};

export const identifyLicenseText = (text) => {
  const tagged = String(text).match(/SPDX-License-Identifier:\s*([A-Za-z0-9.+-]+)/);
  if (tagged && isOsiLicense(tagged[1])) return canonicalLicense(tagged[1]);
  const normalized = String(text).toLocaleLowerCase().replace(/\s+/g, " ");
  if (normalized.includes("gnu affero general public license")) return "AGPL-3.0-only";
  if (normalized.includes("gnu general public license") && normalized.includes("version 3")) return "GPL-3.0-only";
  const match = LICENSE_FINGERPRINTS.find(([, needle]) => normalized.includes(needle));
  return match?.[0] ?? null;
};

const githubHeaders = (token, accept = "application/vnd.github+json") => ({
  Accept: accept,
  "User-Agent": "edgeever-plugins",
  "X-GitHub-Api-Version": "2022-11-28",
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
});

export const githubGet = async (request, url, { token, accept } = {}) => {
  const response = await request(url, { headers: githubHeaders(token, accept), redirect: "follow" });
  return response;
};

export const readJsonBody = async (response) => {
  if (!response.ok) throw new Error(`GitHub request failed with HTTP ${response.status}.`);
  return response.json();
};

export async function loadPluginApi() {
  const specifier = process.env.EDGEEVER_PLUGIN_API ?? "@edgeever/plugin-api";
  return import(specifier);
}

export const assertSubmissionShape = (submission, { allowRevokedShortcut = false } = {}) => {
  const errors = [];
  if (!submission || typeof submission !== "object" || Array.isArray(submission)) {
    return ["Submission must be a JSON object."];
  }
  if (Object.prototype.hasOwnProperty.call(submission, "publisher")) {
    errors.push("Community submissions cannot set publisher.");
  }
  if (typeof submission.id !== "string" || !ID_PATTERN.test(submission.id)) errors.push("Plugin id is invalid.");
  if (typeof submission.id === "string" && isReservedPluginId(submission.id)) {
    errors.push("org.edgeever is reserved for official plugins.");
  }
  const revoked = submission.status === "revoked";
  if (submission.status !== undefined && submission.status !== "active" && submission.status !== "revoked") {
    errors.push("status must be active or revoked.");
  }
  if (revoked) {
    if (typeof submission.reason !== "string" || !submission.reason.trim()) errors.push("A revoked plugin needs a reason.");
    if (typeof submission.revokedAt !== "string" || Number.isNaN(Date.parse(submission.revokedAt))) {
      errors.push("A revoked plugin needs an ISO revokedAt.");
    }
    if (allowRevokedShortcut) return errors;
  }
  for (const field of ["name", "description", "author", "category", "repositoryUrl", "licenseSpdx", "releaseTag"]) {
    if (typeof submission[field] !== "string" || !submission[field].trim()) errors.push(`${field} is required.`);
  }
  if (!parseRepositoryUrl(submission.repositoryUrl)) errors.push("repositoryUrl must be a GitHub repository.");
  if (typeof submission.sourceRevision !== "string" || !COMMIT_PATTERN.test(submission.sourceRevision)) {
    errors.push("sourceRevision must be a 40-character commit SHA.");
  }
  if (!isOsiLicense(submission.licenseSpdx)) errors.push("licenseSpdx must be an OSI-approved SPDX identifier.");
  const verification = submission.verification;
  if (!verification || typeof verification.version !== "string" || !verification.checksums?.manifestJson) {
    errors.push("verification must pin a version and manifest.json checksum.");
  } else if (!SHA256_PATTERN.test(verification.checksums.manifestJson)) {
    errors.push("manifestJson checksum must be SHA-256.");
  }
  for (const name of ["mainJs", "stylesCss"]) {
    const value = verification?.checksums?.[name];
    if (value !== undefined && !SHA256_PATTERN.test(value)) errors.push(`${name} checksum must be SHA-256.`);
  }
  if (!submission.admitted || !Array.isArray(submission.admitted.permissions) || !Array.isArray(submission.admitted.networkHosts)) {
    errors.push("admitted must record permissions and networkHosts.");
  }
  const pluginApi = submission.apiVersion;
  const themeApi = submission.themeApiVersion;
  if (Boolean(pluginApi) === Boolean(themeApi)) errors.push("Set exactly one of apiVersion or themeApiVersion.");
  return errors;
};

export const compiledEntry = (submission) => {
  const repository = parseRepositoryUrl(submission.repositoryUrl);
  return {
    id: submission.id,
    name: submission.name.trim(),
    description: submission.description.trim(),
    ...(submission.locales ? { locales: submission.locales } : {}),
    author: submission.author.trim(),
    category: submission.category.trim(),
    repositoryUrl: repository.repositoryUrl,
    distribution: { type: "github", repositoryUrl: repository.repositoryUrl },
    verification: {
      version: submission.verification.version,
      checksums: Object.fromEntries(
        ["manifestJson", "mainJs", "stylesCss"]
          .filter((key) => submission.verification.checksums[key])
          .map((key) => [key, submission.verification.checksums[key]]),
      ),
    },
    licenseSpdx: canonicalLicense(submission.licenseSpdx),
    sourceRevision: submission.sourceRevision.toLocaleLowerCase(),
    ...(submission.apiVersion ? { apiVersion: submission.apiVersion } : {}),
    ...(submission.themeApiVersion ? { themeApiVersion: submission.themeApiVersion } : {}),
    admitted: {
      permissions: [...submission.admitted.permissions],
      networkHosts: [...submission.admitted.networkHosts],
    },
  };
};

export const compiledRevocation = (submission) => ({
  id: submission.id,
  reason: submission.reason.trim(),
  revokedAt: submission.revokedAt,
});
