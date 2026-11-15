# 更新记录

## 0.1.1

首个 npm 公开版本（`0.1.0` 仅为本地打包验证产物，未发布到 npm）。

- 四种账号接入：浏览器 PKCE 登录、本机 `devin` CLI 凭据只读导入、API Key / Session Token、DSH 凭据引用名。
- 订阅额度与重置倒计时、免费模型标注。
- 模型家族折叠、实时目录同步与逐模型参数覆盖（含 DSH `off` ↔ Devin `none` 档位映射）。
- 5 分钟提示词缓存保活（默认关闭，可配置保活间隔与最大续命次数）。

版本号、npm dist-tag 与 GitHub Release 的对应关系见[开发与发布](docs/development.md)。
