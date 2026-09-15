# 本地客户端实施记录

目标：完成 [本地客户端规划](LOCAL_CLIENT.md) 的 macOS SwiftUI App、Windows 内置 Node 的网页客户端、共享 MCP/Skill 接入及简化 MCP App。以下是进度，不是缩减后的交付范围。

## 验收清单

- [x] 独立共享业务服务与受限本地 HTTP API；原 MCP stdio 接入保持可用。
- [x] 本地界面与外部 MCP 适配共享业务及会话规则；跨会话凭据拒绝，既有过期检查通过回归测试。
- [x] 本地界面精确预览确认，保留 plan/apply、一次性 receipt 和重放。
- [ ] Windows 网页：首次绑定、搜索、图片列表、精确预览、选择、材料化。
- [ ] Windows 网页：本地知识库列表、图片/代码导入、审阅、发布与历史。
- [x] Windows 包内 Node、独立启动入口及 MCP 配置；已验证子进程 PATH 不包含系统 Node。具体宿主插件安装仍需逐一验收。
- [ ] macOS SwiftUI：与网页相同的核心知识库流程、原生窗口和目录选择。
- [x] macOS 私有 Node、两种架构原生编译、Universal App 与 DMG；原生窗口和核心业务 smoke 通过。Developer ID 签名与公证尚未配置。
- [ ] MCP App 保持简化候选交互；Skill、协议、双语手册和分发说明同步。
- [ ] 本地服务安全、退出/断开、并发写入与更新行为验证。

## 连接设计

本地 App 不加入 AI、模型调用或任务编排。它直接通过本地 HTTP 接口调用共享图库业务层；外部 CLI/Desktop 才通过 MCP Server 接入。新增的内部 MCP Client、内存协议连接和 stdio 代理已移除。

`src/library-service.ts` 管理图库业务和会话，`src/service/operations.ts` 提供输入校验与普通函数调用，`src/server.ts` 和 `src/mcp-adapter.ts` 负责外部 MCP 适配。原有 MCP SDK、工具清单和外部调用方式保留。需要同时提供两种入口时，它们可持有同一业务实例，无需协议套接或凭据复制。

本地服务绑定 loopback 的动态端口。浏览器通过一次性启动凭据建立同源会话，SwiftUI 通过私有启动通道取得凭据。界面 API 按操作白名单直接调用共享业务；不开放通用 shell 或任意文件下载。本地图片确认使用独立的 local 模式，保留精确资产和传输图片身份。网页中的多选仅用于复制资产信息，不创建 Agent 任务或轮询 Agent 状态。

macOS 原生界面使用同样的 HTTP 数据契约。Node/TypeScript 核心只维护一份；SwiftUI 原生构建和运行必须在 macOS 上验证，Linux 检查不替代该验证。

## 当前环境

- 开发环境为 Linux/WSL2；已使用 Windows 宿主验证内置运行时，并通过 GitHub Actions macOS/Windows runner 构建和验证平台产物。
- 平台 smoke 使用隔离数据和受限 PATH。完整的终端用户人工安装与宿主插件验收仍待完成。

## 已执行的验证

- `npm run check`：326 项测试通过，类型检查、两种 Web 入口构建及原有 56 个 MCP 工具的 stdio smoke 通过。
- 本地 HTTP 集成测试：认证、Origin/Host 校验、一次性连接、绑定、上传、导入、审阅、发布、资产读取、本地精确确认、材料化及重放。
- 同一业务实例的直接调用与真实外部 MCP Client 调用共用状态，另一业务会话不能使用其 receipt；关闭后直接操作和资源读取被拒绝。
- Linux 浏览器实测：目录绑定、搜索、六张候选图加载、精确图片确认、保存计划入口、复制引用和退出。检查了页面布局；本地界面没有 AI/Agent 操作控件。
- macOS 原生 smoke 覆盖窗口创建、图片解码、绑定、导入、发布、预览确认、材料化和重放；Windows ZIP 的内置运行时与文件清单校验通过。
- 客户端为未公证预览版，更完整的编辑交互、真实宿主人工验收和正式签名分发尚未完成。
