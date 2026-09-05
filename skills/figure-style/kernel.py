"""Sidecar helpers for the figure-style skill.

Modified for SFL: reference-preserving default and optional explicit restyling.
Derived from Wisp Science under Apache-2.0; see LICENSE and NOTICE.md.

Definition-only module: importing it must not touch the network, filesystem
(beyond font probing at call time), or draw anything. Heavy imports live
inside function bodies so the kernel loads instantly.

Public API (names are stable — other skills reference them):
    apply_figure_style, set_frame, panel_letter, focal_palette,
    bar_with_points, strip_with_median, goodness_arrow, two_tier_label,
    end_of_line_labels, panel_crops
"""

META_GREY = "#888888"

# CJK-capable fonts each OS ships with, probed by file path first (so the
# exact file gets registered with matplotlib) and by family name second.
# Without this, Chinese/Japanese/Korean labels fall back to DejaVu Sans and
# render as tofu boxes (□□□).
_CJK_CANDIDATES = {
    "Windows": [
        ("Microsoft YaHei", r"C:\Windows\Fonts\msyh.ttc"),
        ("Microsoft YaHei", r"C:\Windows\Fonts\msyh.ttf"),
        ("SimHei", r"C:\Windows\Fonts\simhei.ttf"),
        ("SimSun", r"C:\Windows\Fonts\simsun.ttc"),
    ],
    "Darwin": [
        ("PingFang SC", "/System/Library/Fonts/PingFang.ttc"),
        ("Hiragino Sans GB", "/System/Library/Fonts/Hiragino Sans GB.ttc"),
        ("STHeiti", "/System/Library/Fonts/STHeiti Medium.ttc"),
    ],
    "Linux": [
        ("Noto Sans CJK SC", "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
        ("Noto Sans CJK SC", "/usr/share/fonts/opentype/noto/NotoSansCJKsc-Regular.otf"),
        ("WenQuanYi Zen Hei", "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc"),
        ("Source Han Sans SC", "/usr/share/fonts/opentype/source-han-sans/SourceHanSansSC-Regular.otf"),
    ],
}


def _find_cjk_font():
    """Return a CJK-capable family name registered with matplotlib, or None.

    Probes the current OS's known font files first (registering the file so
    the family becomes usable), then any CJK family the font manager already
    knows. Uses whatever the machine has — nothing is bundled.
    """
    import os
    import platform
    import matplotlib.font_manager as fm
    for family, path in _CJK_CANDIDATES.get(platform.system(), []):
        if os.path.isfile(path):
            try:
                fm.fontManager.addfont(path)
                return family
            except Exception:
                continue
    known = {f.name for f in fm.fontManager.ttflist}
    for family in ("Microsoft YaHei", "SimHei", "PingFang SC", "Hiragino Sans GB",
                   "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Zen Hei",
                   "Arial Unicode MS"):
        if family in known:
            return family
    return None


def _register_conda_fonts():
    """Fonts installed via conda (e.g. mscorefonts) land in $CONDA_PREFIX/fonts,
    which matplotlib never scans — register them so `font=` requests resolve."""
    import glob
    import os
    import sys
    import matplotlib.font_manager as fm
    fdir = os.path.join(os.environ.get("CONDA_PREFIX") or sys.prefix, "fonts")
    if not os.path.isdir(fdir):
        return
    known = {f.fname for f in fm.fontManager.ttflist}
    for f in glob.glob(os.path.join(fdir, "*.ttf")):
        if f not in known:
            fm.fontManager.addfont(f)


# ---------------------------------------------------------------- style setup

def apply_figure_style(*, frame="open", font=None, sizes=(8, 7, 6), grid=False,
                       preserve_reference=True):
    """Install publication-output rcParams. Call once, before any plotting.

    What this sets is mechanics, not a house look: a three-step font-size
    ladder mapped to text roles, outward ticks, frameless legends, left-flush
    regular-weight titles, 300-dpi tight saves, and Type-42 (editable) fonts
    in vector output. Frame shape, family, and the ladder are parameters.

    frame : 'open' → bottom+left spines only (default); 'boxed' → all four;
            'none' → no spines, no tick marks
    font  : preferred sans-serif family; None keeps the platform default
    sizes : (base, secondary, tick) point sizes — base covers titles, axis
            labels and series identity; secondary covers legends/annotations;
            tick covers tick labels
    grid  : draw axes.grid when True
    preserve_reference : True (default) changes export settings only and leaves
            every visual theme setting intact. False applies the theme below
            and is appropriate only when the user explicitly requests restyling.
    """
    import matplotlib as mpl
    # SFL: preserve the template theme unless the user requests restyling.
    if preserve_reference:
        mpl.rcParams.update({"savefig.dpi": 300, "pdf.fonttype": 42, "ps.fonttype": 42})
        return
    if frame not in ("open", "boxed", "none"):
        raise ValueError(f"frame must be 'open'|'boxed'|'none', got {frame!r}")
    try:
        _register_conda_fonts()
    except Exception:
        pass
    base, secondary, tick = sizes
    boxed = (frame == "boxed")
    spined = (frame != "none")
    rc = {
        "font.family": "sans-serif",
        "font.size": base,
        "axes.titlesize": base, "axes.labelsize": base,
        "legend.fontsize": secondary,
        "xtick.labelsize": tick, "ytick.labelsize": tick,
        "axes.titleweight": "normal", "axes.titlelocation": "left",
        "axes.labelweight": "normal",
        "axes.linewidth": 0.6,
        "axes.spines.top": boxed, "axes.spines.right": boxed,
        "axes.spines.bottom": spined, "axes.spines.left": spined,
        "axes.grid": bool(grid),
        "xtick.direction": "out", "ytick.direction": "out",
        "xtick.major.size": 3, "ytick.major.size": 3,
        "xtick.major.width": 0.6, "ytick.major.width": 0.6,
        "legend.frameon": False,
        "lines.linewidth": 1.2,
        "patch.linewidth": 0.6,
        "figure.dpi": 200,
        "savefig.dpi": 300, "savefig.bbox": "tight",
        "pdf.fonttype": 42, "ps.fonttype": 42,
    }
    # Sans-serif fallback chain: explicit request first, then a CJK family
    # (when the OS has one) so non-Latin labels never render as boxes, then
    # the usual Latin families. Putting CJK ahead of DejaVu matters on older
    # matplotlib versions that lack per-glyph fallback.
    chain = [font] if font else []
    cjk = _find_cjk_font()
    if cjk and cjk not in chain:
        chain.append(cjk)
    chain += ["DejaVu Sans", "Liberation Sans", "Arial"]
    rc["font.sans-serif"] = chain
    rc["axes.unicode_minus"] = False  # a boxed minus sign is still tofu
    mpl.rcParams.update(rc)


def set_frame(ax, style="open"):
    """Re-apply a frame shape to one existing axes. style ∈ {'open','boxed','none'}."""
    visible = {
        "open": {"bottom": True, "left": True, "top": False, "right": False},
        "boxed": dict.fromkeys(("top", "right", "bottom", "left"), True),
        "none": dict.fromkeys(("top", "right", "bottom", "left"), False),
    }[style]
    for side, vis in visible.items():
        ax.spines[side].set_visible(vis)
        if vis:
            ax.spines[side].set_linewidth(0.6)
    ax.tick_params(direction="out", length=0 if style == "none" else 3, width=0.6)


# ------------------------------------------------------------------ palettes

def _desaturate(color, keep=0.3):
    """Pull a colour toward its own grey value, keeping `keep` of the hue."""
    import matplotlib.colors as mcolors
    r, g, b = mcolors.to_rgb(color)
    grey = (r + g + b) / 3
    return mcolors.to_hex(tuple(keep * c + (1 - keep) * grey for c in (r, g, b)))


def focal_palette(labels, focal, focal_color, other="muted", base_colors=None):
    """Colour list where the focal series dominates and the rest recede.

    labels      : ordered category labels
    focal       : one label or an iterable of labels to emphasise
    focal_color : the colour the focal series gets
    other       : how non-focal entries are drawn —
                  'muted'   desaturated versions of base_colors (default)
                  'grey'    one uniform light grey
                  'ordinal' a light→dark grey ramp in input order
    base_colors : cycle to mute for 'muted'; defaults to the active prop cycle
    """
    import matplotlib.colors as mcolors
    import matplotlib.pyplot as plt
    focal_set = {focal} if isinstance(focal, str) else set(focal)
    if not focal_set & set(labels):
        raise ValueError(f"focal {focal!r} not found in labels")
    n = len(labels)
    if base_colors is None:
        base_colors = plt.rcParams["axes.prop_cycle"].by_key().get("color", ["#444444"])
    base_colors = [base_colors[i % len(base_colors)] for i in range(n)]

    if other == "grey":
        rest = ["#BCBCBC"] * n
    elif other == "ordinal":
        n_rest = max(1, n - len(focal_set))
        levels = ([0.55] if n_rest == 1
                  else [0.80 - 0.35 * i / (n_rest - 1) for i in range(n_rest)])
        ramp = [mcolors.to_hex((v, v, v)) for v in levels]
        rest, k = [], 0
        for lab in labels:
            rest.append(ramp[min(k, n_rest - 1)])
            k += lab not in focal_set
    else:  # 'muted'
        rest = [_desaturate(c) for c in base_colors]

    return [focal_color if lab in focal_set else rest[i]
            for i, lab in enumerate(labels)]


# ------------------------------------------------------------- chart builders

def _ci95_halfwidth(values):
    """t-based 95% CI half-width of the mean — valid at small n, where the
    z shortcut 1.96·s/√n is noticeably too narrow."""
    import numpy as np
    from scipy.stats import t
    values = np.asarray(values)
    n = values.size
    if n < 2:
        return 0.0
    return t.ppf(0.975, n - 1) * np.std(values, ddof=1) / np.sqrt(n)


def bar_with_points(ax, x, ymat, labels, colors, jitter=0.08, show_points=True,
                    errorbar=None, point_alpha=0.5, point_size=8):
    """Mean bars with either raw-point overlay or an error interval (not both).

    x        : bar positions
    ymat     : per-category arrays of raw observations
    labels   : tick labels, aligned with x
    colors   : per-category colours (e.g. from focal_palette)
    errorbar : None | 'sd' | 'ci95', drawn only when show_points is False;
               'ci95' uses the t-distribution interval (see _ci95_halfwidth)
    """
    import numpy as np
    means = np.array([np.mean(y) for y in ymat], float)
    err = None
    if errorbar and not show_points:
        err = np.array([
            (np.std(y, ddof=1) if np.asarray(y).size > 1 else 0.0)
            if errorbar == "sd" else _ci95_halfwidth(y)
            for y in ymat
        ])
    ax.bar(x, means, color=colors, width=0.7, edgecolor="none",
           yerr=err, error_kw={"elinewidth": 0.8, "capsize": 0})
    if show_points:
        for xi, ys in zip(x, ymat):
            ys = np.asarray(ys)
            if ys.ndim and ys.size > 1:
                jit = (np.random.rand(ys.size) - 0.5) * 2 * jitter
                ax.scatter(np.full(ys.size, xi) + jit, ys, s=point_size,
                           color="black", alpha=point_alpha, zorder=3, linewidths=0)
    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    return ax


def strip_with_median(ax, groups, values, colors=None, jitter=0.12):
    """Jittered raw observations per group, each with a bold median tick."""
    import numpy as np
    labs = list(groups)
    colors = colors or ["#444444"] * len(labs)
    for i, (ys, c) in enumerate(zip(values, colors)):
        ys = np.asarray(ys)
        jit = (np.random.rand(ys.size) - 0.5) * 2 * jitter
        ax.scatter(np.full(ys.size, i) + jit, ys, s=10, color=c,
                   alpha=0.6, linewidths=0, zorder=2)
        med = np.median(ys)
        ax.plot([i - 0.22, i + 0.22], [med, med], color="black", lw=1.6, zorder=3)
    ax.set_xticks(range(len(labs)))
    ax.set_xticklabels(labs)
    return ax


# ------------------------------------------------------- annotation helpers

def panel_letter(ax, letter, dx=-0.18, dy=1.02, case="lower", fontsize=None):
    """Bold panel letter outside the axes' top-left corner.

    case follows the target venue ('lower' or 'upper'). Size defaults to one
    step above the base of the font ladder — the single sanctioned exception
    to the three-size rule.
    """
    import matplotlib.pyplot as plt
    if fontsize is None:
        fontsize = plt.rcParams.get("font.size", 8) + 1
    s = letter.lower() if case == "lower" else letter.upper()
    ax.text(dx, dy, s, transform=ax.transAxes,
            fontweight="bold", fontsize=fontsize, va="bottom", ha="left")


def goodness_arrow(ax, text="higher = better", loc="upper left", axis="y", fontsize=None):
    """Small upright direction-of-goodness cue placed in the axes margin."""
    import matplotlib.pyplot as plt
    if fontsize is None:
        fontsize = plt.rcParams["legend.fontsize"]  # annotation role
    pos = {"upper left": (0.02, 0.98), "upper right": (0.98, 0.98),
           "lower left": (0.02, 0.02), "lower right": (0.98, 0.02)}[loc]
    ax.text(*pos, ("↑ " if axis == "y" else "→ ") + text,
            transform=ax.transAxes, fontsize=fontsize, color=META_GREY,
            ha="left" if "left" in loc else "right",
            va="top" if "upper" in loc else "bottom")


def two_tier_label(name, meta):
    """Two-line label (name over metadata); the caller styles the meta line."""
    return f"{name}\n{meta}"


def end_of_line_labels(ax, xs, ys, labels, colors=None, dx=0.01, fontsize=None):
    """Direct-label each line series just past its right endpoint (in place of
    a legend box)."""
    import matplotlib.pyplot as plt
    if fontsize is None:
        fontsize = plt.rcParams["font.size"]  # series-identity role
    colors = colors or [None] * len(labels)
    span = ax.get_xlim()[1] - ax.get_xlim()[0]
    for x, y, lab, c in zip(xs, ys, labels, colors):
        ax.text(x[-1] + dx * span, y[-1], lab, color=c,
                va="center", ha="left", fontsize=fontsize)


# ---------------------------------------------------------------- QA helpers

def _saved_frame(fig, renderer, bbox_inches, pad_inches):
    """Origin and size, in inches, of the frame savefig will actually write."""
    import matplotlib as mpl
    if bbox_inches == "tight":
        if pad_inches is None:
            pad_inches = mpl.rcParams.get("savefig.pad_inches", 0.1)
        tb = fig.get_tightbbox(renderer).padded(pad_inches)
        return tb.x0, tb.y0, tb.width, tb.height
    if isinstance(bbox_inches, mpl.transforms.BboxBase):
        return bbox_inches.x0, bbox_inches.y0, bbox_inches.width, bbox_inches.height
    w, h = fig.get_size_inches()
    return 0.0, 0.0, w, h


def _lettered_axes(fig):
    """Map axes → panel letter, detected as the bold single-character Text
    that panel_letter() places. Falls back to index keys when nothing is
    lettered (standalone plots, or composer sub-agents told not to letter),
    so the QA crop loop always has something to iterate."""
    import matplotlib.text
    found = {}
    for ax in fig.axes:
        for t in ax.findobj(matplotlib.text.Text):
            s = (t.get_text() or "").strip()
            if len(s) == 1 and s.isalpha() and t.get_fontweight() in ("bold", 700):
                found[ax] = s
                break
    return found or {ax: str(i) for i, ax in enumerate(fig.axes)}


def panel_crops(fig, dpi=None, pad_px=6, bbox_inches=None, pad_inches=None):
    """Per-panel pixel crop boxes for the figure as saved to PNG.

    Returns ``{letter: (x0, y0, x1, y1)}`` with a top-left pixel origin, i.e.
    directly usable as ``PIL.Image.crop(box)``. Each panel is its axes'
    tight bbox mapped into the saved file's pixel grid and padded by
    ``pad_px``. A composite panel — abutting subplots that share an axis with
    the letter drawn only on the leftmost — is unioned with its letterless
    ``sharex``/``sharey`` siblings on the same grid row or column (and only
    those: ``subplots(sharey=True)`` joins the whole grid transitively, which
    must not merge distinct panels).

    ``bbox_inches`` mirrors ``Figure.savefig``: ``None`` consults rcParams
    (under :func:`apply_figure_style` that resolves to ``'tight'``); pass an
    explicit ``Bbox`` only if you saved with one. Boxes are clamped to the
    saved image regardless.

        >>> fig.savefig("fig.png")
        >>> from PIL import Image
        >>> for letter, box in panel_crops(fig).items():
        ...     Image.open("fig.png").crop(box).save(f"fig-{letter}.png")
    """
    import matplotlib as mpl
    if dpi is None:
        dpi = mpl.rcParams.get("savefig.dpi", fig.dpi)
        if dpi == "figure":
            dpi = fig.dpi
    dpi = float(dpi)
    if bbox_inches is None:
        bbox_inches = mpl.rcParams.get("savefig.bbox")
    fig.canvas.draw()
    r = fig.canvas.get_renderer()
    ox_in, oy_in, w_in, h_in = _saved_frame(fig, r, bbox_inches, pad_inches)
    w_px, h_px = int(round(w_in * dpi)), int(round(h_in * dpi))

    lettered = _lettered_axes(fig)
    out = {}
    for ax, letter in lettered.items():
        boxes = [ax.get_tightbbox(r)]  # display px at fig.dpi
        ss = ax.get_subplotspec()
        for sib in fig.axes:
            if sib is ax or sib in lettered:
                continue
            ssib = sib.get_subplotspec()
            same_row = ss is None or ssib is None or ss.rowspan == ssib.rowspan
            same_col = ss is None or ssib is None or ss.colspan == ssib.colspan
            if ((ax.get_shared_y_axes().joined(ax, sib) and same_row)
                    or (ax.get_shared_x_axes().joined(ax, sib) and same_col)):
                boxes.append(sib.get_tightbbox(r))
        bb = mpl.transforms.Bbox.union(boxes)
        # display px → inches → saved-frame inches → saved px, y flipped to
        # image convention
        x0 = (bb.x0 / fig.dpi - ox_in) * dpi
        x1 = (bb.x1 / fig.dpi - ox_in) * dpi
        y0 = h_px - (bb.y1 / fig.dpi - oy_in) * dpi
        y1 = h_px - (bb.y0 / fig.dpi - oy_in) * dpi
        out[letter] = (
            max(int(x0) - pad_px, 0),
            max(int(y0) - pad_px, 0),
            min(int(x1) + pad_px, w_px),
            min(int(y1) + pad_px, h_px),
        )
    return out


if __name__ == "__main__":
    # Smoke-check the CJK font wiring: the sans-serif chain must be populated
    # (so CJK glyphs have somewhere to resolve) and the minus sign must not
    # be a unicode box. Run: `python kernel.py`.
    import matplotlib
    matplotlib.use("Agg")
    apply_figure_style(preserve_reference=False)
    sans = matplotlib.rcParams["font.sans-serif"]
    assert sans, "font.sans-serif must not be empty"
    assert "DejaVu Sans" in sans, "DejaVu Sans should remain a Latin fallback"
    assert matplotlib.rcParams["axes.unicode_minus"] is False
    print("figure-style self-check OK; font.sans-serif =", sans)
