## 关联 Issue / Related issue
Closes / Refs #...
小型拼写修正等无须 Issue 的改动，请说明不适用原因。

## 变更目的 / Purpose
本 PR 解决的一个主要问题。

## 问题背景 / Background
当前行为、影响范围和复现条件。

## 实现方案 / Implementation
关键实现、取舍和未包含的工作。

## 变更范围 / Scope
- 模块 / 宿主 / Provider：
- 公共 MCP 工具或 schema：
- 资源、Skills、插件 manifest：

## 测试命令 / Commands actually run
列出操作系统、Node.js 版本、实际命令和 CI / 日志链接。

## 测试结果 / Results
- 通过：
- 失败：
- 未运行及原因：
- 真实宿主验证（与 DOM、单元测试分开）：

## 风险分析 / Risks
权限、路径边界、并发锁、数据一致性、性能、网络与兼容性。

## 回滚方案 / Rollback
代码如何回退；是否影响已有 Library、Revision/Release、Provider 或配置状态。

## API / 数据库 / 配置影响
说明公共 MCP API、本地存储格式、locator、receipt、环境变量和插件配置变化。
没有影响请填写“无”；不要为本项目虚构数据库服务或迁移。

## 部署影响 / Deployment
GitHub Pages、Release ZIP、npm tarball、Wisp update manifest、signed feed 是否受影响？

## Agent 使用说明 / Agent involvement
- Agent / model（如适用，不填写 API Key）：
- Agent 实现的部分：
- 人工实现和复核的部分：
- Session / 任务链接（确认不含私密内容）：

## 人工审查重点 / Human review focus
需要 reviewer 重点查看的文件、边界和风险。

## Checklist
未配置、不适用或无法执行的检查请明确解释，不能把未运行写成通过。
- [ ] 只解决一个主要问题，已关联 Issue 或说明不适用
- [ ] 已添加或更新测试，或说明无需新增的原因
- [ ] 已运行 lint，或说明当前未配置 / 不适用
- [ ] 已运行格式检查，或说明当前未配置 / 不适用
- [ ] 已运行类型检查
- [ ] 已运行测试
- [ ] 已运行构建和 MCP smoke，或说明未运行原因
- [ ] 已运行受影响的打包与文档检查
- [ ] 没有提交 Secrets、私有数据或本机 locator / receipt
- [ ] 没有混入无关格式化
- [ ] 已更新文档，或说明不适用
- [ ] 已检查兼容性并评估安全影响
- [ ] 已说明 Agent 参与和人工检查的部分
