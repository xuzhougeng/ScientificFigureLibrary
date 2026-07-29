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
  library.
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

## Distribution

The standalone npm tarball contains the server, App, FigureYa search catalog,
and thumbnails, but not the large archive collection:

```bash
npm run package:npm
npm install --global ./release/scientific-figure-library-0.1.1.tgz
```

Use `scientific-figure-library` as the MCP command after installation.

For Wisp:

```bash
npm run package:wisp
```

Install `release/scientific-figure-library-wisp-0.1.1.zip` from Wisp
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
`release/figure-library-source-pack-volcano-0.1.1.zip` before use.

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
