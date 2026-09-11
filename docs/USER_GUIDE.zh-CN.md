# Scientific Figure Library 用户手册

[English](USER_GUIDE.md) | 简体中文 · [返回 README](../README.zh-CN.md)

本手册面向第一次使用 Scientific Figure Library(SFL)的科研用户,按
"目录 → 图型/功能 → 数据准备 → 调用示例 → 输出与再次修改" 组织。
手册与英文版 [USER_GUIDE.md](USER_GUIDE.md) 结构和技术标识保持一致。

正文中用三种标记区分状态,避免把规划中的能力当成已有功能:

| 标记 | 含义 |
| --- | --- |
| ✅ 已实现 | 当前版本已交付,可直接使用 |
| 🤖 宿主模型执行 | 由 Claude/Codex/Cursor 等宿主里的模型完成,通常需要你确认 |
| 🕓 规划中 | 仍在 issue 讨论中,尚未实现;本手册如实标注 |

## 目录

1. [项目能力边界](#1-项目能力边界)
2. [安装与首次配置](#2-安装与首次配置)
3. [模板浏览、搜索与确认](#3-模板浏览搜索与确认)
4. [图型索引(按用途)](#4-图型索引按用途)
5. [准备你自己的图与数据](#5-准备你自己的图与数据)
6. [字体、配色、尺寸与导出调整](#6-字体配色尺寸与导出调整)
7. [输出查看与重绘](#7-输出查看与重绘)
8. [常见问题](#8-常见问题)
9. [进阶参考](#9-进阶参考)

附录:

- [附录 A:端到端示例](#附录-a端到端示例)
- [附录 B:索引再生成与链接检查](#附录-b索引再生成与链接检查)

---

## 1. 项目能力边界

SFL 是一个**本机优先**的 stdio MCP 服务器加 MCP App。它把你的科学图和绘图代码
收纳到本机一份全局 Library,审阅后发布为不可变 Release,再跨项目、跨宿主精确复用。

整个流程涉及三方,每一步由谁完成请始终问自己:

| 角色 | 是谁 | 负责什么 |
| --- | --- | --- |
| 你 | 科研用户 | 选目录、确认路径与模板、提供数据、要求绘图 |
| 宿主模型 | Claude Science / Wisp Science / Codex / Cursor / Claude Code 里的编码代理 | 检查文件、调用 SFL 工具、修改绘图代码、在批准的运行时里执行 |
| SFL 服务器 | `figure-library` MCP 服务器 | 哈希、版本化、审阅门禁、发布与精确物化(materialize)模板 |

**SFL 做什么(✅ 已实现):**

- 维护本机**一份全局 Library**,一个用户选定的目录,跨项目、跨宿主共享
- 图+代码的**直接导入**:不可变 Revision、审阅记录与 Release
- MCP App 画廊:浏览、精确预览、用户确认后才继续
- 统一检索,默认顺序:**Local Published → FigureYa → 内置 Open Figure Modules → 已启用并显式参与默认搜索的动态个人 Provider**;Community 快照已冻结,不参与默认搜索
- **精确物化(materialize)**:把你确认的那一个模板复制进项目,目标目录永不覆盖,并写入 `template.lock.json`
- 便携备份/恢复/分叉(bundle export / full restore)

**SFL 不做什么(✅ 边界同样已实现):**

- **不执行绘图代码**,也不内置第二个模型;`template.lock.json` 里始终记录 `codeExecutedBySflClient: false`
- 不悄悄写入当前项目;没有绑定全局 Library 之前,写入一律失败(fail closed)
- 不把上游的审核状态说成本地验证:FigureYa 模板标记为 `not_reviewed`、代码 `not_run`

**宿主模型负责什么(🤖):** 真正改代码、跑 R/Python、看图、迭代,都发生在宿主会话里,
依赖项目里你批准的运行时和宿主的看图工具。SFL 的三个辅助 Skill
(figure-description、figure-organization、figure-style)为这些行为提供指导,详见
[第 9 节](#9-进阶参考)。

**规划中(🕓,截至本手册编写时均未实现):**

- [#17](https://github.com/xuzhougeng/ScientificFigureLibrary/issues/17):持久保存用户绘图规范(style profile)并在后续会话自动应用——当前字体、配色等偏好只在你当次会话内有效
- [#18](https://github.com/xuzhougeng/ScientificFigureLibrary/issues/18):用户可见的科研绘图提示与需求表达示例——目前请参考本手册[第 6 节](#6-字体配色尺寸与导出调整)的提问示例
- [#19](https://github.com/xuzhougeng/ScientificFigureLibrary/issues/19):默认落实"一图一文件夹"归档与投稿打包——当前由宿主模型按你的要求临时组织,见[第 7 节](#7-输出查看与重绘)

---

## 2. 安装与首次配置

**准备(你):** Node.js 22 或更新版本;任一 stdio MCP 宿主(Wisp Science、
Claude Science、Codex、Claude Code、Cursor 等)。

### 2.1 安装方式(任选其一)

**方式 A:让编码代理帮你装(推荐给新用户)。** 把本仓库给 Claude Code、Codex、
Cursor 等有终端权限的本地编码代理,并粘贴以下请求(✅ 已实现,安装器即本仓库文档):

```text
Install Scientific Figure Library from
https://github.com/xuzhougeng/ScientificFigureLibrary.

Follow docs/QUICKSTART.md. Prefer a GitHub Release ZIP when one is published.
Node.js 22+ is required. Register the stdio MCP server as figure-library
pointing at dist/index.js. For Wisp Science, use npm run package:wisp and
install the generated plugin. For Cursor, use npm run package:cursor and unzip
into ~/.cursor/plugins/local/figure-library/. Bind one global Library directory on disk.
Do not execute user plotting code. First test: open or source_status; if
setup_required, bind the global Library and Local workspace before searching.
Tell me when I need to grant folder access or start a new host session.
```

**方式 B:Wisp Science 插件(🤖 宿主打包,你安装)。** `npm run package:wisp`
生成 ZIP,在 Wisp **Settings → Plugins** 安装并启用,然后新开会话。

**方式 C:Cursor 本地插件。** `npm run package:cursor` 生成 ZIP,解压到
`~/.cursor/plugins/local/figure-library/`,重启 Cursor。

**方式 D:从源码运行。**

```bash
git clone https://github.com/xuzhougeng/ScientificFigureLibrary.git
cd ScientificFigureLibrary
npm ci
npm run check
node dist/index.js
```

```json
{
  "mcpServers": {
    "figure-library": {
      "command": "node",
      "args": ["/absolute/path/to/ScientificFigureLibrary/dist/index.js"]
    }
  }
}
```

注意:不要同时注册裸 MCP 配置**和**宿主插件,那会重复暴露工具。

### 2.2 首次配置:绑定两个目录

新安装处于 `setup_required` 状态,直到两个目录都绑定完成。**全局 Library**
(绘图仓库)是全机唯一一份;**本地工作区**是当前项目侧的工作目录。

| 步骤 | 谁做 | 工具/操作 |
| --- | --- | --- |
| 1. 检查状态 | 宿主模型 | 调 `figure_library_source_status` 或 `figure_library_open`,确认 `setup_required` |
| 2. 你提供两个**绝对路径** | 你 | 如 `D:\figure-library` 与当前项目目录;不要随手用当前项目当全局 Library |
| 3. 生成绑定计划 | 宿主模型 | `figure_library_plan_bind_global` / `figure_library_plan_bind_workspace`,并把确切路径、`libraryId`、`planDigest` 展示给你 |
| 4. 确认路径 | 你 | 核对计划里展示的路径无误后确认 |
| 5. 应用绑定 | 宿主模型 | 同一会话内 `figure_library_apply_bind_global` / `figure_library_apply_bind_workspace` |
| 6. 复查 | 宿主模型 | 再次 `figure_library_source_status`,确认写入已启用、计数正确 |

绑定信息记录在本机 locator 文件中(Windows:
`%APPDATA%\ScientificFigureLibrary\locator.json`;Linux/WSL:
`~/.config/scientific-figure-library/locator.json`)。`FIGURE_LIBRARY_DIR`
环境变量是管理员覆盖项,日常使用不需要设置。

---

## 3. 模板浏览、搜索与确认

SFL 的核心纪律是:**先看真实预览,由你确认那一张卡,然后才物化**。

| 步骤 | 谁做 | 说明 |
| --- | --- | --- |
| 1. 打开工作台/搜索 | 宿主模型 | MCP App 宿主调 `figure_library_open`;任意宿主可调 `figure_library_search` |
| 2. 浏览候选 | 你 + 宿主模型 | App 逐页渲染缩略图;点缩略图或"查看详情"看大图与描述;检索得分只用于排序,**不是**相似度或可信度 |
| 3. 停下等你选 | 宿主模型 | 搜索后宿主必须停下,等待你选择;除非你明确说"帮我选模板" |
| 4. 精确预览 | 宿主模型/App | App 内"查看精确预览"走 `figure_library_preview_exact` + `figure_library_confirm_selection`;无 App 界面的宿主用 `figure_library_preview_exact_headless` + `figure_library_confirm_selection_headless` |
| 5. 确认 | 你 | 只有你在看到精确预览后确认,才产生一次性的 `previewReceipt` |
| 6. 物化计划 | 宿主模型 | `figure_library_plan_materialize`:带上未改动的 `providerId`、`exactSelector`、`previewReceipt`、绝对目标路径;缺回执会返回 `preview_required` |
| 7. 展示并确认计划 | 宿主模型 + 你 | 展示确切模板、目标目录、文件集(template/full) |
| 8. 执行物化 | 宿主模型 | `figure_library_apply_materialize`;目标为 `<目标目录>/<templateId>`,永不覆盖已有目录 |
| 9. 查看结果 | 你 + 宿主模型 | 项目里出现模板文件与 `template.lock.json`(记录 `codeExecutedBySflClient: false`) |

两点常见误解:

- **检索范围**:默认按第 1 节的顺序搜索;Community 快照要显式指定才可访问。
  用 `figure_library_list_provider_sources`(完全离线)查看已启用的 Provider。
- **上游状态 ≠ 本地验证**:FigureYa 与 Open Figure Modules 的上游发布、发布者签名
  或中心策展状态,都不会自动变成你本地的审核通过。描述模板时宿主必须如实区分。

空目录也可能是健康状态:某个内置附加目录在授权撤下后可能没有任何 Release,
默认搜索会继续在其余 Provider 上进行,这不代表安装坏了。

---

## 4. 图型索引(按用途)

本手册的两份图型索引由仓库内置目录元数据**自动生成**,并标注快照版本:

- [Open Figure Modules 索引(36 个模块,按 plotFamily 分类)](generated/open-figure-modules-index.zh-CN.md)
- [FigureYa 模板索引(全部模板,按 ID 字母序)](generated/figureya-index.zh-CN.md)

每个索引条目包含:名称与稳定标识(`moduleId`)、分类、预览链接、适用科研场景、
输入数据要求、模板来源与许可,以及可复制的自然语言调用示例。目录里缺失的元数据
在页面中如实标注为"未记录",不会编造调用链接。

使用索引时注意三点:

1. **快照 vs 远端**:索引页生成自插件内置的目录快照;安装后 SFL 会通过签名 feed
   异步更新 Open Figure Modules 的本地 overlay,远端可能已有新增或下架模块。
   最终以 SFL 搜索结果为准。
2. **你自己的图不在索引里**:Local Published 的模板请在工作台或搜索里查看,
   它们属于你本机 Library,不在这个仓库的目录快照中。
3. **FigureYa 无分类元数据**:FigureYa 目录没有按用途的分类字段,索引按模板 ID
   字母序列出;按场景找图建议直接用关键词搜索(如 survival、PCA、volcano)。

找到候选模板后的流程见[第 3 节](#3-模板浏览搜索与确认);数据怎么准备见
[第 5 节](#5-准备你自己的图与数据)。

---

## 5. 准备你自己的图与数据

把"一张图 + 它的代码 + 作图数据"当作一个**图形单元(Figure Unit)**导入。
建议每个图形单元整理出一个独立文件夹再开始。

### 5.1 要准备什么(你)

| 材料 | 要求 |
| --- | --- |
| 图像文件 | 该单元的成图(位图或矢量);用户上传的原图必须包含在内 |
| 绘图代码 | 生成该图的脚本(R/Python/其他均可;SFL 只记录语言,不执行)。没有可靠代码时,宿主应按 `visual_reference` 导入,而不是假装存在可复现模板 |
| 作图数据 | 绘图就绪的表:每行一个样本/观测,分组用明确的列,单位写在列名里;不要为了好看而改动数据或统计结果 |
| 依赖信息 | 用到的包列表(会进入模板描述) |
| 许可信息 | 你拥有导入权利;许可证在导入时如实记录 |

### 5.2 导入与发布流程(🤖 宿主模型执行,关键处你确认)

| 步骤 | 谁做 | 工具/操作 |
| --- | --- | --- |
| 1. 检查文件并收集决策 | 宿主模型 | 核对图像/代码/数据实际存在,确认图形单元边界、图-代码对应关系、许可证与验证状态 |
| 2. 生成导入计划 | 宿主模型 | `figure_library_plan_working_revision`(只读,不写盘) |
| 3. 审阅工作预览 | 你 + 宿主模型 | `figure_library_preview_working_revision` 看规范化主图 |
| 4. 确认并应用 | 你 → 宿主模型 | 你确认该计划后,`figure_library_apply_working_revision` 写入不可变 Working Revision |
| 5. 审阅与发布 | 你 → 宿主模型 | `figure_library_review_open` 检查;`figure_library_plan_publish_working_revision` → 确认 → `figure_library_apply_publish_working_revision` 发布不可变 Release |

发布后,这个 Release 就可以被搜索并精确物化到任何项目。导入的绝对源路径不会
被持久化;重复导入同一单元时,宿主会在 `create_new` / `update_exact` /
`reuse_existing` 里和你确认。

---

## 6. 字体、配色、尺寸与导出调整

**当前机制(✅ + 🤖):** SFL 内置的 figure-style Skill 为宿主模型提供通用绘图风格
指导(字体、配色、尺寸、导出等检查项,R/Python 后端各有细则),模型会优先遵循你
**当次会话**里的明确要求。SFL 本身**不会**跨会话记住你的偏好——持久化的用户绘图
规范仍在规划中(🕓 [#17](https://github.com/xuzhougeng/ScientificFigureLibrary/issues/17))。
在规范落地前,可以把偏好写进项目级提示文件,或每次绘图时直接粘贴下面的示例。

**可复制的提问示例(粘贴给宿主模型,按需修改):**

字体与字号层级:

```text
这张图要放进论文正文:全文用 Arial;主标题 10 pt,坐标轴标题 8 pt,
刻度标签 7 pt,图例 8 pt。修改代码时保持数据映射和统计结果不变。
```

实验组固定配色(避免子图换序导致颜色变化):

```text
分组颜色固定映射:Control = #4D4D4D,A 组 = #0072B2,B 组 = #D55E00。
后面无论子图怎么排列,这三组的颜色都保持不变。
```

最终物理尺寸(A4 PPT 手工拼版场景):

```text
图最终插入 A4 横版 PPT。请按 170 mm × 60 mm 的最终尺寸出图,单位 mm,
不要在 PPT 里缩放;导出 300 dpi PNG 和一份矢量 PDF。
```

导出格式:

```text
投稿要求:TIFF,300 dpi,白底,Lab 或 RGB 都可以;矢量 PDF 不需要套栅格 DPI。
```

有期刊规范或参考图时直接提供:

```text
按 Nature 单栏 89 mm 宽度规范调整这张图;附上一张参考图,请尽量贴近它的版式。
```

**由谁完成:** 改代码与运行由宿主模型(🤖)在项目批准的 R/Python 环境里完成,
SFL 服务器不参与执行;格式能力取决于实际运行后端,图库导入支持与绘图导出支持
要分开确认。

---

## 7. 输出查看与重绘

**绘图执行链(🤖):** 你提出绘图要求 → 宿主模型用项目批准的 R/Python 运行时执行
脚本 → 用宿主的看图工具自查 → 把图像路径和内容摘要交付给你。SFL 全程不执行代码,
只在模板层面保证"你拿到的是你确认过的那一版"。

**重绘与迭代:** 物化产生的模板副本属于项目,直接改副本即可;Library 里的不可变
Release 不受影响。想把这些修改沉淀为新版本时,回到[第 5 节](#5-准备你自己的图与数据)
的导入发布流程,生成新的 Revision/Release(SFL 原生版本化,✅)。

**按图组织文件:** figure-organization Skill 已要求输入/输出可追溯(✅ 的指导),
但"一图一文件夹"的强制归档单元与投稿打包仍在规划中
(🕓 [#19](https://github.com/xuzhougeng/ScientificFigureLibrary/issues/19))。
当前你可以直接要求宿主模型按该结构组织,例如:

```text
请按"一图一文件夹"组织这次绘图:figures/fig02a-volcano-treatment-vs-control/
里放 scripts/、data/、最终图像和 README.md(记录参数、数据来源与运行方式)。
完成后给我内容清单。不要把其他图的数据混进这个文件夹。
```

这是给宿主模型的临时约定,SFL 目前不会自动检查归档完整性;投稿打包
(图级 ZIP、总索引材料包)也请直接向宿主模型提出。

---

## 8. 常见问题

**调用报 `setup_required`?**
全局 Library 或本地工作区还没绑定。按[第 2.2 节](#22-首次配置绑定两个目录)
提供两个绝对路径,走 Plan/Apply 绑定。

**搜索结果很少甚至为空?**
按顺序排查:①默认只搜 Local Published → FigureYa → Open Figure Modules → 显式
启用的动态 Provider;②Community 已冻结且不参与默认搜索,需显式指定;
③某个内置附加目录可能是健康的空目录;④用 `figure_library_list_provider_sources`
(离线)检查 Provider 状态。

**materialize 之后怎么没有自动出图?**
这是设计边界:SFL 不执行绘图代码。物化只复制模板;真正画图要由宿主模型在
批准的运行时里进行(见[第 7 节](#7-输出查看与重绘))。

**项目里的 `template.lock.json` 是什么?**
物化回执:记录模板身份、来源 commit、文件清单,以及
`codeExecutedBySflClient: false`——即 SFL 客户端没有执行过任何代码。

**想微调已发布的图?**
项目内改物化副本,Library 的 Release 不动;要沉淀新版本就导入并发布新 Revision
(见[第 5 节](#5-准备你自己的图与数据))。

**换一台电脑或换宿主怎么办?**
同一台机器上,所有宿主共享同一全局 Library(locator 文件决定)。跨机器用
便携 bundle:`figure_library_plan_bundle_export` / `figure_library_apply_bundle_export`
备份,`figure_library_plan_full_restore` / `figure_library_apply_full_restore` 恢复。

**许可怎么算?**
本仓库代码 MIT;你导入的图保留导入时记录的许可证;FigureYa 上游内容为
CC BY-NC-SA 4.0(见 `assets/FIGUREYA_LICENSE.txt`);Open Figure Modules 代码
MIT、内容与文档 CC BY 4.0。详见
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)。

**索引页的模块数和 SFL 里搜到的不一致?**
索引页是内置快照,安装后签名 feed 可能已更新本地 overlay。以 SFL 搜索为准;
文档维护者可按[附录 B](#附录-b索引再生成与链接检查)重新生成。

**我的数据会被上传吗?**
Library 在你指定的本机目录;搜索与 Provider 状态检查完全离线,搜索不等待网络。
只有你显式要求的流程(如 GitHub 发布 PR、官方频道提交)才涉及网络,且都需要
逐步确认。安全边界见 [SECURITY.md](../SECURITY.md)。

---

## 9. 进阶参考

### 9.1 仓库目录结构

```text
ScientificFigureLibrary/
├── assets/
│   ├── catalog.json               # FigureYa 目录快照(自动生成)
│   ├── personal-modules/          # Open Figure Modules bootstrap 目录与预览
│   └── thumbs/                    # FigureYa 缩略图
├── docs/
│   ├── USER_GUIDE.md              # 本手册(英文)
│   ├── USER_GUIDE.zh-CN.md        # 本手册(中文)
│   ├── generated/                 # 自动生成的图型索引(勿手工编辑)
│   ├── PROTOCOL.md                # 完整工具契约
│   ├── QUICKSTART.md              # 安装快速上手
│   └── GLOBAL_LIBRARY_0.6.md      # 当前 Library 设计说明
├── scripts/                       # 构建/打包/索引生成脚本
├── skills/                        # 四个内置 Skills
└── src/                           # MCP 服务器实现
```

### 9.2 内置 Skills 分工

| Skill | 职责 |
| --- | --- |
| figure-library | SFL 工具与工作台使用规范:搜索、确认、物化纪律 |
| figure-description | 模板描述写作:需求、应用场景、数据特征的安全 Markdown 呈现 |
| figure-organization | 图形单元组织:输入/输出可追溯,导入边界约定 |
| figure-style | 绘图风格指导:字体、配色、尺寸、导出;R/Python 后端检查细则 |

四个插件包(Wisp/Codex/Claude/Cursor)都包含全部 Skills,宿主无需另装。

### 9.3 协议与相关文档

- [PROTOCOL.md](PROTOCOL.md):全部 MCP 工具的完整契约(plan/apply、回执、错误码)
- [QUICKSTART.md](QUICKSTART.md):安装与首个会话
- [GLOBAL_LIBRARY_0.6.md](GLOBAL_LIBRARY_0.6.md) 与
  [GLOBAL_LIBRARY_0.5.md](GLOBAL_LIBRARY_0.5.md):Library 设计与 0.5→0.6 迁移
- [WISP_UPDATES.md](WISP_UPDATES.md):Wisp 插件更新 feed
- [SECURITY.md](../SECURITY.md) / [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)

### 9.4 相关 issue 实现状态

| Issue | 内容 | 状态 |
| --- | --- | --- |
| [#17](https://github.com/xuzhougeng/ScientificFigureLibrary/issues/17) | 用户绘图规范持久保存与自动应用 | 🕓 规划中 |
| [#18](https://github.com/xuzhougeng/ScientificFigureLibrary/issues/18) | 用户可见的科研绘图提示与需求表达示例 | 🕓 规划中 |
| [#19](https://github.com/xuzhougeng/ScientificFigureLibrary/issues/19) | 一图一文件夹归档与投稿打包 | 🕓 规划中 |
| [#20](https://github.com/xuzhougeng/ScientificFigureLibrary/issues/20) | 本双语用户手册 | 随本手册交付 ✅ |

---

## 附录 A:端到端示例

场景:新用户用 Open Figure Modules 里的单细胞细胞类型比例堆叠柱状图模板
(`sc-celltype-grouped-stacked-bar`),为自己的数据出一张投稿用图。

| # | 你做 | 宿主模型做 | SFL 服务器做 |
| --- | --- | --- | --- |
| 1 | 发出安装请求(第 2.1 节方式 A 的提示词) | 按 QUICKSTART 安装并注册 MCP 服务器 | — |
| 2 | 提供 `D:\figure-library` 和项目目录两个绝对路径 | Plan 绑定并展示路径,你确认后 Apply | 校验路径、写 locator、启用写入 |
| 3 | 说"搜索 celltype stacked" | `figure_library_search`,展示候选卡后**停下等你选** | 返回候选与缩略图,附 `exactSelector` |
| 4 | 点开详情、精确预览后确认那张卡 | 按宿主能力走 `preview_exact`/`confirm_selection`(或 headless 版) | 生成一次性 `previewReceipt` |
| 5 | 确认物化计划 | `figure_library_plan_materialize` → 你确认 → `figure_library_apply_materialize`,目标 `./figures/fig03-celltype/` | 校验回执与计划,复制模板文件集 `template`,写 `template.lock.json` |
| 6 | 把自己的数据整理成模板要求的表(见索引条目的"输入数据要求") | 对照 `description.md`/`data_schema.yml` 检查列与单位,替换示例数据 | — |
| 7 | 提风格要求(第 6 节示例:Arial、分组配色、170 mm × 60 mm、300 dpi) | 按 figure-style 指导改项目内脚本副本 | — |
| 8 | 批准运行 | 在项目批准的 R 环境运行脚本,看图自查,交付图像路径 | — |
| 9 | 检查成图,提出修改 | 迭代重绘 | — |
| 10 | 满意后说"按一图一文件夹整理"(第 7 节示例) | 整理归档并给内容清单 | — |

任意一步卡住时,先问宿主模型当前处于哪一步、缺哪个确认;`setup_required`、
`preview_required` 等错误码的含义见 [PROTOCOL.md](PROTOCOL.md)。

## 附录 B:索引再生成与链接检查

本手册的图型索引(第 4 节链接的四个页面)由脚本从内置目录 JSON 生成,
输出确定性(不含运行时刻时间戳),元数据更新后可重复再生成:

```bash
npm run docs:index         # 重新生成 docs/generated/ 下四个索引页
npm run docs:check-links   # 检查手册与 README 的本地链接和锚点(离线)
```

- `docs:index` 读取 `assets/catalog.json` 与
  `assets/personal-modules/module-catalog.json`,重新生成中英文四页;
  缺失元数据会如实标注,不会编造链接。
- `docs:check-links` 只校验仓库内相对链接与标题锚点,不访问外部网站,
  可在离线环境重复执行。
- 目录快照更新(如 FigureYa 目录重建、Open Figure Modules feed 刷新 bootstrap)
  后,重新运行 `docs:index` 并随代码一起提交即可,无需手工维护模板名单。
