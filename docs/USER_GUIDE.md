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
- [Appendix B: regenerating the index and checking links](#appendix-b-regenerating-the-index-and-checking-links)

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
  bundled Open Figure Modules → enabled dynamic personal Providers that
  explicitly opt into default search**; the Community snapshot is frozen and
  excluded from default search
- **Exact materialization**: copies the one template you confirmed into a
  project; the target directory is never overwritten, and a
  `template.lock.json` is written
- Portable backup / restore / fork (bundle export / full restore)

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
- [#18](https://github.com/xuzhougeng/ScientificFigureLibrary/issues/18): a
  user-visible plotting tips card with requirement examples — for now use the
  prompts in [section 6](#6-fonts-colors-sizes-and-export)
- [#19](https://github.com/xuzhougeng/ScientificFigureLibrary/issues/19): enforce
  one-figure-one-folder archiving and submission packaging by default — today
  the host model organizes folders on request only, see
  [section 7](#7-viewing-output-and-redrawing)

---

## 2. Install and first-run setup

**Prerequisites (you):** Node.js 22 or newer; any stdio MCP host (Wisp
Science, Claude Science, Codex, Claude Code, Cursor, and others).

### 2.1 Install options (pick one)

**Option A: let a coding agent install it (recommended for new users).** Give
this repository to Claude Code, Codex, Cursor, or another local coding agent
with terminal access, together with this request (✅ the installer is this
repository's documentation):

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

**Option B: Wisp Science plugin (🤖 the host packages, you install).**
`npm run package:wisp` produces a ZIP; install and enable it in Wisp
**Settings → Plugins**, then start a new session.

**Option C: Cursor local plugin.** `npm run package:cursor` produces a ZIP;
unzip it into `~/.cursor/plugins/local/figure-library/` and restart Cursor.

**Option D: run from source.**

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

Note: do not register a raw MCP entry **and** a host plugin at the same time;
that duplicates tools.

### 2.2 First-run setup: bind two directories

A fresh install stays in `setup_required` until two directories are bound.
The **global Library** (绘图仓库) is the single machine-wide one; the **Local
workspace** is the working directory on the project side.

| Step | Who | Tool / action |
| --- | --- | --- |
| 1. Check status | Host model | Call `figure_library_source_status` or `figure_library_open`; expect `setup_required` |
| 2. You provide two **absolute paths** | You | e.g. `D:\figure-library` and the current project folder; do not casually use the project as the global Library |
| 3. Plan the binding | Host model | `figure_library_plan_bind_global` / `figure_library_plan_bind_workspace`, showing you the exact paths, `libraryId`, and `planDigest` |
| 4. Confirm the paths | You | Verify the displayed paths before confirming |
| 5. Apply the binding | Host model | `figure_library_apply_bind_global` / `figure_library_apply_bind_workspace` in the same server session |
| 6. Re-check | Host model | `figure_library_source_status` again; writes enabled, counts correct |

The binding is recorded in the machine-local locator (Windows:
`%APPDATA%\ScientificFigureLibrary\locator.json`; Linux/WSL:
`~/.config/scientific-figure-library/locator.json`). `FIGURE_LIBRARY_DIR` is
an admin override only; daily use does not need it.

---

## 3. Browse, search, and confirm templates

The core discipline: **look at the real preview, let the user confirm that one
card, and only then materialize.**

| Step | Who | Notes |
| --- | --- | --- |
| 1. Open workbench / search | Host model | MCP App hosts call `figure_library_open`; any host can call `figure_library_search` |
| 2. Browse candidates | You + host model | The App renders thumbnails page by page; click a thumbnail or "查看详情" for the large image and description; the retrieval score only orders candidates — it is **not** similarity, confidence, or approval |
| 3. Stop and wait for you | Host model | After searching, the host must stop and wait for your selection unless you explicitly say "帮我选择模板" |
| 4. Exact preview | Host model / App | In the App, "查看精确预览" runs `figure_library_preview_exact` + `figure_library_confirm_selection`; hosts without an App UI use `figure_library_preview_exact_headless` + `figure_library_confirm_selection_headless` |
| 5. Confirm | You | Only your confirmation after seeing the exact preview produces the one-time `previewReceipt` |
| 6. Plan materialization | Host model | `figure_library_plan_materialize` with the unchanged `providerId`, `exactSelector`, `previewReceipt`, and absolute destination; a missing receipt returns `preview_required` |
| 7. Present and confirm the plan | Host model + you | Show the exact template, target directory, and file set (`template`/`full`) |
| 8. Apply materialization | Host model | `figure_library_apply_materialize`; the target is `<destination>/<templateId>` and existing directories are never overwritten |
| 9. Inspect the result | You + host model | The project now contains the template files plus `template.lock.json` recording `codeExecutedBySflClient: false` |

Two common misconceptions:

- **Retrieval scope**: default search follows the order in section 1; the
  Community snapshot is accessible only when explicitly requested. Use
  `figure_library_list_provider_sources` (fully offline) to see enabled
  providers.
- **Upstream status ≠ local verification**: upstream publication, publisher
  signatures, or central curation of FigureYa and Open Figure Modules never
  become your local approval. Hosts must describe templates with that
  distinction intact.

An empty catalog can be a healthy state: after an authorized redaction a
bundled extra catalog may contain zero releases, and default search continues
across the remaining providers — that does not mean the install is broken.

---

## 4. Figure index (by purpose)

The two figure indexes referenced here are **auto-generated** from the bundled
catalog metadata and stamped with their snapshot version:

- [Open Figure Modules index (36 modules, grouped by plotFamily)](generated/open-figure-modules-index.md)
- [FigureYa template index (all templates, alphabetical by ID)](generated/figureya-index.md)

Every entry carries: the name and stable ID (`moduleId`), the plot family, a
preview link, the research use case, input data requirements, template source
and license, and a copyable natural-language invocation example. Metadata that
the catalog lacks is honestly marked "not recorded"; invocation links are
never fabricated.

Three things to keep in mind when using the indexes:

1. **Snapshot vs remote**: the pages are generated from the catalog snapshot
   bundled with the plugin. After install, SFL asynchronously refreshes the
   local Open Figure Modules overlay through a signed feed, so the remote may
   already have newer or retired modules. Always trust the SFL search results.
2. **Your own figures are not in the index**: Local Published templates live in
   your machine's Library — browse them in the workbench or via search.
3. **FigureYa has no category metadata**: its catalog carries no use-case
   categories, so that index lists templates alphabetically by ID; to find a
   figure by scenario, search by keyword (for example survival, PCA, volcano).

After you find a candidate, continue with [section 3](#3-browse-search-and-confirm-templates);
data preparation is covered in [section 5](#5-prepare-your-own-figure-and-data).

---

## 5. Prepare your own figure and data

Treat "one figure + its code + the plotting data" as one **Figure Unit** and,
ideally, give it its own folder before importing.

### 5.1 What to prepare (you)

| Material | Requirement |
| --- | --- |
| Image file | The finished figure for this unit (raster or vector); user-uploaded originals must be included |
| Plotting code | The script that produced it (R/Python/anything; SFL records the language but never executes it). When reliable code is absent, the host should import as `visual_reference` rather than pretend a reproducible template exists |
| Plotting data | Plot-ready tables: one row per sample/observation, explicit grouping columns, units in column names; never alter data or statistical meaning for aesthetics |
| Dependencies | The package list (it becomes part of the template description) |
| License | You must have the right to import; the license is recorded truthfully at import time |

### 5.2 Import and publish flow (🤖 host model, with your confirmation at the gates)

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
Submission requires TIFF, 300 dpi, white background; do not apply raster DPI
to the vector PDF.
```

Provide journal rules or a reference figure directly:

```text
Adjust this figure to the Nature single-column 89 mm width; attached is a
reference figure — match its layout as closely as possible.
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
`assets/FIGUREYA_LICENSE.txt`); Open Figure Modules are code MIT, content and
documentation CC BY 4.0. See
[THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).

**The index page count differs from what SFL finds?**
Index pages are the bundled snapshot; after install the signed feed may have
updated the local overlay. Trust SFL search; maintainers can regenerate the
pages per [Appendix B](#appendix-b-regenerating-the-index-and-checking-links).

**Will my data be uploaded?**
The Library lives in the local directory you chose; search and provider
status checks are fully offline and search never waits for the network. Only
flows you explicitly request (such as a GitHub publication PR or the official
channel submission) touch the network, and each step requires confirmation.
Security boundaries: [SECURITY.md](../SECURITY.md).

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
│   ├── generated/                 # Auto-generated figure indexes (do not edit)
│   ├── PROTOCOL.md                # Full tool contract
│   ├── QUICKSTART.md              # Install quickstart
│   └── GLOBAL_LIBRARY_0.6.md      # Current Library design
├── scripts/                       # Build/package/index-generation scripts
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

## Appendix A: end-to-end example

Scenario: a new user reproduces the single-cell cell-type proportion stacked
bar template from Open Figure Modules
(`sc-celltype-grouped-stacked-bar`) for their own submission figure.

| # | You | Host model | SFL server |
| --- | --- | --- | --- |
| 1 | Send the install request (section 2.1, option A prompt) | Install per QUICKSTART and register the MCP server | — |
| 2 | Provide two absolute paths, e.g. `D:\figure-library` and the project folder | Plan the binding, show paths, Apply after your confirmation | Validate paths, write the locator, enable writes |
| 3 | Say "search celltype stacked" | `figure_library_search`, present candidate cards, then **stop and wait for your pick** | Return candidates with thumbnails and `exactSelector` |
| 4 | Open the details, exact-preview, confirm that card | Use `preview_exact`/`confirm_selection` (or the headless pair) per host capability | Issue the one-time `previewReceipt` |
| 5 | Confirm the materialization plan | `figure_library_plan_materialize` → your confirmation → `figure_library_apply_materialize` into `./figures/fig03-celltype/` | Validate receipt and plan, copy the `template` file set, write `template.lock.json` |
| 6 | Arrange your data into the table the template expects (see the entry's input data requirements) | Check columns and units against `description.md`/`data_schema.yml`, replace example data | — |
| 7 | State style requirements (section 6 prompts: Arial, fixed group colors, 170 mm × 60 mm, 300 dpi) | Edit the project-side script copy following figure-style guidance | — |
| 8 | Approve execution | Run the script in the project-approved R environment, self-check the image, deliver the path | — |
| 9 | Review the figure, request changes | Iterate and redraw | — |
| 10 | When satisfied, ask for one-figure-one-folder organization (section 7 prompt) | Organize the archive and deliver the inventory | — |

If any step gets stuck, ask the host model which step it is on and which
confirmation is missing; error codes such as `setup_required` and
`preview_required` are specified in [PROTOCOL.md](PROTOCOL.md).

## Appendix B: regenerating the index and checking links

The figure indexes linked from section 4 are generated from the bundled
catalog JSON by script. Output is deterministic (no wall-clock timestamps),
so they can be regenerated reproducibly whenever the metadata changes:

```bash
npm run docs:index         # regenerate the four index pages under docs/generated/
npm run docs:check-links   # check guide/README local links and anchors (offline)
```

- `docs:index` reads `assets/catalog.json` and
  `assets/personal-modules/module-catalog.json` and regenerates the four
  bilingual pages; missing metadata is honestly marked and links are never
  fabricated.
- `docs:check-links` validates only repository-relative links and heading
  anchors, never external websites, so it is repeatable offline.
- When a catalog snapshot updates (a rebuilt FigureYa catalog, or an Open
  Figure Modules feed refresh of the bootstrap), rerun `docs:index` and commit
  the result together with the metadata — no hand-maintained template lists.
