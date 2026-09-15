# R / ggplot2 / base graphics

Use the project's established R runtime and approval policy. Do not invoke Python or install missing packages as a workaround. Read the selected code and create a separate adapted script with visible settings and Chinese navigation comments.

Preserve the reference palette, typography, theme, scales, layout and legend unless the user requests a change. When unspecified, set an available readable font and an explicit size hierarchy. Do not assume Arial or CJK fonts exist; report a fallback rather than claiming a font was embedded.

For ggplot use explicit filenames and plot=p in ggsave, with dpi=300 and bg="white" as appropriate. Prefer ragg::agg_png and grDevices::cairo_pdf when available and compatible with the reference. Do not auto-install ragg or silently change the backend. For base graphics open the requested device and always close it even on errors. Devices/output names must match project conventions.

Validate the actual output exists and is nonempty, then inspect the image for missing text, clipping, blank panels, mismatched legends and overlapping labels. R uses actual output inspection, not matplotlib's bounding-box API. No runtime or viewer means the render/visual check remains unverified; static source review does not become a passed render.

Keep statistical choices separate from styles: do not recompute phylogenies, enrichment, differential expression or confidence intervals just to reproduce a visual. State when only the plotting layer was run.
