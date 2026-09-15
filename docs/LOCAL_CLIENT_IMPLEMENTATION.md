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
- [x] macOS 私有 Node、按 arm64 / x64 分别原生编译的 App 与 DMG；原生窗口和核心业务 smoke 通过。Developer ID 签名与公证尚未配置。
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

- `npm run check`：334 项测试通过，类型检查、两种 Web 入口构建及原有 56 个 MCP 工具的 stdio smoke 通过。
- 本地 HTTP 集成测试：认证、Origin/Host 校验、一次性连接、绑定、上传、导入、审阅、发布、资产读取、本地精确确认、材料化及重放。
- 同一业务实例的直接调用与真实外部 MCP Client 调用共用状态，另一业务会话不能使用其 receipt；关闭后直接操作和资源读取被拒绝。
- Linux 浏览器实测：目录绑定、搜索、六张候选图加载、精确图片确认、保存计划入口、复制引用和退出。检查了页面布局；本地界面没有 AI/Agent 操作控件。
- macOS 原生 smoke 覆盖窗口创建、图片解码、绑定、导入、发布、预览确认、材料化和重放；Windows ZIP 的内置运行时与文件清单校验通过。
- 客户端为未公证预览版，更完整的编辑交互、真实宿主人工验收和正式签名分发尚未完成。


## 0.8.0 轻量安装包

- macOS 拆分为 arm64 / x64，分别只携带本架构的 SwiftUI、MCP 启动器和 Node；Windows 与 Linux 使用内置 Node 和本地网页。Linux 提供 x64 / arm64 ZIP。
- 本地安装包排除 388 个图库图片文件，保留原始目录与预览身份。打包生成固定源码提交的下载描述；只在读取相应图片时下载，并在安装目录外缓存。源码仓和传统插件快照仍保留图片。
- 下载单测覆盖仅按需读取、并发去重、缓存离线读取、损坏修复、固定身份与路径检查。材料化重验证不会触发新的图片下载。
- 平台打包 smoke 检查安装包携带固定提交的按需预览清单，并用本地导入图验证 NSImage 解码；真实缩略图与精确预览下载属于安装后浏览，不作为打 DMG 的门槛。新架构产物需分别通过平台工作流后分发。
- 本地网页与 macOS 设置页显示按需预览缓存目录和占用，并支持清除；macOS 设置同时列出图片来源。

- 同时提供 `no-node` 包，移除运行时并检查本机 Node.js 22+。macOS 的 App 与外部启动器共用 Node 定位逻辑；Windows 与 Linux 通过启动脚本检测 PATH 或明确指定路径。


## 外部工具连接说明页

Windows 网页与 macOS 原生 App 提供独立“连接外部工具”页面，共享只读 `/api/integrations` 数据。页面包含 Codex CLI/Desktop、Claude Code、Claude Desktop 与其他 stdio 客户端说明，可复制实际运行时配置、命令、Skill 路径和验证指令，不自动修改其他应用配置。

命令和配置格式参考 [Codex 官方 MCP 文档](https://developers.openai.com/codex/mcp/)、[Claude Code 官方文档](https://code.claude.com/docs/en/mcp) 和 [MCP 本地客户端指南](https://modelcontextprotocol.io/docs/develop/connect-local-servers)。zcode / WorkBuddy 使用通用配置说明，具体版本的安装和图片显示仍需宿主验收。


本轮验证补充：334 项测试及 56 个 MCP 工具 smoke 通过；网页已实测四种接入说明的切换、剪贴板内容一致性和页面布局。修复了本地随机资产 ID 含 `3d` 时误触发三维图降权的问题，以固定 ID 的真实导入、发布和检索流程覆盖回归。原生连接说明页与最终安装包继续通过平台工作流验证。
