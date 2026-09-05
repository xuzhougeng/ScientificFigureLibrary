---
name: figure-library
description: Build, review, search, select, and materialize immutable scientific-figure references from Local Published, FigureYa, bundled Open Figure Modules, frozen explicit-only Community, and explicitly trusted dynamic Providers.
---

# Scientific Figure Library 0.6.3

Use this Skill when a user wants to store an uploaded figure/code pair, review
or publish a local template, search for a plotting reference, or materialize an
exact template into a project.

Version 0.6.1 adds the bundled Open Figure Modules Provider while keeping
materialization protocol v2, review truthfulness, and the transport image
adapter. Default search is Local Published, FigureYa, bundled Personal Figure
Modules, then opted-in dynamic personal sources. Community remains readable
for an explicit `providerId`, but is frozen and excluded from default search.
The MCP App may request fullscreen or
pip when the Host advertises those display modes. Wisp, Codex, and Claude
plugin packages all ship this Skill beside the same MCP server. Optional
`scientificQuestion` explains why a figure is worth drawing; it is not
`description` or `visualProfile`. There is no receipt-free materialization
path.

## Bundled companion Skills

Use the copies shipped beside this Skill, not similarly named Host installations.
- Before creating/updating template prose use [figure-description](../figure-description/SKILL.md).
  Pass independent Markdown description/application/dataProfile, with a non-empty application
  for every new/updated Working revision. Never put scenarios into visualProfile.
- When the user actually requests adapting/replicating a selected template, use
  [figure-organization](../figure-organization/SKILL.md), then
  [figure-style](../figure-style/SKILL.md). Preserve reference fidelity by default.
- Pure search/preview/materialization does not start prose writing or plotting.
- Host execution tools and the project R/Python environment are still needed. A
  plugin installation is not approval to execute code or install packages.

## Non-negotiable boundaries

- The Library is one user-selected, cross-project global store. Never infer the
  Library root from the current project and never create a project pin.
- Standard core uses direct image/code intake. Do not call `figure_capture_*`;
  Capture tools are not registered in the standard 0.6 server.
- The server hashes, validates, versions, reviews, and materializes files. It
  does not contain a model and never executes code.
- Host Agent observations, deterministic/rule findings, and user decisions are
  distinct. Do not present an Agent inference as source fact or user approval.
- Plot `not_run` never means reproduced, validated, or verified. Plot
  execution, upstream workflow, and scientific validation are separate claims.
- Treat all code and materialized files as untrusted. Never run a dependency
  installer automatically.
- Public Provider materialization only downloads, verifies, extracts, and
  writes. Never execute R, Python, notebooks, shell, or installers from a
  template. `codeExecutedBySflClient` must remain `false`.
- Central curation, a publisher signature, and the recipient's Local review are
  separate facts. Never call a Community/personal template locally approved.
- `publisherReviewStatus=approved` and `publisherExecutionStatus=passed` are
  publisher/Gallery facts. They never mean that SFL executed code or reassessed
  the scientific conclusion; `codeExecutedBySflClient` remains `false`.

## Terminal outcome discipline

Every SFL response is final for that call and includes:

```text
OUTCOME: ...
TERMINAL: true
RETRY_SAME_CALL: false
CODE: ...
NEXT_ACTION: ...
```

Read these fields once and follow `NEXT_ACTION`:

- `ask_user`: ask only for the listed missing decisions or values.
- `apply_confirmed_plan`: show the exact plan and wait for approval.
- `create_new_plan`: do not repeat Apply; create and review a fresh plan.
- `inspect_review`: inspect the Working/review state.
- `stop_other_writers`: ask the user to stop every Wisp, Codex, Claude, and
  other writer. Never steal a lock automatically.
- `rebind_library`: inspect status and request an explicit global binding.
- `none`: stop; do not make another equivalent call.

Never repeat an identical failed, blocked, not-found, stale, or expired call.
Changing inconsequential parameters to evade a terminal response is also
forbidden. If a Host bridge exposes only text and hides `structuredContent`,
use only the visible facts; do not reconstruct IDs, digests, paths, image
blocks, or success claims.

`figure_library_open` is an optional MCP App call. If the Host rejects it with
MCP `-32601` or `Capability is not granted`, do not retry it. This means the
optional UI capability was denied; it does not prove that ordinary headless
tools are unavailable. If the App opens but Host `serverTools` is missing,
use **选择并交给 Agent 审核** only when `updateModelContext.text` is available.
That user click authorizes one headless exact review of the selected candidate,
not App-local preview acceptance or Apply. If both capabilities are missing,
report the capability blocker. Never use a backend image viewer as a substitute
for user-visible App preview.

## 1. Inspect or bind the global Library

Call `figure_library_source_status` when the effective Library is unknown. It
reports the global root/source, locator, `libraryId`, write status, lifecycle
counts, write lock, Local Published provider, FigureYa provider, and Local
workspace confirmation.

This machine has two roots. They are cross-project and are not inferred from
the current Wisp cwd:

- Published Library: immutable search/publish store
- Local workspace: pre-publish inbox/drafts/gallery knowledge base

If `WORKSPACE_CONFIRMED` is false, this machine has never bound a Local
workspace. Ask once for an absolute directory (do not use the current project
folder unless the user names it). Call `figure_library_plan_bind_workspace`,
show the plan, then `figure_library_apply_bind_workspace` after approval.
Later MCP starts reuse that locator silently. Rebind only when the user asks
or the bound directory is missing/invalid.


If writing is disabled or the user wants another Library:

1. Ask the user for one absolute global Library directory. Explain that it is
   shared across projects and should be backed up.
2. Call `figure_library_plan_bind_global` with `libraryDirectory` and normally
   `migrationMode: "none"`.
3. If the user deliberately wants to stage a legacy flat Library, use
   `migrationMode: "copy_legacy"` and an absolute `legacySourceDirectory`.
4. Show the exact directory, `libraryId`, locator path, inventories, migration
   mode, and `planDigest`. The plan writes nothing.
5. After explicit approval, call `figure_library_apply_bind_global` in the
   same server session with the visible `planDigest` and a stable
   `operationId`. Do not pass or reconstruct an opaque plan; Apply accepts
   only the server-issued cached digest.

`FIGURE_LIBRARY_DIR` overrides the locator. If it blocks a different binding,
report that fact instead of silently using a project directory. The legacy
`~/.figure-library` fallback is read-only until explicitly bound.

Write-lock recovery is exceptional. Call
`figure_library_plan_recover_write_lock` only after identifying an abandoned
lock. Apply with `figure_library_apply_recover_write_lock` only after the user
confirms that all writers are stopped and approves the exact unchanged plan.

## 2. Create or update a Working Revision from user files

### Inspect before asking for confirmation

- For every uploaded image, first use the host image viewer. Record only what
  is actually visible: chart family, panels, axes, encodings, labels, and
  annotations. Include every uploaded original in `visualAssets` as a
  `source_reference`; never omit it merely because a rendered output exists.
- Read supplied code as text. Identify its language, intended output, inputs,
  dependencies, and whether it is user-supplied, author-provided,
  Agent-generated, or adapted. Do not execute it.
- Use absolute trusted host paths in tool input. If an attachment is not
  locally accessible, ask the user to upload it again or provide an accessible
  path; never guess a path.

### Obtain explicit user decisions

Before planning, state what will be stored and ask the user to confirm:

1. `create` a new Series, `update` an exact Series, or reuse an existing one;
2. title and complete Figure Unit boundary;
3. multi-image grouping, if applicable;
4. canonical primary preview and any required user override;
5. each visual role: `source_reference` or `rendered_output`;
6. asset kind: `plot_template` or `visual_reference`;
7. truthful `plotExecution`, `upstreamWorkflow`, and
   `scientificValidation` state;
8. duplicate decision: `create_new`, `update_exact`, or `reuse_existing`;
9. license and provenance;
10. for `plot_template`, each code origin, canonical implementation, and every
    evidence-backed many-to-many figure-code relationship.

Allowed relationships are `user_supplied_pair`, `author_provided_original`,
`visual_inference`, `adapted_from_template`, and `generated_output`.

Use `visual_reference` when reliable code is absent. A `plot_template` requires
code and a canonical code asset selected by the user. Any `visual_inference`
must be `scaffold` / `not_run` and described as inspired by the visual, not as
a reproduction. `plotExecution.passed` is permitted only with a visual marked
`rendered_output`, a `generated_output` link, and an evidence asset.

Canonical preview rules:

- exactly one `source_reference` defaults to that source, even when rendered
  outputs also exist;
- exactly one total visual is the only available choice;
- multiple sources, or multiple rendered-only visuals without a selection, are
  `canonical_preview_ambiguous`;
- choosing rendered while a source exists requires
  `primaryPreviewOverride: { confirmedBy: "user", reason }`, otherwise stop on
  `canonical_preview_override_required`.

The Server validates only assets the Host declares. Version 0.5.3 deliberately
has no separate upload digest declaration, so it cannot detect that a Host
omitted an uploaded original entirely. This is a Host contract, not evidence
that omission detection passed.

### Plan, preview, review, then Apply

Call `figure_library_plan_working_revision` with:

- `mode`, optional exact `templateId`, title and searchable metadata;
- `visualAssets`, `codeAssets`, optional reference/evidence assets;
- optional `primaryVisualAssetId`, optional user-confirmed
  `primaryPreviewOverride`, and optional `canonicalCodeAssetId`;
- `validationState`; keep `executionStatus` only as its compatible
  `plotExecution.status` projection;
- evidence-backed `figureCodeLinks` with `confirmedBy: "user"`;
- all applicable confirmation booleans set only after the user confirmed;
- `assessment` separated into validation errors, blocking gates, and warnings;
- Agent observations in `agentAssessment`, not in the user decision;
- provenance and optional intake adapter metadata.

For create use `duplicateDecision: "create_new"`; for update use
`"update_exact"`. `"reuse_existing"` requires an exact `templateId` and
creates no Working Revision.

The plan writes nothing. Show the user at least:

- action and `templateId`;
- `revisionId`, `contentDigest`, and every stored asset hash;
- `reviewId` and the unified `reviewSummary` (validation errors, open gates,
  warnings, `publishEligible`, canonical decision, and validation state);
- the exact `previewSelector` plus `expectedSeriesDigest` and `planDigest`.

Call `figure_library_preview_working_revision` once with the unchanged
`templateId`, `revisionId`, and `contentDigest` selector when the Working
image must be inspected. Before Apply it resolves only the latest exact,
session-local pending Working plan for that Series; after Apply it resolves the
matching current Working Head. It is read-only, accepts no destination, creates
no preview receipt, and never authorizes materialization. A superseded selector,
missing Working target, or invalid image is terminal; do not broaden or retry
it.

Only after the user approves that exact plan call
`figure_library_apply_working_revision` with the returned `planDigest`, a
stable `operationId`, `expectedAction`, `expectedTemplateId`, and
`expectedSeriesDigest`. Do not alter fields between plan and Apply. If source
bytes or Series state changed, create a new plan and request confirmation again.

## 3. Review, gate, publish, discard, or restore

- `figure_library_review_open` reports `workingReview` and
  `publishedReview` separately for one Series; compatibility `review` means
  `workingReview ?? publishedReview`. Published findings come from the
  immutable Review bound by its Release.
- `figure_library_template_history` reads immutable Revision/Review/Release
  history.
- `figure_library_diff_revisions` compares two exact Revisions.

Validation Errors and open Blocking Review Gates prevent publication. Warnings
remain visible before and after publication because Published search/review
loads the Release-bound immutable Review; warnings are not waivers and the
standard server has no waiver mechanism. Working and publish plan/apply responses expose the same
`reviewSummary` shape.

Every mutation is plan/apply:

- gate decisions: `figure_library_plan_review_gate_update` then
  `figure_library_apply_review_gate_update`;
- atomic approval/publication:
  `figure_library_plan_publish_working_revision` then
  `figure_library_apply_publish_working_revision`;

After `figure_library_apply_publish_working_revision` succeeds, ask once whether
to submit that exact Local Published Release to Open Figure Modules. Explain
that source/reference images, PDFs, evidence, receipts, and Local Library
state stay out of the PR; included bytes are portable code, example/synthetic
data, a generated PNG preview, and documentation, licensed MIT / CC BY 4.0.
If the user declines, stop. If the user agrees, call
`figure_library_github_auth_status` then
`figure_library_plan_open_figure_module_pr` with the just-published
`providerId` and `exactSelector`.

- If the Plan returns `NEXT_ACTION: ask_user` and similar candidates, call
  `figure_library_search` with the Plan's `similarSearch.query`,
  `providerIds`, `plotFamily`, `language`, `limit`, and `resultSetId` from
  `plan.similarSearch` so the SFL window
  shows FigureYa and Open Figure Modules hits. Do not include Local
  Published. Stop and wait. Retrieval scores are ranking only.
- After the user confirms the hits are not duplicates, call
  `figure_library_apply_open_figure_module_pr` with the Plan digest, a
  stable `operationId`, `similarReviewConfirmed: true`, and the
  `expectedResultSetId` equal to `plan.similarSearch.resultSetId`. The search
  must return that exact set before confirmation. A newly repeated query is
  not the reviewed set. On a text-only Host, show the same result set as a text
  list and wait for the same explicit confirmation.
- If the Plan returns `NEXT_ACTION: apply_confirmed_plan` because there were
  no similar hits, apply immediately in the same turn without a second
  question.
- Path collisions on `modules/<moduleId>/` fail closed. The tool creates a
  two-commit PR and never merges. Do not present an open PR as already in
  default search.

- discard Working Head: `figure_library_plan_discard_working_revision` then
  `figure_library_apply_discard_working_revision`;
- restore a historical Release as a new Working candidate:
  `figure_library_plan_restore_release` then
  `figure_library_apply_restore_release`;
- explicitly adopt one legacy flat-v1 template:
  `figure_library_plan_adopt_versioning` then
  `figure_library_apply_adopt_versioning`.

Show each exact plan and wait for approval. Apply with the returned
`planDigest`, stable `operationId`, `expectedTemplateId`, and
`expectedSeriesDigest`. Publication switches the Published pointer atomically;
it does not edit or delete the old Published Release. Restoration never moves
the Published pointer backward directly.

## 4. Search the dynamic Provider set

If the user only asks to open the workbench, call `figure_library_open`; do not
invent a generic query. Otherwise inspect the request first:

- image: view it before searching;
- data: profile shape, columns/types, semantic roles, and missingness locally;
- text: extract purpose, expected chart, and constraints.

Call `figure_library_search` with 2–8 discriminative query terms and compact
`dataProfile` / `visualProfile`. Do not pass raw datasets. Leave `providerIds`
at its default so Local Published, FigureYa, bundled Open Figure Modules,
and only those dynamic personal Providers explicitly opted into default search
are searched together. Community stays registered as frozen explicit-only
compatibility; search it only when the user explicitly supplies its Provider
ID.

A bundled Community snapshot may be healthy and contain zero current releases
after an authorized Catalog redaction. Do not report that state as degraded,
retry redacted selectors from an older plugin, or turn zero Community candidates
into a terminal failure when other selected Providers are healthy. This pre-0.7
redaction is not the normal withdrawn lifecycle of a later protocol and does not
erase Git history or an already materialized, commit-pinned recipient copy.

The built-in Open Figure Modules source is a separate, read-only snapshot
maintained by the operator. Its Catalog and thumbnails are bundled for offline
search and exact preview; complete ZIPs are not bundled. Each personal module
uses the `module-archive.v1` selector kind and binds the Provider ID, module ID, source repository/commit, archive
repository/commit/path, archive bytes and SHA-256, primary preview identity,
Catalog SHA-256, and `template` or `full` mode. Publisher/Gallery review and
execution facts are displayed separately from SFL Local review and execution.

Maintainers use the offline commands below from the SFL checkout. They never
create a GitHub repository, commit, push, run R, or modify the Gallery:

```text
npm run modules:validate -- --check --repository <PERSONAL_MODULE_REPOSITORY>
npm run modules:archive -- --write --repository <PERSONAL_MODULE_REPOSITORY>
npm run modules:catalog -- --write --repository <PERSONAL_MODULE_REPOSITORY>
npm run modules:source-pack -- --write --repository <PERSONAL_MODULE_REPOSITORY>
```

Use `--check` first. `--write` only atomically replaces generated output after
path, file, privacy, license, preview, ZIP, and fixed-commit checks pass. The
single personal content repository contains both `modules/` and `archives/`;
the SFL plugin contains only the derived Catalog, preview manifests, and
thumbnails.

Ordinary results exclude Working, Capture, and unadopted flat entries. Every
candidate has a `providerId` and provider-qualified `exactSelector`. Preserve
both unchanged. Never resolve by bare `templateId` or let a same-named provider
shadow another.

The retrieval score is ranking only. It is not confidence, approval, or visual
similarity. Local Published structured results preserve Release-bound warnings and
separate plot, upstream, and scientific summaries; the browse UI focuses on
requirements, use cases, data profile and actual resource lists. A legacy plot `passed`
means upstream unknown and scientific not assessed. FigureYa is
upstream-published but locally `not_reviewed`, code `provided`, plot
`not_run`, upstream `unknown`, and scientific `not_assessed`; do not call it
SFL-approved or reproduced.

Search defaults to 6 candidates per page and returns the true `total`,
`resultSetId`, `pageIndex`, `hasMore`, and opaque `nextCursor`. In the MCP App,
the App-only `figure_library_search_page` receives only the current
`resultSetId` and `nextCursor` to visit every page. Do not truncate the catalog
yourself. If the server returns `search_results_stale`, start a new search;
never reuse the old result set.

After `figure_library_search` returns candidates, **stop the Agent turn and
wait for the user**. Do not automatically call any preview tool, inspect each
candidate, or use a backend image viewer. Opening and closing card details,
loading the selected exact image, and confirming it are App interactions and
must not trigger a model turn. Only when the user explicitly asks the Agent to
choose may the Agent visually review a small, top-ranked subset; never walk the
complete result set by default.

## 5. Preview and confirm one exact candidate

The search result keeps model-visible `structuredContent` compact and carries
verified thumbnail Data URLs only in result `_meta`, which is component-only.
The App merges those thumbnails by result-scoped `candidateId`; do not ask the
Agent to parse Base64. Each thumbnail, title, and **查看详情** action opens an
accessible dialog using metadata already returned by search. Basic detail must
remain usable without `serverTools` and must not call the Agent or a Server
Tool. Candidates whose preview is missing, unreadable, unsupported,
path-invalid, corrupt, or over the transfer limit remain visible with an error
state but cannot be confirmed.

For one selected usable candidate, preserve `resultSetId`, `providerId`, and
`exactSelector`. Do not pass a destination and do not download or materialize
anything during preview.

- Apps + `serverTools` path: only the App calls App-only
  `figure_library_preview_exact`. Its image Data URL and one-time
  `previewChallenge` remain in component-only `_meta`. The App waits for the
  exact `<img>` `load` event and a user click on **确认并交给 Agent**, then calls
  App-only `figure_library_confirm_selection` and sends the minimal selection
  summary plus `previewReceipt` through `updateModelContext`.
- Apps without `serverTools`: when `updateModelContext.text` is available, the
  user may click **选择并交给 Agent 审核**. Treat that handoff as authorization
  to call model-visible `figure_library_preview_exact_headless` exactly once
  for the one selected candidate, then call
  `figure_library_confirm_selection_headless`. Do not inspect another
  candidate, Apply, or claim the exact image loaded inside the App.
- Host with no Apps UI: wait for the user's selection or explicit delegation,
  then use the same headless preview/confirmation sequence for one selected
  candidate. Both headless routes cannot prove that the user actually saw an
  App image; say so in any acceptance report.

If App `updateModelContext` reports `handoffMode=agent_plot_set`, the user
selected 1..N templates to draw. Plot every `selectedCandidates` item in the
current science project. Keep each `providerId` and `exactSelector`
unchanged. Do not plot only the first item, do not inspect unselected
candidates, and do not publish. Materialize or load each template separately.

Both paths return a session-local, opaque, single-use `previewReceipt` bound to
the exact result set, provider, selector digest, preview hash, catalog/Library
revision, and Library root. A challenge is destroyed on confirmation. A
receipt has no time TTL, but restart, content/root/catalog change, mismatch, or
successful plan generation invalidates it.

The older `figure_library_preview` copy/display tool is compatibility-only. It
cannot create a receipt and must never be described as a sidebar preview.

## 6. Plan and Apply exact materialization

Materialize only after the preview/confirmation sequence above.

1. Call `figure_library_plan_materialize` with the unchanged `providerId`,
   `exactSelector`, the returned `previewReceipt`, an absolute `destination`,
   optional absolute `sourcePackDir`, and the intended `allowNetwork` policy.
   For bundled Open Figure Modules this directory must contain
   `module-source-pack.manifest.json`; for FigureYa it must contain the legacy
   FigureYa Source Pack manifest. A supplied but mismatched Source Pack fails
   closed and is not silently bypassed with a network download.
   Missing receipt is `preview_required`; do not retry without preview.
2. Show provider, full exact selector, preview confirmation mode,
   `<destination>/<templateId>` target, and acquisition policy. Wait for
   approval. Successful planning consumes the receipt, so do not reuse it.
3. Call `figure_library_apply_materialize` with `planDigest`, stable
   `operationId`, `expectedProviderId`, and exact `expectedTarget`. Apply uses
   the confirmation fact sealed into the v2 plan and does not take a receipt.

The output has `TEMPLATE.md`, `template.json`, `template.lock.json`, and
normalized `assets/`; FigureYa and Open Figure Modules also have untouched
`upstream/`. A Personal selector offers explicit `template` and `full` modes;
`template` uses only the Catalog's `requiredFiles`, while `full` uses the
complete cleaned module inventory. Do not overwrite
an existing target. Keep exact reference files unchanged and create adapted
project code separately.

Do not treat `template.lock.json` alone as proof that Apply succeeded. Durable
replay requires the matching authoritative Receipt in the global Library and
revalidates the provider selector plus every materialized file. Never fabricate
or copy a lock to bypass a missing/expired plan.

Any materialization error is a hard stop. Do not retry the same call, switch
mode/provider/source, use a shell downloader, fetch a complete repository,
recreate the reference, or generate a substitute/demo plot. Report the exact
error and wait for a new user instruction.

## 7. Manage signed personal Providers

Call `figure_library_list_provider_sources` for an offline inventory. Personal
sources are never trusted from a key embedded in their own manifest. A first
Add requires an independently obtained raw 32-byte Ed25519 public key and
defaults to `includeInDefaultSearch: false`.

Use `figure_library_plan_provider_source_change` for `add`, `update`,
`configure`, `remove`, or exceptional `trust_reset`. Planning may access the
listed HTTPS URLs but must not write config or snapshots. Show sequence,
manifest digest, old/new key fingerprints, template additions/updates/
withdrawals, default-search state, target paths, and all warnings. Wait for
explicit approval, then call `figure_library_apply_provider_source_change`
with the exact cached `planDigest`, action/provider expectations, and a stable
`operationId`. A stale remote, rollback, equivocation, bad signature, unsafe
URL/DNS redirect, inventory collision, or size violation is terminal. Failed
updates preserve the last-known-good snapshot; Remove does not delete it.

## 8. Export one sanitized public submission

This workflow is different from a Local publish or portable bundle. It accepts
only one exact currently reachable Local Published Release and does not expose
an entire Library.

1. With `figure_library_plan_publication_export`, explicitly include or exclude
   every asset. Included assets must be licensed code, synthetic data, one
   code/data-generated PNG preview, or documentation. Exclude source-reference
   images, screenshots, paper/PDF/TIFF extracts, evidence, patient/experimental
   data, private lifecycle state, and machine paths. DOI/URL text provenance is
   allowed.
2. Show every asset role/path/digest/license/source, generated-preview trace,
   public metadata, parent/public metadata conflicts, excluded state, target,
   and `written: false`. A parent `unknown` or `private_reference` license is
   not silently promoted. Require complete per-publication rights attestation
   and explicit conflict confirmation.
3. After approval call `figure_library_apply_publication_export` with the exact
   `planDigest`, stable `operationId`, and exact absent `expectedTarget`. Apply
   revalidates the Release and every selected byte, then writes deterministic
   `submission.json`, licenses, render receipt, inventory, and `payload/**`.

Export never accesses the network, signs, executes code, creates a PR, merges,
or publishes the Local Library. GitHub Archive PR then Catalog PR are separate
plan/apply operations; neither tool may merge. Do not present an exported
submission or an open PR as a public Community release.

Every future Community proposal must originate from an exact reachable Local
Published Release through this export flow. Never treat an ad-hoc
`seed-staging` directory, an Archive retained for a Catalog-redacted release,
or a bare filesystem bundle as an alternate public intake path.

## 9. Create staged central GitHub PRs

SFL delegates credentials to the official `gh` CLI. First call
`figure_library_github_auth_status`; report its login, host, per-repository
permission, `credentialStorage=managed_by_github_cli`, and the observed
`secureStorageVerified` value. Never call `gh auth token`, read `hosts.yml`, or
print/cache/write a token. If authentication is absent, call
`figure_library_github_auth_instructions` and ask the user to run the displayed
command in a terminal. SFL must not open a browser or start interactive login.

For `figure_library_plan_publication_pr`, the only allowed actions are:

- `archive`: consume one validated submission and propose one deterministic
  ZIP at
  `archives/<templateId>/<releaseVersion>/<templateId>-<releaseVersion>.zip`
  in `jarxunlai/ScientificFigureLibrary-community-archives`.
- `catalog`: only after the corresponding Archive PR was manually merged,
  fetch its exact merge commit, revalidate ZIP/inventory/preview, and propose
  only the Catalog entry, thumbnail, preview manifest, aggregate Catalog, and
  human review record changes in `jarxunlai/ScientificFigureLibrary-community`.

Show expected login, repository/base commit, head/fork, branch, commit message,
PR title/body, every file, archive/content digests, and `written: false`.
After explicit approval call `figure_library_apply_publication_pr` with the
exact cached `planDigest` and stable `operationId`. Apply rechecks login,
permissions, base, source, and all identities before Git Data API writes. It
never uses the task cwd or git remote, never changes `.github/**`, CI or policy,
and never merges. Stop at each created PR for the user to review and manually
merge. An Archive PR, even when open and CI-green, is not permission to create
a Catalog PR; a merged Catalog PR is the public-release boundary.

## 10. CiteBox intake

CiteBox is not an ordinary search provider. Obtain a user-selected Figure only
through CiteBox API, MCP, or explicit export; never read or write its SQLite
database directly.

After obtaining self-contained local assets, use the normal Working Revision
workflow with `intake.adapterId: "citebox"`. Preserve available Figure ID,
DOI/title, figure label, page, caption, export hash, retrieval time, and source
metadata in `intake.sourceManifest` and provenance. Source publication or
CiteBox state is not inherited as local SFL approval. The imported Working
Revision must pass the same local review and publication gates.

## 11. Portable backup, restore, fork, and template exchange

Portable operations are also plan/apply and require absolute trusted paths.

- Full backup or one exact reachable Published template:
  `figure_library_plan_bundle_export` then
  `figure_library_apply_bundle_export`. Show kind, source `libraryId`, exact
  selector when present, target, file count, and inventory digest. Apply must
  echo the visible absolute target as `expectedTarget`; never infer or replace
  it.
- Full Library restore or independent fork:
  `figure_library_plan_full_restore` then
  `figure_library_apply_full_restore`. Restore preserves `libraryId`; obtain
  explicit authority-transfer confirmation that the old copy will stop
  accepting writes. Use fork for an independently writable clone. Apply does
  not change the active locator automatically.
- Published-template bundle import:
  `figure_library_plan_template_bundle_import` then
  `figure_library_apply_template_bundle_import`. The result is a Working
  Revision; source-Library approval is provenance only and is not inherited.

Every Apply in the same server session receives the visible matching
`planDigest` and a stable `operationId`. Never invent, reconstruct, or
hand-edit an opaque plan; Apply accepts only a server-issued cached digest.
If the server reports `plan_not_available`, create and review a new plan rather
than repeating Apply. The only cache-loss exception is a server-reported
bundle-export recovery from its authoritative pre-write intent and the exact
byte-verified `expectedTarget`. Targets must otherwise be absent; a stale
inventory or occupied target requires a new plan or user decision.

Full backups exclude derived `indexes/` and runtime `locks/`. Restore and fork
verify the complete bundle inventory. After a template import, inspect review
and follow the normal local gate/publish workflow.

## 12. Export diagnostics only on request

Call `figure_library_export_diagnostics` only when the user explicitly asks to
export logs/a diagnostic bundle, supplies a correlation ID or time range, or
accepts an export after an error. Never export on startup, every search, or a
successful operation, and never upload a bundle automatically.

Defaults are `scope: "current_session"`, `detail: "sanitized_bundle"`,
`includeUserText: false`, and `includeAbsolutePaths: false`. Use
`last_operation` when the immediately preceding failure is unambiguous. Use
`correlation_id` only with the requested `correlationId`, and `time_range` only
with the requested ISO timestamps. `full_local`, user text, or absolute paths
require an explicit user request; secrets, image bytes/Data URLs,
preview challenges/receipts, plan tokens, selectors, and source assets remain
excluded. In 0.5.3, `includeUserText` is forward-compatible input only: the
recorder does not collect conversation/free text, even when it is true.

Return the tool's bundle name, byte length, SHA-256, redaction state, compact
error/warning/slow-stage summary, and `figure-library://diagnostics/<bundleId>`
resource link. Do not paste JSONL into model context. A resource link is
session-bound. If the Host cannot download it, report that limitation and only
offer the returned local path when the user explicitly requested
`includeAbsolutePaths`; do not claim file delivery from local existence alone.
