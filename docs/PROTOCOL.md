# Scientific Figure Library protocol

> Landing page and install: [README.md](../README.md). This file is the full tool contract, safety rules, and Library layout.


Scientific Figure Library (SFL) is a standard stdio MCP server and MCP App for
building, reviewing, finding, and materializing reusable scientific-figure
references. Version 0.6 keeps one **user-selected global Library** as the durable,
cross-project source of truth. Wisp, Codex, Claude, and other MCP hosts can use
the same Library without copying it into every project.

The 0.6 standard core uses one Provider registry. Its built-in retrieval
providers are:

- **Local Published** (`org.scientificfigurelibrary.local`) — immutable,
  locally reviewed Releases from the global Library.
- **FigureYa** (`org.figureya.module`) — the bundled 319-module search catalog,
  with commit-pinned source/archive identities.
- **SFL Community** (`io.github.jarxunlai.scientific-figure-community`) — a
  centrally curated Catalog and preview snapshot bundled with this SFL build.
  Complete template archives stay outside the plugin and are downloaded only
  during an explicitly network-enabled materialization.

Users may also add an independently keyed, Ed25519-signed HTTPS Provider.
Personal Providers are excluded from default search until the user explicitly
enables `includeInDefaultSearch`. `figure_library_search` queries the dynamic
default Provider set. Results are provider-qualified and carry an
`exactSelector`; a bare `templateId` is never enough to describe, preview, or
materialize an exact result.

> **0.6.0 Provider and publication boundary:** bundled Community search and
> preview are offline. Public materialization verifies a commit-pinned archive
> and writes `template-lock.v3` with `codeExecutedBySflClient: false`. An exact
> Local Published Release can be exported only as a sanitized, explicitly
> licensed submission. Export does not publish, sign, execute code, or create a
> pull request.

> **0.5.1 protocol migration (still required in 0.6.0):** `figure_library_plan_materialize`
> requires a session-local, single-use `previewReceipt` produced only
> after an exact preview and explicit confirmation. There is no receipt-free
> compatibility path.
>
> **0.5.2 review truthfulness:** Working preview now has its own exact read-only
> selector; Working and Published Reviews are reported separately; Published
> warnings remain bound to their immutable Release; canonical preview choices
> and the three-part validation state are exposed consistently across review,
> planning, search, and details.
>
> **0.5.5 host plugins and display modes:** the same Skill and MCP server are packaged for Wisp, Codex, and Claude. The MCP App may request `fullscreen` or `pip` when the Host advertises those modes; there is no docked-sidebar display mode.
>
> **0.5.4 scientificQuestion:** optional retrieval field for the biological question a figure answers. It is not `description` or `visualProfile`. In that release, ordinary search returned only Local Published heads; 0.6.0 keeps the field while expanding the Provider set.

> **0.5.3 transport image adapter:** MCP image payloads are adapted to the
> existing search and preview Data URL budgets before they leave the server.
> Canonical Preview bytes, Revision Content Digests, and `previewSha256` remain
> unchanged; derived transport images live only under rebuildable `indexes/`.

The host Agent, not this server, inspects an uploaded figure and code, reasons
about their relationship, and asks the user to confirm the Figure Unit. SFL
then verifies bytes, records hashes and provenance, creates immutable
Revisions, enforces review gates, and publishes Releases. The server contains
no second model and does not execute plotting code.

## 0.6 design boundaries

- The Library is global and cross-project. A project receives a
  `template.lock.json` when a template is materialized; there are no project
  pins and no project-scoped Library.
- Direct user-supplied image/code intake is the standard path.
- Web Capture and `figure_capture_*` tools are not registered in the standard
  0.6 core. The experimental 0.4.2 Capture work remains isolated from the
  standard design.
- Legacy flat `figure-library.template.v1` entries are migration input only.
  They do not appear in ordinary search until explicitly adopted.
- Working Revisions are visible only through review tools. Ordinary
  search/describe/preview/materialize operate on Published Releases or exact
  public/FigureYa selectors.
- CiteBox is an explicit intake adapter, not a search provider. SFL never reads
  or writes CiteBox SQLite directly.

## Safety and truthfulness contract

SFL treats every supplied or downloaded asset as untrusted reference material.
It copies and hashes files but never runs plotting code, notebooks, shell
scripts, or dependency installers.

Validation state has three independent parts. `plotExecution` records only the
plot run, `upstreamWorkflow` records the upstream analysis workflow, and
`scientificValidation` records a user or external-review assessment. Plot
execution never implies either of the other two:

- `plotExecution.status: not_run`: SFL has no plot-execution evidence.
- `plotExecution.status: failed`: a plot execution attempt is recorded as
  failed.
- `plotExecution.status: passed`: requires a `rendered_output`, a
  `generated_output` figure-code relationship, and an evidence asset.
- `upstreamWorkflow.status: partial|passed|failed`: requires a non-empty scope
  and evidence; otherwise use `unknown`, `not_run`, or `not_applicable`.
- `scientificValidation.status: limited|validated|rejected`: requires a
  `decisionSource` (`user` or `external_review`) and a referenced assessment
  asset; otherwise use `not_assessed` or `not_applicable`.

The legacy `executionStatus` field remains a compatibility projection of
`plotExecution.status`. A legacy `passed` Release reads as plot passed with
unknown scope, upstream unknown, and scientific not assessed; it is never
promoted to full workflow reproduction or scientific validation.

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

`figure_library_open` and the paginated candidate gallery are MCP App entry
points. A Host may reject App display before the server runs with MCP `-32601`
or `Capability is not granted`. That is a Host UI-capability result, not
permission to retry. Ordinary headless tools can still be used. A real
App-local exact-preview acceptance requires Host `serverTools`. When
`serverTools` is absent but
`updateModelContext.text` is available, the sidebar may let the user select one
current-page candidate and hand it to the Agent for a single headless exact
review. That fallback must not be reported as an exact image loaded in the App.
If both capabilities are absent, the sidebar displays a capability error. A
backend `view_image` check is never evidence that the user's sidebar displayed
the image.

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
   `rendered_output`; every user-uploaded original figure must be included in
   `visualAssets` as `source_reference`;
4. multi-image grouping when more than one visual belongs to the Figure Unit;
5. the canonical primary preview and, when required, the user's override;
6. `plot_template` or `visual_reference`;
7. for a plot template, all code assets, their origins, the canonical
   implementation, and evidence-backed many-to-many figure-code links;
8. the truthful three-part validation state;
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

Canonical preview selection is deterministic:

- exactly one `source_reference` is the default
  (`default_uploaded_source`), even when rendered outputs also exist;
- one total visual is the only available choice (`only_visual_available`);
- an explicit source selection is recorded as `user_selected_source`;
- multiple sources, or multiple rendered-only visuals without a selection,
  return `canonical_preview_ambiguous`;
- choosing a rendered output while a source exists requires
  `primaryPreviewOverride: { confirmedBy: "user", reason }` and is recorded as
  `user_override_rendered`; without it the plan returns
  `canonical_preview_override_required`.

This 0.5.3 boundary is intentionally Host-governed: the Host must include the
uploaded original in `visualAssets` as `source_reference`. The Server verifies
declared assets but does not receive a separate upload manifest, so it cannot
detect that a Host omitted an original entirely. No digest-declaration hard
check is added in this release.

Call `figure_library_plan_working_revision` first. It verifies regular,
non-symlink host files and produces a complete immutable candidate and review
snapshot without writing. Absolute source paths are input-only and are not
persisted in the public Revision. Show the returned action, IDs, digests, asset
hashes, `reviewSummary`, canonical decision, validation state, and the exact
Working preview selector. Call `figure_library_preview_working_revision` with
that unchanged `templateId`, `revisionId`, and `contentDigest` to inspect the
canonical image before Apply. The selector resolves only the latest exact,
session-local pending Working plan for that Series; after Apply it resolves the
matching current Working Head. A newer plan makes the prior pending selector
stale, and publication removes the Working target. This tool is read-only: it
accepts no destination, creates no preview receipt, and never authorizes
materialization. Show validation errors, gates, and warnings. Only after the
user confirms that exact plan call `figure_library_apply_working_revision`
with:

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

There is no waiver path in 0.6.0. Review with
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

`figure_library_review_open` returns `workingReview` and `publishedReview`
separately when both exist; compatibility field `review` resolves to
`workingReview ?? publishedReview`. Published review findings come from the
Review Snapshot bound by the Release and therefore remain visible after the
Working Head is cleared or replaced. Working and publish plan/apply responses
use one `reviewSummary` shape containing validation errors, open gates,
warnings, `publishEligible`, canonical preview decision, and validation state.

## Unified search and exact selectors

`figure_library_search` searches the complete relevance-matched dynamic
Provider set unless `providerIds` explicitly narrows it. The default order is
Local Published, bundled Community, FigureYa, then enabled personal Providers
whose `includeInDefaultSearch` flag was explicitly set, ordered canonically by
`providerId`. Working Revisions, Capture records, and unadopted flat entries
are excluded. The retrieval score is unchanged: it only orders candidates and
is not visual similarity, confidence, or approval. A broken personal Provider
is reported as degraded/corrupt while healthy default Providers continue; an
explicit request for only the broken Provider fails terminally.

The first page defaults to 6 candidates (`limit` maximum 12). Responses expose
`resultSetId`, true `total`, `pageIndex`, `hasMore`, and opaque `nextCursor` as
well as the structured `pagination` object. The cursor is bound to the query,
filters, page size, Library root, Local Published revision, and FigureYa
catalog revision. Catalog or Library changes return `search_results_stale`
instead of silently drifting. Each page carries verified PNG/JPEG/WebP
thumbnails. Search uses a 256 KiB per-image and 3 MiB per-page Data URL
ceiling; exact, Working, and compatibility preview use a 1 MiB single-image
Data URL ceiling. Oversized canonical assets are scaled or JPEG-compressed
only for transport. The
model-visible `structuredContent` contains only compact candidate summaries;
thumbnail Data URLs are keyed by result-scoped `candidateId` under result
`_meta.candidatePreviews`, which MCP Apps expose only to the component.

Each candidate includes `providerId` and `exactSelector`:

- Local Published identity: `templateId`, `revisionId`, `contentDigest`, and
  `releaseId`.
- FigureYa identity: `moduleId`, source commit, archive commit, archive
  integrity identity, and materialization mode when an archive exists.
- Public Provider identity: `templateId`, semantic `releaseVersion`, public
  content digest, Catalog digest, immutable archive repository/commit/path,
  byte count and SHA-256, plus the preview identity.

Always pass the returned provider and selector unchanged to
`figure_library_describe`, `figure_library_preview`, and materialization.
Same-named templates from different providers do not shadow one another.

FigureYa is upstream-published but locally `not_reviewed`; its code is
`provided` and `not_run`. Never describe a FigureYa search result as locally
approved, reproduced, or verified by SFL.

Community and personal public templates likewise separate
`upstreamStatus`, `publisherVerified`, `curationStatus`, `renderValidation`,
`localReviewStatus`, and `plotExecutionByRecipient`. Central curation or a
publisher signature never becomes the recipient's Local approval.

Local Published search cards and details inherit warnings from the immutable
Review bound by the exact Release and display separate plot-execution,
upstream-workflow, and scientific-validation summaries. They do not fall back
to the current Working Head and do not collapse a plot `passed` result into a
claim of complete reproduction.

The MCP App paginates all matched candidates through App-only
`figure_library_search_page` and renders each usable candidate as a real
lazy-loaded `<img>`. Clicking the thumbnail, title, or **查看详情** opens an
accessible dialog with a larger candidate image, the complete description,
and only metadata actually present in the search result. This basic detail is
fully local to the App: it works without `serverTools`, does not call the
Agent, and does not update model context.

After search, the Agent must stop and wait for user selection. It must not call
exact preview for every candidate or substitute a backend `view_image` pass.
Only an explicit request such as “帮我选择模板” permits limited visual review
of a small top-ranked subset.

When Host `serverTools` is available, **查看精确预览** calls App-only
`figure_library_preview_exact`, which returns the exact image and one-time
`previewChallenge` in component-only `_meta`. It never accepts a destination,
writes files, downloads archives, or accesses the network. The confirmation
button remains disabled until that exact `<img>` fires `load`; `error` keeps it
disabled. Clicking **确认并交给 Agent** calls App-only
`figure_library_confirm_selection`, then sends only the provider, selector,
preview hash, receipt, and compact selection summary through
`updateModelContext`.

When `serverTools` is absent but `updateModelContext.text` is available, the
exact-preview action stays disabled and the separate button becomes **选择并交给
Agent 审核**. Only that click submits one compact candidate through
`updateModelContext`; the Agent may call `figure_library_preview_exact_headless`
once for that candidate, review it, call
`figure_library_confirm_selection_headless`, and create a read-only materialize
plan. It must not inspect other candidates, Apply, or claim that the exact
image loaded in the App. If `updateModelContext` is also absent, selection
handoff remains disabled with an explicit capability error.

`figure_library_describe` publishes these App/headless tool names, the
component thumbnail `_meta` key, the model-image exclusion flag, receipt gate,
and diagnostics export/resource capabilities so Hosts can inspect the exact
0.5.3 boundary without guessing.

`figure_library_preview` remains a compatibility tool that returns/copies one
standard MCP image, but it never authorizes materialization and must not be
presented as sidebar display evidence.

## Exact materialization

Materialization protocol v2 is preview/confirm/plan/apply only:

1. Search and retain `resultSetId`, `providerId`, and `exactSelector`.
2. Choose the capability-aware confirmation path:
   - Apps Host with `serverTools`: the App calls App-only
     `figure_library_preview_exact` and `figure_library_confirm_selection` only
     after the exact image visibly loads and the user clicks confirmation.
   - Apps Host without `serverTools` but with `updateModelContext.text`: after
     the user clicks **选择并交给 Agent 审核**, call model-visible
     `figure_library_preview_exact_headless` once for that single candidate and
     then `figure_library_confirm_selection_headless`.
   - Host with no Apps UI: use the same model-visible tools only after the user
     selects a candidate or explicitly delegates selection to the Agent.
   Both headless routes cannot technically prove that the user saw the image in
   the App; acceptance reports must preserve this boundary.
3. Pass the returned single-use `previewReceipt` with the unchanged
   `providerId`, `exactSelector`, absolute `destination`, optional absolute
   `sourcePackDir`, and `allowNetwork` to
   `figure_library_plan_materialize`. Missing receipts return
   `preview_required`; mismatches, changed preview/catalog/root, replay, or
   server restart are rejected. A receipt has no wall-clock TTL but is valid
   only in the issuing server session and is consumed after one successful
   plan.
4. Present the exact selector, target, confirmation mode, and acquisition
   policy.
5. `figure_library_apply_materialize` with `planDigest`, `operationId`,
   `expectedProviderId`, and `expectedTarget`. Apply consumes only the plan and
   does not request the receipt again.

The target is `<destination>/<templateId>` and is never overwritten. All
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
└── upstream/                 # when supplied by the exact Provider payload
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

## Provider source management

`figure_library_list_provider_sources` is completely read-only and offline. It
reports Local, bundled Community, FigureYa, and configured personal Providers,
including enabled/default-search state, active sequence/digest/key, verified
snapshot status, template count, and the last safe error.

Personal Provider changes use
`figure_library_plan_provider_source_change` followed by
`figure_library_apply_provider_source_change`. Supported actions are `add`,
`update`, `configure`, `remove`, and `trust_reset`. A first Add requires the
expected `providerId`, an HTTPS manifest URL, and a separately obtained raw
32-byte Ed25519 public key. Planning may fetch and verify a candidate but never
writes configuration or snapshots. Show every URL, sequence/digest/key change,
template delta, target path, default-search choice, and warning; Apply only
after explicit confirmation.

Apply fetches the exact planned manifest again, rejects stale/rollback/
equivocation/signature/DNS/path changes, verifies all payloads in staging, then
atomically activates an immutable snapshot. A failed update preserves the
last-known-good snapshot. Remove unregisters the source but does not delete
snapshots or materialized projects. `trust_reset` is exceptional recovery: it
must display and explicitly confirm both the old and new key fingerprints.

## Sanitized public submission export

Public publication starts from one exact, currently reachable Local Published
Release; it never accepts a Working Revision, an entire Library, or an
unreachable historical Release. Use
`figure_library_plan_publication_export` to declare every source asset as
included or excluded and, for each included asset, its public path, role,
source, and license. The only accepted payload classes are explicitly selected
code, synthetic data, a preview actually generated from the selected code and
data, and documentation. Source-reference media, screenshots, PDF/TIFF
extracts, evidence, private lifecycle state, and machine paths are excluded.
DOI and URL text may remain as provenance.

The Plan shows source/output digests, generated-preview trace, metadata and
license conflicts, excluded private state, and `written: false`. Parent
`unknown` or `private_reference` status is not a public license: the publisher
must attest rights for the selected assets and explicitly acknowledge any
metadata conflict. After approval,
`figure_library_apply_publication_export` revalidates the exact Release and all
asset bytes and writes a deterministic, previously absent target containing:

```text
submission.json
licenses.json
render-receipt.json
inventory.jsonl
payload/
  template.json
  code/**
  data/**
  preview/preview.png
  docs/**
```

Export Apply is local only: it does not access the network, sign content,
execute plotting code, create a GitHub PR, publish the Local Library, or include
Library IDs, locators, histories, operations, receipts, quarantine, other
templates, or absolute paths. GitHub Archive/Catalog PR creation is a separate
plan/apply gate and never merges a PR automatically.

## Staged central GitHub publication PRs

GitHub publication uses the official `gh` CLI only. SFL never calls
`gh auth token`, reads `hosts.yml`, stores a token, starts an interactive login,
or opens a browser. `figure_library_github_auth_status` reports the current
login, host, central-repository permissions,
`credentialStorage=managed_by_github_cli`, and whether secure storage was
actually verified. If login is missing,
`figure_library_github_auth_instructions` returns a command for the user to run
in their own terminal.

`figure_library_plan_publication_pr` and
`figure_library_apply_publication_pr` implement two separate, manual-review
gates:

1. **Archive PR** — validate one sanitized submission, create a deterministic
   ZIP, and propose only
   `archives/<templateId>/<releaseVersion>/<templateId>-<releaseVersion>.zip`
   in `jarxunlai/ScientificFigureLibrary-community-archives`.
2. **Catalog PR** — permitted only after that Archive PR was manually merged.
   It reloads the ZIP from the exact merge commit, verifies every identity, and
   proposes the Catalog entry, thumbnail, preview manifest, aggregate Catalog,
   and human review record in `jarxunlai/ScientificFigureLibrary-community`.

Plan is read-only and displays the expected login, repository/base, branch or
fork, commit/PR text, complete file list, and digests. Apply rechecks login,
permission, base commit/tree, source, and files; it uses `gh api` and Git Data
API rather than the current cwd or a git remote. It cannot modify `.github/**`,
CI, policy, or an existing archive path. Operation receipts contain no secret
and make a stable `operationId` replay the existing open/merged PR rather than
create a duplicate.

Neither SFL nor its CI merges a PR. The user must review and manually merge the
Archive PR before a Catalog Plan can exist, and must separately review and
manually merge the Catalog PR. An export, Archive PR, or Catalog PR that has not
been merged is not a public Community release.

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

See [`docs/GLOBAL_LIBRARY_0.6.md`](docs/GLOBAL_LIBRARY_0.6.md) for the storage,
locator, lifecycle, migration, and portability model.

## Structured diagnostics and export

Each MCP Server process creates an independent diagnostics session and writes
bounded JSONL outside the global Library and project repositories. Set
`SFL_DIAGNOSTICS_DIR` to an absolute directory to override the system temporary
diagnostics directory. The default limits are 5 MiB per JSONL segment and
50 MiB total across JSONL/ZIP files. Rotation is oldest-first. A diagnostics
write failure never fails search, preview, confirmation, or planning; affected
tool/status output reports `diagnosticsDegraded` instead.

The logger records fixed structured events for server startup, capability
detection, search stages, candidate detail open/close, exact preview request,
image load/error, confirmation, model-context update, materialization planning,
and tool failures. App-only `figure_library_record_ui_event` accepts only a
fixed enum plus the current result/candidate identifiers and bounded numeric
metrics; it rate-limits at 120 events/minute and 1000 events/session. It is an
internal component tool, not an Agent workflow tool.

Call public `figure_library_export_diagnostics` only when the user explicitly
requests logs/a diagnostic bundle, supplies a correlation ID or time range, or
accepts export after a failure. Defaults are current session, sanitized ZIP,
no user text, and no absolute paths. The ZIP contains:

```text
scientific-figure-library-diagnostics-<timestamp>.zip
├── summary.md
├── events.jsonl
├── errors.jsonl
├── environment.json
└── manifest.json
```

The manifest records schema/app version, session, creation time, file sizes and
SHA-256 values, total payload bytes, scope, and redaction mode. Image bytes,
Data URLs, selectors, preview challenges/receipts, plan tokens, credentials,
cookies, environment variables, conversation/free text, source assets, and
sensitive paths are excluded or redacted. `includeUserText` is accepted for
forward compatibility, but 0.5.3 does not collect conversation/free text and
therefore still records `userTextIncluded: false`. Absolute paths appear only
when the user explicitly sets `includeAbsolutePaths: true`.

The result contains only a compact summary, size, SHA-256, and a session-bound
`figure-library://diagnostics/<bundleId>` resource link; it never injects the
JSONL or ZIP into model-visible structured content. If the Host cannot download
resource links, report that integration limitation. A local path is returned
only when absolute paths were explicitly requested, and local file existence
alone must not be described as delivery to the user.

## MCP tools in the 0.6 standard core

| Area | Tools |
| --- | --- |
| Workbench and retrieval | `figure_library_open`, `figure_library_search`, `figure_library_describe`, `figure_library_preview`, `figure_library_preview_exact_headless`, `figure_library_confirm_selection_headless`, `figure_library_source_status` |
| App-only component tools | `figure_library_search_page`, `figure_library_preview_exact`, `figure_library_confirm_selection`, `figure_library_record_ui_event` |
| Diagnostics export | `figure_library_export_diagnostics` |
| Global binding | `figure_library_plan_bind_global`, `figure_library_apply_bind_global` |
| Write-lock recovery | `figure_library_plan_recover_write_lock`, `figure_library_apply_recover_write_lock` |
| Review inspection | `figure_library_review_open`, `figure_library_preview_working_revision`, `figure_library_template_history`, `figure_library_diff_revisions` |
| Direct intake | `figure_library_plan_working_revision`, `figure_library_apply_working_revision` |
| Gate, publish, discard, restore, adoption | the lifecycle plan/apply pairs listed above |
| Exact acquisition | `figure_library_plan_materialize`, `figure_library_apply_materialize` |
| Portable bundles | `figure_library_plan_bundle_export`, `figure_library_apply_bundle_export`, `figure_library_plan_full_restore`, `figure_library_apply_full_restore`, `figure_library_plan_template_bundle_import`, `figure_library_apply_template_bundle_import` |
| Provider source management | `figure_library_list_provider_sources`, `figure_library_plan_provider_source_change`, `figure_library_apply_provider_source_change` |
| Sanitized publication export | `figure_library_plan_publication_export`, `figure_library_apply_publication_export` |
| Staged central GitHub PRs | `figure_library_github_auth_status`, `figure_library_github_auth_instructions`, `figure_library_plan_publication_pr`, `figure_library_apply_publication_pr` |

There are no `figure_capture_*`, project status/pin, direct-write import, sync,
archive/reconcile, or one-step materialize tools in the standard 0.6 server.

## Distribution

The same standard MCP server and Skill are packaged for three hosts. Do not
register a raw `mcp_servers.figure-library` entry **and** a host plugin at the
same time; that duplicates tools.

```bash
npm run package:plugins
```

This writes three artifacts into `release/`:

- `scientific-figure-library-wisp-0.6.0.zip` — install from Wisp **Settings → Plugins**
- `scientific-figure-library-codex-0.6.0.zip` — Codex plugin with `.codex-plugin/plugin.json`, `.codex-plugin/mcp.json`, and `skills/figure-library`
- `scientific-figure-library-claude-0.6.0.zip` — Claude Code plugin with `.claude-plugin/plugin.json`, `.claude-plugin/mcp.json`, and auto-discovered `skills/`

Each package uses its Host's plugin-root contract. Codex resolves `cwd: "."`
from the installed plugin root, Claude expands `${CLAUDE_PLUGIN_ROOT}`, and Wisp
continues to expand `${WISP_PLUGIN_ROOT}`. Therefore the server entry does not
depend on the project directory from which the Host was opened.

The automated package smoke extracts each ZIP under a path containing spaces,
starts the packaged server from an unrelated project cwd, and completes MCP
`initialize` plus an exact `tools/list` inventory. This proves the packaged
stdio and Host root-resolution contracts only. It does **not** prove that a
real Codex Desktop installation has formed an exact ready client or injected
the tools into a Desktop session; those observations remain a manual
pre-release field acceptance from an arbitrary project directory.

The MCP App may request `fullscreen` or `pip` if the Host lists those modes in
`availableDisplayModes`. Codex has no docked-sidebar display mode.

Build a standalone npm package:

```bash
npm run package:npm
npm install --global ./release/scientific-figure-library-0.6.0.tgz
```

Use `scientific-figure-library` as the MCP command after installation.

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
`release/figure-library-source-pack-volcano-0.6.0.zip` before use.

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

### Vendor the reviewed Community Catalog

Ordinary startup, search, build, and packaging never refresh the Community
Catalog over the network. After the Archive PRs and their corresponding Catalog
PRs have both passed human review and been manually merged, explicitly sync the
fixed final Community commit from a clean checkout:

```powershell
$communityCheckout = Resolve-Path "<checked-out-community-repo>"
npm run community:sync -- `
  --source $communityCheckout `
  --commit <exact-40-hex-community-commit>
```

The sync command creates an isolated provenance repository and fetches the
fixed central HTTPS URL rather than trusting a checkout-defined remote or Git
configuration. The requested commit must equal the freshly fetched central
`main`; its tracked modes/blob identities and vendored bytes must also match the
clean local checkout. Only then does the command validate the aggregate and
standalone Catalog entries, preview manifest, PNG identities, license mapping,
and exact inventory before atomically replacing `assets/community`. The source
checkout and target must be separate directory trees. Packaging has an
additional final-release gate that requires the three reviewed 1.0.0 seed
releases; the empty bootstrap snapshot is valid for development tests but
cannot be packaged as the 0.6.0 release.

## License

Project code is MIT licensed. FigureYa-derived catalog data, thumbnails, and
downloaded templates remain CC BY-NC-SA 4.0. Bundled Community template code is
MIT; its synthetic data, generated previews/thumbnails, and documentation are
CC BY 4.0 and retain per-release attribution in the Community Catalog and
archive. User-supplied and adapter-imported material keeps its recorded source
license. See
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
