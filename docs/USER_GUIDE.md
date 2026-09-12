# Scientific Figure Library User Guide

English | [简体中文](USER_GUIDE.zh-CN.md) · [Back to README](../README.md)

This guide is for first-time scientific users of Scientific Figure Library
(SFL) and follows the flow "index → figure/function → data preparation →
invocation example → output and revision". It stays structurally identical to
the Chinese version [USER_GUIDE.zh-CN.md](USER_GUIDE.zh-CN.md); section
numbering and technical identifiers match.

The text uses three status markers so planned capabilities are never
presented as shipped ones:

| Marker | Meaning |
| --- | --- |
| ✅ Implemented | Shipped in the current version, ready to use |
| 🤖 Host model | Performed by the model inside Claude/Codex/Cursor etc., usually with your confirmation |
| 🕓 Planned | Still an open issue; honestly labeled as such |

## Table of contents

1. [Scope and boundaries](#1-scope-and-boundaries)
2. [Install and first-run setup](#2-install-and-first-run-setup)
3. [Browse, search, and confirm templates](#3-browse-search-and-confirm-templates)
4. [Figure index (by purpose)](#4-figure-index-by-purpose)
5. [Prepare your own figure and data](#5-prepare-your-own-figure-and-data)
6. [Fonts, colors, sizes, and export](#6-fonts-colors-sizes-and-export)
7. [Viewing output and redrawing](#7-viewing-output-and-redrawing)
8. [FAQ](#8-faq)
9. [Advanced reference](#9-advanced-reference)

Appendices:

- [Appendix A: end-to-end example](#appendix-a-end-to-end-example)
- [Appendix B: document maintenance and link checks](#appendix-b-document-maintenance-and-link-checks)

---

## 1. Scope and boundaries

SFL is a **local-first** stdio MCP server plus an MCP App. It collects your
scientific figures and their code into one global Library on your machine,
publishes reviewed Releases that can never be mutated, and reuses those exact
templates across projects and hosts.

Three parties are involved; for every step, ask who does it:

| Role | Who | Responsibility |
| --- | --- | --- |
| You | The researcher | Choose directories, confirm paths and templates, provide data, request plots |
| Host model | The coding agent in Claude Science / Wisp Science / Codex / Cursor / Claude Code | Inspect files, call SFL tools, edit plotting code, execute inside approved runtimes |
| SFL server | The `figure-library` MCP server | Hash, version, review-gate, publish, and exactly materialize templates |

**What SFL does (✅ implemented):**

- Maintains **one global Library** in a user-chosen directory, shared across
  projects and hosts
- **Direct image + code intake**: immutable Revisions, review records, Releases
- MCP App gallery: browse, exact preview, and user confirmation before anything
  proceeds
- Unified retrieval in the default order: **Local Published → FigureYa →
  Open Figure Modules (bundled or verified updated catalog) → enabled dynamic personal Providers that
  explicitly opt into default search**; the Community snapshot is frozen and
  excluded from default search
- **Exact materialization**: copies the one template you confirmed into a
  project; the target directory is never overwritten, and a
  `template.lock.json` is written
- Portable backup / restore / fork (bundle export / full restore)

Collapsible plotting tips and a copyable example help express current-task requirements without a mandatory form or persistent style settings. More examples are in [section 6](#6-fonts-colors-sizes-and-export).

**What SFL does not do (✅ boundaries are equally implemented):**

- It **never executes plotting code** and contains no second model;
  `template.lock.json` always records `codeExecutedBySflClient: false`
- It never silently writes into the current project; writes fail closed until
  a global Library is explicitly bound
- It never promotes upstream status to local verification: FigureYa templates
  are marked `not_reviewed` with code `not_run`

**What the host model does (🤖):** editing code, running R/Python, inspecting
images, and iterating all happen in the host session and depend on the
runtimes you approved for the project plus the host's image-viewing tools.
The three auxiliary Skills (figure-description, figure-organization,
figure-style) guide those behaviors; see [section 9](#9-advanced-reference).

**Planned (🕓, none implemented at the time of writing):**

- [#17](https://github.com/xuzhougeng/ScientificFigureLibrary/issues/17): persist
  a user style profile and apply it automatically in later sessions — today
  font/color preferences last only for the current session
- [#19](https://github.com/xuzhougeng/ScientificFigureLibrary/issues/19): enforce
  one-figure-one-folder archiving and submission packaging by default — today
  the host model organizes folders on request only, see
  [section 7](#7-viewing-output-and-redrawing)

---

## 2. Install and first-run setup

**Prerequisites (you):** Node.js 22 or newer; any stdio MCP host (Wisp
Science, Claude Science, Codex, Claude Code, Cursor, and others).

### 2.1 Installation

Keep host-specific install, packaging, and connection instructions in the
[QUICKSTART](QUICKSTART.md), rather than duplicating commands here. From an
unpacked plugin, use the [online quickstart](https://github.com/xuzhougeng/ScientificFigureLibrary/blob/main/docs/QUICKSTART.md).

Give a terminal-capable host model this request:

```text
Install Scientific Figure Library from
https://github.com/xuzhougeng/ScientificFigureLibrary using its QUICKSTART
and the instructions for my host. Explain downloads and configuration changes
before asking for my approval. Do not run plotting code or automatically install
plotting dependencies. Once connected, check setup status and ask for explicit
absolute Library and Local workspace paths if either binding is missing.
Tell me when folder access, a host restart, or a new session is needed.
```

Do not register both a bare MCP configuration and a plugin for the same server.

### 2.2 First-run setup: bind two directories

A fresh install stays in `setup_required` until two directories are bound.
The **global Library** (绘图仓库) is the single machine-wide one; the **Local
workspace** is the working directory on the project side.

| Step | Who | Tool / action |
| --- | --- | --- |
| 1. Check status | Host model | Call `figure_library_source_status` or `figure_library_open`; expect `setup_required` |
| 2. You provide two **absolute paths** | You | e.g. `D:\figure-library` and the current project folder; do not casually use the project as the global Library |
| 3. Plan the binding | Host model | Show the exact directories and plan; do not apply before confirmation; tool names are in section 9.5 |
| 4. Confirm the paths | You | Verify the displayed paths before confirming |
| 5. Apply the binding | Host model | Apply the confirmed plans in the same server session |
| 6. Re-check | Host model | `figure_library_source_status` again; writes enabled, counts correct |

The binding is recorded in the machine-local locator (Windows:
`%APPDATA%\ScientificFigureLibrary\locator.json`; Linux/WSL:
`~/.config/scientific-figure-library/locator.json`). `FIGURE_LIBRARY_DIR` is
an admin override only; daily use does not need it.

---

## 3. Browse, search, and confirm templates

The core discipline is **view the real preview, explicitly confirm that card,
then materialize**. Materialization copies the confirmed template into the
project; it does not execute code.

Click a title or empty card area to select or deselect; use the selected marker and count as feedback. Thumbnails and **查看详情** open details. Basic detail browsing emits no diagnostic tool calls. Neither a selection checkbox nor a host tool approval is an exact-preview confirmation or permission to materialize or execute code.

| Step | Who | What you need to know |
| --- | --- | --- |
| 1. Describe the goal and search | You → host model | State the research question, available data, and preferred source; the model shows actual candidates |
| 2. Browse candidates | You | Inspect thumbnails, use cases, input requirements, and sources; retrieval scores are not confidence or scientific validation |
| 3. Choose a template | You | The model stops after search unless you explicitly delegate the choice |
| 4. View the exact preview | Host model / App → you | View the actual selected version; hosts without an App use the headless preview flow |
| 5. Explicitly confirm | You | Only confirmation after the exact preview produces a session-local, single-use preview receipt |
| 6. Check the materialization plan | Host model → you | Check the template, file set (template/full), network needs, and absolute destination before confirming |
| 7. Apply materialization | Host model calls SFL | Preserve the receipt and exact identity; output is `<destination>/<templateId>` and existing directories are not overwritten |
| 8. Inspect the files | You + host model | Review the inventory and `template.lock.json`, then adapt your data; no plotting code has run |

See [section 9.5](#95-tool-reference) for tool names; users do not need to memorize them.

- **Search scope:** defaults are in section 1; frozen Community is explicit-only. Provider status can be read offline, but search results are not a complete catalog enumeration.
- **Upstream status is not local verification:** upstream publication, signatures, or review do not establish a successful local run or scientific validity.
- **An empty catalog can be healthy:** a source may legitimately be empty after a withdrawal. Inspect source status rather than reinstalling without diagnosis.

---

## 4. Figure index (by purpose)

**The guide explains workflows; content sources maintain their catalogs.**
This guide does not duplicate an easily stale complete template list or treat
a plugin's bundled count as a permanent total.

- [Current Open Figure Modules content catalog](https://github.com/jarxunlai/ScientificFigureLibrary-personal#current-modules): browse figure families, Chinese names, readable English subtitles, and module links; each module provides previews, descriptions, inputs, and its own license scope.
- [Upstream FigureYa catalog](https://github.com/ying-ge/FigureYa): browse upstream documentation, then search SFL with the FigureYa source and inspect the available version.
- **Local Published and additional Providers:** inspect them in your local workbench; a public content repository is not an inventory of your personal Library.

### 4.1 Search by research question

| I want to | Ask the host model to look for |
| --- | --- |
| Compare cell composition | Cell proportions, grouped bars, or stacked bars |
| Show differential expression | Suitable views for the differential-analysis table, after checking its input fields |
| Show pathway enrichment | Enrichment bars, bubbles, or other enrichment templates |
| Show expression patterns | Heatmaps, annotated heatmaps, or marker dot plots |

```text
Find Open Figure Modules templates for comparing cell composition across two
groups. First inspect my inputs, show candidate previews, input requirements,
and sources, then stop for my choice. Do not automatically download complete
modules or execute code.
```

### 4.2 Why catalog counts differ

| Layer | What it represents |
| --- | --- |
| Content repository | Merged public modules, potentially not yet published to the official feed |
| Official published catalog | The version referenced by the official feed, accepted by clients after signature verification |
| Plugin bootstrap | The offline catalog bundled at packaging time, not the current complete collection |
| Locally loaded catalog | The bundled or verified catalog actually in use, depending on refresh status, connectivity, and configuration |

An older installation's small bootstrap may contain far fewer modules than
the official published collection. Its count is not an upper limit, and this
guide does not hard-code a current total.
Use the content source for current counts and ask the host to read the relevant
Provider's status for local availability. One search page is not a full inventory.

Ordinary module additions, updates, or withdrawals do not require repackaging
the plugin. Search reads the loaded local catalog without waiting for the
network; the official catalog can refresh in the background. If the local
catalog is old, inspect its origin, refresh status, and errors before blaming
the installation.

Continue with [section 3](#3-browse-search-and-confirm-templates), then adapt
your data using [section 5](#5-prepare-your-own-figure-and-data).

---

## 5. Prepare your own figure and data

There are two independent routes: **plot your own data with an existing
template**, or **save a finished figure as a reusable asset**. Using a public
template does not require importing and publishing your own figure first.

### 5.1 Route A: plot your own data with a template

Complete selection and materialization in section 3. Have the host inspect the
project copy's `description.md`, `data_schema.yml`, input files, and actual code.
Provide your data path, column meanings, groups, and units. Unknown meanings
must be clarified; do not guess or change statistical results to fit a figure.

**Minimal teaching example:** `sc-celltype-grouped-stacked-bar` expects a
sample-level long table: one row is the count of one cell type in one sample.
The field contract is grounded in the pinned [data schema](https://github.com/jarxunlai/ScientificFigureLibrary-personal/blob/b349606d7219b58a80a224e409dfd51928d1329b/modules/sc-celltype-grouped-stacked-bar/data_schema.yml)
and [plotting code](https://github.com/jarxunlai/ScientificFigureLibrary-personal/blob/b349606d7219b58a80a224e409dfd51928d1329b/modules/sc-celltype-grouped-stacked-bar/code/organized.R).
The following values are synthetic tutorial data, not experimental results:

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

- Required columns are `Sample_ID`, `Group`, `celltype`, and `n`; counts are nonnegative integers and each sample belongs to one group.
- This code version fixes group levels to `Control` / `Treatment` and orders cell types using Control. Different group names or group-specific cell types require an explicit mapping and order; do not silently turn them into missing values.
- The code pools cell counts by group before drawing 100% stacked bars. It is not an equal-weight average of sample proportions or a differential-abundance test. Changing the aggregation is an analysis decision, not merely styling.
- Preserve the materialized synthetic example. Put real inputs in a separate project file such as `data/user-counts.csv` and explicitly change the project-side script's input path; do not silently overwrite source data.
- Diagnose duplicate rows, negative or missing values, mismatched groups, and zero totals first. Do not automatically delete, merge, zero-fill, or install dependencies.

```text
Inspect the template's data contract and my count table. Explain the row unit
and column mapping. Preserve its synthetic input and use my data path in the
project copy. Confirm group names, cell-type ordering, and the meaning of pooled
group counts before editing. List required R packages and the output directory;
wait for permission to run. Do not call data adaptation a reproduction of the
original study.
```

### 5.2 Route B: save your own figure to the Library

Treat one figure, its code, and its plotting data as a Figure Unit, preferably
in one folder. Use `visual_reference` when reliable code is absent.
This optional asset-capture step is not a prerequisite for route A.

| Material | Requirement |
| --- | --- |
| Image file | The finished figure for this unit (raster or vector); user-uploaded originals must be included |
| Plotting code | The script that produced it (R/Python/anything; SFL records the language but never executes it). When reliable code is absent, the host should import as `visual_reference` rather than pretend a reproducible template exists |
| Plotting data | Plot-ready tables: one row per sample/observation, explicit grouping columns, units in column names; never alter data or statistical meaning for aesthetics |
| Dependencies | The package list (it becomes part of the template description) |
| License | You must have the right to import; the license is recorded truthfully at import time |

### 5.3 Import and publish flow (🤖 host model, with your confirmation at the gates)

| Step | Who | Tool / action |
| --- | --- | --- |
| 1. Inspect files and collect decisions | Host model | Verify image/code/data actually exist; confirm the Figure Unit boundary, figure-code links, license, and validation state |
| 2. Plan the import | Host model | `figure_library_plan_working_revision` (read-only, writes nothing) |
| 3. Review the working preview | You + host model | `figure_library_preview_working_revision` shows the canonical preview |
| 4. Confirm and apply | You → host model | After you confirm that exact plan, `figure_library_apply_working_revision` writes the immutable Working Revision |
| 5. Review and publish | You → host model | `figure_library_review_open` to inspect; `figure_library_plan_publish_working_revision` → confirm → `figure_library_apply_publish_working_revision` publishes the immutable Release |

Once published, the Release is searchable and can be exactly materialized into
any project. Absolute source paths are not persisted; when re-importing the
same unit, the host will confirm with you among `create_new` /
`update_exact` / `reuse_existing`.

---

## 6. Fonts, colors, sizes, and export

**Current mechanism (✅ + 🤖):** the bundled figure-style Skill gives the host
model general plotting-style guidance (fonts, colors, sizes, export checks,
with per-backend details for R and Python), and the model follows your
**current-session** instructions first. SFL itself does **not** remember your
preferences across sessions — a persistent user style profile is still planned
(🕓 [#17](https://github.com/xuzhougeng/ScientificFigureLibrary/issues/17)).
Until that lands, keep preferences in a project-level prompt file or paste one
of the examples below each time.

**Copyable prompts (paste into the host model and adjust):**

Font and size hierarchy:

```text
This figure goes into a paper body: use Arial throughout; main title 10 pt,
axis titles 8 pt, tick labels 7 pt, legend 8 pt. Keep the data mapping and
statistics unchanged while editing the code.
```

Fixed group colors (so reordering subplots never shifts colors):

```text
Fix the group color mapping: Control = #4D4D4D, group A = #0072B2,
group B = #D55E00. Keep these colors regardless of subplot order.
```

Final physical size (A4 PPT manual layout scenario):

```text
The figure will be inserted into an A4 landscape PPT. Export at the final size
of 170 mm × 60 mm, units in mm, no rescaling inside PPT; produce a 300 dpi PNG
and one vector PDF.
```

Export format:

```text
Follow the journal instructions I provide: TIFF, 300 dpi, white background.
Confirm the color space against those instructions and the actual backend.
Do not apply raster DPI to the vector PDF.
```

Provide journal rules or a reference figure directly:

```text
The submission instructions I provide specify a single-column width of 89 mm.
Use that final size; match the attached reference layout without changing the
meaning of the data.
```

**Who does what:** editing and running are done by the host model (🤖) inside
the project-approved R/Python environment; the SFL server never executes
anything. Format capabilities depend on the actual runtime backend — image
intake support and plotting export support should be confirmed separately.

---

## 7. Viewing output and redrawing

**Plot execution chain (🤖):** you request a plot → the host model runs the
script with the project-approved R/Python runtime → it inspects the rendered
image with the host's image tools → it hands the image path and a content
summary back to you. SFL never executes code; at the template layer it only
guarantees "you got the exact version you confirmed".

**Redraw and iterate:** materialized copies belong to the project — edit the
copy directly; the immutable Release in the Library is untouched. To fold the
changes back as a new version, return to the import/publish flow in
[section 5](#5-prepare-your-own-figure-and-data) and create a new
Revision/Release (native versioning, ✅).

**Per-figure organization:** the figure-organization Skill already requires
traceable inputs/outputs (✅ as guidance), but enforced one-figure-one-folder
archival units and submission packaging are still planned
(🕓 [#19](https://github.com/xuzhougeng/ScientificFigureLibrary/issues/19)).
For now you can simply ask the host model to organize that way, for example:

```text
Organize this plotting task as one-figure-one-folder:
figures/fig02a-volcano-treatment-vs-control/ containing scripts/, data/,
the final image, and a README.md recording parameters, data provenance, and
how to re-run. Give me a content inventory when done. Never mix other
figures' data into this folder.
```

That is a session-level agreement with the host model; SFL does not yet verify
archive completeness. Submission packaging (per-figure ZIPs, an indexed
submission bundle) should likewise be requested from the host model directly.

---

## 8. FAQ

**A call returns `setup_required`.**
The global Library or the Local workspace is not bound. Follow
[section 2.2](#22-first-run-setup-bind-two-directories) with two absolute
paths, using Plan/Apply.

**Search returns few or no results?**
Check in order: ① default search only covers Local Published → FigureYa →
Open Figure Modules → explicitly enabled dynamic providers; ② Community is
frozen and excluded from default search — request it explicitly; ③ a bundled
extra catalog may legitimately be an empty source; ④ use
`figure_library_list_provider_sources` (offline) to check provider health.

**Materialize finished — why is there no figure?**
By design: SFL does not execute plotting code. Materialization only copies the
template; plotting happens through the host model in an approved runtime
(see [section 7](#7-viewing-output-and-redrawing)).

**What is `template.lock.json` in my project?**
The materialization record: template identity, source commit, file inventory,
and `codeExecutedBySflClient: false` — no code was executed by the SFL client.

**I want to tweak a published figure.**
Edit the materialized copy inside the project; the Library Release stays
untouched. To capture the changes as a new version, import and publish a new
Revision (see [section 5](#5-prepare-your-own-figure-and-data)).

**New machine or new host?**
On one machine, all hosts share the same global Library (via the locator
file). Across machines use portable bundles:
`figure_library_plan_bundle_export` / `figure_library_apply_bundle_export` to
back up, `figure_library_plan_full_restore` /
`figure_library_apply_full_restore` to restore.

**How do licenses work?**
This repository's code is MIT; imported figures keep the license recorded at
import; upstream FigureYa content is CC BY-NC-SA 4.0 (see
`assets/FIGUREYA_LICENSE.txt`); Open Figure Modules have per-module license scopes recorded in their manifests. See
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

**The content catalog and SFL show different counts?**
Content, official publication, plugin bootstrap, and locally loaded catalogs
are different layers; see [section 4.2](#42-why-catalog-counts-differ).
Keyword filtering and pagination also mean search results are not a full inventory.

**Will my data be uploaded? Does SFL access the network?**

- SFL Library files live in the local directory you bind; SFL has no hosted backend for these files.
- Search reads the loaded local catalog without waiting for the network, and reading Provider status is itself offline. With auto-refresh enabled, process startup and later background checks can fetch the official catalog and previews without asking separately each time.
- Fetching public catalog metadata and previews is not publishing your Library. Complete module archives are obtained through confirmed materialization; GitHub or official-channel publication has separate explicit authorization gates.
- Users can disable official auto-refresh through its configuration flow or `SFL_OPEN_FIGURE_AUTO_REFRESH=0`. This does not make other explicitly requested network operations or the host model offline.
- Handling of data, images, and conversations sent to a host model depends on that host and model service. Local-first SFL does not guarantee an offline end-to-end workflow; check host data policies before sharing sensitive material.

Security boundaries: [SECURITY.md](../SECURITY.md).

**Missing fonts or dependencies, or a failed render?**
Ask the host for the original error, actual runtime, and missing requirements.
Separate input-contract, font, package, and export-backend problems. Do not
silently install packages, substitute fonts, or alter data to hide a failure;
approve the proposed fix before it runs.


---

## 9. Advanced reference

### 9.1 Repository layout

```text
ScientificFigureLibrary/
├── assets/
│   ├── catalog.json               # FigureYa catalog snapshot (generated)
│   ├── personal-modules/          # Open Figure Modules bootstrap catalog and previews
│   └── thumbs/                    # FigureYa thumbnails
├── docs/
│   ├── USER_GUIDE.md              # This guide (English)
│   ├── USER_GUIDE.zh-CN.md        # This guide (Chinese)
│   ├── PROTOCOL.md                # Full tool contract
│   ├── QUICKSTART.md              # Install quickstart
│   └── GLOBAL_LIBRARY_0.6.md      # Current Library design
├── scripts/                       # Build/package/document-check scripts
├── skills/                        # The four bundled Skills
└── src/                           # MCP server implementation
```

### 9.2 Bundled Skills

| Skill | Responsibility |
| --- | --- |
| figure-library | SFL tool and workbench discipline: search, confirm, materialize |
| figure-description | Template description writing: requirements, use cases, data profile in safe Markdown |
| figure-organization | Figure Unit organization: traceable inputs/outputs, intake boundaries |
| figure-style | Plotting style guidance: fonts, colors, sizes, export; R/Python backend checks |

All four plugin packages (Wisp/Codex/Claude/Cursor) bundle every Skill; hosts
do not need to install them separately.

### 9.3 Protocol and related documents

- [PROTOCOL.md](PROTOCOL.md): the full contract for every MCP tool
  (plan/apply, receipts, error codes)
- [QUICKSTART.md](QUICKSTART.md): install and first session
- [GLOBAL_LIBRARY_0.6.md](GLOBAL_LIBRARY_0.6.md) and
  [GLOBAL_LIBRARY_0.5.md](GLOBAL_LIBRARY_0.5.md): Library design and the
  0.5 → 0.6 migration
- [WISP_UPDATES.md](WISP_UPDATES.md): Wisp plugin update feed
- [SECURITY.md](../SECURITY.md) / [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md)

### 9.4 Related issues and implementation status

| Issue | Content | Status |
| --- | --- | --- |
| [#17](https://github.com/xuzhougeng/ScientificFigureLibrary/issues/17) | Persist a user style profile and auto-apply it | 🕓 Planned |
| [#18](https://github.com/xuzhougeng/ScientificFigureLibrary/issues/18) | User-visible plotting tips and requirement examples | 🕓 Planned |
| [#19](https://github.com/xuzhougeng/ScientificFigureLibrary/issues/19) | One-figure-one-folder archiving and submission packaging | 🕓 Planned |
| [#20](https://github.com/xuzhougeng/ScientificFigureLibrary/issues/20) | This bilingual user guide | Delivered with this guide ✅ |

---

### 9.5 Tool reference

For host models and advanced users; ordinary users need not memorize these names.

| Operation | Tools |
| --- | --- |
| Setup | `figure_library_source_status`, `figure_library_open`; `figure_library_plan_bind_global` / `figure_library_apply_bind_global`; `figure_library_plan_bind_workspace` / `figure_library_apply_bind_workspace` |
| Search | `figure_library_search`, `figure_library_list_provider_sources` |
| Preview / confirm | `figure_library_preview_exact` / `figure_library_confirm_selection`; `figure_library_preview_exact_headless` / `figure_library_confirm_selection_headless` |
| Materialize | `figure_library_plan_materialize` / `figure_library_apply_materialize` |

Show binding and materialization plans and wait for confirmation. Preserve the
exact preview's `providerId`, `exactSelector`, and `previewReceipt`; a missing
receipt yields `preview_required`. Full parameters, intake/publication, and
backup/restore contracts remain in [PROTOCOL](PROTOCOL.md), not in a second
protocol maintained here.

---

## Appendix A: end-to-end example

Scenario: a new user reproduces the single-cell cell-type proportion stacked
bar template from Open Figure Modules
(`sc-celltype-grouped-stacked-bar`) for their own submission figure.

| # | You | Host model | SFL server |
| --- | --- | --- | --- |
| 1 | Send the install request (section 2.1 prompt) | Install per QUICKSTART and register the MCP server | — |
| 2 | Provide two absolute paths, e.g. `D:\figure-library` and the project folder | Plan the binding, show paths, Apply after your confirmation | Validate paths, write the locator, enable writes |
| 3 | Ask to search Open Figure Modules for `sc-celltype-grouped-stacked-bar` | `figure_library_search`, present candidate cards, then **stop and wait for your pick** | Return candidates with thumbnails and `exactSelector` |
| 4 | Open the details, exact-preview, confirm that card | Use `preview_exact`/`confirm_selection` (or the headless pair) per host capability | Issue the one-time `previewReceipt` |
| 5 | Confirm the materialization plan | `figure_library_plan_materialize` → your confirmation → `figure_library_apply_materialize` into your explicitly supplied absolute destination | Validate receipt and plan, copy the `template` file set, write `template.lock.json` |
| 6 | Check row units, columns, groups, and aggregation as in section 5.1 | Preserve the synthetic input and explicitly change the input path in the project copy | — |
| 7 | State style requirements (section 6 prompts: Arial, fixed group colors, 170 mm × 60 mm, 300 dpi) | Edit the project-side script copy following figure-style guidance | — |
| 8 | Approve execution | Verify dependencies and an explicit output directory, run in the project-approved R environment, and inspect the image | — |
| 9 | Review the figure, request changes | Iterate and redraw | — |
| 10 | When satisfied, ask for one-figure-one-folder organization (section 7 prompt) | Organize the archive and deliver the inventory | — |

The distributed script generates `render.png` and defaults to an R temporary directory. After approval, the host should set an explicit project output directory using `SFL_OUTPUT_DIR` or verified script arguments. PDF/TIFF require changes to the project-side export code and actual validation. This walkthrough is not evidence of a successful run on your machine.

If any step gets stuck, ask the host model which step it is on and which
confirmation is missing; error codes such as `setup_required` and
`preview_required` are specified in [PROTOCOL.md](PROTOCOL.md).

## Appendix B: document maintenance and link checks

Run from a complete source checkout:

```bash
npm run docs:check-links
node --test tests/docs-link-checker.test.ts
```

The check covers supported Markdown local links and heading anchors in the
READMEs, guides, and QUICKSTART. External links are counted, not fetched.
It does not download modules or refresh local catalogs and needs no dependency
installation. Passing does not prove external availability, host installation,
or plotting success.

- Keep both languages aligned in structure, data contracts, feature status, and technical identifiers.
- README entries use online guide URLs, including in unpacked plugins and npm packages, rather than pointing to guides absent from the package. Reading the online guide requires network access.
- Complete source checkouts can still read the guide offline. Full public catalogs remain with their content sources; this guide does not duplicate or force them into installation packages.
- If a complete reproducible offline index is needed later, define a pinned official publication snapshot and update workflow separately; do not equate bootstrap with the current collection.
