---
name: figure-library
description: Retrieve, visually review, import, select, and materialize scientific figure references from FigureYa or a user's own figures and plotting code.
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
   - For an image, **first call the host's `view_image` tool**. Describe the
     chart family, panels, axes, encodings, labels, and notable visual style
     from what you actually see. Never infer an attached image from its file
     name alone.
   - For a data file, profile it with the existing Python or R runtime. Record
     shape, column names/types, semantic roles, and missingness. Do not pass
     full data values to the MCP server.
   - For text, extract the scientific purpose, expected chart, and constraints.
4. Build the retrieval request with Agent reasoning:
   - Keep `query` to 2–8 discriminative keywords such as
     `volcano differential expression`; do not paste a prose specification.
   - Keep `dataProfile` and `visualProfile` compact and structured. Do not pass
     raw dataset contents.
   - Search both sources unless the user explicitly requests a source filter.
   - Call `figure_library_search`. Its score is only a retrieval-order signal,
     never a recommendation, confidence, or visual-similarity score.
5. **Agent review is mandatory before recommending a template:**
   - Call `figure_library_preview` for candidate 1. In Wisp, pass an absolute
     project-local directory such as
     `/absolute/project/.wisp/figure-library-previews`, then call `view_image`
     on the returned path. Other MCP hosts may display the returned image
     directly.
   - Compare the preview against the user's reference/request: chart family,
     panel structure, geometry, axes, visual encodings, labels, annotations,
     and overall style.
   - Act as the visual scorer. Give 0–2 points for each of: chart family,
     panel/layout, geometry/axes, encodings, and labels/annotations/style.
     A candidate passes only at 8/10 or above, with the chart family correct
     and no incompatible data requirement. This visual score comes from the
     Agent's image inspection; it is unrelated to the retrieval score.
   - Also compare data compatibility with `figure_library_describe`.
   - If candidate 1 is unsuitable, inspect candidates 2 and 3 in the same way.
     Stop after three and explain the gap instead of trusting the keyword rank.
   - The Agent, not the retrieval score, makes and explains the final choice.
     If no preview can be inspected, say that visual verification was not
     completed and do not present the candidate as visually verified.
   - In the final result, report the reviewed template ID, `pass` or `reject`,
     the visual score out of 10, the decisive matches/differences, and the data
     compatibility verdict. For image input, explicitly compare it with the
     original image that was inspected in step 3.
6. Before `figure_library_materialize`, make sure the user selected a template
   or explicitly asked the Agent to choose and the review above is complete.
   Pass an absolute project directory as `destination` when the MCP process is
   not launched from the project root.
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
