# GitHub 协作与自有 API 配置

## 当前阶段

已加入 Phase 1 协作规范、Phase 2A 确定性 CI，以及手动试运行的自有 API 回复/审查工作流。
实现包括无网络 mock 测试、严格输出校验和幂等评论；**本地测试不等于 GitHub 已部署或真实模型已验证。**
工作流需经审查合入，仓库设置和 Secret 仍需配置。`AGENTS.md` 是规则，不是后台触发器。
当前未实现自动 Issue 分诊/标签、PR 自动摘要/CI 状态评论、自动 AI 重审、Lint/formatter、
正式安全扫描门禁、覆盖率门槛、自动关闭、代码修改 Agent、Merge Queue 或自动发布。

本轮批准的自有模型协议为 OpenAI-compatible **Chat Completions**：`POST /v1/chat/completions`。
已按维护者提供的参数写入 [AI 策略](../.github/ai-policy.json)：

```text
base URL: https://api.jadelai.top/v1
endpoint: https://api.jadelai.top/v1/chat/completions
model: gemini-3.8-flash-high
```

API Key 未写入仓库，也没有发起真实模型请求。此处记录的是用户指定配置，不是对服务商模型可用性的验证。

## 谁维护、谁有平台权限

| 角色 | 账号 | 职责 |
| --- | --- | --- |
| 主力开发与日常维护 | `jarxunlai` | 技术方案、Issue 分诊、Agent 授权、代码审核与发布协调 |
| GitHub 个人仓库 owner | `xuzhougeng` | owner-only 设置、私密安全报告与受保护 Environment 配置、备援审查 |
| 自动回复身份 | GitHub Actions bot（部署启用后） | 按最小权限评论，不冒充个人维护者 |

个人仓库的 owner 和 collaborator 不是组织仓库的细分角色体系。
主维护者不能因为写进 CODEOWNERS 就自动获得 owner-only 设置权限。
CODEOWNERS 中列出两位允许其中一位有效批准，不是双人批准或优先路由；日常分诊仍优先 `jarxunlai`。
主维护者自己的 PR 需要另一位有效人工 reviewer。

## 推荐路线：Actions + 自有 API

不要求购买 Copilot 或使用 OpenAI 官方端点。Issue 回复与 PR 审核使用已实现的受限模型适配器：

```text
Issue / PR / CI 事件
  → 可信策略检查与事件归属验证
  → 读取并脱敏公开文本 / diff
  → 主维护者授权；受保护 ai-assist Environment 批准
  → 调用你配置的 Chat Completions API
  → 严格校验输出和当前 head SHA
  → 不持有模型 Key 的独立评论 job 幂等发布
```

这条链路的模型没有 shell、写代码、合并或发布工具。
回复/审查辅助与能持续修改代码的 coding agent 是两个权限级别，不能同时默认开启。
添加 `AGENTS.md`、选择某个模型或在 Secrets 中填 Key，均不会单独使该链路工作。

GitHub 原生 Copilot review 与本地 CLI/SDK 的 BYOK 功能不同；不能假设一个 repo variable
会让原生 Copilot reviewer 改用自定义 base URL。本项目的自有 API 方案不依赖该假设。

## 配置项

以下是本项目适配器读取的配置，不是 GitHub 自动识别的 Agent 功能。
默认关闭；`AI_ENABLED` 缺失或不是精确的 `true` 时不运行。

| 名称 | 存放位置 | 示例 / 约束 |
| --- | --- | --- |
| `AI_API_KEY` | `ai-assist` Environment secret，推荐 | 直接输入 GitHub，不发送到对话、代码或日志 |
| `AI_BASE_URL` | 可选 Environment variable | 默认 `https://api.jadelai.top/v1`；仅允许当前批准的精确端点 |
| `AI_MODEL` | 可选 Environment variable | 默认 `gemini-3.8-flash-high`；仅允许当前批准的模型 |
| `AI_API_STYLE` | 可选 Environment variable | 默认 `chat_completions`；暂不支持其他协议 |
| `AI_ENABLED` | Repository variable | 初始 `false`，部署与验收后再设 `true` |

最少需要设置一个 Secret（`AI_API_KEY`）与一个 Repository Variable（`AI_ENABLED`）。
端点、模型和协议可直接使用已批准的策略默认值；如果填变量，值必须与策略一致。
更换服务商/模型必须先审查策略文件，不允许通过 Issue 内容或任意 dispatch 参数改变目标。

URL 规则：完整请求地址为 `https://api.jadelai.top/v1/chat/completions`，base URL 为
`https://api.jadelai.top/v1`，由适配器追加 `/chat/completions`，不重复追加 `/v1`。
只允许 HTTPS、已批准的确切目标；拒绝 userinfo、凭据 query、任意重定向和用户正文提供的端点。
GitHub-hosted runner 中的 localhost 指 runner 本身，不是维护者电脑；内网服务需要单独批准网络方案。

需要确认模型的上下文限制、认证 header 和 token 参数兼容性。
首版请求只采用 `model`、`messages`、`stream: false`，不默认兼容服务支持 `response_format`、
`temperature` 或同名 token 参数。模型必须返回 `choices[0].message.content` 中的纯 JSON，
且 `finish_reason` 为 `stop`；不接受 markdown fence、tool calls、截断或无效 schema。
响应字节限制不是推理/付费 token 上限，务必另设服务商额度。实际兼容性需要配置 Key 后验收。

## GitHub 页面操作

1. 仓库 owner 创建名为 `ai-assist` 的 Environment。
2. 将允许使用该 Environment 的分支限制为 `main`，拒绝任意同仓库工作分支和 fork ref。
3. 将 `jarxunlai` 设为 required reviewer，让主维护者控制模型用量和外部文本发送。
4. 确认自我批准选项：手动触发者若也是唯一 reviewer，启用禁止自我批准会导致需要第二人。
   AI 建议任务是否允许其自行批准由维护者明确决定，不能类推为允许 PR self-approval。
5. 在 Environment 的 Secrets/Variables 中填写上表配置。
6. 工作流合入受保护 main 后，将 Repository Variable `AI_ENABLED` 设为 `true`，
   先对一条无敏感信息的测试 Issue/PR 做人工触发验收。这只启用手动入口，不启用自动触发。
7. 自动触发需后续单独实现和审查；不要修改为任何公开评论都可以调用模型。

入口：仓库 Settings → Environments → ai-assist。个人仓库的 Environment 配置需要 owner；
具体设置不可见时请 owner 协助，不借用他人 token。

仓库级 Actions Secret 可由有相应权限的 collaborator 配置，但**不提供相同的 Environment 审批与分支隔离**。
只限制主 workflow 的 trigger 不能防止同仓库其他不可信 workflow 引用 repository secret。
因此本项目优先使用受保护 Environment；若临时使用仓库 Secret，必须另行接受其信任边界，不默默降级。

可以使用 GitHub 网页输入密钥，不需要将 Key 提供给开发 Agent。
如由有权限的本人使用 `gh`，先核验账号，再使用交互式 secret 输入，不把值写进命令行历史：

```powershell
gh api user --jq .login
# 在确认返回当前被授权的账号后，且该账号具备环境 Secret 管理权限时：
gh secret set AI_API_KEY --repo xuzhougeng/ScientificFigureLibrary --env ai-assist
```

本地开发 Agent 进行 GitHub 写入时必须使用 `jarxunlai`；owner-only 设置由 owner 本人独立完成。
此文档不授权开发 Agent 切换为 owner 的身份。

## 后续触发与审核策略

- 第一版 AI 仅 `workflow_dispatch`，始终执行所选 main 的固定 `github.sha`，不 checkout PR head。
- 输入 Issue/PR 编号需类型校验并通过 API 验证属于当前仓库；不从用户文本获取 API 端点、prompt 路径或命令。
- 当前唯一默认授权维护者是 `jarxunlai`；必须同时通过 actor allowlist 和当前仓库权限验证。
- 后续公共 Issue 自动分诊采用确定性规则。当前带 security 标签或明确安全标题的对象被阻止进入模型；
  启发式检测不能识别所有敏感内容，人工批准前仍须检查，不要把私密报告交给该工作流。
- PR 的常规 CI 在无 Secrets 的临时 runner 上执行；AI 审查不运行 PR 代码和 npm install。
- 后续通过 workflow_run 或其他可信入口调用时，重新核验 workflow、仓库、事件、PR 归属、head SHA 和 run attempt。
- 不能对公开 Issue 中的 `@agent`、`/review` 或 `agent:approved` 文字直接执行付费任务。
- 合法授权失效、head 变化或输出对应旧提交时，不发布陈旧审查结果。
- 模型 job 只读源码，无 GitHub 写权限；评论 job 不持有模型 API Key，也不执行模型生成的代码。
- 当前跨 job 只传递本次运行产生的 `result.json`，保留 1 天。发布端验证大小、schema、仓库、
  对象、来源指纹、model、run ID 和 attempt，不执行其中的内容；模型 Key 不进入发布 job。
- 提交 diff、Issue/PR 内容和模型输出都按不可信数据处理，移除危险 HTML、意外 mentions 和隐藏指令。

## 评论和预算

使用固定 marker：`<!-- issue-triage:v1 -->`、`<!-- pr-summary:v1 -->`、
`<!-- pr-review:v1 -->`、`<!-- ci-status:v1 -->`。
按受信任 bot ID 和 marker 完整分页查找；内容不变不更新，存在则 update，不存在才 create。
创建请求超时后先查询是否成功，不盲目重发；同一 PR 的写入串行化，并拒绝旧 SHA 结果。

已实施限制：最多 40 个可审查文本文件、100,000 字符输入、262,144 字节响应、90 秒请求超时、最多 10 个 findings。
普通生成/二进制/敏感文件、lockfile 和删除文件明确排除；缺失文本 patch、截断文件列表、超大 PR 拒绝自动审查。
明确的 429/503 最多再请求 1 次，长 Retry-After 停止；超时或结果不明的 POST 不自动重试，避免重复付费。
已发布且来源/策略未变化的同类评论会跳过后续模型调用；首次调用失败或尚未成功发评论时，不能承诺跨运行恰好一次付费。
预算不承诺精确 token 统计，由服务商账单和全局额度兜底。
模型超时、无效 JSON 或服务端错误只能报告“审核未完成”，不能写“未发现问题”。
AI finding 包含 severity、file、line、证据、影响、建议、置信度和 head SHA。
置信度低于 0.75 的 finding 不发布。文件、new-side 行号与该行字面代码证据必须一致；
脱敏或移除隐藏字符后被改写的行不能充当原代码证据，不接受 diff 外 finding。
当前统一更新普通 PR 评论，不创建 inline review，也不提交 approve/request-changes。
所有 AI 审核初期仅供参考，不批准、不阻塞、不自动合并。

## 如何手动运行

前置：工作流已合入 main，Environment/Key 已配置，`AI_ENABLED=true`，以 `jarxunlai` 登录。

1. 仓库 Actions → **SFL AI Assist** → **Run workflow**。
2. Branch 选择 **main**，其他分支会被拒绝。
3. Task 选择 `issue_reply` 或 `pr_review`。
4. Number 填当前仓库中一个开放的 Issue/PR 编号，不是 URL。
5. 批准 `ai-assist` Environment 的待处理 job。
6. 查看运行结果和对应 Issue/PR 的固定评论。

CLI 示例（123 为示例，替换为实际开放的 PR；这些命令会产生远端运行，需本人确认后执行）：

```powershell
gh api user --jq .login
gh workflow run ai-assist.yml --repo xuzhougeng/ScientificFigureLibrary --ref main -f task=pr_review -f number=123
```

PR push 后确定性 CI 会重跑，但本版 AI 不自动重审；再次手动运行才检查新的 base/head。
同一来源已审查时会跳过模型；若需要改变审查规则，先审查并更新策略版本。
Issue 内容或标签、PR 描述、base/head、策略任一变化都会使旧结果失效。

失败只在 Actions 中输出有限错误码，不公开 provider 响应体、Key 或用户日志。例如：

| 错误码 | 下一步 |
| --- | --- |
| `AI_API_KEY_MISSING_OR_INVALID` | 检查 ai-assist Environment Secret，不将值复制到日志 |
| `ACTOR_NOT_AUTHORIZED` / `ACTOR_HAS_NO_WRITE_PERMISSION` | 检查触发者及重跑者身份与仓库当前权限 |
| `API_ENDPOINT_NOT_APPROVED` / `MODEL_NOT_APPROVED` | 检查变量是否与已审查策略一致 |
| `MODEL_HTTP_401` | 在服务商侧检查 Key；不反复自动重试 |
| `MODEL_HTTP_429` / `MODEL_RETRY_DEFERRED` | 等待限流解除并检查额度 |
| `MODEL_REQUEST_TIMEOUT_NOT_RETRIED` | 先查服务商请求记录，避免立即重复付费 |
| `MODEL_OUTPUT_NOT_JSON` / `MODEL_COMPLETION_INCOMPLETE` | 检查模型协议和输出兼容性，不能当作无缺陷 |
| `SECURITY_REPORT_EXCLUDED` / `POSSIBLE_SECRET_CONTENT_BLOCKED` | 转为私密、人工处理，不简单关闭检测 |
| `STALE_OR_WRONG_RESULT` | 当前内容或 PR base/head 已变化，重新审查最新内容 |
| `COMMENT_CREATE_UNCERTAIN_DO_NOT_BLINDLY_RETRY` | 先检查评论是否已创建，不盲目重发 |

停止：将 Repository Variable `AI_ENABLED` 改为 `false`，并取消正在运行/待批准的 AI 任务。
变量变更不会保证中断已经开始的 HTTP 请求；泄露时还需立即轮换/吊销服务商 Key。

## CI 与离线验证

[SFL CI](../.github/workflows/ci.yml) 在 PR、main push 和 merge_group 上提供：

- 版本同步、TypeScript、默认和协作文档链接、自动化回归测试。
- Ubuntu/Node 22、Ubuntu/Node 24、Windows/Node 24、macOS/Node 24 的业务测试与 build/smoke。
- 四宿主插件和 npm tarball 构建候选，不发布。
- `SFL / CI required` 汇总：任意必需 job 失败、取消或跳过均不通过。
- 非阻塞 npm audit 基线；不能视作强制安全扫描已完成。

跨平台 runner 约束：CI 通过仅进程级 `GIT_CONFIG_*` 固定 `core.autocrlf=false` 和 `core.eol=lf`，
避免 Windows checkout 改变已有字节锁定快照。测试的 TMPDIR/TEMP/TMP 统一指向 runner 临时目录下
经过 `realpathSync` 规范化的隔离目录，避免 8.3 短名与长名混用。预检查报告字节长度并拒绝非规范临时根；
不修改源快照、产品校验或业务测试断言，也不写维护者机器的全局 Git 配置。

工作流文件不会自动把检查设为 required；应待实际 Actions 验证后，由有权限的人设置分支保护。
Dependabot 对 npm 和 Actions 每周检查，每个生态最多 3 个普通更新 PR，不自动合并。

无需真实 API Key 或网络的适配器验证：

```powershell
node --test .github/tests/*.test.cjs
node scripts/check-doc-links.mjs AGENTS.md CONTRIBUTING.md CODE_OF_CONDUCT.md SECURITY.md docs/GITHUB_AUTOMATION.md
```

Mock 测试覆盖身份、端点白名单、输出协议、注入输入、凭据检测、响应超限、超时、分页、评论幂等、
旧 SHA/attempt、字面证据与多行隐藏评论行号，以及 prepare → model → JSON → publish 的无网络集成路径。
它们不证明真实 Gemini 路由、GitHub Environment 审批或原生 Actions 运行已经成功。

## 如以后需要真正的 coding agent

可另行评估支持 BYOK 的 CLI/SDK，在隔离 runner 中执行，经批准的分支写入和 PR 创建单独分层。
这要求模型真正支持 tool calling/streaming 等 Agent 能力，不是“支持聊天 API”就自动满足。
GitHub 原生 Copilot cloud agent、Copilot CLI BYOK 和本项目 HTTP 审查适配器是不同运行方式。
第一阶段不安装 CLI、不接入 Codex Action、不创建 GitHub App，不配置任何生产或签名权限。

## 启用前的人工清单

- [ ] 当前 gh 身份有效；写操作符合 `jarxunlai` 身份约定。
- [ ] 核验维护者的 accepted write access 与 CODEOWNERS reviewer 资格。
- [ ] owner 启用 Private Vulnerability Reporting，确认私密报告通知/协作方式。
- [ ] 确定性 CI 与主分支保护先于可写 coding agent 启用。
- [ ] 确认 AI_BASE_URL、AI_MODEL、API 参数和服务商数据保留规则。
- [ ] Environment 仅允许 main，审批人设置正确，密钥未落入文件或日志。
- [ ] 验证 fork、重复事件、旧 SHA、恶意 prompt、API 超时与评论权限不足场景。
- [ ] 设置付费用量上限与 AI_ENABLED 停止开关。

当前个人仓库不按“已有原生 merge queue”描述；组织迁移、自动合并与正式发布需要单独决策。

## 参考

- [GitHub Actions Secrets](https://docs.github.com/en/actions/how-tos/write-workflows/choose-what-workflows-do/use-secrets)
- [GitHub Environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
- [个人仓库权限](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/repository-access-and-collaboration/permission-levels-for-a-personal-account-repository)
- [Copilot BYOK 范围](https://docs.github.com/en/copilot/concepts/models/bring-your-own-key)
- [Copilot CLI 自有模型配置](https://docs.github.com/en/copilot/how-tos/copilot-cli/customize-copilot/use-byok-models)
- [Actions 安全用法](https://docs.github.com/en/actions/reference/security/secure-use)
