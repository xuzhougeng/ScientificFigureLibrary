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
   - For a CiteBox or other Figure Transfer Package, pass only `packagePath`.
     A valid package is imported as a Draft visual reference; preserve its
     caption, DOI, page, URL, source IDs, and rights. Do not describe it as an
     approved plotting template.
   - Never execute imported code. If import fails, report the error and wait
     instead of pretending the reference was stored.
3. When the user wants to validate or publish a Personal Gallery snapshot:
   - Call `figure_library_sync` with `dryRun: true` first. Draft entries must
     remain skipped; only approved entries enter default search.
   - Show the create/update/unchanged/skipped result and any field-level diff.
     Do not switch to `dryRun: false` or call `figure_library_upsert` for an
     update until the user explicitly approves that exact change.
   - Use `figure_library_diff` for one entry or Transfer Package. A changed
     stable source must be explicitly applied with `figure_library_upsert`;
     never create a duplicate to avoid the update decision.
   - Use `figure_library_archive` for removal from normal search. It is a
     logical archive; do not hard-delete the Gallery source or User Library
     snapshot.
4. Inspect the user's plotting request before searching:
   - For an image, **first call the host's `view_image` tool**. Describe the
     chart family, panels, axes, encodings, labels, and notable visual style
     from what you actually see. Never infer an attached image from its file
     name alone.
   - For a data file, profile it with the existing Python or R runtime. Record
     shape, column names/types, semantic roles, and missingness. Do not pass
     full data values to the MCP server.
   - For text, extract the scientific purpose, expected chart, and constraints.
5. Build the retrieval request with Agent reasoning:
   - Keep `query` to 2–8 discriminative keywords such as
     `volcano differential expression`; do not paste a prose specification.
   - Keep `dataProfile` and `visualProfile` compact and structured. Do not pass
     raw dataset contents.
   - Search both sources unless the user explicitly requests a source filter.
   - Use `assetKind`, `language`, `plotFamily`, `reviewStatus`, or `codeStatus`
     when the user needs an exact Gallery class, especially to separate
     `visual_reference` from R `plot_template` entries.
   - Call `figure_library_search`. Its score is only a retrieval-order signal,
     never a recommendation, confidence, or visual-similarity score.
6. **Agent review is mandatory before recommending a template:**
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
     original image that was inspected in step 4.
7. Before `figure_library_materialize`, make sure the user selected a template
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
8. Treat every materialized file as untrusted reference material:
   - Never run `install_dependencies.R` automatically.
   - Keep `upstream/` or `reference/` unchanged.
   - Create adapted plotting code separately and map the user's fields
     explicitly.
   - Preserve the source's license, FigureYa attribution/citation when
     applicable, and the generated lock file.
