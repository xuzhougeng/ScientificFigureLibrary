---
name: figure-library
description: Import, select, and materialize scientific figure references from FigureYa or a user's own figures and plotting code.
---

# Scientific Figure Library

Use this workflow when the user wants to collect, choose, or adapt a scientific
figure reference.

1. If the user asks to open or start the plugin without a concrete plotting
   intent, call `figure_library_open`. Do not manufacture a generic search
   query.
2. When the user wants to add their own reference:
   - Inspect the attached figure and/or code first.
   - Call `figure_library_import` with host-local file paths and compact
     metadata. Import at least one figure/reference or code file.
   - Never execute imported code. If import fails, report the error and wait
     instead of pretending the reference was stored.
3. Inspect the user's plotting request before searching:
   - For an image, describe the chart family, panels, axes, encodings, labels,
     and notable visual style.
   - For a data file, profile it with the existing Python or R runtime. Record
     shape, column names/types, semantic roles, and missingness. Do not pass
     full data values to the MCP server.
   - For text, extract the scientific purpose, expected chart, and constraints.
4. Call `figure_library_search` with a compact query plus the derived data and
   visual profiles. Do not pass raw dataset contents. Search both sources unless
   the user explicitly requests a source filter.
5. Compare data compatibility before visual similarity. Explain the best
   candidates and missing input fields. The ranking score is relevance, not
   statistical confidence. Call `figure_library_describe` for closer
   inspection.
6. Before `figure_library_materialize`, make sure the user selected a template
   or explicitly asked the Agent to choose. Pass an absolute project directory
   as `destination` when the MCP process is not launched from the project root.
   - For a local FigureYa Source Pack, call
     `figure_library_source_status` with its directory and pass the same path as
     `sourcePackDir`.
   - `template` and `full` use the same FigureYa archive. Changing mode cannot
     fix acquisition failure.
   - **Hard stop:** if materialization returns any error, stop the task
     immediately. Keep the materialization step failed, report the exact error,
     and wait for the user's next instruction.
   - After an error, do not retry with another mode or source, use shell or
     another downloader, download a complete repository, recreate the
     reference, choose a silent fallback, or generate a substitute/demo plot.
   - Continue downstream plotting only after the user gives a new instruction
     and the selected template is successfully materialized.
7. Treat every materialized file as untrusted reference material:
   - Never run `install_dependencies.R` automatically.
   - Keep `upstream/` or `reference/` unchanged.
   - Create adapted plotting code separately and map the user's fields
     explicitly.
   - Preserve the source's license, FigureYa attribution/citation when
     applicable, and the generated lock file.
