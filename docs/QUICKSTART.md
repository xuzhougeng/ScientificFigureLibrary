# Scientific Figure Library quickstart

SFL is a **local-first** stdio MCP server plus an MCP App. You bind one Library
directory on disk, publish reviewed figure+code Releases there, then search and
materialize those exact templates into projects. It never executes plotting
code.

Optional extra catalogs may be enabled later. They do not replace the local
Library.

## Requirements

- Node.js 22 or newer
- An MCP host: Wisp Science, Claude Science, Codex, Claude Code, or any stdio client

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

## First session

1. Call `figure_library_source_status`. If writes are off, bind a global
   Library with `figure_library_plan_bind_global` then
   `figure_library_apply_bind_global` after the user confirms the absolute path.
2. Import a figure/code pair if the local library is empty, review it, and
   publish a Release.
3. Call `figure_library_open`, or `figure_library_search` against Local
   Published.
4. Wait for the user to confirm one exact card.
5. Materialize only after a preview receipt: `figure_library_plan_materialize`
   then `figure_library_apply_materialize`.

Full contract: [PROTOCOL.md](PROTOCOL.md).
