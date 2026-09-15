# 本地客户端安装与使用

本地客户端是简单的图片—代码知识库，不内置 AI，也不执行模板代码。
macOS 使用原生 SwiftUI，Windows 使用本机网页；两端均随包携带 Node 运行时。

## Windows ZIP

1. 下载 Windows x64 ZIP，解压整个文件夹。
2. 双击 `Start SFL.cmd`，本地服务启动后会在默认浏览器打开页面。服务窗口会最小化。
3. 在“设置与连接”中确认全局图库和本地工作区的绝对目录。
4. 使用“退出本地客户端”结束服务，再关闭页面。

不需要安装 Node.js 或 npm。请保留整个解压目录，不要单独移动 `node.exe`、`dist/` 或 `assets/`。
当前提供 x64 包；其他处理器架构不在此包的验证范围内。网页需要现代浏览器。

## macOS DMG

1. 按“关于本机”中的芯片选择 DMG：Apple Silicon（M 系列）用 `macos-arm64`，Intel 用 `macos-x64`。每个包仅携带对应架构的运行时。
2. 打开 DMG，将 `Scientific Figure Library.app` 拖入“Applications/应用程序”。
3. 打开 App，在设置中选择全局图库和本地工作区。

原生界面最低目标为 macOS 13。应用内已携带 Node，不需要使用 Homebrew 或 npm。

**预览版签名状态：当前产物使用 ad-hoc 签名，尚未经过 Developer ID 签名和 Apple 公证。**
macOS 可能阻止从网络下载的 App 首次运行；只在确认下载来源与校验信息后，按系统的
“隐私与安全性”提示允许该应用。此包不等同于已经完成正式签名分发的产品。

## 图片按需下载

本地安装包不携带 FigureYa 与 Open Figure Modules 的图库缩略图、精确预览图，仅保留目录、许可和图片校验信息。浏览搜索结果时下载当前页缩略图，打开精确预览时下载对应图片；FigureYa 使用同一张参考图。

首次查看需要能访问 GitHub 的图片下载地址。下载校验成功后写入本机缓存，之后可离线复用；未缓存或下载失败的图片不能用于确认，恢复网络后重新搜索或打开预览即可重试。自己的图库图片继续从指定的本地图库读取。

缓存与安装目录分开：

- macOS：`~/Library/Caches/ScientificFigureLibrary/previews/v1`
- Windows：`%LOCALAPPDATA%/ScientificFigureLibrary/preview-cache/v1`

关闭 App 和使用它的 MCP 进程后，可以删除缓存以释放空间；后续查看会重新下载。测试或高级配置可通过绝对路径 `SFL_PREVIEW_CACHE_DIR` 指定缓存目录。清除已确认图片的缓存后，需要重新预览再保存模板。

图片下载固定到构建时的源码提交，逐张校验大小、SHA-256 和图片格式。它与已有的 Provider 来源更新是两个流程：已启用的 Open Figure Modules 自动更新仍会获取签名快照及其预览包。模板代码归档仍在材料化流程中单独确认下载。

## 外部 MCP 与 Skill

本地 App 直接调用共享业务服务。外部 CLI/Desktop 可以另行配置 MCP：

- 在 App 设置中点击“复制 MCP 配置”，得到使用包内 Node 和后端绝对路径的配置。
- macOS 包同时提供 `Contents/MacOS/sfl-mcp`，可作为 stdio MCP 启动命令。
- Windows 包提供 `MCP.cmd`，以及 Wisp/Codex/Claude/Cursor 的插件元数据。
- 一个核心 Skill 位于 Windows 包的 `skills/figure-library/`，或 macOS App 的
  `Contents/Resources/sfl/skills/figure-library/`。

各宿主对插件安装路径的处理不同；通用 MCP 配置是直接接入方式，真实宿主的插件安装
和图片呈现需要分别验收。不要同时安装插件和重复的原始 MCP 配置。

## 数据、更新和卸载

程序目录与知识库目录分开。更新时关闭客户端和使用旧程序的 MCP 进程，再替换程序；
不要覆盖用户指定的图库与工作区。旧会话的预览凭据和未应用计划不会跨重启继续使用。
删除程序不会自动删除用户图库。建议在升级前备份自己指定的知识库目录。

## 构建与验证

- Windows：`npm run package:windows`
- macOS：在 macOS/Xcode 环境运行 `npm run package:macos` 构建本机架构；显式入口为 `npm run package:macos:arm64` 和 `npm run package:macos:x64`，须在对应架构运行原生 smoke。
- 固定运行时来源与 SHA-256：`scripts/runtime/node-runtime.json`
- 每个安装文件旁提供 `.sha256` 校验文件。

构建检查、隔离数据下的应用 smoke、真实宿主的人工体验验收分别记录，不能相互替代。
