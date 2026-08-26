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

图库目录由你指定，不会悄悄写进当前项目。服务器**不执行**绘图代码。可选的外部
检索源只是补充，默认权威仍是 **Local Published**。

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
