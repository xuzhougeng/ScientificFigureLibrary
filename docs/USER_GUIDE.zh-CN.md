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
- [附录 B:文档维护与链接检查](#附录-b文档维护与链接检查)

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
- 可折叠的科研绘图提示与复制示例:帮助表达当次需求,不保存长期样式、不要求填写参数表;更多示例见[第 6 节](#6-字体配色尺寸与导出调整)
- 统一检索,默认顺序:**Local Published → FigureYa → Open Figure Modules(内置目录或已验证更新目录) → 已启用并显式参与默认搜索的动态个人 Provider**;Community 快照已冻结,不参与默认搜索
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
- [#19](https://github.com/xuzhougeng/ScientificFigureLibrary/issues/19):默认落实"一图一文件夹"归档与投稿打包——当前由宿主模型按你的要求临时组织,见[第 7 节](#7-输出查看与重绘)

---

## 2. 安装与首次配置

**准备(你):** Node.js 22 或更新版本;任一 stdio MCP 宿主(Wisp Science、
Claude Science、Codex、Claude Code、Cursor 等)。

### 2.1 安装方式

各宿主的安装、打包和连接步骤统一见 [QUICKSTART](QUICKSTART.md),本手册不另维护一套安装命令。
如果你在阅读解压后的插件包,请使用 [在线快速开始](https://github.com/xuzhougeng/ScientificFigureLibrary/blob/main/docs/QUICKSTART.md)。

可以把下面的请求交给具有终端权限的宿主模型:

```text
请从 https://github.com/xuzhougeng/ScientificFigureLibrary 安装 Scientific Figure Library,
按仓库 QUICKSTART 和我正在使用的宿主选择安装方式。先说明需要下载什么、
改哪些配置,在我确认后执行。不要运行绘图代码或自动安装绘图依赖。
连接后先检查配置状态,缺少绑定时向我要全局 Library 和本地工作区的明确绝对路径。
告诉我何时需要授予目录权限、重启宿主或新建会话。
```

不要同时注册裸 MCP 配置和同一服务的宿主插件,以免工具重复。

### 2.2 首次配置:绑定两个目录

新安装处于 `setup_required` 状态,直到两个目录都绑定完成。**全局 Library**
(绘图仓库)是全机唯一一份;**本地工作区**是当前项目侧的工作目录。

| 步骤 | 谁做 | 工具/操作 |
| --- | --- | --- |
| 1. 检查状态 | 宿主模型 | 调 `figure_library_source_status` 或 `figure_library_open`,确认 `setup_required` |
| 2. 你提供两个**绝对路径** | 你 | 如 `D:\figure-library` 与当前项目目录;不要随手用当前项目当全局 Library |
| 3. 生成绑定计划 | 宿主模型 | 展示确切目录和计划,不在你确认前应用;工具名见第 9.5 节 |
| 4. 确认路径 | 你 | 核对计划里展示的路径无误后确认 |
| 5. 应用绑定 | 宿主模型 | 在同一服务会话内应用你确认的绑定计划 |
| 6. 复查 | 宿主模型 | 再次 `figure_library_source_status`,确认写入已启用、计数正确 |

绑定信息记录在本机 locator 文件中(Windows:
`%APPDATA%\ScientificFigureLibrary\locator.json`;Linux/WSL:
`~/.config/scientific-figure-library/locator.json`)。`FIGURE_LIBRARY_DIR`
环境变量是管理员覆盖项,日常使用不需要设置。

---

## 3. 模板浏览、搜索与确认

SFL 的核心纪律是:**先看真实预览,由你确认那一张卡,然后才物化**。
物化(materialize)是把确认的模板文件复制到项目,不是运行代码。

点击标题或卡片空白处可选择/取消选择,以“已选”标记和计数为准;缩略图和“查看详情”用于浏览。基础详情不触发诊断工具调用。勾选和宿主工具审批都不等于精确预览确认,也不自动授权物化或执行绘图。

| 步骤 | 谁做 | 你需要知道什么 |
| --- | --- | --- |
| 1. 说明目标并搜索 | 你 → 宿主模型 | 说明科研问题、已有数据和希望使用的来源;模型展示真实候选 |
| 2. 浏览候选 | 你 | 查看缩略图、用途、数据要求和来源;检索得分不是可信度或科学验证 |
| 3. 选择模板 | 你 | 模型搜索后应停下等你选择,除非你明确委托它代选 |
| 4. 查看精确预览 | 宿主模型/App → 你 | 查看选中版本的真实预览;没有 App 的宿主使用 headless 预览流程 |
| 5. 明确确认 | 你 | 看过精确预览后确认,服务器才签发本次会话的一次性预览回执 |
| 6. 核对物化计划 | 宿主模型 → 你 | 展示模板、文件集(template/full)、网络需求和绝对目标目录,等你确认 |
| 7. 应用物化 | 宿主模型调用 SFL | 保持原回执和模板身份不变;目标为 `<目标目录>/<templateId>`,不覆盖已有目录 |
| 8. 检查文件 | 你 + 宿主模型 | 查看文件清单与 `template.lock.json`,然后进入数据适配,尚未运行代码 |

高级工具名见[第 9.5 节](#95-工具对照),普通用户不需要记住固定工具口令。

- **搜索范围:** 默认顺序见第 1 节;Community 冻结且只在明确指定时参与。模型可离线读取 Provider 状态,但搜索结果不是完整目录枚举。
- **上游状态不等于本地验证:** 上游发布、签名或审核不能自动变成你本机的运行通过或科学验证。
- **空目录不一定是故障:** 某些来源可能在撤下内容后合法为空;先看来源和状态,不要擅自重新安装。

---

## 4. 图型索引(按用途)

**手册讲使用方法,内容源维护模板目录。** 本手册不复制一份容易落后的“全部模板”名单,也不把插件内置模板数当作永久总数。

- [Open Figure Modules 当前内容目录](https://github.com/jarxunlai/ScientificFigureLibrary-personal#current-modules):按图型提供中文名称、英文副标题和模块入口;模块内查看预览、说明、输入文件及逐模块许可。
- [FigureYa 上游目录](https://github.com/ying-ge/FigureYa):浏览上游说明后,在 SFL 中指定 FigureYa 搜索并检查实际可用版本。
- **Local Published 与额外 Provider:** 在你本机的工作台中查看,不属于公共内容仓库的完整目录。

### 4.1 按科研问题查找

| 我想做什么 | 给宿主模型的查找方向 |
| --- | --- |
| 比较细胞组成 | 搜索细胞比例、分组条形或堆叠柱状图 |
| 展示差异表达 | 根据差异分析表查找相应展示图型,先核对输入字段 |
| 展示通路富集 | 搜索富集柱状图、气泡图或其他富集展示模板 |
| 展示表达模式 | 搜索热图、带注释热图或 marker 气泡图 |

```text
请在 Open Figure Modules 中查找适合比较两组细胞组成的模板。
先核对我的输入数据,展示候选预览、数据要求与来源,然后停下来让我选。
不要自动下载完整模块或运行代码。
```

### 4.2 为什么目录数量会不同

| 层次 | 代表什么 |
| --- | --- |
| 内容仓库 | 已合入的公开模块,可能尚未发布到官方 feed |
| 官方发布目录 | 官方 feed 指向的版本;客户端验证签名后可采用 |
| 插件内置目录(bootstrap) | 打包时的离线起步快照,不代表当前全集 |
| 本机加载目录 | 本机实际采用的内置或已验证目录,受更新状态、联网和配置影响 |

早期安装中的小目录可能远少于官方已发布集合。插件内置条目数不是模板总数上限,手册不固定宣称一个当前总数。
最新数量请查看内容源;本机可用数量请让模型读取相应 Provider 的状态。不要用一次搜索结果的条数代替全集数量。

普通模块新增、更新或撤下不要求重新打包插件。SFL 搜索读取已加载的本地目录,不等待网络;官方目录可以在后台更新。
若本机仍显示旧快照,先检查目录来源、更新状态和错误,不要仅凭手册数字判断安装失败。

选中模板后按[第 3 节](#3-模板浏览搜索与确认)继续,数据适配见[第 5 节](#5-准备你自己的图与数据)。

---

## 5. 准备你自己的图与数据

这里有两条独立路线:**用已有模板画自己的数据**,以及**把满意的图保存为可复用资产**。
使用公共模板不要求先导入、发布一张自己的图。

### 5.1 路线 A:用模板画自己的数据

先完成第 3 节的选择与物化,再让宿主模型检查项目副本中的 `description.md`、`data_schema.yml`、输入文件和实际代码。
向模型提供数据路径、各列含义、分组和单位;未知含义先询问,不要为适配图形而猜测或改动统计结果。

**最小教学例子:** `sc-celltype-grouped-stacked-bar` 的真实输入契约是样本级长表,一行代表一个样本中一种细胞的计数。
字段依据固定版本的[数据说明](https://github.com/jarxunlai/ScientificFigureLibrary-personal/blob/b349606d7219b58a80a224e409dfd51928d1329b/modules/sc-celltype-grouped-stacked-bar/data_schema.yml)和[绘图代码](https://github.com/jarxunlai/ScientificFigureLibrary-personal/blob/b349606d7219b58a80a224e409dfd51928d1329b/modules/sc-celltype-grouped-stacked-bar/code/organized.R)。下面的数值是为教程编写的合成示例,不是真实实验结果:

```csv
Sample_ID,Group,celltype,n
C1,Control,B-cells,40
C1,Control,T-cells,60
C2,Control,B-cells,30
C2,Control,T-cells,70
T1,Treatment,B-cells,55
T1,Treatment,T-cells,45
T2,Treatment,B-cells,60
T2,Treatment,T-cells,40
```

- 必需列是 `Sample_ID`、`Group`、`celltype`、`n`;`n` 为非负整数,每个样本只属于一个组。
- 该版本示例代码固定使用 `Control` / `Treatment`,并从 Control 组决定细胞类型顺序。真实分组名称或某组独有的细胞类型需要先确认映射和顺序,不能直接让它们变成缺失值。
- 代码先按组汇总细胞计数,再绘制 100% 堆叠柱;这不是样本比例的等权平均,也不是差异丰度检验。改变汇总方法属于分析决策,不能只作为样式修改。
- 保留物化时的合成示例;真实数据可另存为项目中的 `data/user-counts.csv`,让模型在脚本副本里明确修改读取路径,不要静默覆盖原数据。
- 重复行、负值、缺失值、组名不匹配或零总数先诊断,不自动删除、合并、补零或安装依赖。

```text
请检查这个模板的数据契约与我的计数表,说明每列如何对应、每行代表什么。
保留模板的示例输入,在项目副本中使用我的数据路径。先确认分组名称、
细胞类型顺序和按组汇总的含义,再修改脚本。列出所需 R 包和输出目录,
等我授权运行后再执行;不要把数据适配说成已经复现了原研究。
```

### 5.2 路线 B:把自己的图保存到图库

把“一张图 + 它的代码 + 作图数据”当作一个图形单元(Figure Unit),建议放在独立文件夹。
没有可靠代码时使用 `visual_reference`,不要声称存在可复现模板。
这一步是可选的资产沉淀,不是路线 A 的前置条件。

| 材料 | 要求 |
| --- | --- |
| 图像文件 | 该单元的成图(位图或矢量);用户上传的原图必须包含在内 |
| 绘图代码 | 生成该图的脚本(R/Python/其他均可;SFL 只记录语言,不执行)。没有可靠代码时,宿主应按 `visual_reference` 导入,而不是假装存在可复现模板 |
| 作图数据 | 绘图就绪的表:每行一个样本/观测,分组用明确的列,单位写在列名里;不要为了好看而改动数据或统计结果 |
| 依赖信息 | 用到的包列表(会进入模板描述) |
| 许可信息 | 你拥有导入权利;许可证在导入时如实记录 |

### 5.3 导入与发布流程(🤖 宿主模型执行,关键处你确认)

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
请按我提供的期刊要求导出 TIFF,300 dpi,白底;色彩空间按期刊和实际后端确认。
矢量 PDF 不需要套栅格 DPI。
```

有期刊规范或参考图时直接提供:

```text
我提供的投稿说明要求单栏宽度 89 mm;请按这个最终尺寸调整这张图。
附上一张参考图,请尽量贴近它的版式,但不要改变数据含义。
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

**内容目录和 SFL 的数量不同?**
内容仓库、官方发布目录、插件 bootstrap 和本机加载目录是不同层次,见[第 4.2 节](#42-为什么目录数量会不同)。
搜索结果可能经过关键词过滤和分页,不能据此宣称完整目录只有这么多。

**我的数据会被上传吗?会联网吗?**

- SFL 的 Library 文件存放在你绑定的本机目录,没有用于托管这些文件的 SFL 后端。
- 搜索使用已加载的本地目录,不等待网络;Provider 状态读取本身是离线的。但进程启动及后续后台检查可在自动刷新开启时联网获取官方目录和预览,不是每次都另行询问。
- 自动目录刷新是获取公共元数据和预览,不等于发布你的 Library。完整模块归档按你确认的物化流程获取;发布到 GitHub/官方频道属于另外的显式授权流程。
- 关闭官方自动刷新可使用已有配置流程或环境变量 `SFL_OPEN_FIGURE_AUTO_REFRESH=0`,由用户明确决定;这不保证其他显式网络操作或宿主模型也离线。
- 宿主模型如何处理你提交的数据、图像和对话,取决于宿主及模型服务的设置。SFL 本地优先不等于整条工作流离线;敏感数据应先核对宿主的数据政策。

安全边界见 [SECURITY.md](../SECURITY.md)。

**字体缺失、依赖不足或渲染失败?**
让模型给出原始错误、实际运行环境和缺失项,先区分数据契约、字体、包和导出后端问题。
不要自动装包、替换字体或改数据来隐藏失败;确认修复方案后再执行。


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
│   ├── PROTOCOL.md                # 完整工具契约
│   ├── QUICKSTART.md              # 安装快速上手
│   └── GLOBAL_LIBRARY_0.6.md      # 当前 Library 设计说明
├── scripts/                       # 构建/打包/文档检查脚本
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

### 9.5 工具对照

供宿主模型和进阶用户查阅,不要求普通用户背工具名。

| 操作 | 工具 |
| --- | --- |
| 配置 | `figure_library_source_status`, `figure_library_open`; `figure_library_plan_bind_global` / `figure_library_apply_bind_global`; `figure_library_plan_bind_workspace` / `figure_library_apply_bind_workspace` |
| 搜索 | `figure_library_search`, `figure_library_list_provider_sources` |
| 预览与确认 | `figure_library_preview_exact` / `figure_library_confirm_selection`; `figure_library_preview_exact_headless` / `figure_library_confirm_selection_headless` |
| 物化 | `figure_library_plan_materialize` / `figure_library_apply_materialize` |

绑定与物化都要展示计划再等用户确认。精确预览的 `providerId`、`exactSelector`、`previewReceipt` 必须保持不变;缺回执会返回 `preview_required`。
参数、导入发布、备份恢复等完整合同统一见 [PROTOCOL](PROTOCOL.md),本表不是另一份协议。

---

## 附录 A:端到端示例

场景:新用户用 Open Figure Modules 里的单细胞细胞类型比例堆叠柱状图模板
(`sc-celltype-grouped-stacked-bar`),为自己的数据出一张投稿用图。

| # | 你做 | 宿主模型做 | SFL 服务器做 |
| --- | --- | --- | --- |
| 1 | 发出安装请求(第 2.1 节的提示词) | 按 QUICKSTART 安装并注册 MCP 服务器 | — |
| 2 | 提供 `D:\figure-library` 和项目目录两个绝对路径 | Plan 绑定并展示路径,你确认后 Apply | 校验路径、写 locator、启用写入 |
| 3 | 说"在 Open Figure Modules 搜索分组堆叠柱状细胞构成图" | `figure_library_search`,展示候选卡后**停下等你选** | 返回候选与缩略图,附 `exactSelector` |
| 4 | 点开详情、精确预览后确认那张卡 | 按宿主能力走 `preview_exact`/`confirm_selection`(或 headless 版) | 生成一次性 `previewReceipt` |
| 5 | 确认物化计划 | `figure_library_plan_materialize` → 你确认 → `figure_library_apply_materialize`,使用你明确提供的绝对目标目录 | 校验回执与计划,复制模板文件集 `template`,写 `template.lock.json` |
| 6 | 按第 5.1 节核对行单位、列名、分组和汇总方法 | 保留合成示例,在项目副本中明确修改输入路径 | — |
| 7 | 提风格要求(第 6 节示例:Arial、分组配色、170 mm × 60 mm、300 dpi) | 按 figure-style 指导改项目内脚本副本 | — |
| 8 | 批准运行 | 核对依赖和明确输出目录后,在项目批准的 R 环境执行并看图自查 | — |
| 9 | 检查成图,提出修改 | 迭代重绘 | — |
| 10 | 满意后说"按一图一文件夹整理"(第 7 节示例) | 整理归档并给内容清单 | — |

该模板分发的脚本默认只生成 `render.png`,没有指定输出位置时使用 R 临时目录。宿主应在获批后通过 `SFL_OUTPUT_DIR` 或核对过的脚本参数指定项目输出目录;如需 PDF/TIFF,还需修改项目副本中的导出代码并实际验证。这里的流程说明不是已在你的机器运行成功的证明。

任意一步卡住时,先问宿主模型当前处于哪一步、缺哪个确认;`setup_required`、
`preview_required` 等错误码的含义见 [PROTOCOL.md](PROTOCOL.md)。

## 附录 B:文档维护与链接检查

从完整源码检出目录执行:

```bash
npm run docs:check-links
node --test tests/docs-link-checker.test.ts
```

只检查 README、手册和 QUICKSTART 中支持的 Markdown 本地链接及标题锚点;外部链接计数但不抓取,不会下载模板或刷新本机目录。
本地检查不需要安装依赖。它不能证明外部页面在线、宿主安装成功或绘图已通过。

- 两种语言的目录结构、数据契约、功能状态和技术标识应同步维护。
- README 使用在线手册入口,解压插件包或安装 npm 包后也不会指向未打包的手册路径;阅读在线手册需要网络。
- 完整源码检出仍可离线阅读本手册;公共完整模板目录由各内容源维护,不随手册复制或强制纳入安装包。
- 以后如需可复现的离线全量索引,应另行约定固定的官方发布快照与更新流程,不要把 bootstrap 当成当前全集。
