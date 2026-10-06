# EdgeEver community plugins

[简体中文](README.zh-CN.md) | **English**

This repository lists community plugins for EdgeEver. It does not host plugin code. Each listing points at a developer's GitHub release, and the signed catalog only records the checksums of those release files.

Official EdgeEver plugins stay in [tianma-if/edgeever](https://github.com/tianma-if/edgeever) (`apps/web/public/extensions/registry.json`). Do not add `org.edgeever.*` or `publisher` here.

## Submit a plugin

Before the in-app wizard is available, submission is a pull request.

1. Publish a public GitHub release that contains `manifest.json` and, for a plugin, `main.js`. A theme does not need `main.js`. Optional `styles.css` is pinned when you include its checksum.
2. Add `plugins/<id>.json`. The filename is the plugin id. Use the example at the bottom of this file.
3. Run the same check CI runs:

   ```bash
   bash scripts/vendor-plugin-api.sh
   bun install
   bun scripts/verify-plugin.mjs plugins/<id>.json
   ```

4. Open a pull request that only adds that file. CI fetches the `repositoryUrl` in the file. It does not trust the pull request description.
5. You need write access to the source repository. CI checks that with the GitHub API. If the API cannot see it, put the full pull request URL in `.edgeever/marketplace-claim` on the admitted commit.

The mechanical check confirms a public repository, an OSI SPDX license, readable source and a build note, an immutable release tag, and checksums. It does not prove that `main.js` was built from that commit. A static scan for `eval`, `new Function`, and remote script loads is a review signal. It does not block the merge by itself. “Admitted” means those checks passed. It is not a safety guarantee.

`published-ids.json` only grows. Revoke a plugin by setting `status` to `revoked` and adding `reason` and `revokedAt`. Keep the file. Deleting a published plugin file fails the publish job.

## Updates

A scheduled job opens a pull request when an admitted repository publishes a newer release. The bot may change the version, release tag, commit SHA, and checksums. It auto-merges only when the owner, repository, id, license, and API version are unchanged and the new manifest does not add permissions or network hosts beyond `admitted`. The bot never edits `admitted`.

## Publishing the catalog

On each push to `main` of `tianma-if/edgeever-plugins`, the publish workflow writes `community-registry.json` and `community-registry.json.sig`, then uploads both to the `community-registry` GitHub release. The private Ed25519 key is the Actions secret `EDGE_EVER_COMMUNITY_REGISTRY_SIGNING_KEY`. It is not stored in this repository. The matching public key is embedded in the EdgeEver client (`vkaOJCCApTIzFvkDRGguUW+hg7tK7oF9WsWoNfUbB8g=`).

The release is the artifact. An operator copies the two files to the HTTPS host named by the EdgeEver instance setting `EDGE_EVER_COMMUNITY_REGISTRY_URL` and serves them with `Cache-Control: max-age=60`. The signature URL is the registry URL plus `.sig`. Leave that setting unset to show only the built-in official plugins. Do not point it at a host that is not serving these two files.

## Example listing

```json
{
  "id": "com.example.readwise",
  "name": "Readwise",
  "description": "Imports Readwise highlights into notes.",
  "author": "Example",
  "category": "Import",
  "repositoryUrl": "https://github.com/example/readwise",
  "licenseSpdx": "MIT",
  "sourceRevision": "0123456789abcdef0123456789abcdef01234567",
  "releaseTag": "v1.2.0",
  "apiVersion": "2",
  "verification": {
    "version": "1.2.0",
    "checksums": {
      "manifestJson": "<sha256>",
      "mainJs": "<sha256>"
    }
  },
  "admitted": {
    "permissions": ["notes:write"],
    "networkHosts": ["readwise.io"]
  }
}
```

Use `themeApiVersion` instead of `apiVersion` for a theme, and omit the `main.js` checksum.
