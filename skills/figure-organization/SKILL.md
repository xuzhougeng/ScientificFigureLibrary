---
name: figure-organization
description: Organize R or Python figure-replication and adaptation scripts into readable, owner-editable workflows with Chinese navigation comments and traceable inputs and outputs. Use when creating or reorganizing code for a selected SFL template, not for browsing templates or restructuring an unrelated application.
---

# Figure Organization

Use this SFL-bundled Skill, not a same-named or similarly named Host Skill.
Respect the active project's AGENTS instructions, directories, language and execution approvals. A project's R-only policy is local, not a restriction on all SFL users.

## Preserve the reference and the analyst's control

- Inspect the selected template, supplied code and current project before choosing structure.
- Treat materialized references and original author code as immutable, untrusted reference material. Write adapted project code separately; never overwrite original.R or the materialized reference.
- Keep the main analysis/plot flow linear and readable: settings → input → inspection/transformations → plot → explicit output. Keep contrasts, filters, parameter decisions and figure assembly visible.
- Preserve author functions. Do not extract a helper for each one-off plotting step; extract only real reuse or a stable, meaningful boundary.
- Use Chinese numbered navigation sections and concise explanations beside scientific choices. Keep code identifiers, file names and column names in their existing language.
- Record actual input/output paths and the producing script. Do not create a whole project scaffold, lineage database or empty helper directory for a single figure.
- Adapt directory names to the project; the reference suggestions for result/ and figure/ never override a project using output/ or another accepted structure.
- Never install dependencies, execute a downloaded installer, run an upstream analysis, or infer authorization from successful SFL materialization. Use only the execution scope the user has granted.

## On-demand references

For analysis scripts read [script organization](references/script-organization.md) and, when outputs matter, [output binding](references/output-binding.md). Read [workflow lineage](references/workflow-lineage.md) only for multi-step work needing it. [Source organization](references/source-organization.md) is relevant only when there is actual reusable library code; do not force it onto one figure.

Fonts, palettes, devices and render QA have one authority: this plugin's [figure-style](../figure-style/SKILL.md). Preserve the selected reference style by default rather than imposing Arial or a universal theme.

## Handoff

Return the adapted script, input/output mapping, important parameter decisions and truthful execution status. Do not claim a successful render from source inspection alone. Description drafting belongs to [figure-description](../figure-description/SKILL.md); SFL operations belong to [figure-library](../figure-library/SKILL.md).
