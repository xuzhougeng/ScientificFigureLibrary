# Script Organization

Use this reference for analysis projects, pipelines, notebooks converted into scripts, and script-first repositories.

## Principle

Organize scripts by:

```text
module -> stage -> script id -> action name
```

The script is the main engineering asset. Outputs, figures, workflow entries, and lineage entries should be traceable back to scripts.

For bioinformatics and exploratory analysis, the script is also the analyst's editable record. Preserve the ability for the project owner to review, tweak parameters, rerun sections, and understand the scientific logic without jumping through many helper functions.

## Recommended Shapes

Small project:

```text
scripts/
  00-prepare_data.R
  01-run_analysis.R
  02-make_figures.R
utils/
```

Medium or staged project:

```text
scripts/
  00-upstream/
  01-qc/
  02-analysis/
  03-visualization/
utils/
```

Large multi-topic project:

```text
module-a/
  scripts/
  utils/
module-b/
  scripts/
  utils/
```

Use module-level organization only when modules have distinct workflows or lifecycles.

## Learning Existing Scripts

Before generalizing a project's script style, inspect representative scripts deeply enough to understand:

- how inputs are loaded and named;
- where parameters and thresholds are declared;
- how objects are transformed across analysis stages;
- how annotations, metadata, reductions, models, or statistics are stored;
- how result data and figures are written;
- which helpers are reused and which logic stays inline;
- how comments explain scientific intent, especially Chinese navigation comments that mark purpose, decisions, and human review gates.

Do not summarize only filenames. The organization pattern comes from both directory layout and script body structure.

## Naming

Script names should encode:

```text
order + action + object/context
```

Good:

```text
00-cell_qc.R
01-single_sample_annotation.R
02-multi_sample_integration.R
03-regulon_activity.py
04-lineage_choice.R
```

Avoid:

```text
test.R
new.R
final.R
plot1.R
analysis_copy.py
```

## Script Header

For script-first projects, use a compact header:

```r
# Script: 04-lineage_choice.R
# Purpose:
# Input:
# Output:
# Figure:
# Status:
```

Keep headers truthful and maintainable. Do not write long documentation that becomes stale.

## Internal Sections

Use predictable numbered blocks with Chinese titles (Python and R alike):

```text
0. 环境设置
1. 读取输入
2. 准备数据
3. 执行分析
4. 保存结果
5. 保存图片
```

Inside each section, add short Chinese orientation comments for purpose, key choices, and human checkpoints. Do not use English-only section headers in analysis scripts unless the project explicitly prefers that.

## Owner-Editable Analysis Scripts

Bioinformatics scripts should be easy for the analyst to audit and change. Prefer a visible top-down workflow:

```text
setup -> load input -> inspect/filter -> analyze -> save result -> save figures
```

Avoid turning the script body into a list of opaque function calls such as:

```text
run_step_1()
run_step_2()
run_step_3()
```

unless those functions are stable, well-named domain operations that the owner already accepts.

Keep these in the script:

- dataset-specific decisions;
- thresholds, marker lists, contrasts, comparisons, and plotting choices;
- object names and saved-file names;
- short transformations used only once;
- Chinese navigation comments that explain why a step exists, what to inspect next, and which conclusions still need human judgment.

## Chinese Navigation Comments

Analysis scripts are reading text as well as executable code. When writing or rewriting scripts:

```text
Must comment in Chinese:
1. numbered section titles
2. start of each major code block: purpose and upstream/downstream role
3. critical parameters: why this value, or that it awaits human confirmation
4. biology / analysis decisions and subsequent Gates
5. review checkpoints: what to look at before continuing
6. checkpoint / skip logic: what reuse means and when to recompute
```

Good comments read like analysis notes, not syntax narration. Skimming comments alone should reveal the storyline; code then confirms details.

Avoid:

```text
- long English narrative instead of Chinese orientation
- line-by-line translation of obvious syntax
- empty phrases with no decision content
- putting parameters only in comments instead of in code
```

If the project defines `docs/ai_context/script_style.md`, follow that file's「中文导航注释」section as the local authority.

Extract to `utils/` only when:

- the same logic is repeated across scripts;
- the helper has a clear domain name;
- the extracted code can be understood independently;
- extraction makes review easier rather than harder.

`utils/` should not become a hiding place for every analysis step.
