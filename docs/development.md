# 开发、CI 与发布

[返回主页](../README.md) · [更新记录](../CHANGELOG.md)

## 本地开发

Node.js >=22.19.0；打包与归档校验使用 Python >=3.9 标准库。

```sh
node scripts/check.mjs
node scripts/build.mjs
node --test test/*.test.mjs
python -m unittest discover -s test -p 'test_*.py'
python scripts/pack.py --output-dir release-artifacts
python scripts/verify-package.py release-artifacts
```

`lib/` 为生成目录（`scripts/build.mjs` 先清空再复制 `src/` 下全部 `.mjs` 与 `.json`，并把 `client.js` 与 `remote.mjs` 合并成浏览器 bundle），不提交到仓库；CI 在打包前先构建。`check.mjs` 校验语法、manifest、locale、Client 边界与 `src/` 相对导入闭包；`verify-package.py` 校验 tarball 身份、校验和、必要文件、manifest 入口与归档内 `lib/*.mjs` 相对导入闭包。

打包产出 `.tgz` 与同名 `.tgz.sha256`；同名文件已存在时 `pack.py` 会报错，可换用新的输出目录。

## CI 流程

[工作流](../.github/workflows/ci.yml) 包含四步：**检查 → 打包 → npm 发布 → GitHub Release**。

| 触发 | 测试 / 构建 / 打包 | npm 与 Release |
|---|---|---|
| 推送 `main` | 执行 | 跳过 |
| Pull Request | 执行 | 跳过 |
| 手动运行 | 执行 | 跳过 |
| 推送 `v*` 标签 | 执行 | 检查通过后执行 |

检查矩阵为 Ubuntu / Windows × Node 22.19.0 / 24；单元测试使用替身，不安装依赖、不执行包生命周期脚本、不接触真实账号。打包任务使用 Python 3.12 生成并校验归档，上传 `plugin-package` artifact 保留 14 天。

标签发布复用同一次运行已验证的归档。npm job 使用 GitHub OIDC 短期身份（`id-token: write`），发布前精确核对 registry 中该版本是否存在（HTTP 200 跳过、404 才发布）；Release job 单独获取 `contents: write`。其余 job 只读，官方 Actions 固定到 commit SHA。

## npm Trusted Publisher

包设置中的信任字段必须与工作流精确一致：

| 字段 | 值 |
|---|---|
| GitHub owner | `KouzakiUmi` |
| Repository | `dsh-devin-provider` |
| Workflow filename | `ci.yml` |
| Environment | 留空 |
| Allowed action | 允许直接 `npm publish` |

npm 默认的 staged publishing 与直接发布权限不同，需选择允许直接发布。使用 npm >=11.15.0 时也可执行：

```sh
npm trust github dsh-devin-provider --repo KouzakiUmi/dsh-devin-provider --file ci.yml --allow-publish
npm trust list dsh-devin-provider --json
```

## 首次发布与后续版本

**npm 不支持为尚不存在的包预配置 Trusted Publisher**，OIDC 无法创建全新包。因此 `0.1.1` 由维护者本机完成首次发布：使用 Windows Hello 在 npm 官方网页完成登录确认，然后用已校验的归档发布。

```sh
npm publish ./release-artifacts/dsh-devin-provider-0.1.1.tgz \
  --access public --tag latest --ignore-scripts --registry=https://registry.npmjs.org/
```

首次发布成功后，在 npm 包设置中按上表绑定 Trusted Publisher（要求账号有写权限且启用 2FA）。后续版本只需更新 `package.json` 版本号、提交代码并推送同版本标签：

```sh
git tag -a v<version> -m "Release v<version>"
git push origin v<version>
```

- 普通版本（含 `0.x`）发布到 npm `latest`；带预发行后缀的版本使用 `next`，GitHub Release 标为 prerelease。
- 标签须与包版本一致；已发布版本会被跳过，不会覆盖。
- CI 发布后核对 registry 精确版本；发布成功的版本不可覆盖。

本机 Windows Hello、密码与长期发布 token 留在本机，仓库不保存 npm token。

## 验证边界

工作区内的静态检查、构建产物校验、单元测试与 Core 兼容性探针均通过；真实在线 `server.codeium.com` 推理、浏览器人工界面操作与安装到 DSH Profile 后的实测未包含在本仓库 CI 中，需由维护者实测。
