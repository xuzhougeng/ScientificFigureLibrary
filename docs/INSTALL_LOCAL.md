# 本地客户端安装与使用

本地客户端是简单的图片—代码知识库，不内置 AI，也不执行模板代码。
macOS 使用原生 SwiftUI，Windows 与 Linux 使用本机网页；均提供内置 Node 和使用本机 Node 两种安装包。

## 选择是否携带 Node

- **默认包**（文件名不含 `no-node`）：内置 Node，无需安装 Node.js 或 npm。
- **本机 Node 包**（文件名含 `no-node`）：不含 Node，要求已安装 **Node.js 22+**；程序依赖已构建打包，不需要 `npm install`。缺失或版本过低时停止启动并提示。

macOS 两种架构、Windows x64、Linux x64 / arm64 都提供这两个版本。在线图库图片不会随安装下载，需要你在设置中对某个图库执行「缓存图片」，浏览或搜索该图库后查看当前页。

Windows 默认从 PATH 查找 `node.exe`。Linux 从 PATH 查找 `node`。macOS 从 Homebrew 常用位置和 App 的 PATH 查找；Finder 的 PATH 与终端可能不同。未能自动找到时，可在启动界面点击“选择本机 Node…”，指定可执行文件。CLI/MCP 可通过绝对路径环境变量 `SFL_NODE_BINARY` 指定。成功启动后，在 App 中复制的 MCP 配置使用实际选中的 Node 绝对路径。

## Windows ZIP

1. 下载 Windows x64 ZIP，解压整个文件夹。
2. 双击 `Start SFL.cmd`。本地服务窗口会保持打开，并在默认浏览器打开页面。
   若浏览器没有自动打开，把服务窗口里的地址复制到 Edge 或 Chrome。使用期间不要关闭该窗口。访问 GitHub 超时或连接被重置时，错误会显示在这个窗口。
3. 在「设置」中确认全局图库和本地工作区的绝对目录。同一页可配置系统代理和图片缓存。添加、移除或恢复 FigureYa 等来源请到「外部图库」；自己的资产在「我的图库」。默认不使用系统代理；若 Clash 等把 GitHub 解析到 198.18.x，请打开系统代理并填写本机回环地址（例如 `http://127.0.0.1:7897`）。
4. 使用“退出本地客户端”结束服务，再关闭页面。

内置 Node 版不需要安装 Node.js；本机 Node 版要求 Node.js 22+。请保留整个解压目录，不要单独移动 `node.exe`、`dist/` 或 `assets/`。
当前提供 x64 包；其他处理器架构不在此包的验证范围内。网页需要现代浏览器。

## Linux ZIP

1. 按处理器架构选择 ZIP：常见 PC 用 `linux-x64`，ARM 用 `linux-arm64`。
2. 解压整个文件夹，在终端运行 `./start-sfl.sh`。服务会保持在该终端中，并尝试用默认浏览器打开页面。
   若浏览器没有自动打开，把终端里打印的地址复制到 Firefox、Chrome 或 Chromium。使用期间不要关闭该终端。访问 GitHub 超时或连接被重置时，错误会显示在这个终端。
3. 在「设置」中确认全局图库和本地工作区的绝对目录。同一页可配置系统代理、对某个图库缓存图片。添加、移除或恢复外部来源请到「外部图库」。
4. 使用“退出本地客户端”结束服务，再关闭页面。

内置 Node 版不需要安装 Node.js；本机 Node 版要求 Node.js 22+。请保留整个解压目录，不要单独移动 `runtime/node`、`dist/` 或 `assets/`。
网页需要现代浏览器。本机 Node 版可设置 `SFL_NODE_BINARY` 指向绝对路径。

## macOS DMG

1. 按“关于本机”中的芯片选择 DMG：Apple Silicon（M 系列）用 `macos-arm64`，Intel 用 `macos-x64`。每个包仅携带对应架构的运行时。
2. 打开 DMG，将 `Scientific Figure Library.app` 拖入“Applications/应用程序”。
3. 打开 App，在设置中选择全局图库和本地工作区。

原生界面最低目标为 macOS 13。选择内置 Node 版即可免装运行时；`no-node` 版复用本机 Node.js 22+。

**预览版签名状态：当前产物使用 ad-hoc 签名，尚未经过 Developer ID 签名和 Apple 公证。**
macOS 可能阻止从网络下载的 App 首次运行；只在确认下载来源与校验信息后，按系统的
“隐私与安全性”提示允许该应用。此包不等同于已经完成正式签名分发的产品。

## 图片按需下载

本地安装包不携带 FigureYa 与 Open Figure Modules 的图库缩略图、精确预览图，仅保留目录、许可和图片校验信息。缓存必须由你主动触发某个图库：在「外部图库」或设置的「图片缓存」中对该图库执行「缓存图片」。打开「图库」即列出图片，搜索则按关键词筛选。浏览或搜索当前页时下载缩略图，打开精确预览时下载对应图片；FigureYa 使用同一张参考图。安装、启动或勾选系统代理都不会批量下载全部图库。

首次缓存或查看需要能访问 GitHub 的图片下载地址。下载校验成功后写入本机缓存，之后可离线复用；未缓存或下载失败的图片不能用于确认，恢复网络后重新对该图库执行「缓存图片」，或重新搜索、打开预览即可重试。自己的图库图片继续从指定的本地图库读取。

用户缓存与安装目录分开，统一放在「图库存储位置」下：

- 在线图片预览：`indexes/preview-cache/v1/`。
- 已确认的参考图片和代码：`indexes/reference-cache/`。
- FigureYa / Open Figure Modules 参考包：`source-packs/figureya/` 与 `source-packs/open-modules/`，整库「缓存参考包」与单张展开复用同一份已校验压缩包。旧版 `source-packs/references/` 不自动删除。
- 缓存状态数据库：`indexes/cache-state.sqlite`。它按图库身份记录预览图和参考包的缓存数量、扫描/缓存/校验时间及任务状态；只保存可重建的索引，不替代实际缓存文件。

设置页的「图片缓存」按图库列出可下载数量和已缓存数量，可对单个图库下载、复制路径或清除预览缓存，不删除完整参考副本。更换图库位置后，新预览缓存跟随新位置。旧版系统缓存不会自动迁移或删除，首次访问会重新下载。高级配置 `SFL_PREVIEW_CACHE_DIR` 仅允许指定当前图库内的子目录，外部路径会报错。清除已确认图片的缓存后，需要重新预览再保存模板。

图片下载固定到构建时的源码提交，逐张校验大小、SHA-256 和图片格式。它与已有的 Provider 来源更新是两个流程：已启用的 Open Figure Modules 自动更新仍会获取签名快照及其预览包。模板代码归档仍在材料化流程中单独确认下载。

## 外部 MCP 与 Skill

打开客户端侧边栏的 **连接外部工具** 页面，选择目标客户端：

1. Codex CLI / Desktop：复制添加命令或 TOML 片段；Claude Code：复制用户范围添加命令；Claude Desktop：按页面说明合并 JSON。
2. zcode、WorkBuddy 等其他客户端：复制通用 JSON，或分别复制命令、参数填写 stdio 配置。
3. 按页面说明通过 MCP 读取核心 Skill，或导入整个 Skill 文件夹。
4. 将页面中的验证指令发送给外部工具，确认能读取图库状态并展示候选图片。

页面显示真实的安装目录与当前 Node 路径，支持复制配置、命令、Skill 路径和验证指令；macOS 还可在 Finder 显示 Skill 文件。外部工具配置完成后可关闭 SFL 窗口。各外部会话的结果和确认凭据仍独立。

本地 App 直接调用共享业务服务。外部 CLI/Desktop 可以另行配置 MCP：

- 在「连接外部工具」中点击“复制 MCP 配置”，得到使用包内 Node 和后端绝对路径的配置。
- macOS 包同时提供 `Contents/MacOS/sfl-mcp`，可作为 stdio MCP 启动命令。
- Windows 包提供 `MCP.cmd`，Linux 包提供 `mcp.sh`，以及 Wisp/Codex/Claude/Cursor 的插件元数据。
- 一个核心 Skill 位于 Windows / Linux 包的 `skills/figure-library/`，或 macOS App 的
  `Contents/Resources/sfl/skills/figure-library/`。

各宿主对插件安装路径的处理不同；通用 MCP 配置是直接接入方式，真实宿主的插件安装
和图片呈现需要分别验收。不要同时安装插件和重复的原始 MCP 配置。

## 数据、更新和卸载

程序目录与知识库目录分开。更新时关闭客户端和使用旧程序的 MCP 进程，再替换程序；
不要覆盖用户指定的图库与工作区。旧会话的预览凭据和未应用计划不会跨重启继续使用。
删除程序不会自动删除用户图库。建议在升级前备份自己指定的知识库目录。

## 构建与验证

- Windows：`npm run package:windows`；本机 Node 版为 `npm run package:windows:no-node`
- Linux：`npm run package:linux`（x64）或 `npm run package:linux:arm64`；本机 Node 版为 `npm run package:linux:no-node` / `npm run package:linux:arm64:no-node`
- macOS：在 macOS/Xcode 环境运行 `npm run package:macos` 构建本机架构；显式入口为 `npm run package:macos:arm64` 和 `npm run package:macos:x64`，须在对应架构运行原生 smoke。
- 本机 Node 版 macOS：`npm run package:macos:no-node`；显式架构可运行 `node scripts/package-local-client.mjs macos-arm64 --system-node`（先构建）。
- 固定运行时来源与 SHA-256：`scripts/runtime/node-runtime.json`
- 每个安装文件旁提供 `.sha256` 校验文件。

构建检查、隔离数据下的应用 smoke、真实宿主的人工体验验收分别记录，不能相互替代。
