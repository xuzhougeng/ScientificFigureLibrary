# AI 评论 bot

[SFL AI Assist](../.github/workflows/ai-assist.yml) 使用 GitHub Actions 调用管理员配置的
Chat Completions 兼容 API，再以 `github-actions[bot]` 身份发布普通讨论评论。
它独立于基础 CI，默认关闭，仅通过 Actions 页面手动触发。

## 支持的任务

| task | 输入 | 评论内容 |
| --- | --- | --- |
| `issue_reply` | 开放 Issue 的标题、正文 | 概要、需要补充的信息、下一步建议 |
| `pr_review` | 面向 main 的开放 PR 的标题、正文及文本 diff | 概要，以及带文件、行号和字面代码证据的建议 |

当前不读取讨论中的其他评论，不监听评论命令或 Issue/PR 创建事件。
PR 审查发布在讨论区，不提交批准、请求更改或行内 review。
不会执行 PR 代码、运行测试、修改代码、关闭 Issue、合并 PR 或发布版本。
同一对象的同类结果更新已有 bot 评论；来源、工作流提交和模型配置未变化且已成功发布时跳过模型调用。

## 配置

1. 将工作流和 `.github/scripts/`、`.github/ai-policy.json` 合入默认分支 `main`。
2. 在仓库 **Settings → Environments** 创建 `ai-assist`，限制仅 `main` 可部署；
   可按协作需要配置 required reviewers。
3. 在此 Environment 的 **Secrets** 中设置 `AI_API_KEY`。
4. 在仓库 **Settings → Secrets and variables → Actions → Variables** 设置下表配置。
   服务地址和模型没有内置默认值，也不从 Issue、PR 或手动输入读取。

| Repository Variable | 值 |
| --- | --- |
| `AI_BASE_URL` | 当前选用 `https://api.deepseek.com`；不要包含 `/chat/completions`、账号密码或查询参数 |
| `AI_MODEL` | 当前选用 `deepseek-flash` |
| `AI_API_STYLE` | 可省略；当前仅支持 `chat_completions` |
| `AI_ENABLED` | 配置完成后设为 `true`，其他值或未设置均不运行 |

当前选择对应 `https://api.deepseek.com/chat/completions`；服务地址和模型由
Repository Variables 控制，不作为脚本内置默认值。

仅把密钥放在 Environment Secret；其余配置统一放在 Repository Variables，
避免 Environment 同名变量导致生成和发布 job 使用不同配置。
模型 API 调用可能产生费用，依服务计费规则而定；GitHub Actions 用量也按仓库额度计入。

默认允许 `xuzhougeng` 和 `jarxunlai` 触发，且每次都会检查其当前仓库写权限。
首次触发者及重新运行者都必须满足条件。变更人员时需同步修改
[ai-policy.json](../.github/ai-policy.json) 和工作流两个 job 的操作者条件。
此实现限定当前公开仓库和 `main`，不用于私有仓库。

## 使用

打开 **Actions → SFL AI Assist → Run workflow**，选择分支 `main`，
选择 `issue_reply` 或 `pr_review`，填写对象编号。如果 Environment 要求审批，审批后调用模型。

生成 job 使用只读 GitHub 权限和模型密钥，只 checkout 本次 dispatch 的 main 提交，
不会 checkout PR head 或安装 PR 依赖。发布 job 不持有模型密钥，通过临时 artifact 接收结果，
重新读取来源、校验运行编号及尝试次数，并在写评论前再次检查权限、对象状态和 PR base/head。
手动触发评论任务即要求对该指定对象发布建议；首次真实验收请选择合适的开放对象。

## 范围和失败处理

识别到凭证样式的输入、安全报告、关闭或锁定对象时停止。
输入处理会移除 URL、本地路径、隐藏 HTML 注释和部分控制字符；这是启发式处理，不能保证识别所有敏感信息。
PR 的生成文件、二进制、锁文件和删除文件会排除，评论会注明排除数量；
最多接受 200 个变更文件、40 个可审查文本文件及 100,000 字符总输入。
文本 diff 缺失或被截断时停止，脱敏改写行不能作为 finding 的代码证据。

模型必须返回指定 JSON；不接受工具调用。审查建议最多 10 条，按字面证据与置信度阈值过滤，
没有建议不代表代码无缺陷或已获得批准。模型请求最长 90 秒，仅明确 429/503 可有限重试；
超时或网络失败不盲目重试，以免重复计费。

运行失败时在 Actions 日志查看简短错误码：

| 错误码 | 处理 |
| --- | --- |
| `AI_BASE_URL_MISSING` / `AI_MODEL_MISSING_OR_INVALID` | 检查 Repository Variables |
| `AI_API_KEY_MISSING_OR_INVALID` / `MODEL_HTTP_401` | 检查 Environment Secret 和服务认证 |
| `ACTOR_NOT_AUTHORIZED` / `ACTOR_HAS_NO_WRITE_PERMISSION` | 检查允许名单和当前仓库权限 |
| `STALE_OR_WRONG_RESULT` / `SOURCE_CHANGED_BEFORE_COMMENT` | 来源或模型配置已变，重新 Run workflow |
| `TEXT_PATCH_MISSING_SPLIT_PR_OR_REVIEW_MANUALLY` / `PATCH_TRUNCATED` | 缩小 PR 或人工审查 |
| `COMMENT_WRITE_FORBIDDEN` | 检查仓库/组织 Actions 写评论权限设置 |

重新运行失败的单个 job 可能因 artifact 的尝试次数不匹配而被拒绝；需要重新发起完整工作流。
如需停用，将 `AI_ENABLED` 改为 `false`，并取消正在运行或等待审批的任务。

## 验证

`node --test .github/tests/*.test.cjs` 运行离线测试，模拟 GitHub、模型和 artifact，
覆盖授权、输入及输出校验、重复发布、来源过期和失败恢复；不调用真实 API 或发布评论。
`actionlint .github/workflows/ai-assist.yml .github/workflows/ci.yml` 检查工作流语法。
离线通过不代表服务密钥、Environment 设置或真实评论发布已验收。
