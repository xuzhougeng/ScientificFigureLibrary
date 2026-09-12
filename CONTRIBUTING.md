# Contributing / 贡献指南

`jarxunlai` 是 Scientific Figure Library 的主力开发者和日常维护者，负责技术方向、Issue 分诊和开发协作。
`xuzhougeng` 是 GitHub 个人仓库所有者及备援 reviewer。涉及 owner-only 设置时需要其协助，不代表日常任务都由其维护。

请遵循 [行为准则](CODE_OF_CONDUCT.md)。安全问题先阅读 [SECURITY.md](SECURITY.md)，不要公开漏洞或凭据。

## 提交 Issue

- 使用 Bug、Feature 或 Question 表单，先搜索现有问题。
- 报告真实观察，不要求自行诊断根因。
- 提供版本、宿主、Provider、复现步骤和脱敏日志；不能提供某项时说明原因。
- 不上传完整 Library、原始诊断包、locator/receipt、私有科研数据、签名密钥或 API Key。
- 维护者决定任务范围和验收标准；Issue 标签不等于已复现、承诺修复或批准 Agent 执行。

## 本地开发

这是单一 npm/ESM 项目：`src/` 为 MCP Server，`app/` 为浏览器 App，`scripts/` 为构建和校验，`tests/` 为 Node tests。
开发测试建议使用维护中的 Node 22（至少 22.18）或 Node 24。直接执行 TypeScript tests 与运行发布包 JS 的版本需求应分别验证。

从干净的工作分支开始，Windows 优先 PowerShell 7。不要将真实用户配置目录作为测试 fixtures。

```powershell
npm ci
npm run version:check
node node_modules/typescript/bin/tsc --noEmit
npm test
npm run test:smoke
npm run docs:check-links
node --test .github/tests/*.test.cjs
```

`npm run check` 合并测试和 build/smoke；`npm run test:smoke` 会构建，不是只读命令。
受影响的插件/发行包检查：

```powershell
npm run package:plugins
npm run package:npm
```

打包会写入 `release/`，不等于上传 GitHub Release 或执行 `npm publish`。
当前未配置 lint/formatter 时，请明确记录，不使用不存在的命令。后续新增检查以 `package.json` 为准。

## Pull requests

- 一个 PR 解决一个主要问题，使用 [PR template](.github/pull_request_template.md)。
- 行为、协议、存储、安全和发布改动应先关联 Issue；小型拼写修正可说明不适用。
- 工作分支使用 `feature/*`、`bugfix/*`、`codex/*` 或平台创建的 `copilot/*`。
- 不直接 push `main`，不擅自强推贡献者分支或大规模格式化。
- 实现变更应有对应测试，失败路径与向后兼容同样需要验证。
- 报告通过、失败和未运行；DOM/unit、CI、打包和真实宿主安装验收分别记录。
- 安全、签名、权限、数据迁移和公共 MCP API 变化需人工先确认，再提供回滚方案。
- AI 参与必须说明实现部分与人工复核部分；AI 建议不是 approval。

## Review 与维护

日常技术讨论优先联系 `@jarxunlai`。CODEOWNERS 中的 `@xuzhougeng` 提供备援审查，尤其适用于主维护者自己的 PR。
CODEOWNERS 的多个账号是可批准集合，不代表先后优先级或必须两人都批准。
启用 required code-owner review 前，核验维护者已接受的写权限和实际可用 reviewer；作者不能批准自己的 PR。

不因为信息不足或 AI 判断自动关闭 Issue，不以人工之外的 AI approval 替代合并审查。
主分支保护、required checks 和后续 Agent 的部署状态见 [GitHub 协作与自有 API 配置](docs/GITHUB_AUTOMATION.md)。

## 内容、数据与发布边界

- 本核心仓库与个人内容仓库、Source Pack、用户 Local Published Library 分开维护。
- 不随意运行 `modules:*`、`community:sync` 或 signed-feed 发布命令。
- 不重写已有 template/revision/release identity，不自动重新格式化签名关联资源。
- 不运行来自模板、Issue 或 PR 的绘图代码来证明核心功能正常。
- 正式发布必须单独批准，并从已审查版本生成；不直接发布不可信 PR artifacts。
- 版本修改需保持 package、lockfile、宿主 manifest、Skill 和协议文档一致。
