# Scientific Figure Library quickstart

SFL is a **local-first** stdio MCP server plus an MCP App. You bind one Library
directory on disk, publish reviewed figure+code Releases there, then search and
materialize those exact templates into projects. It never executes plotting
code.

Optional extra catalogs may be enabled later. They do not replace the local
Library.

## Requirements

- Node.js 22 or newer
- An MCP host: Wisp Science, Claude Science, Codex, Claude Code, Cursor, or any stdio client

## From source

```bash
git clone https://github.com/xuzhougeng/ScientificFigureLibrary.git
cd ScientificFigureLibrary
npm ci
npm run check
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

`FIGURE_LIBRARY_DIR` overrides the user locator (admin only).

## Wisp Science

```bash
npm run package:wisp
```

Install the generated ZIP from `release/` in **Settings → Plugins**, enable it
for the project, and start a new session.

## Cursor

```bash
npm run package:cursor
```

Unzip the generated Cursor ZIP from `release/` so this file exists:

`~/.cursor/plugins/local/figure-library/.cursor-plugin/plugin.json`

The same folder must also contain plugin-root `mcp.json`, `dist/index.js`, and
`skills/`. Restart Cursor. Cursor's official marketplace is Git-based; this ZIP
is the local plugin path.

## First session

1. Call `figure_library_open` or `figure_library_source_status`. A new install
   returns `setup_required` until both roots exist.
2. If setup is required, ask for two absolute directories: the global Library
   (绘图仓库) and the Local workspace (本地工作区). Do not use the current
   project folder unless the user names it. Plan/Apply
   `figure_library_plan_bind_global` and `figure_library_plan_bind_workspace`
   after the user confirms each path.
3. Import a figure/code pair if the local library is empty, review it, and
   publish a Release.
4. After both binds succeed, call `figure_library_open` or
   `figure_library_search` against Local Published.
5. Wait for the user to confirm one exact card.
6. Materialize only after a preview receipt: `figure_library_plan_materialize`
   then `figure_library_apply_materialize`.

Full contract: [PROTOCOL.md](PROTOCOL.md).
