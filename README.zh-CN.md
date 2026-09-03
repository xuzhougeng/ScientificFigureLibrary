<p align="center">
  <img src=".github/assets/sfl-banner.svg" alt="Scientific Figure Library：本机优先的科学图库 MCP App，用于 Claude Science 与 Wisp Science。" width="100%" />
</p>

# Scientific Figure Library

[Website](https://xuzhougeng.github.io/ScientificFigureLibrary/) ·
[English](README.md) ·
[快速开始](docs/QUICKSTART.md) ·
[协议说明](docs/PROTOCOL.md) ·
[Releases](https://github.com/xuzhougeng/ScientificFigureLibrary/releases)

Scientific Figure Library（SFL）是**本机优先**的 MCP 服务和 MCP App：把你自己的
科学图和代码收入**本机一份全局 Library**，审阅后发布成不可变 Release，再在
**Claude Science**、**Wisp Science**、**Codex** 等宿主里跨项目复用。

图库目录由你指定，不会悄悄写进当前项目。服务器**不执行**绘图代码。默认检索顺序为
**Local Published → FigureYa → Open Figure Modules → 已启用的动态个人 Provider**。
Community 代码和旧资产保留用于显式兼容访问，但已冻结，且不再参与默认搜索
（`includeInDefaultSearch: false`）。你自己的图形仍以 **Local Published** 为权威。

<p align="center">
  <img src="docs/assets/sfl-gallery.png" alt="Scientific Figure Library：浏览本机已发布的科学图模板。" width="100%" />
</p>

## 安装

```text
从 https://github.com/xuzhougeng/ScientificFigureLibrary 安装。按
docs/QUICKSTART.md。需要 Node.js 22+。stdio MCP 名称 figure-library，
入口 dist/index.js。Wisp Science 用 npm run package:wisp 后安装插件。
先绑定一个本机全局 Library 目录。不要运行用户绘图脚本。
```

完整工具契约见 [docs/PROTOCOL.md](docs/PROTOCOL.md)。

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

SFL 核心仓库只内置 `assets/personal-modules/` 下的派生 Catalog、预览清单、主预览、
缩略图和许可说明，不内置完整个人 ZIP、Gallery 源图、私有数据、凭证或仓库状态。
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
