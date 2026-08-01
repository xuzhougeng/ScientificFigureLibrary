# Scientific Figure Library

Scientific Figure Library is a standard MCP server and MCP App for finding,
importing, and materializing scientific figure references. It is not tied to
Wisp: any stdio MCP host can use it. The included Wisp manifest and Skill are a
thin optional adapter.

The first release has two template sources:

- **FigureYa** — 319 searchable modules with local thumbnails and
  commit-pinned archives.
- **User Library** — figures and plotting code copied from paths supplied by
  the MCP host.

The host Agent analyzes an uploaded image, a natural-language request, or a data
file. It builds a compact retrieval intent, searches both sources, inspects the
top preview, and decides whether that candidate actually matches before
materializing anything. The catalog score orders retrieval candidates; it is
not a recommendation or visual-similarity score.

For image input, the Agent must first inspect the user's image with the host's
`view_image`, then inspect the top candidate with `figure_library_preview`.
The final recommendation includes an Agent-produced visual pass/reject score
covering chart family, layout, axes/geometry, encodings, and annotations/style,
plus a separate data-compatibility verdict.

## Safety contract

The server copies and extracts reference files but never executes plotting code
or dependency installers. It verifies imported user files with SHA-256 and
verifies FigureYa archives against the pinned catalog.

**Materialization errors are terminal.** `figure_library_materialize` returns a
`STOP:` error that instructs the Agent to report the exact failure and wait for
the user. The Agent must not switch extraction modes, use another downloader,
fetch the complete repository, recreate the template, or generate a
substitute/demo plot. This behavior is covered by the MCP smoke test.

## Build

Requirements: Node.js 22 or newer.

```bash
npm install
npm run check
```

## Use with any stdio MCP client

```json
{
  "mcpServers": {
    "figure-library": {
      "command": "node",
      "args": ["/absolute/path/to/ScientificFigureLibrary/dist/index.js"],
      "env": {
        "FIGURE_LIBRARY_DIR": "/absolute/path/to/my-figure-library",
        "FIGURE_GALLERY_DIR": "/optional/path/to/my-personal-gallery",
        "FIGUREYA_SOURCE_PACK_DIR": "/optional/path/to/FigureYaSourcePack"
      }
    }
  }
}
```

`FIGURE_LIBRARY_DIR` defaults to `~/.figure-library`. The server exposes:

- `figure_library_open` — open an empty candidate workbench.
- `figure_library_search` — search FigureYa and/or the user library.
- `figure_library_import` — safely copy a user figure and/or code into the
  library, or validate and import a Figure Transfer Package.
- `figure_library_diff` — validate one Transfer Package or Gallery entry and
  return a read-only create/update/unchanged diff.
- `figure_library_upsert` — explicitly apply a stable Transfer Package or
  Gallery create/update.
- `figure_library_sync` — validate or synchronize a Personal Gallery; dry-run
  is the default.
- `figure_library_archive` — logically archive a Gallery entry without deleting
  its snapshot.
- `figure_library_preview` — return a candidate as MCP image content and,
  optionally, a checked project-local preview path for Agent inspection.
- `figure_library_source_status` — inspect the user library and a FigureYa
  Source Pack.
- `figure_library_describe` — inspect one exact template.
- `figure_library_materialize` — write one selected reference to a project.

The MCP server does not contain a second model. Agent reasoning stays in the
host: understand input → build retrieval intent → search → view the top
candidate → visually and semantically audit it → materialize only an accepted
template. For attachments, the host makes files available locally and the Agent
passes those paths to `figure_library_import`. For search, the Agent passes
compact descriptions, not raw datasets.

`figure_library_preview` returns standard MCP image content. In Wisp, pass an
absolute project-local `destination` (for example,
`/project/.wisp/figure-library-previews`) and call `view_image` on the returned
path. This keeps visual judgment with the Agent even when the host exposes only
the text portion of an MCP tool result.

Example import arguments:

```json
{
  "title": "Our lab volcano plot",
  "description": "Labeled differential-expression volcano plot",
  "tags": ["volcano", "differential expression"],
  "visualProfile": "log2FC x-axis, -log10 FDR y-axis, labeled hits",
  "dataProfile": "gene, log2FC, adjusted p value",
  "imagePath": "/project/references/volcano.png",
  "codePaths": ["/project/references/volcano.R"],
  "license": "Internal lab reference"
}
```

Supported visual references are PNG, JPEG, WebP, SVG, and PDF (20 MiB maximum).
Up to 20 R, R Markdown, Quarto, Python, notebook, Julia, MATLAB, Markdown,
TeX, shell, JSON, or YAML files may be imported (5 MiB each, 50 MiB total).
Original absolute paths are never stored in the shareable manifest.

## Figure Transfer Package v1

`figure_library_import` accepts `packagePath` instead of the direct-import
fields. A v1 package is a ZIP containing exactly `manifest.json` and one figure
at the archive root:

```text
figure-transfer-package.zip
├── manifest.json
└── figure.png
```

The interoperable manifest contract is:

```json
{
  "schema": "figure-transfer-package.v1",
  "version": 1,
  "producer": { "name": "CiteBox", "version": "0.31.0" },
  "exportedAt": "2026-08-01T01:02:03Z",
  "source": {
    "sourceId": "paper-42",
    "figureId": "7",
    "parentFigureId": null,
    "figureLabel": "Fig 2",
    "subfigureLabels": ["a", "b"],
    "caption": "Original figure caption",
    "page": 12,
    "paper": {
      "title": "Paper title",
      "authors": ["First Author"],
      "year": 2026,
      "journal": "Journal name",
      "doi": "10.1234/example",
      "url": "https://example.org/paper"
    },
    "license": {
      "scope": "article figure",
      "text": "CC BY 4.0"
    }
  },
  "figure": {
    "file": "figure.png",
    "mediaType": "image/png",
    "bytes": 12345,
    "sha256": "<64 lowercase-or-uppercase hex characters>"
  }
}
```

Unknown or unavailable provenance values must be represented explicitly with
an empty string, empty array, `null`, or `"unknown"` according to the field
type. IDs may be strings or non-negative integers. The importer rejects an
unsupported schema/version, unsafe or extra archive paths, oversized content,
extension/media-type/signature mismatch, byte-count mismatch, and SHA-256
mismatch. It stores the original manifest as read-only metadata and never
executes package content.

A Transfer Package enters the User Library as a `draft` `visual_reference`, so
default search does not present uncurated paper figures. Its stable producer +
source + figure identity makes repeated imports idempotent. If its content
changes, inspect it with `figure_library_diff`, then explicitly apply it with
`figure_library_upsert`.

## Personal Gallery v1

The Gallery remains the editable source of truth; the User Library is a
rebuildable search snapshot. A Gallery root contains entries like:

```text
gallery/lab-volcano/
├── figure.yml
├── preview.png
├── description.md
├── source/
│   └── provenance.yml
└── code/
    ├── example.R
    ├── data_schema.yml
    └── example.csv
```

`figure.yml` uses this schema:

```yaml
schema: figure-library.gallery-entry.v1
gallery_id: lab-volcano
title: Lab volcano plot
tags: [volcano, differential expression]
visual_profile: log2FC x-axis, -log10 FDR y-axis, labeled hits
data_profile: gene, log2FC, adjusted p value
packages: [ggplot2]
license: Internal lab reference
asset_kind: plot_template       # plot_template | visual_reference
language: R
plot_family: volcano
review_status: approved         # draft | approved | archived
code_status: reviewed           # none | scaffold | reviewed
preview: preview.png             # optional default
description_file: description.md # optional default
provenance_file: source/provenance.yml # optional default
source_commit: 0123456789abcdef  # optional; sync can also supply it
content_hash: <optional computed SHA-256>
```

`provenance.yml` may contain `producer`, `producer_version`, `exported_at`,
`source_id`, `figure_id`, `parent_figure_id`, `figure_label`,
`subfigure_labels`, `caption`, `paper_title`, `authors`, `year`, `journal`,
`doi`, `page`, `url`, `license_scope`, and `rights`. The original description
and provenance files are retained in the snapshot. Gallery code/data files may
be R, R Markdown, Quarto, Python, notebook, Julia, MATLAB, shell, Markdown,
TeX, JSON, YAML, CSV, TSV, or text files; none are executed.

The importer computes `content_hash` from normalized searchable metadata,
provenance, and every stored file descriptor (`file`, bytes, SHA-256, and role),
with object keys and set-like tags/packages sorted; `content_hash` itself and
`source_commit` are excluded. If `content_hash` is present in `figure.yml`, it
must match. Stable `gallery_id` maps to one stable template ID and registry
record containing `gallery_id`, `template_id`, `content_hash`, and
`source_commit`.

Preview a complete sync without writing:

```json
{
  "galleryDirectory": "/absolute/path/to/gallery-repository",
  "dryRun": true,
  "sourceCommit": "0123456789abcdef"
}
```

Set `dryRun` to `false` only after reviewing the returned per-field diffs.
Sync imports approved entries, skips drafts, and treats `archived` as a logical
archive rather than a deletion. Missing entries are never deleted implicitly.
Default search includes approved entries only; an explicit `reviewStatus`
filter can be used for review/audit. Search and sync also accept `assetKind`,
`language`, `plotFamily`, and `codeStatus` filters, keeping visual-only
references separate from reusable R templates.

## Distribution

The standalone npm tarball contains the server, App, FigureYa search catalog,
and thumbnails, but not the large archive collection:

```bash
npm run package:npm
npm install --global ./release/scientific-figure-library-0.2.0.tgz
```

Use `scientific-figure-library` as the MCP command after installation.

For Wisp:

```bash
npm run package:wisp
```

Install `release/scientific-figure-library-wisp-0.2.0.zip` from Wisp
**Settings → Plugins**, enable it for a project, and start a fresh session.

## FigureYa Source Pack

The core plugin and the optional Source Pack are deliberately separate. A
Source Pack is an ordinary directory containing the existing per-module ZIPs
from FigureYa-compressed:

```text
FigureYaSourcePack/
├── FigureYa59volcanoV2.zip
└── archives/
    └── FigureYa9heatmap.zip
```

Pass this directory as `sourcePackDir` or set
`FIGUREYA_SOURCE_PACK_DIR`. Resolution order is:

1. Local Source Pack.
2. Bases configured in `FIGUREYA_ARCHIVE_BASE_URLS`.
3. The commit-pinned FigureYa-compressed archive on GitHub.

The complete pinned archive collection is roughly 3 GiB, so it is not embedded
in either plugin package. It can be copied by USB/shared storage or split into
small transport packs:

```bash
npm run package:source-pack -- \
  --source /path/to/FigureYa-compressed \
  --name volcano \
  --modules FigureYa59volcanoV2
```

The helper verifies every selected ZIP and caps one transport pack at 200 MiB.
Extract the resulting
`release/figure-library-source-pack-volcano-0.2.0.zip` before use.

## Materialized layouts

FigureYa template:

```text
<destination>/<template-id>/
├── upstream/
├── TEMPLATE.md
└── template.lock.json
```

User template:

```text
<destination>/<template-id>/
├── reference/
│   ├── preview.*
│   └── code/
├── TEMPLATE.md
└── template.lock.json
```

An existing target is never overwritten. Keep `upstream/` or `reference/`
unchanged and adapt plotting code in a separate file.

## Catalog development

The repository includes a generated FigureYa catalog. To regenerate it from
local checkouts:

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
downloaded templates remain CC BY-NC-SA 4.0. User-imported material keeps the
license supplied at import. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
