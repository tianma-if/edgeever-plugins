# EdgeEver 社区插件

**简体中文** | [English](README.md)

这个仓库收录 EdgeEver 的社区插件。它不托管插件代码。每条记录指向开发者自己的 GitHub Release，签名目录只保存这些文件的校验和。

EdgeEver 官方插件仍在 [tianma-if/edgeever](https://github.com/tianma-if/edgeever) 的 `apps/web/public/extensions/registry.json`。不要在这里添加 `org.edgeever.*` 或 `publisher`。

## 提交插件

端内向导可用之前，提交方式是 Pull Request。

1. 发布一个公开的 GitHub Release，其中包含 `manifest.json`。插件还要有 `main.js`。主题不需要 `main.js`。如果要钉住可选的 `styles.css`，写入它的校验和。
2. 新增 `plugins/<id>.json`。文件名必须是插件 ID。字段见下方示例。
3. 在本地运行与 CI 相同的检查：

   ```bash
   bash scripts/vendor-plugin-api.sh
   bun install
   bun scripts/verify-plugin.mjs plugins/<id>.json
   ```

4. 提交一个只新增该文件的 Pull Request。CI 按文件里的 `repositoryUrl` 重新拉取，不采信 PR 描述里的其他地址。
5. 提交人必须对源仓库有写权限。CI 用 GitHub API 核对。API 无法确认时，待收录的 Commit 上要有 `.edgeever/marketplace-claim`，内容是该 PR 的完整 URL。

机械检查确认仓库公开、许可证是 OSI 认可的 SPDX 标识、仓库里有可读源码和构建说明、Release 标签指向不可变 Commit，以及校验和一致。它不证明 `main.js` 由该 Commit 编译而来。对 `eval`、`new Function` 和远程脚本加载的静态扫描只供审核者查看，不单独阻断合并。“已收录”表示这些检查通过，不是安全保证。

`published-ids.json` 只增不减。下架时把 `status` 改为 `revoked`，并写上 `reason` 和 `revokedAt`。文件保留。删除已发布的插件文件会使发布失败。

## 更新

定时任务发现已收录仓库发布了更高版本后，会开一个 Pull Request。机器人只能修改版本、Release 标签、Commit SHA 和校验和。只有仓库所有者和仓库名、插件 ID、许可证、API 版本都没变，且新 Manifest 的权限和 `networkHosts` 没有超出 `admitted` 时才自动合并。机器人不会修改 `admitted`。

## 发布目录

`tianma-if/edgeever-plugins` 的 `main` 每次推送后，发布流程生成 `community-registry.json` 和 `community-registry.json.sig`，并上传到名为 `community-registry` 的 GitHub Release。Ed25519 私钥只放在 Actions secret `EDGE_EVER_COMMUNITY_REGISTRY_SIGNING_KEY`，不进入本仓库。对应的公钥内置在 EdgeEver 客户端中（`vkaOJCCApTIzFvkDRGguUW+hg7tK7oF9WsWoNfUbB8g=`）。

这个 Release 是产物。运维者把这两个文件复制到 EdgeEver 实例环境变量 `EDGE_EVER_COMMUNITY_REGISTRY_URL` 指向的 HTTPS 主机，并用 `Cache-Control: max-age=60` 提供。签名地址是目录地址加上 `.sig`。不设置该变量时，市场只显示内置官方插件。不要把变量指到一个还没有提供这两个文件的主机。

## 列表示例

```json
{
  "id": "com.example.readwise",
  "name": "Readwise",
  "description": "把 Readwise 标注导入笔记。",
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

主题使用 `themeApiVersion`，不要写 `apiVersion`，也可以不写 `main.js` 校验和。
