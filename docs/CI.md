# 基础 CI

[SFL CI](../.github/workflows/ci.yml) 在面向 `main` 的 PR、推送到 `main`
和手动触发时运行；也支持 `merge_group` 检查事件，但这不代表仓库已启用合并队列。
所有 PR 改动均触发检查，不按文件路径跳过。

## 检查范围

| 环境 | 执行内容 |
| --- | --- |
| Ubuntu / Node 22 | 锁定依赖安装、版本同步、全部测试、类型检查、构建、MCP smoke |
| Ubuntu / Node 24 | 同上，另检查主要用户文档、AGENTS、CI 和评论 bot 文档的本地 Markdown 链接 |
| Windows / Node 24 | 锁定依赖安装、版本同步、全部测试、类型检查、构建、MCP smoke |
| macOS / Node 24 | 锁定依赖安装、版本同步、全部测试、类型检查、构建、MCP smoke |

各环境使用 `npm ci`、`npm test` 和 `npm run test:smoke`，并运行
`node --test .github/tests/*.test.cjs` 验证评论 bot 的权限、输出验证和评论更新流程。
`npm test` 包含版本同步检查，`npm run test:smoke` 包含类型检查/构建，无需重复执行。
测试失败后仍允许其他矩阵环境完成，便于定位平台差异；日志保存在 GitHub Actions 运行记录中。

CI 使用只读仓库权限，checkout 不保留凭据，Actions 固定到完整 commit SHA。
应用配置、缓存、数据及临时目录隔离到 runner 临时空间，并关闭官方源后台自动刷新。
checkout 单独固定 LF，避免改变已提交快照的字节；临时目录规范化避免 Windows 短路径别名影响断言。
这两项沿用 PR #28 已验证的环境处理，不修改业务测试或快照。

## 合并检查

`SFL / CI required` 仅在全部矩阵环境成功时通过；失败、取消或跳过都不能算成功。
同一 PR 的新提交取消旧 CI；合并队列事件保留正在运行的检查。

工作流文件不会自动配置分支保护。首次 GitHub CI 成功后，可由仓库管理员在 `main`
保护规则中将 **SFL / CI required** 设置为必需检查，并按协作约定配置 PR 审批要求。
如需删除或重命名此检查，应同步调整保护规则，避免 PR 一直等待不存在的检查。

## 本地复现与边界

使用 Node 22 或 24，执行 `npm ci`、`npm run check`、`npm run docs:check-links`，
以及 `node --test .github/tests/*.test.cjs` 和
`npm run docs:check-links -- AGENTS.md docs/CI.md docs/COMMENT_BOT.md`。
环境隔离的具体设置见工作流；本机通过不能代替远端跨平台验收。

本阶段覆盖基础质量检查。[评论 bot](COMMENT_BOT.md) 的离线测试纳入 CI，真实模型调用在独立手动工作流中运行。
Dependabot、依赖安全审计、发布打包和自动发布不在该工作流中。
MCP smoke 验证服务协议流程，不代表真实桌面宿主安装/交互验收，也不执行用户绘图代码。
