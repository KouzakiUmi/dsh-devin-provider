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
- 发布：npm Trusted Publisher 绑定在 `ci.yml`（owner `KouzakiUmi`、workflow 文件名 `ci.yml`、environment 留空、允许直接发布）。npm 12 的 `createPackage` 权限允许为尚不存在的包绑定信任并完成首次 OIDC 发布，`0.1.1` 与 `0.1.2` 均由 CI 发布；普通版本用 `latest`，预发行版本用 `next`。
- 参考实现与许可：协议与家族折叠策略参考 `@magpie-community/opencode-devin-auth`（MIT），设置页与发布结构参考 `dsh-volcengine-provider`，说明见 `NOTICE`。
- 提交使用账号已验证的 SSH 签名；发布前核验 GitHub 的 Verified 判定。

## 0.1.1 发布前审查修复

独立只读审查未发现阻断发布问题（关键 DSH 契约已对照宿主 Core 核实，`lib/client.js` 与源码合并结果逐字节一致）。发布前修复：

- 凭据回退目录的账号 ID 在任何读写前经 `assertAccountId` 校验，避免路径穿越；`saveAccount` 中 `server` 先经 `normalizeServerUrl` 再写入凭据，读取已存 grant 时也做安全规范化。
- 设置变更后 `onChange()` 失败不再让已保存的操作误报失败；路由刷新异常保留原始错误为 `cause`，且不覆盖已有路由错误。
- 流式消费提前结束时关闭底层帧生成器，释放 `ReadableStream` reader 锁。
- 卸载时清理思考签名与 Gemini thought 模块级缓存；PKCE 令牌交换的超时与取消信号联动；CLI `api_server_url` 未经校验的值回退默认服务地址。
- `scripts/check.mjs` 的 Client 边界检查覆盖 `src/remote.mjs` 与构建产物 `lib/client.js`。

## 0.1.2 变更

- 保存 API Key 时弱校验结果（网络失败无法在线核验）记录为 `identityVerified: false`，设置页显示「凭据未验证」提示。
- `refreshAdapters` 用模型路由指纹比较，无关设置变更不再重建适配器；路由错误文案更新为最新具体原因。
- 设置页额度每 60 秒自动刷新；错误提示中文化；自定义服务地址字段说明凭据会发送到该地址；混合免费/收费的模型家族显示对应标记。
- 声明 `engines.dsh`，安装器对不兼容 Core 拒绝安装；CI 检查任务改为先构建再检查；`verify-package.py` 开发机路径校验覆盖无尾分隔符形式。
- 文档修正首次发布说明（`createPackage` + OIDC），README 与开发文档改为事实陈述。

## Fusion 支持与读缓存中间层

### Fusion（lead + sidekick 路由家族）
- **协议（Devin CLI 3000.15.14）**：Lead 用 `AssignModel` field 2=组合 UID、3=cascadeId、5=用户轮，`GetChatMessage` 用 field 21=分配模型、16=cascadeId、26=assignmentJwt。CLI 通过本地工具触发 Sidekick：为子会话重新分配，`AssignModel` fields 2/6 均为组合 UID，子会话 `GetChatMessage` 用独立 cascadeId 和返回的精确副模型 UID，不复制 Lead 的 JWT。
- **交接**：`fusion-handoff.mjs` 注册仅向 Fusion Lead 开放的 `devin_sidekick`。用 DSH 本地 `spawn` 启动独立会话，遵循子代理深度与现有工具权限，阻塞等待报告交给 Lead；工具卡、子会话与报告由 DSH 展示。插件不模拟 CLI 的后台交接和历史子会话续跑；Sidekick 绑定只在本次交接期间存在。
- **目录**：`fusion-routes.mjs` 以四元组索引标准 UID 和快速 UID，禁止合成未列出的路由；`catalog.mjs` 将其投影为 `fusion.{config,options,perAccount}` 的配置及选项。`profileFor` 仅在有合法组合时暴露 Fusion，描述符随标准 Lead 变体；适配器按已应用的账号和组合固化一代路由，会话快速开关仍实时读取。默认搭配 Opus 5.5 Medium + SWE-2.1 Medium。
- **缓存**：`op:'models'` 优先 `GetCliModelConfigs`，再用 `devin models list` 补组合。新版缓存按协议版本及服务地址校验，暂时拉不到时复用同版本、同服务的上次结果。没有匹配缓存时，官方服务使用内置的 438 条组合（255 标准、183 快速）与账号目录交集；自定义服务使用自身组合。
- **UI**：设置页与聊天药丸共用依赖式选择器；副模型及档位按当前主模型档位过滤，快速模式只对精确搭配显示。Lead 与 Sidekick 仍分别由 Devin 计费。

### 读缓存中间层（解耦上游拉取与 Client 读取）
- **读路径**：`op:'quota'` 即时返回缓存快照（附 `refreshing`/`stale`），绝不阻塞等上游；无缓存时返回 `state:'loading'` 占位。
- **刷新路径**：`startQuotaRefresh()` 后台拉上游回填缓存（inflight 去重）；`startBackgroundRefresh()` 每 30s 检查活跃账号缓存 TTL（ok 60s / 其它 15s）按需保暖，`dispose` 清理定时器。
- **Client**：`pullQuota` 即时显示缓存，`refreshing` 时 800ms 廉价重读（30s 上限）；60s 轮询改为读缓存不强制上游；`QuotaWindows` 增 loading/刷新中指示。
- Fusion 验收覆盖目录全量精确 UID、档位联动、CLI 补全、Sidekick 分配、子会话报告和取消清理；在线协议与 DSH Core 分别验证。

### 插件审查结论（全模块）
- pb/wire/adapter/index/catalog/state/manager/quota/keepalive/lease/defaults/oauth/cli/client 均已审查：凭据脱敏、accountId/路径穿越防护、PKCE state 校验、回调仅绑 127.0.0.1、HTML 转义、CLI spawn 无注入 + 隔离 home、状态锁 + 原子写齐全，未发现关键缺陷。
- 先前两项疑似问题已定性：Claude「思考+摘要进 CoT」为 Devin 服务端多轮工具上下文行为（签名覆盖整段思考，须原样回放，不可拆分）；SWE-2 schema 写错为 magpie 插件侧问题，本插件目录/参数处理与参考实现一致。

## 最新代模型筛选与已启用置顶

- **代际清单**：`src/model-generations.mjs` 是默认可见性的规则源。按厂商发布证据维护最新代及同代分支；不从 Devin 的推荐标记、账号目录最高版本或名称排序推断代际。账号缺少已核实的最新代时不回退，包括只有 GLM-5.3 的目录；新发布型号需在代际清单核验后随插件更新。
- **设置与作用域**：沿用 `hideLegacyModels`（默认 `true`）与 `setHideLegacyModels`，不迁移账号偏好。普通模型设置页、路由注册和参数默认值使用 `getModelRows()` 发出的 `legacy` 标记；Fusion 在建索引前用同一清单筛选两侧实际存在的变体。关闭开关恢复完整目录。
- **已启用模型置顶**：设置页稳定排序；非当前代只在完整目录展示，并可从筛选空态直接切换到完整目录。
