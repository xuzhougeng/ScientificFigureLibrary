# Feature Spec: Scientific Figure Library 0.6.0 Community Providers

> 本 worktree 仅用于 SFL 0.6.0。本文记录已由用户批准的实施边界、验收 Gate 与跨仓人工门禁；它不是放宽现有 Local Library 生命周期或安全边界的授权。

## 分支信息

| 项目 | 值 |
|---|---|
| 分支名称 | `codex/sfl-0.6.0-community-providers` |
| 基于分支 | 本地 `main`（已 fast-forward 到 `305fc5a534a51d0a439ce742d27471fff2261c9c`） |
| Worktree 路径 | `E:\scientific-figure-dev\ScientificFigureLibrary-0.6.0` |
| 建立日期 | 2026-08-21 |
| 发布版本 | `0.6.0` |
| SFL 上游交付 | 本地 commits；不 push，不创建上游 PR |
| 发布产物目录 | 本 worktree 的 `release/`；不覆盖 0.5.5，不复制到 Desktop |

## 2026-08-22 最终交付状态快照

- SFL 功能实现、真实中央投稿闭环、vendoring 与发布前测试已经完成；SFL 改动仍只存在于本地 `codex/sfl-0.6.0-community-providers`，未 push、未创建 SFL 上游 PR。
- 用户在最初计划之后又明确授权主 Agent 审核并合并本次中央 PR。主 Agent 在逐次身份确认、CI/内容审核和串行 Gate 后执行了这些人工合并；这不改变 MCP publication 工具的安全契约，MCP 工具本身仍永不自动 merge。
- Archives Policy PR #1、#4、#5 已完成；三个真实 Archive PR #6、#7、#8 已分别通过可信 GitHub-hosted CI 并完成合并。Archives 最终 `main` commit 为 `30d45429419f68166cb9cfa3310dc8c03b2f1e72`。
- 三个 Catalog PR #3、#4、#5 已串行完成；Community LF policy PR #6 已完成。Community 最终 `main` commit 为 `a21d3ad5612a723621fc4581735032c95b39a949`。
- `assets/community/**` 已从上述固定 Community commit 完成验证与 vendoring；插件正常启动、搜索和打开 App 不依赖联网刷新中央 Catalog。
- 最近一次完整测试为 210 tests / 209 pass / 1 fail；唯一失败是本机 Windows 无创建 symlink 权限导致 portable bundle symlink 安全测试返回 EPERM，测试没有被跳过、弱化或吞掉。随后新增的 release-gate 回归定向测试 8/8 通过。`npm run test:smoke` 已通过，并确认 MCP `tools/list` 共 51 个工具。
- `npm run package:plugins` 与 `npm run package:npm` 已完成；三个 ZIP 和 npm tarball 均通过 final Community preflight、内容审计及含空格安装路径下的 foreign-cwd MCP `initialize`/`tools/list`（51 tools）。真实 Codex Desktop 的 exact ready client 与 tools injection 仍由用户安装插件后做 field acceptance。

## 目标

1. Codex、Claude、Wisp 三种插件在各自 Host 契约下从任意任务 cwd 启动 MCP；Wisp 现有插件根入口保持不变。
2. 仅全局绑定 Plan/Apply 能从 malformed、旧 schema 或悬空 locator 显式恢复；所有普通 Library 操作仍严格 fail closed。
3. 以统一 `ProviderRegistry` 承载 Local Published、FigureYa、内置 Community 和用户显式添加的签名个人 Provider，复用既有 search → exact preview → confirm → materialize 生命周期。
4. 从一个 exact reachable Local Published Release 导出经过逐资产审计的 public submission，并通过 GitHub CLI 身份边界创建中央 Archive PR；合并后才允许创建 Catalog PR。工具永不自动 merge。
5. 建立两个公共中央仓库，clean-room 制作三个 1.0.0 种子，经 `3 × Archive PR → 人工 merge → 3 × Catalog PR → 人工 merge` 后固定 Catalog commit，并 vendoring 到 SFL 0.6.0。

## 实现范围

### A. Host 与 locator 修复

- [x] 删除共享根 `.mcp.json`。
- [x] Codex 使用 `.codex-plugin/mcp.json`，入口为 `node dist/index.js` 且插件根 `cwd` 为 `.`。
- [x] Claude 使用 `.claude-plugin/mcp.json` 和 `${CLAUDE_PLUGIN_ROOT}/dist/index.js`。
- [x] Wisp 保持 `${WISP_PLUGIN_ROOT}/dist/index.js`。
- [x] 三 Host 最终 ZIP 在含空格路径、foreign cwd 下完成 MCP `initialize` 和 `tools/list`；每个 Host 均暴露精确的 51 个工具。
- [x] 引入恢复专用 raw locator observation：`missing`、`valid_v2`、`malformed_json`、`unsupported_or_v1_schema`、`dangling_target`、`target_missing_root_marker`、`library_id_mismatch`。
- [x] bind Plan 不写入、不猜测目标；Apply 对 locator raw digest/config revision 和目标 marker/inventory 做 stale 检查。
- [x] 保留 `FIGURE_LIBRARY_DIR` 优先级；普通 runtime 对坏 locator 仍 fail closed。

### B. ProviderRegistry 与公共协议

- [x] 引入 `ProviderRegistry`、`ProviderAdapter`、`LocalPublishedProviderAdapter`、`FigureYaProviderAdapter`、`PublicCatalogProviderAdapter`。
- [x] 将 search、revision、status、describe、preview、materialize、receipt/replay 的硬编码 Provider 分支路由到 registry。
- [x] 不改变评分算法；身份始终为 `providerId + exactSelector`。
- [x] 默认顺序：Local → Community → FigureYa → 已启用且明确加入默认搜索的个人源（按 providerId 排序）。
- [x] 增加 public catalog/archive/selector/lock v3 schema，同时继续读取旧 Local/FigureYa lock 与 receipt。
- [x] Community catalog、preview manifest、thumbs、licenses 和 source lock 随插件固定，正常 build/package 不联网；完整 archive 仅 materialize 时按固定 commit/path/bytes/hash 下载。
- [x] 区分 upstream、publisher signature、central curation、recipient local review 和 recipient code execution 状态。

### C. 签名个人 Provider

- [x] 增加 Ed25519 detached signature source manifest 协议；首次 trust 必须使用用户独立提供的 32-byte public key。
- [x] 实现只允许公网 HTTPS、逐跳 DNS/redirect 校验、防 DNS rebind、超时、下载大小、MIME、hash、路径、symlink、reserved name、case-fold collision 等 fail-closed 边界。
- [x] sequence 防 rollback/equivocation；正常换钥只接受上一份 manifest 授权的 next key；异常恢复走显式 `trust_reset`。
- [x] verified snapshot 先 staging 完整验证，再 immutable rename + atomic active switch；失败保留 last-known-good。
- [x] 新增 `figure_library_list_provider_sources`、`figure_library_plan_provider_source_change`、`figure_library_apply_provider_source_change`。
- [x] list 完全离线；Add 默认 `includeInDefaultSearch=false`；remove 不删除旧 snapshot 或已 materialize 项目；0.6.0 不做 snapshot GC。

### D. Publication export 与 GitHub PR

- [x] 新增 publication export Plan/Apply，只接受 exact reachable Local Published Release。
- [x] Plan 逐资产列出 include/exclude、role、digests、代码/内容许可证、generated-preview trace、公开 metadata 与被排除私有状态；父 metadata 与新声明冲突必须显式确认。
- [x] Apply 产生 deterministic `figure-library.publication-submission.v1`，目标必须不存在；不联网、不签名、不创建 PR；不泄露 Library/locator/绝对本机路径/其他模板。
- [x] 新增 GitHub auth status/instructions；只通过官方 `gh` 管理凭据，不调用 `gh auth token`，不读 `hosts.yml`，不缓存或打印 token。
- [x] 新增 publication PR Plan/Apply，固定只支持中央 archive/catalog 两仓，使用 Git Data API/`gh api`，不依赖 cwd 或 remote，不修改 `.github/**`/CI/策略。
- [x] Apply 重验 login/permission/plan identity；operationId replay 不重复创建 PR；Archive 未 merge 或 merge commit/digest 不匹配时禁止 Catalog Plan；永不自动 merge。

### E. 三仓与首批种子

- [x] 创建 public `jarxunlai/ScientificFigureLibrary-community` 与 `jarxunlai/ScientificFigureLibrary-community-archives`，做一次 bootstrap direct commit 建立 main/schema/CI/投稿结构。
- [x] 在 Community 仓库 clean-room 重建三个 1.0.0 模板；不修改 `E:\plot`、`E:\ScientificFigureLibrary` 或 Local Published heads。
- [x] 使用现有 `E:\plot\pixi.toml` Windows R 环境和已经存在的包；不安装/升级任何依赖或字体。
- [x] R code 使用 MIT；synthetic data、preview、docs 使用 CC BY 4.0；每个模板记录 render receipt 和最终 artifact digest。
- [x] 视觉检查三个 preview。
- [x] Archives Policy PR #1、#4、#5 已完成：GitHub-hosted runner、无 secrets、reviewed fixed R container、non-root、network none、read-only、drop caps、no-new-privileges、资源/超时限制，并要求 byte-exact/canonical RGBA 重渲染与可信 run identity。
- [x] 三个模板的 Archive PR #6、#7、#8 已按更新后的 Archives `main` 严格串行创建、通过可信 CI、由主 Agent 在用户明确授权下审核并合并；Archives 最终 commit 为 `30d45429419f68166cb9cfa3310dc8c03b2f1e72`。
- [x] Archive merge identity 固定后，Catalog PR #3、#4、#5 已严格串行创建、通过 Community CI、由主 Agent 在用户明确授权下审核并合并。
- [x] Community LF policy PR #6 已完成；最终 Community commit 固定为 `a21d3ad5612a723621fc4581735032c95b39a949`，并已验证和同步到 SFL `assets/community/**`。

### F. 版本、包装与交付

- [x] 将 package、lockfile 两处 root version、三 Host manifest、Skill/README、ZIP/npm 名称统一到 `0.6.0`。
- [x] 修复 `version:set` / `version:check`，强制检查 lockfile 顶层和 `packages[\"\"].version`。
- [x] `package.json.files` 和插件 inventory 仅包含 Host-specific manifests、中央 vendored assets 与正常运行文件；排除 Local Library、locator、个人 source 状态、submission staging、GitHub receipts 和任何 private key。
- [x] 保留多个可审查的本地 commits，不 squash；不 push。
- [x] 最终插件 ZIP、npm tarball、SHA sidecar 与包后 foreign-cwd/content audit 已完成；产物只保留在本 worktree 的 `release/`，原 0.5.5 产物完整保留，未复制到 Desktop。

## 验收标准

### Gate 1 — Host/package

- 三个 ZIP 解压到含空格路径，从另一个项目 cwd 启动，完成 MCP `initialize` + `tools/list`。
- 工具列表含既有 open/search/preview/materialize 和本版本新增的 Provider、publication、GitHub 管理工具。
- 包内无开发机绝对路径；Codex 不依赖 Claude/Wisp 变量；Claude 不依赖任务 cwd；Wisp 行为不变。
- 当前源码构建 smoke 与最终 ZIP 包后 smoke 均已完成 MCP initialize 与 51-tool `tools/list`，且包内容审计未发现开发机绝对路径或本机私有状态。
- 自动 smoke 只证明包装契约；真实 Codex Desktop 的 exact ready client/tool injection 仍由用户安装最终插件后做 field acceptance。

### Gate 2 — Binding

- 覆盖全部 locator observation 类型、missing、正常 v2、环境 override、一致性变化、replay。
- Plan 不写文件；任何 locator/target 状态变化使 Apply stale/conflict；普通 runtime 仍 fail closed。
- 测试全部使用隔离 APPDATA/XDG，不触碰真实 locator。

### Gate 3 — Provider/security regression

- Local/FigureYa 既有 selector、评分、preview receipt 和 materialize 行为保持。
- Community search/preview 完全离线；archive 固定 identity 下载；同 templateId 跨 Provider 不冲突。
- registry/snapshot revision 变化使旧 result set/cursor/preview receipt/materialize Plan stale。
- 覆盖个人源 add/update/configure/remove/trust_reset、签名/错误 key/rollback/equivocation/last-known-good、SSRF/redirect/DNS/大小/ZIP 安全边界。
- 公共 materialize 写 lock v3，继续验证旧 lock；客户端绝不执行模板代码。

### Gate 4 — Publication/GitHub

- 拒绝 Working、不可达历史 Release 和 full Library；私有 reference、截图和 PDF 不进入 submission；DOI/URL 文字 provenance 可保留。
- deterministic/no-overwrite/stale/replay/crash recovery；submission 不泄露 Library 私有状态或本机绝对路径。
- auth status 不泄露 token；Plan 后身份/权限变化失败；PR 工具不能改 workflow/policy；Archive 未 merge 或 merge identity 不符时拒绝 Catalog；同 operationId 不重复建 PR。
- mocked GitHub API 单元测试 + 三个真实 seed PR 作为端到端 field acceptance。

### Gate 5 — Final commands

```powershell
npm run version:check
npm test
npm run test:smoke
npm run package:plugins
npm run package:npm
```

随后执行三个 ZIP 的 foreign-cwd initialize/tools-list smoke 与内容审计。

当前状态：

| 命令/Gate | 状态 |
|---|---|
| `npm test`（含 `version:check`） | 210 tests / 209 pass / 1 fail |
| 唯一失败 | portable bundle symlink 安全测试；本机 Windows 创建 symlink 返回 EPERM |
| `npm run test:smoke` | PASS；MCP `tools/list` 为 51 个工具 |
| 新增 release-gate 定向回归 | 8/8 PASS；固定 clean-room seed 的 `publisherVerified=false`，不与中央策展混同 |
| `npm run package:plugins` | PASS；3 ZIP + 3 SHA sidecar 事务发布 |
| `npm run package:npm` | PASS；1 tgz + 1 SHA sidecar 发布 |
| 三个 ZIP foreign-cwd initialize/tools-list 与内容审计 | PASS；每个 Host 51 tools |
| 真实 Codex Desktop exact ready client/tools injection | 待用户 field acceptance |

EPERM 安全测试不得跳过、弱化或吞掉；CI 必须在具备 symlink 权限的环境完整通过，Windows 本机发布报告单列该环境限制。

## 本地 Commit 边界

1. `fix(plugins): resolve host MCP entries from plugin roots`
2. `fix(binding): plan explicit recovery from broken global locators`
3. `refactor(providers): route Local and FigureYa through a registry`
4. `feat(provider-sources): manage signed personal provider snapshots`
5. `feat(community): add bundled public catalog provider`
6. `feat(publication): export code-generated public submissions`
7. `feat(github): create staged central archive and catalog PRs`
8. `chore(release): package Scientific Figure Library 0.6.0`

## 跨仓依赖与已完成的人工门禁

```text
SFL protocol/tools + Community/Archives bootstrap
  -> Archives Policy PR #1/#4/#5 [complete]
  -> Archive PR #6/#7/#8 [trusted CI + authorized human merge complete]
  -> Archives final 30d45429419f68166cb9cfa3310dc8c03b2f1e72
  -> Catalog PR #3/#4/#5 [CI + authorized human merge complete]
  -> Community LF policy PR #6 [complete]
  -> Community final a21d3ad5612a723621fc4581735032c95b39a949
  -> verified vendoring into SFL [complete]
  -> final 0.6.0 package + package audit [complete]
  -> user Codex Desktop field acceptance [pending]
```

- MCP publication 工具在任何情况下都不调用 merge API，也不自动合并 PR。
- 用户后续明确授权主 Agent 逐项审核和合并中央 PR；主 Agent 的人工、身份校验后操作属于本次显式授权的发布编排，不是 MCP 自动 merge。
- Archive PR 均在相应 trusted CI 成功后才合并；Catalog PR 均在对应 Archive merge commit、archive bytes/digest 和 CI evidence 重新验证后才创建和合并。
- SFL 当前分支仍不 push、不创建上游 PR；两个中央仓库的 policy、bootstrap 与投稿 PR 是计划内远程写入。
- 现有三个 prunable worktree 记录不属于本任务，不清理。

## 明确排除

- Wisp MCP App 缺 `serverTools` 的分页按钮问题、Wisp `os error 32` 和任何 Wisp 源码修改。
- 自动刷新 Catalog、MCP/工具自动 merge、自动 push SFL、用户 `config.toml` 双注册、本机绝对路径救急。
- 复制/绑定/公开整个 Local Library，或把 Local Published 等同于 Community curated。
- 原论文、微信、互联网截图或患者数据进入 Community archive。
- 改评分算法、修改 `E:\plot` Gallery/registry/drafts 或三个 Local Published heads。
- 自动安装 R/Pixi/npm/GitHub CLI/字体/原生 vault 依赖，或客户端 materialize 阶段运行模板代码。
- 完整 TUF/OCI/Artifact Hub crawler 与 personal snapshot GC。
