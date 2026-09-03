# Worktree Spec: Scientific Figure Library UI Branding and Icons

> This worktree is an isolated parallel design line. It must not overwrite the
> `codex/personal-module-provider` working tree or any authoritative figure
> assets outside this repository.

## Branch and baseline

| Item | Value |
| --- | --- |
| Branch | `codex/sfl-ui-branding-icons` |
| Initial base | `main@4bcf5b376b191aba5b7b2403b847eec421b8dade` |
| Integration base | `codex/personal-module-provider@de731dbb853c072d8bf84cfd3e53a84b0749fb98` (fast-forwarded before UI edits) |
| Worktree | `E:\project\Development\ScientificFigureLibrary\.worktree\ui-branding-icons` |
| Product version | Keep `0.6.1` during this feature line; set the test-release patch on `main` |
| Parallel line | `codex/personal-module-provider` remains clean and its commit is retained |

## Goal

Add the user-supplied Scientific Figure Library brand artwork, align supported
plugin and package metadata with the GitHub Pages website and the developers
`xuzhougeng and jarxunlai`, expose the same brand identity in the MCP server
initialization response, add Skill UI metadata for future Skill reuse, and add
accessible inline SVG icons to the existing MCP App controls.

## Hard boundaries

- Do not modify `tools/list[].icons`, upgrade the MCP SDK, add tools, or change
  tool schemas, visibility, lifecycle, or security behavior.
- Do not use a temporary or existing logo as the final replacement. Wait for
  the user's final Logo asset before implementing brand-dependent files.
- Do not modify Wisp Science, `/mnt/e/plot`, the global Published Library, user
  Skills, or the parallel Personal Module worktree.
- Do not push, create a PR, install a plugin, or publish a release.
- Keep the primary brand color `#246C4E` unless the user explicitly changes it.

## Planned implementation

1. Add a distributable canonical Logo under `assets/brand/` and a synchronized
   Skill-side copy under `skills/<skill>/assets/` without symlinks.
2. Add Codex interface metadata (`websiteURL`, `composerIcon`, `logo`,
   `logoDark`, `developerName`) and update supported package/Host author and
   homepage fields while preserving each Host's schema.
3. Add `skills/figure-library/agents/openai.yaml`; future Skills must use the
   same brand asset convention and brand color.
4. Add standard MCP `serverInfo.websiteUrl`, `description`, and `icons` using a
   local, bounded `data:` URI; leave `tools/list` unchanged.
5. Add a small dependency-free SVG icon renderer for the existing App actions.
   Primary actions retain visible labels; icon-only controls retain `title` and
   `aria-label`.
6. Extend explicit package inventories and tests so assets are inside every
   applicable Host archive and no private state enters a package.

## Asset decision

The asset gate was cleared with the full-vector Logo set under
`E:\project\scientific\ppt2image\deliverables\svg\sfl-logo-assets-full-vector`.
The five supplied files contain native SVG paths and gradients without scripts,
embedded raster images, external fonts, or network dependencies. The
app-oriented `sfl-app-mark.svg` variant is the canonical packaged UI icon; the complete set
is retained under `assets/brand/` for traceable host and layout variants. The
four Desktop SVG wrappers were used only for visual comparison because they
embed PNG payloads and are substantially larger; they are not copied into the
repository or packages.

## Acceptance gates

- Manifest metadata and Skill icon paths are valid, portable, and consistent.
- MCP `initialize.serverInfo` contains the approved website and brand icon;
  tool inventory and tool definitions remain unchanged.
- MCP App icons render without network access, preserve keyboard/focus and
  reduced-motion behavior, and do not alter selection/preview/handoff flow.
- `npm run version:check`, build, tests, smoke, package inventory audits, and
  foreign-cwd Host checks pass using Windows-native Node 24 after the asset gate
  is cleared.

## Suggested commit separation

1. `feat(branding): add shared plugin and skill identity metadata`
2. `feat(app): add accessible icons to the MCP workbench`
3. `feat(mcp): expose branded server identity metadata`
