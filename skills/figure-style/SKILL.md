---
name: figure-style
description: Check correctness, legibility and faithful visual reproduction of selected scientific figure templates in R or Python. Use when adapting plotting code or inspecting rendered output, not for browsing templates. Includes an optional matplotlib sidecar and R-specific guidance; does not install packages or execute code automatically.
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
3. The selected template's layout, palette, font, legend, axes and visual identity.
4. General style defaults only where the reference/user does not specify an answer.

Do not silently replace a palette, font, chart type, legend, grid or layout to comply with a generic aesthetic preference. Where the reference has low contrast, overlaps or inconsistent labels, explain the issue and propose a change; do not conceal the defect or call a restyled version a faithful reproduction. Never alter data to make a preferred shape. Plotting a synthetic scaffold is not reproducing the original experiment.

## Backend routing

- For R/ggplot2/base graphics read [R guidance](references/r-backend.md). R never requires the Python kernel.
- For Python/matplotlib read [Python guidance](references/python-backend.md). The bundled kernel is optional and local; its absence in the Host's global skills is irrelevant.
- For other backends apply the correctness checks without switching language or claiming an unsupported automated QA check passed.

Read [correctness and render checks](references/checks.md) before finalizing the output. This Skill does not depend on figure-composer or paper-narrative; multi-panel work stays within the requested figure boundary.

## Execution and output

Materialization downloads/verifies/writes references; it does not authorize arbitrary code execution. Inspect sources before adapting them, use only the project's approved runtime, never install packages automatically, and keep references immutable. Write adapted project code under [figure-organization](../figure-organization/SKILL.md).

After an authorized render, verify file existence and meaningful dimensions, then inspect the actual output with the Host's available image viewer. Inspect per-panel crops when needed. If no image viewer is available, disclose that visual QA remains unverified. Collision scans and successful process exit do not prove visual correctness or scientific validity. Do not rerun expensive upstream analysis merely to restyle a plot.
