# DSH 配置与插件同步 / DSH Config & Plugin Sync

> 一个 DeepSeek Harness（DSH）插件：把你的 **DSH 配置、模型 provider、插件清单与配置、密钥、MCP 服务** 同步到 Git / WebDAV / S3 兼容存储，在多台设备之间保持一致。
>
> English: [README_EN.md](./README_EN.md)

## 它解决什么问题

换一台机器，DSH 里"重建起来最烦"的东西从来不是插件本身（那些能重新装），而是：

- 你调了很久的**模型 provider**（baseURL、API 方言、模型清单、默认模型）；
- 那十几个插件的**版本锁定**与**各自配置**；
- 一堆**API key / 凭据记录**；
- 手写的 **MCP server** 定义（npx/uvx 参数、URL、header 名）；
- 以及整个 profile 的 **cordis patch** —— 里面有你写下的注释和 `!!js` 表达式。

这个插件把这些**声明式的东西**抽出来加密/合并/同步；**插件的代码永远不参与同步**。

## 同步什么，不同步什么

| 内容 | 是否同步 | 说明 |
|---|---|---|
| DSH 基础配置 | ✅ | `$DSH_HOME/cordis.patch.yml`、`profiles/<name>/cordis.patch.yml`、`cordis.yml`、`package.json`；逐条按 entry id 合并，保留注释与 `!!js` |
| 模型 provider | ✅ | 从 LLM 条目抽取 `providers`（displayName/api/baseURL/apiKeyEnv/models）+ `agent-default-model` 默认选择 |
| 插件清单 / 版本 / 安装来源 | ✅ | 包名、版本、`npm/git/local-path/tarball/official`、可复现安装规格、启用状态；`link:` 安装但实为 **GitHub 单包仓库干净检出**的插件会自动识别为 `github:owner/repo#<commit>`，从而可在其他设备还原 |
| 插件自身配置 | ✅ | 每个第三方插件主条目的配置值；敏感键在写入前剔除并标记为 `redacted` |
| 密钥 / key / 凭据记录 | ✅（需口令） | 加密后同步，见 [密钥与口令](#密钥与口令) |
| MCP 服务 | ✅ | serverName、transport、安装方式与包版本、command/args/url、header/env **名称**、其余配置 |
| 插件代码 / node_modules / tarball | ❌ | 只记录"装什么、怎么装"，不复制代码 |
| 本地目录插件（`link:` / `file:`） | ❌ 不同步 | 只在设备快照里记录来源与 `restorable: false`；目录内容与代码都不复制，也不进入需同步的插件清单（否则目标设备永远无法满足，每次同步都会产生一条无法执行的差异） |
| 会话历史 / 日志 / 缓存 | ❌ | 不属于"配置" |

## 三种存储后端

| 后端 | 适用场景 | 认证 | 并发控制 |
|---|---|---|---|
| **Git** | 想要版本历史、多人共享、审查改动 | SSH / credential helper / HTTPS token（读环境变量） | 分支 HEAD 比较；非 fast-forward 先拉取合并，永不强推 |
| **WebDAV** | 自建 NAS / Nextcloud / 坚果云一类 | Basic 或 Bearer | ETag + `If-Match`，412 视为并发冲突 |
| **S3 兼容** | AWS S3 / MinIO / Cloudflare R2 / 七牛等 | AccessKey + SecretKey（+ 可选 session token），本地 SigV4 | `If-Match`/ETag 比较，冲突即拒绝 |

三者共用同一套文档布局，所以你可以同一份数据先放 Git 再换 S3，互不感知。

### 存储布局

```
dsh-config-sync/                    # 可配置的根前缀
├── manifest.json                   # 版本、revision、设备列表、各文档摘要
├── profiles/<profile>/
│   ├── dsh-config.json             # 配置文件（原文）+ 解析后的条目
│   ├── providers.json
│   ├── plugins.json
│   ├── plugin-configs.json
│   ├── mcp.json
│   └── secrets.json                # 只有加密信封
├── devices/<deviceId>.json         # 每台设备最后一次快照
└── snapshots/<profile>/<deviceId>/<ts>.json   # 回滚快照（保留最近 20 份）
```

## 安装

```bash
# 在插件目录内
npm install
npm run build          # 生成 lib/（Host 端）+ lib/client.js（Web 端）
```

然后在 DSH 里安装这个目录：

```
plugin_manager install_bundle  target: /绝对路径/dsh-configandplugin-sync
```

安装后重启 DSH（或等待 HMR），设置页会出现 **DSH 配置与插件同步**。

> `lib/` 是构建产物但需要提交进仓库：DSH 安装插件时会阻止依赖的构建脚本，所以 Git 安装必须带上已构建的一半。

## 快速开始

1. **设置页 → 配置**：选后端（Git/WebDAV/S3），填地址与凭据（凭据只写本机，见[安全](#安全)）。
2. 点 **测试连接**，确认 `ok: true` 与读到的 revision。
3. 勾选要同步的**范围**（配置 / provider / 插件 / 插件配置 / 密钥 / MCP），保存。
4. **同步** 标签页 → **预览**：看到将要上传/下载的条目与冲突 → 确认执行。
5. 到另一台设备上重复 1–3，然后 **预览 → 恢复**。

第一次在两台都有内容的设备之间同步时，同名条目内容不同会进入**冲突**而不是被覆盖 —— 这是刻意的。

## 密钥与口令

密钥同步默认**关闭**。启用前先让插件拿到口令，方式有三（按推荐顺序）：

### 方式 A：设置页保存到本机口令文件（推荐，桌面 App 用这个）

**设置 → DSH 配置与插件同步 → 密钥 → 本机口令文件 → 输入口令 → 保存到本机**。

- 写入 `~/.dsh/dsh-configandplugin-sync/passphrase`，权限 `0600`；
- **不经过环境变量、立即生效、无需重启**；
- 只留在本机，不会被同步，也不会出现在任何页面或日志里。

### 方式 B：启动环境变量

```bash
# macOS：用 open 带着变量启动（推荐，仅影响本次启动）
open -a "DeepSeek Harness" --env DSH_SYNC_PASSPHRASE='你的口令'

# 或者交给 launchd（对之后启动的 App 生效，重启后失效）
launchctl setenv DSH_SYNC_PASSPHRASE '你的口令'
```

### 方式 C：改名后写进 `~/.dsh/.env`

```bash
# DSH 禁止 .env 设置任何 DSH_ 前缀变量，所以先把“口令环境变量名”改成别的名字，
# 例如 SYNC_PASSPHRASE，然后在 ~/.dsh/.env 里写：
SYNC_PASSPHRASE='你的口令'
```

写完需重启 DSH（`.env` 只在启动时读一次）。

> ⚠️ **不要**把 `DSH_SYNC_PASSPHRASE` 直接写进 `~/.dsh/.env`：DSH 会拒绝任何 `DSH_` / `XDG_` / `DYLD_` 前缀的变量（它们会改变进程如何启动、加载什么代码、走哪条网络），并在启动阶段直接失败。这正是本机口令文件存在的原因。

加密细节：

- 加密：`scrypt(N=2^15, r=8, p=1)` 派生 32 字节密钥 → `AES-256-GCM`；
- 信封里只有 salt / iv / tag / 密文，**没有口令、没有明文**；
- 口令从上述三种来源取得，**从不写入配置文件，也从不写入存储**；
- 每台设备都可以用同一口令解开；口令错了是明确的 `passphrase-invalid`，不会破坏本地数据。

## 配置文件里的明文密钥

patch 文件是按**原文**同步的（这样注释和 `!!js` 表达式才能原样还原），所以如果你把密码直接写进了 `cordis.patch.yml`，它本来会跟着存储一起上传。这个插件不会这么做：

- 采集时把**敏感键**（`password` / `token` / `apiKey` / `Authorization` / `secret` 等）的值替换为 `"***"`，并在警告里指出文件、行数与键名（永远不含值）；
- 因此**值不会进入存储，也不会出现在设置页或 Agent 的响应里**；
- 恢复时，如果本机同一位置已有真实值，就用本机值填回（`preserveMaskedValues`），不会用 `***` 覆盖；如果本机没有，会保留 `***` 并明确提示"需要手动补全 N 个敏感值"。

正确做法是把这类凭据放进凭证存储（`~/.dsh/.credentials.yaml`），配置里只写引用名（如 `apiKeyEnv: TFLOW_API_KEY`），这样它会被**加密**后同步（见[密钥与口令](#密钥与口令)），而不是被掩码。

## 冲突与合并规则

同步采用**三方合并**：本机基线（上次双方一致的值）+ 本地现值 + 存储现值。

| 本地 | 存储 | 基线 | 结果 |
|---|---|---|---|
| 有（未变） | 有（未变） | 有 | 无操作 |
| 有（改了） | 未变 | 有 | 上传 |
| 未变 | 改了 | 有 | 拉取 |
| 改了 | 改了（同一条目） | 有 | **冲突**，等用户选 local/remote/skip |
| 有 | 无 | 无 | 上传（首次） |
| 无 | 有 | 无 | 拉取（采纳） |
| 无 | 有 | 有 | 本地删除 → 写入墓碑（破坏性，需确认） |
| 有 | 墓碑 | 有 | 远端删除 → 插件可移除（破坏性，需确认） |

两类"看起来冲突其实能自动合并"的情况会先尝试合并：

- **patch 文件**：两台设备改了**不同 entry id** → 按 id 合并，双方都保留；同一 id 改动才冲突。
- **`package.json`**：不同依赖/不同 bundle 的改动自动合并；同一依赖改成不同版本才冲突。

删除是**破坏性动作**，必须先 `confirmDestructive`；远端墓碑只在 `plugins` 段会真正移除本地插件，其他段只提示，不半途删除。

## 自动同步

设置页可开启：

- **启动时**一次（默认延迟 15s）；
- **定时**（默认 30 分钟，0 = 关闭）；
- **插件变更后**（默认关闭，去抖 5s）。

自动运行遇到冲突会**暂停并提示**，不会替你决策；连续失败按 2 的幂退避，上限 1 小时。

## Agent 工具

| 工具 | 用途 |
|---|---|
| `dsh_sync_status` | 状态、各段计数、待上传/下载、冲突数 |
| `dsh_sync_inventory` | 本机会同步什么（不读代码、不读密钥值） |
| `dsh_sync_diff` | 预览 push/pull/two-way |
| `dsh_sync_backup` | 上传（默认预览，`confirm: true` 执行） |
| `dsh_sync_restore` | 从存储恢复（默认预览） |
| `dsh_sync_sync` | 双向同步（默认预览） |
| `dsh_sync_history` | 写入历史与回滚快照 |
| `dsh_sync_secrets_status` | 密钥包存在性与本机引用名（无值） |

工具与设置页调用**同一个引擎**，不存在两套逻辑。

## 安全

- **密钥加密后才离开设备**，存储里没有明文密钥。
- **存储凭据不回传浏览器**：`webdav.password`、`webdav.token`、`s3.secretAccessKey`、`s3.sessionToken` 在所有 HTTP 响应中为空串；页面提交空值表示"保持原值"。
- **日志脱敏**：`sk-…`、`ghp_…`、`xox…`、URL 里的 `user:pass@`、`Bearer …`、`password=…` 都会被替换。
- **只同步 header/env 名称**，不同步其值。
- 本机私有配置 `~/.dsh/dsh-configandplugin-sync/config.json` 权限 `0600`，目录 `0700`。
- ⚠️ 与 DSH 本身一致：Agent 以你的 OS 用户运行，因此本机凭据文件对 Agent 可读；这个插件能保证的是**不把密钥写进同步存储、不写进日志、不回传浏览器**。

## 开发

```bash
npm run typecheck   # Host + Client 两套 tsconfig
npm test            # vitest（单元 + 集成，离线、确定性）
npm run build       # tsc（Host）+ esbuild（Client）
npm run verify      # 以上全部
```

目录：

```
src/
├── types.ts          领域模型（快照 / 远端文档 / 计划 / 配置）
├── dsh.ts            DSH 服务的结构化类型（无 @deepseek-ai/* 运行时依赖）
├── core/             错误、JSON、脱敏、日志、路径、原子写、YAML 块、patch 合并
├── state/            本机配置与基线（0600）
├── collect/          采集：DSH 配置、provider、插件、插件配置、MCP、密钥
├── backends/         Git / WebDAV / S3（SigV4）
├── engine/           仓库读写、三方合并、计划、应用、加密、快照、引擎
├── http/             设置页接口（同一信封）
├── tools/            Agent 工具
└── scheduler.ts      自动同步
client/src/           Web 设置页（React，注入 settings.section）
```

## 发布与命名约定

- **GitHub 仓库**：`alfredhuang211/<包名>`，分支 `main`（例如 `dsh-ssh-hosts`、`dsh-webdav-sync`）。
- **npm 包名**：统一带 scope —— `@alfredhuang211/<包名>`，避免与社区同名包冲突（例如 npm 上 `dsh-webdav-sync` 已属于 `GaoHu1997/dsh-webdav`）。
  - 公开分发：`npm publish --access public`（或在 `package.json` 设 `"publishConfig": { "access": "public" }`）；
  - 仅内部使用：保持默认私有可见性，用 `npm publish`。
- 发布后，插件清单里的 `installSpec` 会自然变成 `@alfredhuang211/<包名>@<版本>`，其他设备可直接从 registry 还原；未发布时用 `github:alfredhuang211/<仓库>#<commit>`。
- `link:` 安装但实为 **GitHub 干净检出**的插件会被自动识别成可还原规格；monorepo 内的包使用 `github:owner/repo#<commit>&path:/<子目录>`（pnpm 的子目录选择器）。

## 已知限制

- 只能同步**当前运行中的 profile**（其他 profile 的插件状态由其它 profile 的运行实例负责）。
- 本地目录插件（`link:`）不复制代码，因此在目标设备上需要自行准备；同步只保证"记录来源"。
- 回滚基于**本插件写的快照**；Git 后端额外提供提交历史，但回滚仍按快照执行。
- 官方/内置 bundle 只记录，不重装、不移除。
- WebDAV/S3 没有原生的"历史"，历史页显示的是快照列表。

## License

[MIT](./LICENSE)
