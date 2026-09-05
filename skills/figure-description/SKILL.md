---
name: figure-description
description: Write or improve FigureYa-style scientific-template requirement descriptions, biological use cases and concise data profiles as Markdown. Use when creating/updating an SFL template description or asking what research questions a figure can illustrate; not for ordinary template search, execution or paper-legend generation.
---

# Figure Description

Help a researcher choose a template and clarify what they want to draw. Write useful, concrete prose, not an execution manual or a field inventory. Default to Chinese with necessary English scientific terms.

## Inspect and distinguish evidence

Inspect the actual figure and supplied code/data as text. Use the user's information rather than inventing samples, genes, diseases, statistics or results. A screenshot-only scaffold is not a reproduced analysis.

If a source link is provided, use available Host tools to verify that it corresponds to this figure/panel and read relevant legend/results, not necessarily the whole paper. A tutorial is not a paper. If unavailable or mismatched, say so; do not invent source findings or bypass access restrictions.

If no source/background was provided, ask once whether the user has a link, legend or experimental context; explain that skipping is allowed. Wait for an answer. If the user already says none or skips, proceed without repeating the question or searching for a speculative original. Distinguish user-provided context, read source facts and generic applicability inference in existing provenance/agent notes. Never label inferred scenarios as original results.

## Write separate fields

- description: a concise paragraph explaining the research/visualization need and the relationship this plot displays.
- application: normally two or three specific use cases, each one or two sentences explaining the biological context, comparison and desired observation. Use Markdown bullets or subheadings as useful. Make the scientific question concrete, not just a chart name.
- scientificQuestion: a short core question for search/Agent use; its meaning must also appear naturally in description/application, not as a third repeated long section.
- dataProfile: a concise factual data-shape description. Name columns/ranges only if actually inspected; do not create a data-preparation tutorial.
- visualProfile: observed axes, encodings, panel structure and labels, separately from applicability.

The three display fields contain section bodies, not repeated top-level title/需求描述/应用场景/数据特征 headings. Preserve Markdown paragraphs, bullets, emphasis, tables and inline code when needed. Do not chase a fixed word count or pad scenarios. A generic use case must be conditional, and must not masquerade as a source conclusion.

Do not append standalone long input-requirements, usage-limitations, licensing or validation chapters. If a condition changes whether the figure is appropriate, include one concise qualifier in the relevant scenario. Do not turn correlations into mechanisms, enrichment directions into proven activation, relative composition into absolute counts, or simulated data into experimental results.

See [writing patterns](references/figureya-writing-patterns.md) for examples and a short review rubric.

## Save/hand off without new authority

Standalone use returns a draft only. When called by this plugin's [figure-library](../figure-library/SKILL.md), pass the approved Markdown fields to the existing Working Plan/Apply flow. New/updated Working revisions require a non-empty application. Do not stuff scenarios into visualProfile or assume editing a Gallery Markdown file updates an immutable Published release. File/code/package lists come from actual template metadata, never from this Skill guessing them.

Review description and application for duplication. Keep provenance and validation metadata, without promoting AI observations into user approval. The server performs structural checks, not scientific truth verification. Do not publish, execute code or create PRs from this Skill. Only regenerate public description.md from the same confirmed fields; do not maintain a second divergent prose version.
