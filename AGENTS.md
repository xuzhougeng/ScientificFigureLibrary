# Repository instructions

适用于整个仓库。保持本文件简短，只放日常开发约束和按需阅读入口；详细设计、决策依据和任务进度放在对应文档中。

## 产品边界

- SFL 负责可复用科学图资产及其浏览、检索、预览、选择、导入、发布和材料化；具体研究任务的组织、执行与持续管理由宿主 Agent 负责。
- 不将跨会话绘图偏好自动应用、研究项目归档/投稿打包、论文主图/子图编排新增为 SFL 原生职责。图库自身的资产身份、版本和来源管理仍属于核心能力。
- 新需求先判断管理对象和责任归属。混合需求只在 SFL 中实现图库职责内的部分；涉及产品范围变更时参阅 [产品原则](docs/PRODUCT_PRINCIPLES.md)，不要因功能与绘图有关就扩大职责。

## 仓库导航

- `src/`：MCP 服务、图库存储、Provider 和材料化逻辑；入口为 `src/index.ts`、`src/server.ts`。
- `app/`：MCP App 界面。`tests/`：Node 测试。`scripts/`：构建、目录生成、版本和打包脚本。
- `skills/`：随插件分发给宿主的绘图指导。`.wisp-plugin/`、`.codex-plugin/`、`.claude-plugin/`、`.cursor-plugin/`：各宿主插件配置。
- 修改工具契约前阅读 [PROTOCOL](docs/PROTOCOL.md)；修改存储、身份或 Provider 前阅读 [全局图库架构](docs/GLOBAL_LIBRARY_0.6.md)。
- 安装与用户流程见 [QUICKSTART](docs/QUICKSTART.md) 和 [用户手册](docs/USER_GUIDE.zh-CN.md)。历史 worktree spec 中的路径、版本和临时授权不作为当前任务的默认指令。

## 实现约束

- 使用现有 TypeScript ESM、严格类型检查和模块划分；修改源文件，通过构建生成 `dist/`。
- SFL 不执行用户绘图或下载的模板代码；执行由宿主完成，不能将材料化成功描述为绘图已验证。
- 保留用户显式选择的全局 Library、不可变 Published Release 和 Provider 限定的精确身份；不要从当前项目目录推断权威图库。
- 修改写入流程时保留既有 plan/apply、过期状态检查和重放语义；修改材料化时保留精确预览与确认契约，具体要求查阅协议。
- 测试使用隔离临时目录和配置，不读写真实用户图库或绑定状态。
- 工具契约、用户可见行为或宿主调用方式变化时，同步相关协议、手册或分发 Skill；不要把规划能力写成已实现。

## 常用命令与验证

使用 Node.js 22+ 和 npm；首次安装依赖运行 `npm ci`。命令以 [package.json](package.json) 为准。

| 场景 | 命令 |
| --- | --- |
| 定向测试 | `node --test tests/<name>.test.ts` |
| 完整测试（含版本同步检查） | `npm test` |
| 类型检查及构建 | `npm run build` |
| 构建及 MCP smoke | `npm run test:smoke` |
| 完整开发检查 | `npm run check` |
| Markdown 链接检查 | `npm run docs:check-links -- <文件路径>` |

- 按改动范围运行相关测试；影响服务接入或构建时补充 smoke。纯文档改动检查相关链接即可，不要求重跑完整测试。
- 版本调整使用 `npm run version:set -- <版本>`，再运行 `npm run version:check`；打包入口查阅 `package.json` 中的 `package:*`。
- 交付时说明改动、实际运行的验证及未验证项；不要将构建或 smoke 通过等同于真实宿主验收通过。
