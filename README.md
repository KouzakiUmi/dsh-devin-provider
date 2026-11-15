<div align="center">

# Devin Provider

**在 DeepSeek Harness 中接入 Devin 订阅账号。**

浏览器 PKCE / CLI / API Key 登录、额度与重置倒计时、模型家族折叠与逐模型参数覆盖，集中在一个设置页面。

[![npm](https://img.shields.io/npm/v/dsh-devin-provider?color=3b82f6)](https://www.npmjs.com/package/dsh-devin-provider)
[![CI](https://github.com/KouzakiUmi/dsh-devin-provider/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/KouzakiUmi/dsh-devin-provider/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-64748b)](LICENSE)

[快速开始](#快速开始) · [主要功能](#主要功能) · [使用条件](#使用条件) · [开发与发布](docs/development.md) · [更新记录](CHANGELOG.md)

</div>

## 快速开始

安装最新版本（`web` 是示例 Profile，请替换为实际目标；Desktop 使用桌面壳集成的 DSH CLI）：

```console
dsh plugin --profile web add dsh-devin-provider
```

更新已安装版本：

```console
dsh plugin --profile web update dsh-devin-provider@latest
```

也可从 [GitHub Releases](https://github.com/KouzakiUmi/dsh-devin-provider/releases) 下载 `dsh-devin-provider-<version>.tgz`，用下载文件的绝对路径安装：

```console
dsh plugin --profile web add "<tarball 的绝对路径>"
```

1. 打开 **设置 → Devin Provider**，新增账号并选择接入方式（浏览器 PKCE 登录、导入本机 `devin` CLI 登录、API Key / Session Token 或 DSH 凭据引用名）。
2. 首次接入后在账号卡片刷新模型目录与额度；模型卡片按需调整上下文长度、输出上限、温度、图片输入、工具调用与思考档位。
3. 在 DSH 模型选择器中选择 `devin` 路由，开始使用。

安装／更新后按部署方式重新启动或重载 DSH，让 Host 插件重新加载。npm 徽章显示实际已发布版本；`main`、版本字段与当前运行会话不自动等同。不要把 GitHub 源码 ZIP 当作验证过的发布包。

## 主要功能

1. **多种账号接入方式**
   - **浏览器 PKCE 登录**：生成官方 `app.devin.ai/auth/cli/continue` 授权链接，通过本机 `127.0.0.1` 临时回调交换 `sessionToken`（经 `ExchangeDevinCLIPKCECode`）。
   - **导入本机 `devin` CLI 登录**：只读读取 `%APPDATA%\devin\credentials.toml`（或 `$XDG_DATA_HOME/devin/credentials.toml`），每次请求动态读取最新凭据，不改动 CLI 自身文件。
   - **API Key / Session Token（`cog_…` / `devin-session-token$…`）**：加密保存至 DSH 凭据存储（`ctx.credentials.modifyRecord`）或受保护隔离凭据文件，不落入 `state.json`。
   - **DSH 凭据引用名**：引用环境变量或 `.credentials.yaml` 中的键名（如 `DEVIN_API_KEY`）。
2. **订阅额度与重置倒计时**
   - 调用 `GetUserStatus` 展示每日（24 小时）与每周（7 天）配额剩余比例、周期 ACU 用量、超额余额与周期结束时间，并对有效重置时间提供本地实时倒计时。
   - 自动标注不计额度的免费模型（如 `GetCliModelConfigs` 中 `model_cost_tier === 4` 的变体）。
3. **模型家族折叠与逐模型参数覆盖**
   - 按模型家族折叠展示（如 `swe-2`、`claude-opus-5-5`、`gpt-6-sol`），保留 `-fast`/`-priority` 等加速档位与无思考变体，并由 DSH 思考档位自动映射到对应变体 ID（含 DSH `off` ↔ Devin `none` 映射）。
   - 支持从 `GetCliModelConfigs`（及 `devin models list` 回退）同步账号实时模型目录。
   - 支持逐模型启用/停用，以及覆盖 `contextWindow`、`maxTokens`、`temperature`、`imageInput`、`toolsEnabled`、`reasoningEfforts` 与 `defaultReasoning`，并支持一键恢复默认。
4. **5 分钟提示词缓存保活（默认关闭）**
   - 可在「设置 → Devin Provider」开启或调整保活间隔（30–299 秒，默认 285 秒）和单次对话最大保活次数（1–50 次，默认 6 次）。
   - 每次有效缓存命中/写入后按周期发送 `max_tokens=1` 的 `continue` 续命请求，遇新请求、401/402/429、连续 2 次缓存未命中或达到最大次数自动停止。

## 目录结构

- `src/index.mjs`：Host 插件入口（注册 `devin` 路由、Typert `devinProvider` RPC 与 `credentials` 集成）
- `src/devin-adapter.mjs`：基于 `PiAiAdapter` 的模型适配器包装与请求级隔离控制
- `src/devin-wire.mjs`：pi-ai `Context` ↔ Devin Connect+Proto `GetChatMessage` 协议转换与流式解码
- `src/pb.mjs`：手写 Protobuf 编解码、Connect 帧封装（>8 KiB 自动 gzip）与错误映射
- `src/keepalive.mjs`：5 分钟提示词缓存保活调度器
- `src/catalog.mjs` / `src/catalog-snapshot.json`：模型家族折叠、能力快照与逐模型覆盖解析
- `src/state.mjs`：带文件锁与 revision 校验的状态持久化（仅存非密钥元数据）
- `src/manager.mjs` / `src/oauth.mjs` / `src/quota.mjs` / `src/cli.mjs`：控制器、PKCE 登录、额度解析与 CLI 读取
- `src/client.js`：DSH 设置页（`settings.section` / `devin-provider`）
- `scripts/` 与 `.github/workflows/`：构建、检查、打包校验与发布工作流，说明见[开发与发布](docs/development.md)

## 使用条件

- **DSH Core**：`>=0.2.1-rc.4 <0.3.0 || >=0.2.2-rc.1 <0.3.0`；`@earendil-works/pi-ai`：`>=1.1.0 <2.0.0`。兼容性以目标进程实际加载的 Core 及其导出类型为准。
- **Node.js**：`>=22.19.0`。
- **账号**：可用的 Devin 订阅；`cli` 方式需本机已用 `devin auth login` 登录。
- 当前验证以工作区内的静态检查、构建产物校验、单元测试与 Core 兼容性探针为准；真实在线 `server.codeium.com` 推理、浏览器人工界面操作与安装到 DSH Profile 后的实测需由使用者验收。

## 构建与验证

```sh
node scripts/check.mjs
node scripts/build.mjs
node --test test/*.test.mjs
python -m unittest discover -s test -p 'test_*.py'
python scripts/pack.py --output-dir release-artifacts
python scripts/verify-package.py release-artifacts
```

`lib/` 为构建产物，不提交到仓库；CI 在打包前构建。打包产出 `.tgz` 与同名 `.tgz.sha256`，归档内容与 `package.json` 的 `files` 一致。

## 反馈与许可

[提交 Issue](https://github.com/KouzakiUmi/dsh-devin-provider/issues) · [GitHub Releases](https://github.com/KouzakiUmi/dsh-devin-provider/releases)

[MIT](LICENSE)。
