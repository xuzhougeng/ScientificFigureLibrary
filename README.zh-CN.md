<p align="center">
  <img src=".github/assets/sfl-banner.svg" alt="Scientific Figure Library：本机优先的科学图库 MCP App，用于 Claude Science 与 Wisp Science。" width="100%" />
</p>

# Scientific Figure Library

[Website](https://xuzhougeng.github.io/ScientificFigureLibrary/) ·
[English](README.md) ·
[快速开始](docs/QUICKSTART.md) ·
[用户手册（在线）](https://github.com/xuzhougeng/ScientificFigureLibrary/blob/main/docs/USER_GUIDE.zh-CN.md) ·
[协议说明](docs/PROTOCOL.md) ·
[Releases](https://github.com/xuzhougeng/ScientificFigureLibrary/releases)

Scientific Figure Library（SFL）是**本机优先**的 MCP 服务和 MCP App：把你自己的
科学图和代码收入**本机一份全局 Library**，审阅后发布成不可变 Release，再在
**Claude Science**、**Wisp Science**、**Codex**、**Cursor**、**Pi**、**dsh** 等宿主里跨项目复用。

图库目录由你指定，不会悄悄写进当前项目。服务器**不执行**绘图代码。默认检索顺序为
**Local Published → FigureYa → Open Figure Modules → 已启用的动态个人 Provider**。
Community 代码和旧资产保留用于显式兼容访问，但已冻结，且不再参与默认搜索
（`includeInDefaultSearch: false`）。你自己的图形仍以 **Local Published** 为权威。

<p align="center">
  <img src="docs/assets/sfl-gallery.png" alt="Scientific Figure Library：浏览本机已发布的科学图模板。" width="100%" />
</p>

## 本地客户端预览版

提供 macOS 原生 Apple Silicon / Intel 独立 DMG，以及内置 Node 的 Windows 与 Linux ZIP。均提供内置 Node 与使用本机 Node.js 22+ 的 `no-node` 版；图库预览按需下载。安装方式和签名限制见
[本地客户端安装说明](docs/INSTALL_LOCAL.md)。macOS 预览版尚未经过 Developer ID 签名和 Apple 公证。

## 安装

```text
从 https://github.com/xuzhougeng/ScientificFigureLibrary 安装。按
docs/QUICKSTART.md。需要 Node.js 22+。stdio MCP 名称 figure-library，
入口 dist/index.js。Wisp Science 用 npm run package:wisp 后安装插件。Cursor 用 npm run package:cursor，解压到 ~/.cursor/plugins/local/figure-library/。Pi：pi install npm:pi-mcp-adapter 后 pi install npm:scientific-figure-library。dsh：dsh plugin --profile web add scientific-figure-library。
先绑定本机全局绘图仓库（Library）和本地工作区。不要运行用户绘图脚本。
```

完整工具契约见 [docs/PROTOCOL.md](docs/PROTOCOL.md)。

## 模板说明与内置 Skills

Wisp、Codex、Claude、Cursor 插件以及 Pi / dsh 使用的 npm 包均分发一个核心 figure-library Skill，描述、代码组织和
风格指导作为按需资料。普通 MCP 宿主可用 `figure_library_get_skill` 读取同源指导，
用 `figure_library_get_candidate_images` 或资源 URI 获取候选缩略图，再通过
`figure_library_search_page` 翻页；MCP App 为可选界面。复刻默认保持
参考模板的风格；真正绘图仍需要项目批准的 R/Python 环境和宿主执行/看图工具。

详情页以安全 Markdown 渲染需求描述、应用场景和数据特征，实际输入文件、代码文件、
依赖包默认可见；技术与验证信息保留在折叠区。旧模板只做兼容读取，不批量重写。
缺少论文背景时不会自动补造生物学结论。

## 开发验证

本地使用 Node.js 22+，执行 `npm ci` 和 `npm run check`。
PR 的基础 CI 覆盖 Linux、Windows、macOS 上的测试、类型检查、构建和 MCP smoke。
检查矩阵与合并门禁配置见 [基础 CI](docs/CI.md)。
推送稳定标签 `vX.Y.Z` 会打包本地客户端、宿主插件、npm 包和 Wisp 更新 feed，并上传到 GitHub Release。
维护者也可配置 [AI 评论 bot](docs/COMMENT_BOT.md)，手动生成 Issue 回复建议和 PR 审查评论。

## 许可证

本仓库代码 MIT。用户导入的图保留导入时记录的许可证。

## Open Figure Modules

个人模块使用一个内容仓库同时保存清洗后的模块源码和确定性 ZIP，不再拆分第二个
归档仓库：

```text
<PERSONAL_MODULE_REPOSITORY>
├── modules/<moduleId>/       # 审核后的公开清洗模块
├── archives/<moduleId>.zip  # 从固定 source commit 生成的 ZIP
└── catalog/                  # 归档清单和准入记录
```

SFL 插件仍内置 `assets/personal-modules/` 作为离线 bootstrap Catalog、预览/缩略图和许可说明。安装带更新器的版本后，SFL 会在 MCP 进程运行时异步检查个人仓 `open-figure-feed` 上的 signed feed；验证成功后原子切换本地 overlay。普通模板新增/更新/撤下不再需要重新打包插件。插件不包含完整 ZIP、Gallery 源图、私有数据、凭证或签名私钥。搜索不等待网络；`figure_library_list_provider_sources` 保持离线。官方 channel 只允许 `configure autoRefresh` 和显式 `update`，不允许 add/remove/trust_reset。

运行时的完整 Open Figure Modules 不放进插件，而是保存在已经绑定的全局 Library 下：
`source-packs/open-modules/`。固定版本 archive 完整校验成功后会自动持久化，并保留
ZIP 和解压后的模板缓存。GitHub 仓库与固定 commit 仍是 canonical 身份；Gitee
镜像已随插件内置为默认国内下载加速来源，失败时回退 GitHub；用户仍可通过本地
override 覆盖传输顺序，但不能改变 canonical 身份。Local Published 仍直接读取全局
Library 的 `store/`，不会使用这个 Source Pack，也不会因为 Gitee 镜像而改变。
FigureYa 也遵循同样的写穿缓存规则，保存在并列的
`source-packs/figureya/`：固定 archive 校验成功后保留 ZIP，更新
`figureya-source-pack.manifest.json`，并写入派生的 `templates/` 缓存。搜索和预览仍然只读，
只有获批的 Materialize Apply 才会执行这个持久化动作。
维护命令是离线的，并且不会创建仓库、commit、push、运行 R、安装依赖或修改
Gallery：

```text
npm run modules:validate -- --check --repository <PERSONAL_MODULE_REPOSITORY>
npm run modules:archive -- --write --repository <PERSONAL_MODULE_REPOSITORY>
npm run modules:catalog -- --write --repository <PERSONAL_MODULE_REPOSITORY>
npm run modules:source-pack -- --write --repository <PERSONAL_MODULE_REPOSITORY>
```

SFL materialize 只读取或下载用户选中的固定 ZIP，校验字节和安全路径，按
`template/full` 选择文件并写入锁；`codeExecutedBySflClient` 始终为 `false`。
