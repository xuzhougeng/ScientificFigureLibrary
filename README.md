# Scientific Figure Library

Scientific Figure Library (SFL) is a standard stdio MCP server and MCP App for
building, reviewing, finding, and materializing reusable scientific-figure
references. Version 0.5 makes one **user-selected global Library** the durable,
cross-project source of truth. Wisp, Codex, Claude, and other MCP hosts can use
the same Library without copying it into every project.

The standard core has two retrieval providers:

- **Local Published** (`org.scientificfigurelibrary.local`) — immutable,
  locally reviewed Releases from the global Library.
- **FigureYa** (`org.figureya.module`) — the bundled 319-module search catalog,
  with commit-pinned source/archive identities.

`figure_library_search` queries both providers together by default. Results are
provider-qualified and carry an `exactSelector`; a bare `templateId` is never
enough to describe, preview, or materialize an exact result.

The host Agent, not this server, inspects an uploaded figure and code, reasons
about their relationship, and asks the user to confirm the Figure Unit. SFL
then verifies bytes, records hashes and provenance, creates immutable
Revisions, enforces review gates, and publishes Releases. The server contains
no second model and does not execute plotting code.

## 0.5 design boundaries

- The Library is global and cross-project. A project receives a
  `template.lock.json` when a template is materialized; there are no project
  pins and no project-scoped Library.
- Direct user-supplied image/code intake is the standard path.
- Web Capture and `figure_capture_*` tools are not registered in the 0.5
  standard core. The experimental 0.4.2 Capture work remains isolated from the
  standard design.
- Legacy flat `figure-library.template.v1` entries are migration input only.
  They do not appear in ordinary search until explicitly adopted.
- Working Revisions are visible only through review tools. Ordinary
  search/describe/preview/materialize operate on Published Releases or exact
  FigureYa modules.
- CiteBox is an explicit intake adapter, not a search provider. SFL never reads
  or writes CiteBox SQLite directly.

## Safety and truthfulness contract

SFL treats every supplied or downloaded asset as untrusted reference material.
It copies and hashes files but never runs plotting code, notebooks, shell
scripts, or dependency installers.

Execution state has a literal meaning:

- `not_run`: SFL has no execution evidence. Never call it reproduced,
  validated, or verified.
- `failed`: an execution attempt is recorded as failed.
- `passed`: requires a `rendered_output`, a `generated_output` figure-code
  relationship, and an evidence asset.

Code inferred from a visual must use relationship `visual_inference` and remain
`scaffold` / `not_run` with the claim `inspired_by_not_reproduced`.

All public operations return a terminal outcome envelope:

```text
OUTCOME: <ok|needs_user_input|needs_user_confirmation|applied|...>
TERMINAL: true
RETRY_SAME_CALL: false
CODE: <stable code>
NEXT_ACTION: <none|ask_user|apply_confirmed_plan|create_new_plan|...>
```

An Agent must inspect `OUTCOME`, `CODE`, and `NEXT_ACTION` once. It must not
repeat an identical failed or blocked tool call. If a plan is stale or absent,
create a new plan; if user input is missing, ask the user; otherwise stop and
report the exact failure.

`figure_library_open` is an optional MCP App entry point. A Host may reject it
before the server runs with MCP `-32601` or `Capability is not granted`. That is
a Host UI-capability result, not permission to retry. Skip `open`, obtain the
user's plotting goal, and continue through the ordinary
`figure_library_search`, `figure_library_describe`, and
`figure_library_preview` tools. Do not loop on `open` or infer that the global
Library is unavailable when those standard tools still work.

## Requirements and build

Node.js 22 or newer is required.

```bash
npm install
npm run check
```

Run the compiled server from any stdio MCP host:

```json
{
  "mcpServers": {
    "figure-library": {
      "command": "node",
      "args": ["/absolute/path/to/ScientificFigureLibrary/dist/index.js"],
      "env": {
        "FIGUREYA_SOURCE_PACK_DIR": "/optional/path/to/FigureYaSourcePack"
      }
    }
  }
}
```

The preferred global binding is the user locator described below. An optional
`FIGURE_LIBRARY_DIR` environment variable is an administrative override; when
present, it takes precedence over the locator.

## One global, portable Library

The user chooses the Library directory. SFL does not silently use the current
project. Bind it with a read-only plan followed by explicit Apply:

1. Call `figure_library_plan_bind_global` with an absolute
   `libraryDirectory`.
2. Show the user the exact path, `libraryId`, inventories, migration mode, and
   `planDigest`.
3. After confirmation, call `figure_library_apply_bind_global` with the
   visible `planDigest` and a stable `operationId` in the same server session.
   Apply accepts only a server-issued cached digest; client-authored opaque
   plans are deliberately rejected as an authority boundary.
4. Start a new host session if the host caches MCP state.

The locator is deliberately small and machine-local:

- Windows: `%APPDATA%\ScientificFigureLibrary\locator.json`
- Linux/WSL: `$XDG_CONFIG_HOME/scientific-figure-library/locator.json`, or
  `~/.config/scientific-figure-library/locator.json`

The locator records the absolute directory, `libraryId`, and configuration
revision. The portable Library itself contains relative POSIX paths and this
authoritative layout:

```text
<library-root>/
├── library.json
├── store/
│   ├── templates/<templateId>/
│   │   ├── series.json
│   │   ├── revisions/<revisionId>/
│   │   │   ├── content.json
│   │   │   └── assets/...
│   │   ├── reviews/<reviewId>.json
│   │   └── releases/<releaseId>.json
│   ├── operations/
│   │   ├── intents/
│   │   └── receipts/public-materializations/<providerId>/<operationId>.json
│   ├── imports/<adapterId>/<importId>/receipts/<receiptId>/
│   ├── migrations/flat-v1/
│   ├── exports/
│   └── quarantine/
├── indexes/                 # derived and rebuildable
└── locks/                   # runtime only
```

`library.json` plus `store/` are authoritative and should be backed up.
`indexes/` can be rebuilt. `locks/` must not be migrated or copied as Library
content. The root marker is `figure-library.root.v1`, storage layout
`figure-library.store-layout.v1`, with SHA-256 and RFC 8785 canonical JSON.

If neither a locator nor `FIGURE_LIBRARY_DIR` exists, legacy
`~/.figure-library` may be inspected read-only. Writes fail closed until the
user explicitly binds a global Library. `figure_library_source_status` reports
the effective root, source, locator, `libraryId`, write state, counts, lock
state, and FigureYa source-pack state.

## Direct image/code intake

One Working Revision represents one user-confirmed **Figure Unit**. Before
planning, the Agent must inspect the actual files and collect or confirm:

1. create, update, or reuse an exact existing template;
2. title and Figure Unit boundary;
3. every visual asset and whether it is a `source_reference` or
   `rendered_output`;
4. multi-image grouping when more than one visual belongs to the Figure Unit;
5. the primary preview;
6. `plot_template` or `visual_reference`;
7. for a plot template, all code assets, their origins, the canonical
   implementation, and evidence-backed many-to-many figure-code links;
8. the truthful execution claim;
9. duplicate decision: `create_new`, `update_exact`, or `reuse_existing`;
10. provenance, license, and any review findings.

Supported figure-code relationships are:

- `user_supplied_pair`
- `author_provided_original`
- `visual_inference`
- `adapted_from_template`
- `generated_output`

Code origins are `user_supplied`, `author_provided`, `agent_generated`, or
`adapted`. R, Python, Julia, MATLAB, and other languages are accepted as
metadata; SFL does not privilege or execute a language. A `plot_template`
requires code and a user-selected canonical implementation. If reliable code
is absent, use `visual_reference` rather than pretending that a reproducible
template exists.

Call `figure_library_plan_working_revision` first. It verifies regular,
non-symlink host files and produces a complete immutable candidate and review
snapshot without writing. Absolute source paths are input-only and are not
persisted in the public Revision. Show the returned action, IDs, digests, asset
hashes, validation errors, gates, and warnings. Only after the user confirms
that exact plan call `figure_library_apply_working_revision` with:

- `planDigest`
- stable `operationId`
- `expectedAction`
- `expectedTemplateId`
- `expectedSeriesDigest`

Apply rechecks source bytes and series state. Operation IDs are idempotent;
stale plans are rejected rather than silently adapted.

## Immutable review and publication

The canonical schemas are:

- `figure-library.template-series.v1`
- `figure-library.template-content.v1`
- `figure-library.review-snapshot.v1`
- `figure-library.template-release.v1`

A `templateId` identifies a stable Series. A Content Revision and Release are
immutable. A Series has at most one Working Head and one Published Head. Every
Working save creates a full new Revision; history is never edited in place.

Validation findings are intentionally separate:

- **Validation Error** — structurally or semantically invalid content; blocks
  publication.
- **Blocking Review Gate** — an explicit review decision is required; blocks
  publication while open.
- **Review Warning** — visible but not itself blocking.

There is no waiver path in 0.5. Review with
`figure_library_review_open`, `figure_library_template_history`, and
`figure_library_diff_revisions`. Lifecycle changes use separate plan/apply
pairs:

- `figure_library_plan_review_gate_update` /
  `figure_library_apply_review_gate_update`
- `figure_library_plan_publish_working_revision` /
  `figure_library_apply_publish_working_revision`
- `figure_library_plan_discard_working_revision` /
  `figure_library_apply_discard_working_revision`
- `figure_library_plan_restore_release` /
  `figure_library_apply_restore_release`
- `figure_library_plan_adopt_versioning` /
  `figure_library_apply_adopt_versioning`

Publishing atomically creates the immutable Release and switches the Published
pointer. The old Published Release remains usable until that switch. Restoring
history creates a new Working candidate and requires review; it never rewinds
the Published pointer directly. Adopting a flat-v1 template is explicit and
non-destructive, with a migration receipt.

## Unified search and exact selectors

`figure_library_search` searches Local Published and FigureYa in one bounded
call unless `providerIds` explicitly narrows it. Working Revisions, Capture
records, and unadopted flat entries are excluded. The retrieval score only
orders candidates; it is not visual similarity, confidence, or approval.

Each candidate includes `providerId` and `exactSelector`:

- Local Published identity: `templateId`, `revisionId`, `contentDigest`, and
  `releaseId`.
- FigureYa identity: `moduleId`, source commit, archive commit, archive
  integrity identity, and materialization mode when an archive exists.

Always pass the returned provider and selector unchanged to
`figure_library_describe`, `figure_library_preview`, and materialization.
Same-named templates from different providers do not shadow one another.

FigureYa is upstream-published but locally `not_reviewed`; its code is
`provided` and `not_run`. Never describe a FigureYa search result as locally
approved, reproduced, or verified by SFL.

For visual selection, the Agent should inspect the user's image with its host
image tool, preview at most a small candidate set, and explain the decisive
visual and data-compatibility differences. Search never embeds every thumbnail.
`figure_library_preview` returns one standard MCP image content block and can
optionally copy it to an absolute trusted destination for hosts that expose
only text summaries.

## Exact materialization

Materialization is plan/apply only:

1. `figure_library_plan_materialize` with the exact `providerId`,
   `exactSelector`, an absolute `destination`, optional absolute
   `sourcePackDir`, and `allowNetwork`.
2. Present the exact selector, target, and acquisition policy.
3. `figure_library_apply_materialize` with `planDigest`, `operationId`,
   `expectedProviderId`, and `expectedTarget`.

The target is `<destination>/<templateId>` and is never overwritten. Both
providers use a common envelope:

```text
<destination>/<templateId>/
├── TEMPLATE.md
├── template.json
├── template.lock.json
├── assets/
│   ├── visuals/
│   ├── code/
│   ├── references/
│   └── evidence/
└── upstream/                 # FigureYa only; untouched source module
```

Keep `assets/` and `upstream/` unchanged when exact replay matters. Write
project adaptations separately. The lock records the provider-qualified exact
identity and file hashes so another project or Agent can reproduce the same
selection without project pins.

`template.lock.json` alone is not server authority. Durable Apply replay also
requires the immutable global-Library Receipt at
`store/operations/receipts/public-materializations/<providerId>/<operationId>.json`.
The Receipt binds the public plan, exact selector, complete target inventory,
and a hash of the physical target path without storing that absolute path.
Replay revalidates the current provider identity and every target byte; a
pre-created or copied lock without the Receipt is never reported as success.

Any materialization failure is terminal. Do not retry the same call, change
mode/provider/downloader, fetch a full repository, or generate a substitute.
Report the error and wait for a new user decision.

## CiteBox and other intake adapters

CiteBox figures enter through an explicit export/API/MCP handoff. They are not
mixed into ordinary search before local review, and SFL must never access the
CiteBox SQLite database directly.

The host selects a CiteBox Figure, obtains self-contained exported assets, and
then creates a Working Revision with `intake.adapterId: "citebox"`. Preserve
the selected Figure ID, paper DOI/title, figure label, page, caption, export
hash, retrieval time, and other available provenance in `sourceManifest` and
Revision provenance. Copy all selected assets into the Revision. CiteBox
authority or publication status is provenance only and is not inherited as SFL
approval.

Other integrations follow the same adapter contract under
`store/imports/<adapterId>/<importId>/`: explicit source manifest, selected
asset hashes, self-contained immutable Revision, receipt, and local review.

## Migration and portability

Binding can optionally stage a non-destructive copy of a legacy flat-v1
Library with `migrationMode: "copy_legacy"`. Staging does not make entries
searchable. Each template is adopted explicitly through the versioning
plan/apply tools and receives a receipt; original flat content is retained.

Portable bundle operations are exposed as explicit MCP plan/apply pairs and
implemented by `src/portable-bundles.ts`:

- full Library backup/export;
- exact Published-template export;
- full Library restore;
- full Library fork;
- Published-template bundle import as a new Working Revision.

Use `figure_library_plan_bundle_export` /
`figure_library_apply_bundle_export` for a full backup or exact Published
template export. Export Apply must echo the visible absolute target as
`expectedTarget`; the Library stores only its digest in an immutable pre-write
intent. If the server stops after the complete bundle rename but before its
receipt, the same `operationId + planDigest + expectedTarget` verifies every
byte and rolls the receipt forward after restart. Use `figure_library_plan_full_restore` /
`figure_library_apply_full_restore` for restore or fork. Use
`figure_library_plan_template_bundle_import` /
`figure_library_apply_template_bundle_import` to import a Published template as
Working. In the same server session, Apply needs the visible `planDigest` and
a stable operation ID. Apply does not accept a client-authored opaque plan. If
the in-memory plan is unavailable, the tool
returns terminal `plan_not_available` and requires a new plan rather than an
identical retry, except when an authoritative pre-write export intent and its
complete exact target allow deterministic recovery.

Full backups exclude `indexes/` and `locks/`. Restore preserves the source
`libraryId`, requires explicit authority-transfer confirmation, and does not
change the active locator. Fork creates a new `libraryId` and records
`forkedFromLibraryId`. Importing a Published-template bundle never inherits the
source Library's approval; it creates a Working Revision requiring local review
and publication.

See [`docs/GLOBAL_LIBRARY_0.5.md`](docs/GLOBAL_LIBRARY_0.5.md) for the storage,
locator, lifecycle, migration, and portability model.

## MCP tools in the 0.5 standard core

| Area | Tools |
| --- | --- |
| Workbench and retrieval | `figure_library_open`, `figure_library_search`, `figure_library_describe`, `figure_library_preview`, `figure_library_source_status` |
| Global binding | `figure_library_plan_bind_global`, `figure_library_apply_bind_global` |
| Write-lock recovery | `figure_library_plan_recover_write_lock`, `figure_library_apply_recover_write_lock` |
| Review inspection | `figure_library_review_open`, `figure_library_template_history`, `figure_library_diff_revisions` |
| Direct intake | `figure_library_plan_working_revision`, `figure_library_apply_working_revision` |
| Gate, publish, discard, restore, adoption | the lifecycle plan/apply pairs listed above |
| Exact acquisition | `figure_library_plan_materialize`, `figure_library_apply_materialize` |
| Portable bundles | `figure_library_plan_bundle_export`, `figure_library_apply_bundle_export`, `figure_library_plan_full_restore`, `figure_library_apply_full_restore`, `figure_library_plan_template_bundle_import`, `figure_library_apply_template_bundle_import` |

There are no `figure_capture_*`, project status/pin, direct-write import, sync,
archive/reconcile, or one-step materialize tools in the standard 0.5 server.

## Distribution

Build a standalone npm package:

```bash
npm run package:npm
npm install --global ./release/scientific-figure-library-0.5.0.tgz
```

Use `scientific-figure-library` as the MCP command after installation.

Build the Wisp plugin:

```bash
npm run package:wisp
```

Install `release/scientific-figure-library-wisp-0.5.0.zip` from Wisp
**Settings → Plugins**, enable it, and start a fresh session. The Wisp bundle is
an adapter around the same standard MCP server; global Library selection is not
tied to a Wisp project.

## FigureYa Source Pack

The plugin contains the FigureYa catalog and thumbnails, not the roughly 3 GiB
archive collection. A Source Pack is an ordinary directory containing pinned
per-module ZIPs from FigureYa-compressed:

```text
FigureYaSourcePack/
├── FigureYa59volcanoV2.zip
└── archives/
    └── FigureYa9heatmap.zip
```

Pass an absolute directory as `sourcePackDir` or set
`FIGUREYA_SOURCE_PACK_DIR`. Archive resolution is:

1. local Source Pack;
2. bases configured in `FIGUREYA_ARCHIVE_BASE_URLS`;
3. the commit-pinned FigureYa-compressed archive on GitHub.

Create a small transport pack from a local checkout:

```bash
npm run package:source-pack -- \
  --source /path/to/FigureYa-compressed \
  --name volcano \
  --modules FigureYa59volcanoV2
```

The helper verifies selected ZIP identities and caps a transport pack at 200
MiB. Extract the resulting
`release/figure-library-source-pack-volcano-0.5.0.zip` before use.

## Catalog development

Regenerate the bundled catalog from local checkouts:

```bash
git -C /path/to/FigureYa-compressed ls-tree --name-only HEAD |
  npm run catalog -- \
    --source /path/to/FigureYa \
    --figureya-commit <figureya-commit> \
    --compressed-commit <compressed-repo-commit> \
    --compressed-tree /path/to/compressed-github-tree.json
```

## License

Project code is MIT licensed. FigureYa-derived catalog data, thumbnails, and
downloaded templates remain CC BY-NC-SA 4.0. User-supplied and adapter-imported
material keeps its recorded source license. See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
