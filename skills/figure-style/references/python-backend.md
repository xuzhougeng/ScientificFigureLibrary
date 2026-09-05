# Python / matplotlib

Inspect the selected script before executing it. Use the existing project Python environment; do not install dependencies or replace it with the Host's default interpreter.

The local sidecar is `../kernel.py` relative to this reference file's directory (that is, `skills/figure-style/kernel.py`). Resolve it from the installed plugin directory, never from a hard-coded user path. Load it by file path using importlib.util when needed; importing it only defines helpers. Calling functions needs the relevant existing packages (matplotlib, numpy; scipy for t-intervals; Pillow for image crops).

For faithful replication retain the template's rcParams and artist settings. Call apply_figure_style(preserve_reference=True) only to set export mechanics; frame/font/size/grid defaults must not overwrite a specified template. Explicitly set styles only when they are unspecified or the user approved restyling. Dense point-layer rasterization is an option, not permission to rasterize every vector figure.

Use explicit output paths. Save a PNG at 300 dpi when raster preview is needed and PDF/SVG when requested. Type-42 PDF font settings are a mechanism, not proof of editable embedded fonts; inspect the saved result before claiming them.

Call fig.canvas.draw() before inspecting text extents. Treat collision findings in context, including intended overlays. The bundled panel_crops returns crop boxes for saved PNG geometry; saving/cropping uses the approved project's scratch/output location. Inspect the full figure and relevant panel crops with the available image viewer. No Wisp-specific tool name is required. Never run a kernel self-check merely because a Skill was loaded.

Chart-building helpers are optional: do not change the chart or statistical summary just to use them. Preserve the original analysis, replication units and uncertainty method. Fix a random seed for jitter when creating repeatable examples.
