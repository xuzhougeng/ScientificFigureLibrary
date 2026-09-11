---
name: figure-style
description: Apply explicitly saved user plotting preferences, check correctness and legibility, and reproduce selected scientific figure templates in R or Python. Use for saving or overriding style defaults, adapting plotting code or inspecting rendered output, not browsing templates. Does not install packages or execute code automatically.
license: Apache-2.0
---

# Figure Style — faithful template first

This SFL-bundled entrypoint adapts Wisp Science's Apache-2.0 figure-style
guidance. See [LICENSE](LICENSE) and [NOTICE.md](NOTICE.md) for the attribution
and adaptation record.

Use this plugin's Skill rather than a Host copy. Follow the user's selected backend and project runtime approvals. A local R-only project rule does not prohibit Python in other projects.

## Priority

1. Data and semantic truth: labels, thresholds, colour mappings and summaries must agree with the actual data and analysis.
2. The user's explicit current requirements.
3. The enabled user's saved style profile, unless this task explicitly requests faithful template reproduction.
4. The selected template's layout, palette, font, legend, axes and visual identity.
5. General style defaults only where the reference/user does not specify an answer.

Before adapting plotting code, call `figure_library_resolve_style` with known template settings and current overrides. Pass `faithfulTemplate: true` for an explicit faithful-reproduction request. Read the returned effective settings and apply them in the host's plotting backend; the tool itself does not enforce rendering. Explain conflicting settings actually chosen. Preserve semantic group keys when applying saved colors and never alter statistical methods or data.

Only use `figure_library_save_style_profile` when the user explicitly asks to remember or change defaults; first read `figure_library_get_style_profile` and use its revision. Saving replaces the settings, so preserve unrelated preferences when making an incremental change. Use `figure_library_reset_style_profile` for an explicit reset. Current-task overrides must not be saved implicitly.

Example: “记住我的实验室绘图规范：Arial，A 组蓝色、B 组橙色，宽 85 mm，导出 PDF 和 600 DPI PNG。” Another task can say “这次宽 100 mm，其他沿用实验室规范” without changing the saved profile. Store the resolved profile revision, effective parameters and current overrides in the figure archive's `details.style`. Check actual fonts, sizes, group colors and backend format support; report missing fonts or unverified output rather than claiming compliance from configuration alone.

Do not silently replace a palette, font, chart type, legend, grid or layout to comply with a generic aesthetic preference. Where the reference has low contrast, overlaps or inconsistent labels, explain the issue and propose a change; do not conceal the defect or call a restyled version a faithful reproduction. Never alter data to make a preferred shape. Plotting a synthetic scaffold is not reproducing the original experiment.

## Backend routing

- For R/ggplot2/base graphics read [R guidance](references/r-backend.md). R never requires the Python kernel.
- For Python/matplotlib read [Python guidance](references/python-backend.md). The bundled kernel is optional and local; its absence in the Host's global skills is irrelevant.
- For other backends apply the correctness checks without switching language or claiming an unsupported automated QA check passed.

Read [correctness and render checks](references/checks.md) before finalizing the output. This Skill does not depend on figure-composer or paper-narrative; multi-panel work stays within the requested figure boundary.

## Execution and output

Materialization downloads/verifies/writes references; it does not authorize arbitrary code execution. Inspect sources before adapting them, use only the project's approved runtime, never install packages automatically, and keep references immutable. Write adapted project code under [figure-organization](../figure-organization/SKILL.md).

After an authorized render, verify file existence and meaningful dimensions, then inspect the actual output with the Host's available image viewer. Inspect per-panel crops when needed. If no image viewer is available, disclose that visual QA remains unverified. Collision scans and successful process exit do not prove visual correctness or scientific validity. Do not rerun expensive upstream analysis merely to restyle a plot.
