# 设计提案：精简"使用模板"的材料化步骤

> 状态：**提案，未实现**。本文只描述设计和取舍，待维护者确认后再改代码与 [PROTOCOL](PROTOCOL.md)。
> 范围：仅限把已发布模板材料化到用户项目的**使用路径**。复刻、录入并发布到 Local Published 的链路（`plan/apply_working_revision`、`plan/apply_publish` 等）**完全不变**。

## 1. 问题

在没有 MCP App 的宿主中（Claude/Codex/Cursor 的普通对话、Wisp 的 headless 路径），从选中模板到写入项目需要 6 次调用：

```text
search / list_catalog → get_candidate_images → preview_exact_headless
  → confirm_selection_headless → plan_materialize →（用户批准）→ apply_materialize
```

其中 `preview_exact_headless` 和 `confirm_selection_headless` 都由同一个 Agent 连续调用。按 [PROTOCOL](PROTOCOL.md#preview-confirmation-and-writes) 的说明，headless 路径本来就**无法证明用户看到了图**，所以第二次调用并没有带来额外的保证，只增加了一轮往返和一次出错的机会。

## 2. 现有调用各自保证了什么

| 保证 | 由哪一步提供 | 是否必须保留 |
|---|---|---|
| G1 身份：写入的是检索结果里那个精确的 Provider 和 selector，目录和 Library 绑定没有变化 | 结果集校验与 receipt 绑定（selector 摘要、catalogRevision、绑定摘要） | 必须 |
| G2 精确预览：材料化之前展示过这个精确版本的预览图 | `preview_exact_headless` 返回图片 | 必须（展示图片本身） |
| G3 写入批准：写入用户项目之前，用户看过并批准了具体计划 | `plan_materialize` 返回计划，`apply_materialize` 只认 `planDigest` | 必须 |
| G4 一次性、限本会话、过期即作废，Apply 可安全重放 | receipt 单次使用；计划缓存；全局 Library Receipt | 必须 |
| "确认"这一动作 | `confirm_selection_headless` 回传 challenge | headless 下由同一 Agent 完成，**不提供 G1–G4 之外的保证** |

## 3. 方案对比

### 方案 A：精确预览直接签发 receipt（5 步）

`preview_exact_headless` 增加必填参数 `selectionBasis: "user_selected" | "delegated"`，在返回图片的同时直接签发 `previewReceipt`，不再需要 `confirm_selection_headless`。

- 优点：改动最小，`plan_materialize` 和 `apply_materialize` 都不变。
- 缺点：仍是 5 步；receipt 这个概念依然暴露给 Agent。

### 方案 B：plan 自带精确预览（4 步，推荐）

`plan_materialize` 除了现有的 `previewReceipt` 输入，**新增一种输入**：`resultSetId` + `candidateId`（或 `providerId` + `exactSelector`）+ `selectionBasis`。在这种输入下，plan 在服务端内部完成精确预览解析，并在**同一个响应中**返回：

1. 精确预览图（标准 MCP `image` 内容块，带 `sourceSha256`）；
2. 现有的计划内容（精确 selector、目标目录、获取策略、`planDigest`）。

`planDigest` 同时绑定精确预览图的 SHA-256。用户看到"这张图 + 这个写入计划"后批准，Agent 再调用 `apply_materialize`。**用户对 plan 的批准就同时覆盖了"确认精确版本"和"批准写入"。**

```text
list_catalog / search → get_candidate_images →
  plan_materialize（返回精确预览 + 计划）→（用户批准）→ apply_materialize
```

- G1：plan 内部做与现在完全相同的结果集、selector 和绑定校验。
- G2：精确预览图放在 plan 响应里，与写入计划一起展示，**比现在更难被跳过**。
- G3：不变，`apply_materialize` 仍然只认 `planDigest`、`operationId`、`expectedProviderId`、`expectedTarget`。
- G4：不变；预览解析结果只存在于计划缓存中，单次使用，并在过期时作废。

### 方案对比小结

| | 现状 | 方案 A | 方案 B |
|---|---|---|---|
| headless 调用次数 | 6 | 5 | **4** |
| 需要 Agent 理解 receipt/challenge | 是 | 是（只有 receipt） | **否** |
| 精确预览与写入计划同屏 | 否 | 否 | **是** |
| 改动的工具 | — | `preview_exact_headless` | `plan_materialize`（新增一种输入） |
| G1–G4 | 满足 | 满足 | 满足 |

## 4. 兼容与发布

- **App 路径不变**：App 中 `preview_exact` → 用户点击 → `confirm_selection` 的强确认链路保持原样。
- **本地客户端不变**：`confirmationMode: local` 的路径保持原样。
- **旧调用方式继续有效**：现有的 receipt 输入保留至少一个次版本；`describe` 与 `get_skill` 返回的能力字段增加 `materializationProtocolVersion: 3` 和 `planIncludesExactPreview: true`，Skill 按版本选择流程。
- `confirm_selection_headless` 在至少一个次版本内保留，标记为过渡；之后是否移除另行决定。
- `create_plot_task_headless` 的多模板交接：每个 `taskItems` 条目各自走一次方案 B 的 plan。

## 5. 风险

| 风险 | 缓解 |
|---|---|
| plan 响应变大（多了一张图） | 预览沿用现有单图预算（256 KiB），与 `preview_exact_headless` 相同 |
| Agent 不展示图片就直接 apply | 与现在 headless 路径的边界相同；Skill 要求先展示 plan 的图片和目标再请求批准；验收报告继续注明"无法证明用户看到" |
| 两种输入并存，增加 plan 的复杂度 | 两种输入在入口处汇合到同一个内部"已确认精确选择"结构，后续逻辑只有一份 |

## 6. 验证计划

- 单元与集成测试：方案 B 的 4 步路径；旧 receipt 路径的回归；stale（目录变化、绑定变化、会话重启）在 plan 和 apply 两处都被拒绝；`planDigest` 与预览 SHA-256 的绑定；重放语义。
- `npm run test:smoke` 增加 4 步路径。
- 真实宿主验收（构建与 smoke 通过不等于宿主验收通过）：优先 Wisp Science，其次 Claude Code / Codex 的普通 MCP 路径。

## 7. 待维护者决定

1. 采用方案 A 还是方案 B。
2. 旧 receipt 输入和 `confirm_selection_headless` 的保留期限。
3. `selectionBasis: "delegated"`（用户委托 Agent 代选）是否仍然允许走这条精简路径。
