# Third-party notices

Scientific Figure Library code is MIT licensed.

The generated FigureYa search catalog, thumbnails, downloaded templates, and
other material derived from
[ying-ge/FigureYa](https://github.com/ying-ge/FigureYa) remain licensed under
Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International.
`assets/FIGUREYA_LICENSE.txt` contains the upstream license text.

When using a FigureYa template, preserve its authorship and cite:

> Lu, X. et al. (2025). FigureYa: A Standardized Visualization Framework for
> Enhancing Biomedical Data Interpretation and Research Efficiency. iMetaMed,
> 1, e70005. https://doi.org/10.1002/imm3.70005

The vendored Scientific Figure Library Community Catalog, generated
previews/thumbnails, and notices come from
[jarxunlai/ScientificFigureLibrary-community](https://github.com/jarxunlai/ScientificFigureLibrary-community)
at the exact commit recorded in `assets/community/source.lock.json`. Community
template code is MIT licensed. Synthetic data, generated previews/thumbnails,
and template documentation are Creative Commons Attribution 4.0 International
(CC BY 4.0). Per-release attribution and license identities are recorded in the
Catalog and immutable archive. `assets/community/LICENSES/` contains the
notices vendored from that reviewed Community commit; the complete CC BY 4.0
legal code is available from the URL named in its notice.

Community template archives are not included in the SFL package. When a user
materializes one, SFL downloads only the exact archive repository, commit,
path, byte length, and SHA-256 pinned by the public selector. Materialization
does not execute the archive's code or install dependencies.

User-imported figures and code are not relicensed by this project. Their
manifests retain the license text supplied at import. Users are responsible for
having the right to store and reuse that material.

The bundled JavaScript includes MIT-licensed Model Context Protocol SDK,
MCP Apps SDK, Zod, fflate, ISC-licensed YAML, and Apache-2.0-licensed Fuse.js
code. Their source packages and exact versions are recorded in
`package-lock.json`.

## Bundled figure workflow Skills

The figure-style Skill and its Python sidecar derive from Wisp Science figure-style (Apache-2.0). Its license text, attribution and adaptation notice ship at skills/figure-style/LICENSE and NOTICE.md. No Python/R runtime or plotting packages are bundled.

figure-organization adapts the user-provided Code Organization Skill under explicit permission to copy, adapt and distribute with SFL. No upstream open-source license was supplied; this component is not silently relicensed MIT. See skills/figure-organization/NOTICE.md.

The Markdown UI bundles markdown-it (MIT) and DOMPurify (available under Apache-2.0 OR MPL-2.0; this distribution uses Apache-2.0). Their license texts and those of the added parser dependencies (argparse, entities, linkify-it, mdurl, punycode.js and uc.micro) ship in assets/licenses/. Exact versions are in package-lock.json. Raw documentation HTML and remote images are disabled.
