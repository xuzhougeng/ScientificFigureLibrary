# ScientificFigureLibrary：内置复刻 Skills、FigureYa 风格描述与 Markdown 展示

## 目标

在 `codex/sfl-open-figure-module-pr` 中完成四个随插件分发的 Skill：

```text
figure-library
figure-description
figure-organization
figure-style
```

其中 `figure-description` 负责 FigureYa 风格的需求描述和应用场景；
`figure-organization` 负责可读、可编辑的复刻代码流程；`figure-style` 负责
R/Python 图形正确性、可读性和渲染 QA；`figure-library` 负责 SFL 生命周期、
搜索、物化和发布流程。

模板详情默认显示：

1. 预览图、标题和基础标识；
2. Markdown 渲染的需求描述；
3. Markdown 渲染的应用场景；
4. 数据特征；
5. 实际输入文件、代码文件和依赖包。

来源、验证状态、selector、commit、digest 和内部审计信息仍保留在 MCP 与
Agent 数据层，但不占用普通模板说明正文。

## 字段与兼容策略

- 为 Working/Published/Candidate 增加独立 `application` 字段；新建或更新
  模板要求填写，历史 JSON 继续可读。
- `description`、`application`、`dataProfile` 保留 Markdown 换行和结构；搜索
  使用另行生成的纯文本索引。
- Local Published 不再使用 `visualProfile` 冒充 `application`。
- 旧模板从 `使用场景`、`适用场景`、`Recommended use` 或 `Application` 段落
 进行只读兼容提取；无法提取时不伪造场景。
- Open Figure Modules 新生成内容采用同一套 Markdown 描述；现有 36 个模块、
  既有 module.yml、description.md、archive 和 Catalog 本轮不批量修改。
- FigureYa Catalog 保持只读，只复用统一详情渲染组件。

## Skills 纳入

### figure-description

输出 `description`、`scientificQuestion`、`application`、`dataProfile` 和
`visualProfile`。有原文时核对对应图注和正文；无原文时询问一次，用户跳过后
写明依据有限的通用场景。不得执行代码、发布、创建 PR 或虚构科学结论。

### figure-organization

以用户授权的 `C:\Users\Administrator\.agents\skills\code-organization` 为
内容来源，在插件内使用新名称 `figure-organization`。原始目录不修改；插件副本
遵守项目自身 AGENTS 规则，保留线性流程、中文导航、输出绑定和研究者可编辑性。

### figure-style

以 `E:\wisp-science\skills\figure-style` 为来源，保留 Apache-2.0 声明和
`kernel.py`。Python 使用 sidecar；R 使用等价规则。复刻时忠实模板优先：
只检查数据和可读性，不静默替换原图的颜色、字体、图例或布局；样式优化必须
由用户明确选择。

## Markdown 展示

使用 `markdown-it` 解析、`DOMPurify` 过滤。支持标题、段落、列表、引用、表格、
粗体、斜体、行内代码、代码块和 http/https 链接；禁用原始 HTML、script、iframe、
危险链接协议和外部图片自动加载。代码块只展示，不执行。

卡片继续使用纯文本摘要和截断；详情窗口完整渲染说明。输入文件、代码文件、
依赖包和数据特征默认可见。

## Open Figure Modules

新模块的 `module.yml` 保存 Markdown 的 `description`、`application` 和
`dataProfile`，可选保存 `scientificQuestion`；`description.md` 从同一份已确认
内容生成。旧模块保持原格式并继续可读、可搜、可物化。不得把 `visualProfile`
回填为 `application`。

## 验证与交付

在当前 worktree 执行：

```text
npm test
npm run test:smoke
npm run version:check
npm run package:wisp
npm run package:codex
npm run package:claude
```

版本更新到 `0.6.3`，标准 MCP 工具数量保持 `53`。产物写入 worktree 的
`release/`，不写入 Desktop，不推送、不合并、不修改 main，不运行 R 或模板代码。

完成内部代码审查、测试和打包审计后，追加本地 commit；用户再进行 Wisp/Codex/Claude
宿主验收。
