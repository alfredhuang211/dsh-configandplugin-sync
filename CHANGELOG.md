# CHANGELOG

## 0.1.0

首次发布 / First release.

### 同步内容 / What is synchronized

- **DSH 配置**：`$DSH_HOME/cordis.patch.yml`、`profiles/<name>/cordis.patch.yml`、`cordis.yml`、`package.json`，按条目（entry id）逐块合并，保留注释与 `!!js` 表达式。
- **模型 provider**：从 LLM 条目中抽取 provider（displayName / api / baseURL / apiKeyEnv / models），以及 `agent-default-model` 的默认选择。
- **插件清单**：名称、版本、安装来源与可复现安装规格（`name@version`、git URL）、启用状态；官方/内置插件只记录不重装。
- **插件配置**：每个第三方插件主条目的配置值，敏感键在写入前被剔除并标记。
- **密钥**：`~/.dsh/.credentials.yaml` 中的命名密钥与凭据记录，**始终先加密**（scrypt + AES-256-GCM）再写入存储。
- **MCP**：每个 `@deepseek-ai/dsh-mcp-client` 条目，含 transport、安装方式（npx/uvx/pip/npm/binary/http/docker）、包名与版本、命令/URL、header 与 env **名称**、其余配置。

**不同步插件代码**：不读取、不打包、不上传 `node_modules`、tarball 或本地插件目录；本地目录插件只记录来源并标记为不可还原。

### 存储后端 / Backends

- **Git**：任意 https/ssh/scp-like/`file://` 仓库，按分支提交，提交信息带 trailers；非 fast-forward 先拉取再重试，永不强推。
- **WebDAV**：Basic/Bearer 认证，`PROPFIND` 深度遍历、`GET`/`PUT`/`DELETE`，按需 `MKCOL`；用 ETag/`If-Match` 做乐观并发。
- **S3 兼容**：本地实现 SigV4（path-style 与 virtual-host），`ListObjectsV2` 分页、`GetObject`/`PutObject`/`DeleteObject`，带 `If-Match` 条件写。

### 安全 / Security

- 密钥包使用 scrypt（N=2^15, r=8, p=1）+ AES-256-GCM，口令只从环境变量或一次性输入取得，从不落盘、不写入存储。
- 存储凭据（WebDAV 密码、S3 secret key）只存在本机 `0600` 私有配置中，且在所有 HTTP 响应中被置空。
- 日志与错误信息统一脱敏（`sk-…`、`ghp_…`、URL userinfo、Bearer token、`password=` 形式）。
- Header/env 只同步名称，不同步值。

### 运行方式 / Operations

- Web 设置页：概览 / 同步 / 配置 / 插件 / MCP / 密钥 / 历史 / 日志 八个标签页，所有写操作都是"预览 → 确认"两步。
- Agent 工具：`dsh_sync_status`、`dsh_sync_inventory`、`dsh_sync_diff`、`dsh_sync_backup`、`dsh_sync_restore`、`dsh_sync_sync`、`dsh_sync_history`、`dsh_sync_secrets_status`。
- 自动同步：启动时 / 定时 / 插件变更（去抖）三种触发，冲突时暂停而不是自动决策，失败指数退避。
- 三方合并：以本机基线判断"谁改的"；两端改了同一文档的不同条目时按 entry id 自动合并；无法判断时进入冲突，由用户选择 local/remote/skip。
- 回滚：每次推送写一份快照，历史页可按快照回滚（Git 后端同时提供提交历史）。
