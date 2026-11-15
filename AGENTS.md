# Devin Provider：项目设计与维护

## 项目目的

为 DeepSeek Harness 提供 Devin 订阅接入（`devin` 路由），参考本机 Magpie 已安装的 `@magpie-community/opencode-devin-auth` 协议与家族折叠实现，并参考 `dsh-volcengine-provider` 提供完整的 DSH 设置页与逐模型参数管理。

## 固定标识

| 用途 | 固定名称 |
|---|---|
| 用户可见名称、设置页标题 | **Devin Provider** |
| npm 包名、插件导出名 | `dsh-devin-provider` |
| RPC 服务 / namespace | `devinProvider` |
| 设置分区 ID | `devin-provider` |
| 模型路由 ID | `devin` |

## 设计要点与实现边界

- **协议桥接**：Host 通过 `PiAiAdapter` 接入 DSH 的附件、图片预算/卸载、文件句柄投影、工具更新与回放状态，并在自定义 `piProvider` 中调用 `streamDevinChat` 将 pi-ai `Context` 转为 Windsurf/Devin 的 Connect+Proto `GetChatMessage` 请求（> 8 KiB 自动 gzip 压缩）；Claude 思考签名经 `thinkingSignature` 与 `sigTypes` 往返透传，非 Claude 模型保留无签名思考以维持多轮工具思考连贯性。
- **家族折叠与思考档位映射**：沿用 `opencode-devin-auth` 的家族折叠策略，将 Devin `none` 档位对齐 DSH Core 的 `off`（`thinkingLevelMap.off = 'none'`），缺失档位显式置 `null` 以便 `dsh-llm-pi-ai` 的 `getSupportedThinkingLevels` 准确过滤；`variantFor` 在调用时将 DSH 选定档位解析为精确的 Devin 变体 ID。
- **凭据安全边界**：`state.json` 仅保存非密钥账号元数据、模型目录缓存、逐模型覆盖与保活配置；浏览器 PKCE 与手动输入的 API Key/Token 写入 `ctx.credentials.modifyRecord(credentialKey('dsh-devin-provider', accountId), ...)`（无 `credentials` 服务时回退到受限目录 `0o600` 文件）；`cli` 模式只读 `devin` CLI 的 `credentials.toml`；`reference` 模式通过 `ctx.credentials.resolve` / `launchEnvironmentOf` 按次解析。
- **Client 隔离**：`src/client.js` 与 `src/remote.mjs` 构建合并为浏览器 `window.__ModuleLoader__.load` 工厂，禁止任何 Node 内置模块依赖；样式使用 `.ddp-*` 前缀并随实例销毁回收。
- **验证边界**：在工作区内通过静态语法与导入闭包检查、构建产物校验、单元测试（Protobuf/Connect 帧、家族折叠与覆盖、缓存保活、状态锁与控制器、PKCE 回调、Client 替身冒烟）以及运行时 Core 兼容性探针；真实在线 `server.codeium.com` 端到端推理与浏览器人工界面操作需在安装到 DSH Profile 后由用户实测。

## 仓库、CI 与发布

- 仓库：`KouzakiUmi/dsh-devin-provider`，`main` 分支；`lib/` 为生成产物不提交，`.gitignore` 排除构建产物、缓存与本地 tarball。
- CI：`ci.yml` 为检查（Ubuntu/Windows × Node 22.19.0/24）→ 打包校验 → npm 发布 → GitHub Release 四段；标签发布复用同一次运行已验证的归档。详细流程见[开发与发布](docs/development.md)。
- 打包：`scripts/pack.py` 按 `package.json` 的 `files` 生成 tarball 与 SHA256；`scripts/verify-package.py` 校验身份、校验和、必要文件、manifest 入口与归档内 `lib/*.mjs` 相对导入闭包。
- 发布：npm Trusted Publisher 绑定在 `ci.yml`（owner `KouzakiUmi`、workflow 文件名 `ci.yml`、environment 留空、允许直接发布）。npm 不支持为尚不存在的包预配置信任，故 `0.1.1` 由维护者本机首次发布（npm 网页 Windows Hello 登录），后续 `v*` 标签由 CI 通过 OIDC 发布；普通版本用 `latest`，预发行版本用 `next`。
- 提交使用账号已验证的 SSH 签名；发布前核验 GitHub 的 Verified 判定。

## 0.1.1 发布前审查修复

独立只读审查未发现阻断发布问题（关键 DSH 契约已对照宿主 Core 核实，`lib/client.js` 与源码合并结果逐字节一致）。发布前修复：

- 凭据回退目录的账号 ID 在任何读写前经 `assertAccountId` 校验，避免路径穿越；`saveAccount` 中 `server` 先经 `normalizeServerUrl` 再写入凭据，读取已存 grant 时也做安全规范化。
- 设置变更后 `onChange()` 失败不再让已保存的操作误报失败；路由刷新异常保留原始错误为 `cause`，且不覆盖已有路由错误。
- 流式消费提前结束时关闭底层帧生成器，释放 `ReadableStream` reader 锁。
- 卸载时清理思考签名与 Gemini thought 模块级缓存；PKCE 令牌交换的超时与取消信号联动；CLI `api_server_url` 未经校验的值回退默认服务地址。
- `scripts/check.mjs` 的 Client 边界检查覆盖 `src/remote.mjs` 与构建产物 `lib/client.js`。
