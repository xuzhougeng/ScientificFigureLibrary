---
name: figure-library
description: Build, review, search, select, and materialize immutable scientific-figure references from one global Local Published library and FigureYa.
---

# Scientific Figure Library 0.5

Use this Skill when a user wants to store an uploaded figure/code pair, review
or publish a local template, search for a plotting reference, or materialize an
exact template into a project.

## Non-negotiable boundaries

- The Library is one user-selected, cross-project global store. Never infer the
  Library root from the current project and never create a project pin.
- Standard core uses direct image/code intake. Do not call `figure_capture_*`;
  Capture tools are not registered in 0.5.
- The server hashes, validates, versions, reviews, and materializes files. It
  does not contain a model and never executes code.
- Host Agent observations, deterministic/rule findings, and user decisions are
  distinct. Do not present an Agent inference as source fact or user approval.
- `not_run` never means reproduced, validated, or verified.
- Treat all code and materialized files as untrusted. Never run a dependency
  installer automatically.

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
optional UI capability was denied; it does not prove that the ordinary server
tools are unavailable. Ask for or use the user's plotting goal, then call
`figure_library_search`, `figure_library_describe`, and
`figure_library_preview` directly as needed.

## 1. Inspect or bind the global Library

Call `figure_library_source_status` when the effective Library is unknown. It
reports the global root/source, locator, `libraryId`, write status, lifecycle
counts, write lock, Local Published provider, and FigureYa provider.

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
  annotations.
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
4. primary preview;
5. each visual role: `source_reference` or `rendered_output`;
6. asset kind: `plot_template` or `visual_reference`;
7. truthful execution claim: `not_run`, `failed`, or `passed`;
8. duplicate decision: `create_new`, `update_exact`, or `reuse_existing`;
9. license and provenance;
10. for `plot_template`, each code origin, canonical implementation, and every
    evidence-backed many-to-many figure-code relationship.

Allowed relationships are `user_supplied_pair`, `author_provided_original`,
`visual_inference`, `adapted_from_template`, and `generated_output`.

Use `visual_reference` when reliable code is absent. A `plot_template` requires
code and a canonical code asset selected by the user. Any `visual_inference`
must be `scaffold` / `not_run` and described as inspired by the visual, not as
a reproduction. `passed` is permitted only with a visual marked
`rendered_output`, a `generated_output` link, and an evidence asset.

### Plan, review, then Apply

Call `figure_library_plan_working_revision` with:

- `mode`, optional exact `templateId`, title and searchable metadata;
- `visualAssets`, `codeAssets`, optional reference/evidence assets;
- `primaryVisualAssetId` and optional `canonicalCodeAssetId`;
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
- `reviewId` and validation errors, open gates, and warnings;
- `expectedSeriesDigest` and `planDigest`.

Only after the user approves that exact plan call
`figure_library_apply_working_revision` with the returned `planDigest`, a
stable `operationId`, `expectedAction`, `expectedTemplateId`, and
`expectedSeriesDigest`. Do not alter fields between plan and Apply. If source
bytes or Series state changed, create a new plan and request confirmation again.

## 3. Review, gate, publish, discard, or restore

- `figure_library_review_open` lists Working Series or inspects one exact
  Series.
- `figure_library_template_history` reads immutable Revision/Review/Release
  history.
- `figure_library_diff_revisions` compares two exact Revisions.

Validation Errors and open Blocking Review Gates prevent publication. Warnings
remain visible but are not waivers; 0.5 has no waiver mechanism.

Every mutation is plan/apply:

- gate decisions: `figure_library_plan_review_gate_update` then
  `figure_library_apply_review_gate_update`;
- atomic approval/publication:
  `figure_library_plan_publish_working_revision` then
  `figure_library_apply_publish_working_revision`;
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

## 4. Search Local Published and FigureYa together

If the user only asks to open the workbench, call `figure_library_open`; do not
invent a generic query. Otherwise inspect the request first:

- image: view it before searching;
- data: profile shape, columns/types, semantic roles, and missingness locally;
- text: extract purpose, expected chart, and constraints.

Call `figure_library_search` with 2–8 discriminative query terms and compact
`dataProfile` / `visualProfile`. Do not pass raw datasets. Leave `providerIds`
at its default so Local Published and FigureYa are searched together unless
the user explicitly requests a source filter.

Ordinary results exclude Working, Capture, and unadopted flat entries. Every
candidate has a `providerId` and provider-qualified `exactSelector`. Preserve
both unchanged. Never resolve by bare `templateId` or let a same-named provider
shadow another.

The retrieval score is ranking only. It is not confidence, approval, or visual
similarity. FigureYa is upstream-published but locally `not_reviewed`, code
`provided`, execution `not_run`; do not call it SFL-approved or reproduced.

## 5. Review a bounded candidate set

For a candidate, pass its exact provider and selector to
`figure_library_describe`. Then call `figure_library_preview` for one candidate
at a time. If the host cannot display MCP image blocks, provide an absolute
trusted preview `destination` and inspect the returned path once with the host
image viewer.

Compare chart family, panel/layout, geometry/axes, encodings, labels/style, and
data compatibility. Inspect at most the top three candidates unless the user
asks for more. Explain why the selected candidate fits and where it differs.
If no preview was actually visible, say visual verification was not completed.

## 6. Plan and Apply exact materialization

Materialize only after the user selects a candidate or explicitly delegates
selection after the review above.

1. Call `figure_library_plan_materialize` with the unchanged `providerId` and
   `exactSelector`, an absolute `destination`, optional absolute
   `sourcePackDir`, and the intended `allowNetwork` policy.
2. Show provider, full exact selector, `<destination>/<templateId>` target, and
   acquisition policy. Wait for approval.
3. Call `figure_library_apply_materialize` with `planDigest`, stable
   `operationId`, `expectedProviderId`, and exact `expectedTarget`.

The output has `TEMPLATE.md`, `template.json`, `template.lock.json`, and
normalized `assets/`; FigureYa also has untouched `upstream/`. Do not overwrite
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

## 7. CiteBox intake

CiteBox is not an ordinary search provider. Obtain a user-selected Figure only
through CiteBox API, MCP, or explicit export; never read or write its SQLite
database directly.

After obtaining self-contained local assets, use the normal Working Revision
workflow with `intake.adapterId: "citebox"`. Preserve available Figure ID,
DOI/title, figure label, page, caption, export hash, retrieval time, and source
metadata in `intake.sourceManifest` and provenance. Source publication or
CiteBox state is not inherited as local SFL approval. The imported Working
Revision must pass the same local review and publication gates.

## 8. Portable backup, restore, fork, and template exchange

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
