import { generateKeyPairSync, verify as verifySignature } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { assertPublishedIdsAppendOnly, compileRegistry } from "./compile-registry.mjs";
import { planReleaseRefresh } from "./refresh-releases.mjs";
import { sha256Hex } from "./registry-lib.mjs";
import { signRegistryBytes } from "./sign-registry.mjs";
import { verifySubmission } from "./verify-plugin.mjs";

process.env.EDGEEVER_PLUGIN_API = new URL("../vendor/edgeever/packages/plugin-api/src/index.ts", import.meta.url).href;

const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const TAG = "v1.2.0";

const manifestFor = (overrides = {}) => ({
  type: "plugin",
  id: "com.example.readwise",
  name: "Readwise",
  version: "1.2.0",
  apiVersion: "2",
  settingsUi: "host",
  entry: "main.js",
  permissions: ["notes:write"],
  networkHosts: ["readwise.io"],
  ...overrides,
});

const submissionFor = (manifest, assets, overrides = {}) => ({
  id: manifest.id,
  name: manifest.name,
  description: "Imports highlights into notes.",
  author: "Example",
  category: "Import",
  repositoryUrl: "https://github.com/example/readwise",
  licenseSpdx: "MIT",
  sourceRevision: COMMIT,
  releaseTag: TAG,
  apiVersion: "2",
  verification: {
    version: manifest.version,
    checksums: {
      manifestJson: sha256Hex(assets.manifest),
      mainJs: sha256Hex(assets.main),
    },
  },
  admitted: {
    permissions: manifest.permissions,
    networkHosts: manifest.networkHosts,
  },
  ...overrides,
});

const jsonResponse = (body, status = 200, headers = {}) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json", ...headers },
});

const textResponse = (body, status = 200) => new Response(body, { status });

const createFixture = ({ manifest = manifestFor(), main = "export {}", license = "MIT" } = {}) => {
  const manifestText = `${JSON.stringify(manifest)}\n`;
  const assets = { manifest: new TextEncoder().encode(manifestText), main: new TextEncoder().encode(main) };
  return { manifest, manifestText, main, assets, submission: submissionFor(manifest, assets) };
};

const routeGithub = (fixture, { visibility = 200, requests = [] } = {}) => async (url, init = {}) => {
  requests.push({ url, authorization: init.headers?.Authorization ?? init.headers?.authorization ?? "" });
  const parsed = new URL(url);
  if (parsed.hostname === "api.github.com" && parsed.pathname === "/repos/example/readwise") {
    return jsonResponse({ private: false }, visibility);
  }
  if (parsed.pathname === `/repos/example/readwise/git/ref/tags/${encodeURIComponent(fixture.tag ?? TAG)}`) {
    return jsonResponse({ object: { type: "commit", sha: COMMIT } });
  }
  if (parsed.pathname === "/repos/example/readwise/license") {
    return jsonResponse({ license: { spdx_id: fixture.license ?? "MIT" } });
  }
  if (parsed.pathname === `/repos/example/readwise/git/trees/${COMMIT}`) {
    return jsonResponse({ tree: [{ path: "README.md" }, { path: "src/index.ts" }] });
  }
  if (parsed.pathname === "/repos/example/readwise/releases/latest") {
    return jsonResponse({ tag_name: fixture.latestTag ?? TAG });
  }
  if (url.endsWith("/manifest.json")) return textResponse(fixture.manifestText ?? fixture.manifestByTag?.[fixture.tag]?.manifestText);
  if (url.endsWith("/main.js")) return textResponse(fixture.main ?? fixture.manifestByTag?.[fixture.tag]?.main);
  if (url.endsWith("/styles.css")) return textResponse("", 404);
  return textResponse("missing", 404);
};

describe("verify-plugin", () => {
  test("accepts a public release whose checksums match", async () => {
    const fixture = createFixture();
    const requests = [];
    const result = await verifySubmission(fixture.submission, { request: routeGithub(fixture, { requests }), token: "" });
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    const visibility = requests.find((request) => request.url.endsWith("/repos/example/readwise"));
    expect(visibility.authorization).toBe("");
  });

  test("rejects a private repository without using a token", async () => {
    const fixture = createFixture();
    const requests = [];
    const result = await verifySubmission(fixture.submission, {
      request: routeGithub(fixture, { visibility: 404, requests }),
      token: "should-not-be-sent",
    });
    expect(result.ok).toBe(false);
    expect(result.errors[0]).toContain("HTTP 404");
    expect(requests).toHaveLength(1);
    expect(requests[0].authorization).toBe("");
  });

  test("rejects a reserved id and a publisher before any request", async () => {
    const fixture = createFixture();
    let called = false;
    const request = async () => {
      called = true;
      return textResponse("no", 500);
    };
    const reserved = await verifySubmission({ ...fixture.submission, id: "org.edgeever.tasks" }, { request });
    const published = await verifySubmission({ ...fixture.submission, publisher: "edgeever" }, { request });
    expect(reserved.ok).toBe(false);
    expect(published.ok).toBe(false);
    expect(published.errors.join(" ")).toContain("publisher");
    expect(called).toBe(false);
  });

  test("keeps a static scan warning from failing the submission", async () => {
    const fixture = createFixture({ main: "export const run = () => eval('1')\n" });
    const result = await verifySubmission(fixture.submission, { request: routeGithub(fixture), token: "" });
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toContain("static scan eval");
  });

  test("does not contact upstream for a revoked plugin", async () => {
    let called = false;
    const result = await verifySubmission({
      id: "com.example.old",
      status: "revoked",
      reason: "仓库已转为私有",
      revokedAt: "2026-10-05T00:00:00.000Z",
    }, {
      request: async () => {
        called = true;
        return textResponse("no", 500);
      },
    });
    expect(result).toMatchObject({ ok: true, revoked: true });
    expect(called).toBe(false);
  });
});

describe("compile-registry", () => {
  test("moves revoked plugins out of entries and keeps their ids", async () => {
    const fixture = createFixture();
    const compiled = compileRegistry({
      files: [
        { name: "com.example.readwise.json", text: JSON.stringify(fixture.submission) },
        {
          name: "com.example.old.json",
          text: JSON.stringify({
            id: "com.example.old",
            status: "revoked",
            reason: "仓库已转为私有",
            revokedAt: "2026-10-05T00:00:00.000Z",
          }),
        },
      ],
      historyIds: ["com.example.old"],
      updatedAt: "2026-10-06T00:00:00.000Z",
    });
    expect(compiled.ok).toBe(true);
    expect(compiled.registry.entries.map((entry) => entry.id)).toEqual(["com.example.readwise"]);
    expect(compiled.registry.entries[0].distribution).toEqual({
      type: "github",
      repositoryUrl: "https://github.com/example/readwise",
    });
    expect(compiled.registry.entries[0].publisher).toBeUndefined();
    expect(compiled.registry.revocations).toEqual([{
      id: "com.example.old",
      reason: "仓库已转为私有",
      revokedAt: "2026-10-05T00:00:00.000Z",
    }]);
    expect(compiled.ids).toEqual(["com.example.old", "com.example.readwise"]);
    const pluginApi = await import(process.env.EDGEEVER_PLUGIN_API);
    expect(pluginApi.parseMarketplaceRegistry(compiled.registry).entries).toHaveLength(1);
  });

  test("fails when a published id no longer has a file", () => {
    const compiled = compileRegistry({
      files: [],
      historyIds: ["com.example.readwise"],
      updatedAt: "2026-10-06T00:00:00.000Z",
    });
    expect(compiled.ok).toBe(false);
    expect(compiled.errors.join(" ")).toContain("com.example.readwise");
  });

  test("rejects a published-ids list that drops an id", () => {
    expect(() => assertPublishedIdsAppendOnly(["com.example.old", "com.example.readwise"], ["com.example.readwise"]))
      .toThrow(/cannot drop com.example.old/);
  });
});

describe("refresh-releases", () => {
  test("updates checksums without editing admitted permissions", async () => {
    const current = createFixture();
    const nextManifest = manifestFor({ version: "1.3.0" });
    const nextText = `${JSON.stringify(nextManifest)}\n`;
    const nextMain = "export const version = 2\n";
    const requests = [];
    const request = async (url, init) => {
      requests.push(url);
      if (url.endsWith("/releases/latest")) return jsonResponse({ tag_name: "v1.3.0" });
      if (url.includes("/git/ref/tags/v1.3.0")) return jsonResponse({ object: { type: "commit", sha: COMMIT } });
      if (url.endsWith("/manifest.json")) return textResponse(nextText);
      if (url.endsWith("/main.js")) return textResponse(nextMain);
      return routeGithub(current)(url, init);
    };
    const plan = await planReleaseRefresh([current.submission], { request, token: "" });
    const update = plan.updates.find((item) => item.id === current.submission.id);
    expect(update.action).toBe("auto");
    expect(plan.eligibleForAutoMerge).toBe(true);
    expect(update.next.admitted).toEqual(current.submission.admitted);
    expect(update.next.verification.version).toBe("1.3.0");
    expect(update.next.licenseSpdx).toBe(current.submission.licenseSpdx);
    expect(update.next.repositoryUrl).toBe(current.submission.repositoryUrl);
  });

  test("asks for review when a release adds a permission and leaves admitted unchanged", async () => {
    const current = createFixture();
    const nextManifest = manifestFor({ version: "1.3.0", permissions: ["notes:write", "notes:delete"] });
    const nextText = `${JSON.stringify(nextManifest)}\n`;
    const request = async (url, init) => {
      if (url.endsWith("/releases/latest")) return jsonResponse({ tag_name: "v1.3.0" });
      if (url.includes("/git/ref/tags/v1.3.0")) return jsonResponse({ object: { type: "commit", sha: COMMIT } });
      if (url.endsWith("/manifest.json")) return textResponse(nextText);
      if (url.endsWith("/main.js")) return textResponse("export {}\n");
      return routeGithub(current)(url, init);
    };
    const plan = await planReleaseRefresh([current.submission], { request, token: "" });
    const update = plan.updates[0];
    expect(update.action).toBe("review");
    expect(plan.eligibleForAutoMerge).toBe(false);
    expect(update.next.admitted).toEqual(current.submission.admitted);
    expect(update.errors.join(" ")).toContain("exceed the admitted snapshot");
  });
});

describe("sign-registry", () => {
  test("signs the exact registry bytes", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const bytes = Buffer.from('{"registryVersion":"1"}\n');
    const signature = Buffer.from(signRegistryBytes(bytes, pem), "base64");
    expect(signature).toHaveLength(64);
    expect(verifySignature(null, bytes, publicKey, signature)).toBe(true);
    const directory = mkdtempSync(join(tmpdir(), "edgeever-plugins-"));
    writeFileSync(join(directory, "registry.json"), bytes);
    expect(readFileSync(join(directory, "registry.json")).equals(bytes)).toBe(true);
  });
});
