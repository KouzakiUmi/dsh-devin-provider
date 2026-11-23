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

## Fusion 支持与读缓存中间层（0.1.3 发布）

### Fusion（lead + sidekick 路由家族）
- **协议照抄本机 Devin CLI**（3000.14.30821 实测抓包确认）：组合路由 uid `fusion-<leadUid>-sidekick-<sidekickUid>`（如 `fusion-claude-fable-5-2-high-sidekick-swe-2-high`）→ `AssignModel`（unary proto，`application/proto`，field 2=routerUid、3=cascadeId、5=当前用户轮）→ 返回 **lead 的 modelUid + assignmentJwt** → `GetChatMessage` 以 field 21=lead uid、field 26=JWT、field 16=同一 cascadeId 发出；服务端凭 JWT 后台编排 lead+sidekick。
- `devin-wire.mjs`：`assignModel()`、`fusionRouterUid()`、`isFusion()`；`encodeRequest`/`buildFromPiContext` 透传 cascadeId/assignmentJwt；`streamDevinChat` 对 fusion 先分配再推理，`claude` 思考判定按分配到的 lead uid。Fast Mode 的 lead `-fast` 与 GPT sidekick `-priority` 后缀按 `fastAllowed` 决定：官方组合表没有该 lead+sidekick 的快速变体时降级为标准组合，不发出不存在的路由。
- `state.mjs`：`state.fusion[accountId] = {lead, leadEffort, sidekick, sidekickEffort}`，`normalizeFusionConfig` 校验；默认搭配 Opus 5.5 Medium + SWE-2 Medium（`FUSION_DEFAULT`）。
- `catalog.mjs`：官方组合表来自 `devin models list` 的 `fusion-*` 路由；`fusionRouteMatrix()` 解析出每个 lead 的标准/fast sidekick 集合与各 sidekick 档位，`fusionOptions()` 据此过滤 lead 的 sidekick 下拉并给出 `fast`/`fastSidekicks`；`fusionConfigOf()` 把旧配置或手改配置回退到官方允许的 lead/sidekick/档位组合，并返回运行时派生字段 `fastAllowed`（不持久化）。`fusionDescriptor()` 随 lead 定 api/窗口；`profileFor` 追加唯一 `fusion` 路由模型（`reasoningEfforts:false`，lead 档位由 Fusion 配置决定，不走 DSH 逐次档位）。无组合表时退回静态 lead/sidekick 表。
- `manager.mjs`：`saveFusion` op；`op:'models'` 先拉 `GetCliModelConfigs`，RPC 目录缺 `fusionRoutes` 时用 `devin models list` 补一次（CLI 不可用则保留 RPC 目录）；read 快照含 `fusion.{config,options,perAccount}`，其中 `config` 仅含可持久化字段。`index.mjs` 路由指纹纳入 fusion 配置，lead 变更触发适配器重建；`resolveFusion` 调用时读实时状态。
- **UI**：设置页 `FusionCard`（lead/档位/sidekick/档位四选择器，sidekick 选项按 lead 的官方搭配过滤，切换 lead 时自动修正）；`FusionPillEntry` 经 `conversation.input.right` slot 注入聊天输入区药丸（参考 subusage），devin 路由激活时显示、点击即时切换搭配；⚡ 仅当当前 lead+sidekick 存在快速组合时显示。
- **边界**：fusion 计费按 lead/sidekick 各自费率，描述符 cost 暂置 0，实际用量以服务端 `actualModelUid` 为准（尚未接入成本回填）。

### 读缓存中间层（解耦上游拉取与 Client 读取）
- **读路径**：`op:'quota'` 即时返回缓存快照（附 `refreshing`/`stale`），绝不阻塞等上游；无缓存时返回 `state:'loading'` 占位。
- **刷新路径**：`startQuotaRefresh()` 后台拉上游回填缓存（inflight 去重）；`startBackgroundRefresh()` 每 30s 检查活跃账号缓存 TTL（ok 60s / 其它 15s）按需保暖，`dispose` 清理定时器。
- **Client**：`pullQuota` 即时显示缓存，`refreshing` 时 800ms 廉价重读（30s 上限）；60s 轮询改为读缓存不强制上游；`QuotaWindows` 增 loading/刷新中指示。
- 验收：`test/fusion.test.mjs` 19 项（协议组合/AssignModel 解析/field16/26/官方组合矩阵与 fast 限制/配置回退/fast 降级/目录动态选项/状态校验/profile 追加）；`state-and-manager` 增补 CLI 补全 `fusionRoutes` 测试；全量 53 项（52 通过、1 项既有跳过）、build + Client 边界/导入闭包检查通过。官方 995 条路由与 UI 可生成组合逐条相等（脚本核验）。

### 插件审查结论（全模块）
- pb/wire/adapter/index/catalog/state/manager/quota/keepalive/lease/defaults/oauth/cli/client 均已审查：凭据脱敏、accountId/路径穿越防护、PKCE state 校验、回调仅绑 127.0.0.1、HTML 转义、CLI spawn 无注入 + 隔离 home、状态锁 + 原子写齐全，未发现关键缺陷。
- 先前两项疑似问题已定性：Claude「思考+摘要进 CoT」为 Devin 服务端多轮工具上下文行为（签名覆盖整段思考，须原样回放，不可拆分）；SWE-2 schema 写错为 magpie 插件侧问题，本插件目录/参数处理与参考实现一致。
