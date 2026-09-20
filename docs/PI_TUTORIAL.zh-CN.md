# Pi 安装与使用教程：连接 SFL，边看参考图边准备绘图代码

想让 AI 帮忙画一张 UMAP，通常需要先说明风格，再准备数据、找到代码，最后反复调整。如果能先看到一组真实参考图，选中喜欢的样式，再让 AI 接着处理代码，沟通就会具体很多。

这篇教程从安装 **Pi** 开始，介绍如何连接 **Scientific Figure Library（SFL）**，完成“搜索 UMAP → 看图选样式 → 确认模板保存位置 → 准备使用自己的数据绘图”的流程。

本文以 **SFL v0.8.1 / protocol v2** 的使用流程为例，路径和提示词均为教学示例，不代表已经完成实际绘图。Pi 安装与命令说明于 **2026-09-20** 按官方文档核对，实际界面可能随版本变化。

**01｜先认识三个组件**

| 组件 | 在这套流程中做什么 |
| --- | --- |
| Pi | 运行在终端里的 AI 编程助手，连接模型、读取项目文件、修改代码和调用工具 |
| pi-mcp-adapter | 为 Pi 接入 MCP 服务，并提供服务附带的交互页面 |
| SFL | 搜索和预览参考图，将选定版本的代码与参考材料保存到工作区 |

Pi 本身可以通过扩展增加能力，本教程使用 `pi-mcp-adapter` 连接 SFL。模型服务在 Pi 中配置；SFL 不内置模型，也不运行绘图代码。参见 [Pi 官方介绍](https://pi.dev/) 和 [adapter 使用说明](https://github.com/nicobailon/pi-mcp-adapter)。

**02｜安装 Pi**

本教程使用 npm 安装路线，需要本机有 **Node.js 22 或更新版本**，以满足 SFL 的运行要求。可从 [Node.js 官网](https://nodejs.org/en/download) 安装，安装后重新打开终端，检查：

```bash
node --version
npm --version
```

Windows 用户还应安装 [Git for Windows](https://git-scm.com/download/win)：Pi 默认通过 Git Bash 执行 shell 命令。本文的 Windows 安装命令可以在 PowerShell 中输入；Pi 启动后使用的 shell 按它自己的配置决定。参见 [Pi 的 Windows 配置说明](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/windows.md)。

在系统终端中运行：

```bash
npm install -g --ignore-scripts @earendil-works/pi-coding-agent
pi --version
```

这是核对时 [Pi 官方快速开始](https://pi.dev/docs/latest/quickstart) 提供的 npm 安装命令。能够打印版本号，说明 `pi` 命令已经可用。

接着准备一个工作目录。Windows PowerShell 示例：

```powershell
New-Item -ItemType Directory -Force -Path 'D:\SFL\Workspace' | Out-Null
Set-Location 'D:\SFL\Workspace'
pi
```

macOS / Linux 示例：

```bash
mkdir -p ~/SFL/Workspace
cd ~/SFL/Workspace
pi
```

后文以 Windows 路径为例。macOS / Linux 请换成自己机器上的绝对路径，例如 `/Users/你的用户名/SFL/Workspace` 或 `/home/你的用户名/SFL/Workspace`。如果 Pi 运行在 WSL，Windows 的 `D:\SFL\Workspace` 通常对应 `/mnt/d/SFL/Workspace`，安装命令、Node 和数据路径都要使用 Pi 所在的环境。

**03｜连接模型，先完成一次普通对话**

进入 Pi 后输入：

```text
/login
```

按照菜单选择自己使用的模型服务并完成认证，再通过 `/model` 选择模型。若使用 API Key，也可以按对应服务的环境变量配置；例如在 PowerShell 中临时设置 Anthropic Key 后启动 Pi：

```powershell
$env:ANTHROPIC_API_KEY = '替换为自己的 API Key'
pi
```

macOS / Linux 对应写法：

```bash
export ANTHROPIC_API_KEY='替换为自己的 API Key'
pi
```

只需选择一种适合自己的认证方式。其他服务的变量和配置见 [Pi Providers 文档](https://pi.dev/docs/latest/providers)，不要把真实 Key 粘贴到聊天消息或教程截图中。

先发送一个简单请求，确认模型与本机文件访问正常：

> 请告诉我当前工作目录，并列出目录中的文件。暂时不要修改文件。

日常使用可以先记住以下命令，均在 **Pi 对话输入框** 中输入：

| 命令 | 用途 |
| --- | --- |
| `/model` | 选择模型 |
| `/resume` | 选择历史会话 |
| `/new` | 开始新会话 |
| `/reload` | 重新加载扩展、Skill 和项目指令等资源 |
| `/quit` | 退出 Pi，返回系统终端 |

这些命令及更多操作见 [Pi 官方使用说明](https://github.com/earendil-works/pi/tree/main/packages/coding-agent)。下面的安装命令则需要回到系统终端执行。

**04｜安装 SFL 和 MCP 扩展**

在 Pi 中输入 `/quit`，然后在系统终端依次运行：

```bash
pi install npm:pi-mcp-adapter
pi install npm:scientific-figure-library
pi list
```

两个包分别提供 MCP 连接能力，以及 SFL 服务和 `figure-library` 核心 Skill。`pi list` 用来检查安装记录；安装后重新运行 `pi`。

**这里使用发布到 npm 的 SFL 包。** 不要直接用 `pi install` 安装 SFL 的 GitHub 地址，源码仓库没有构建好的 `dist/index.js`，会导致 MCP 服务无法启动。正常 npm 安装不需要自行编译，也不必另外下载 SFL 桌面客户端。具体安装约定见 [SFL 快速开始](QUICKSTART.md#pi)。

如果此前已经把 SFL 本地客户端提供的 MCP 配置接入 Pi，就沿用那份连接，跳过 `pi install npm:scientific-figure-library`，避免同一个服务出现两套工具。

重启 Pi 后，发送：

> 请检查 Scientific Figure Library 是否可用。先读取 figure_library_get_skill，再调用 figure_library_source_status，告诉我图库和工作区是否已绑定。如果需要首次设置，先说明缺少什么。

adapter 可能通过一个统一的 `mcp` 工具代理调用 SFL，因此日志中出现 `mcp call figure-library_...` 属于正常情况。普通用户不必手工复制这些工具调用。

**05｜首次使用，明确图库和工作区的位置**

如果返回 `setup_required`，需要指定两个目录：

| 目录 | Windows 示例 | 用途 |
| --- | --- | --- |
| 全局 Library | `D:\SFL\Library` | 长期保存自己的图库资产和参考缓存，跨项目复用 |
| 本地工作区 | `D:\SFL\Workspace` | 放置当前工作所需的模板副本和相关文件 |

可以把下面这段话发给 Pi，路径替换成自己的选择：

> 我的全局 Library 使用 D:\SFL\Library，本地工作区使用 D:\SFL\Workspace。请检查现有绑定，展示首次配置需要写入的具体计划，等我确认后应用，再复查状态。如果已经绑定到其他位置，请先告诉我。

核对展示的路径后确认即可。已完成绑定的用户可以直接检查现有状态，不必每次新建对话都重新配置。目录的作用和绑定流程见 [SFL 用户手册](USER_GUIDE.zh-CN.md#22-首次配置绑定两个目录)。

**06｜搜索 UMAP，先比较真实参考图**

现在可以直接用中文提出需求：

> 请在 SFL 中搜索适合单细胞分析的 UMAP 降维聚类分群展示模板，展示当前页候选图，并说明主要风格差异。先让我看图选择。

在候选画廊中，可以比较不同 UMAP 风格：突出密度热点的暗夜风格、标记群体范围的半透明椭圆风格，以及结合外圈注释的 Circos 风格。实际候选以当次搜索结果为准。结合自己的展示目的，打开 **“查看详情”**，检查用途、输入要求和配套代码。

点击标题或卡片空白处可以勾选，是否选中以“已选”标记和计数为准。卡片上的“匹配度 100”是检索得分，不代表这个模板已经适合你的数据，也不代表科学验证通过。

浏览器画廊由 adapter 承载；它支持在浏览器中打开 MCP 服务的交互页面。使用时应打开自己会话生成的地址。参见 [adapter 的 MCP UI 说明](https://github.com/nicobailon/pi-mcp-adapter#mcp-ui-integration)。

如果没有弹出画廊，可以让 Pi 检查 MCP 页面是否被关闭，或通过候选图片工具展示真实图片。终端、模型和宿主的图片能力可能不同，应以实际看到的图片为准。

**07｜选定暗夜风格，再确认保存位置**

找到喜欢的模板后，可以在 Pi 对话中说：

> 我选“暗夜密度热力 UMAP”。请核对这个候选的来源和精确版本，展示并审阅对应预览，然后生成模板获取计划。父目录使用 D:\SFL\Workspace，先告诉我最终保存路径、文件范围，以及是否需要联网。

Pi 需要完成选定版本的精确预览与确认流程，取得预览回执，再准备物化计划。“物化”在这里表示把选定模板的代码和参考材料保存到工作区。

生成计划时尚未写入模板文件，Pi 应展示计划并等待确认。

普通用户重点核对三项：

1. **模板是否正确**：名称、来源和预览是否对应自己选中的那张图。
2. **文件保存到哪里**：查看最终绝对路径，而不只看自己最初输入的目录。
3. **准备获取什么**：模板文件范围，以及是否需要联网下载归档。

SFL 会在传入的父目录下追加模板 ID。如果想保存到 `D:\SFL\Workspace\umap-style-density-heatmap`，父目录应填 `D:\SFL\Workspace`，避免重复追加模板名。最终以计划展示的路径为准；若路径需要调整，先请 Pi 重新生成计划，再确认。

如果计划中写着 `allowNetwork: false`，表示这次模板归档获取计划仅使用本地材料；它不代表首次安装无需联网，也不代表先前的预览图片没有下载。新安装如果缺少归档，Pi 应说明需要下载什么，并重新展示相应计划。

`previewReceipt`、`SHA256` 和 `Plan digest` 用于关联所选预览、模板版本与写入计划，由工具处理即可，不需要手工复制。

核对无误后，可以回复：

> 确认按刚才展示的计划，将模板保存到该目录。完成后请列出实际文件和模板锁文件的位置。

浏览器右上角的 **Done** 用于结束该页面交互；勾选卡片、结束页面、确认精确预览和批准写入是不同步骤。写入前的确认对应具体计划，相关约定见 [SFL 物化流程](USER_GUIDE.zh-CN.md#3-模板浏览搜索与提交绘图任务)。

**08｜模板拿到后，再让 Pi 使用自己的数据**

当 Pi 报告获取成功后，先查看真实输出目录和文件清单。`template.lock.json` 记录模板来源与身份；模板准备完成后，还需要实际运行脚本并检查图片。

下面是一段继续绘图的示例提示词。请替换数据路径、列名、输出目录和已经准备好的 R 环境：

> 请读取刚才获取的模板说明与代码。我的 UMAP 坐标位于 D:\Data\umap.csv，包含 cell_id、UMAP_1、UMAP_2、cell_type 四列，使用文件中已有的坐标，不重新计算降维。
>
> 请先检查列名、缺失值和模板输入要求，再在 D:\SFL\Workspace\analysis 中另存适配脚本，保留原始模板。沿用所选参考图的暗色背景和密度表现方式，按 cell_type 标注细胞类型。
>
> 使用我已准备好的项目 R 环境运行；如果缺少依赖，请说明缺少什么。导出 PNG 和 PDF，展示实际生成的图片，并报告运行命令、输出路径和错误信息。

这一阶段由 Pi 读取数据、修改代码并执行绘图，SFL 提供参考材料。R/Python 环境和绘图依赖需要另行准备；本机能运行 Node.js 并不意味着已经能运行 R 模板。

确认成功要看实际运行结果与输出图片。若只拿到了模板，教程流程目前就停在“参考材料准备完成”，不能当作已经复现了图。

**遇到问题时，先检查这些位置**

| 现象 | 如何继续 |
| --- | --- |
| 找不到 `pi` 命令 | 重新打开终端，检查 Node/npm 和全局 npm 命令路径 |
| Pi 启动了但模型不响应 | 先检查 `/login` 与 `/model`，用普通对话验证模型连接 |
| 找不到 SFL 工具 | 在系统终端用 `pi list` 检查两个包，重启 Pi；在 Pi 中用 `/mcp` 查看服务状态，再尝试读取 SFL 状态 |
| 找不到 `dist/index.js` | 检查是否误装了未构建的源码；改用发布的 npm 包 |
| 返回 `setup_required` | 明确提供全局 Library 和工作区路径，完成绑定计划确认 |
| 有文字候选，但没有图片 | 检查图片传输和页面状态；让 Pi 获取真实候选图片，确认当前宿主是否能够展示 |
| 页面关闭后 Pi 没接到选择 | 回到对话说明模板名称，让 Pi 对照当前候选确认身份，完成精确预览流程 |
| 提示本地归档不齐 | 让 Pi 说明下载内容和网络策略，重新准备获取计划 |
| 预览回执或计划过期 | 按工具提示重新搜索、预览和确认，不复用截图或历史消息中的令牌 |
| 模板已保存，但没有生成图片 | 继续检查数据、R/Python 环境和运行日志，执行适配后的脚本 |

`/mcp` 是 adapter 提供的入口，安装说明和服务诊断可查 [adapter 文档](https://github.com/nicobailon/pi-mcp-adapter)。第一次使用，可以按这个顺序操作：**先在画廊里比较 UMAP，再回到 Pi 核对模板获取计划**。
