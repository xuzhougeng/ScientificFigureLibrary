# GitHub Pages design QA

final result: passed

Scope: adapt the visual style of `../wisp-science/docs/` to the existing Scientific Figure Library landing page. Preserve SFL branding, imagery, product facts, and the static GitHub Pages deployment.

## Visual evidence

- Source: `/tmp/sfl-wisp-reference.png`, 1440 × 1100 pixels.
- Implementation: `/tmp/sfl-en-desktop.png`, full page at a 1440 × 1100 CSS viewport; `/tmp/sfl-after-hero.png`, Chinese hero.
- Combined comparison: `/tmp/sfl-design-comparison.png`, source on the left and implementation on the right. Each region is 1440 × 1100 at 1× density, with the implementation cropped from its full-page capture. Both show the light theme and closed FAQ state at the page top. Source copy is Chinese; implementation copy is English. Compare visual language and hierarchy, not text widths or product-specific artwork.
- Mobile: `/tmp/sfl-en-mobile.png`, full page at 390 × 844 CSS pixels; `/tmp/sfl-zh-mobile-install.png`, Chinese installation section at the same viewport.
- Full-page review: `/tmp/sfl-desktop-overview.png`. Focused review: desktop hero and mobile installation captures above, where typography, navigation spacing, and controls are readable.

## Findings

No actionable P0/P1/P2 issues remain. The warm white background, serif headings, centered hero, black pill buttons, fine borders, rounded panels, teal accents, and amber section numbers follow the reference. SFL's own logo and gallery image are retained without stretching or cropping. Content below the hero is adapted to the figure-library workflow.

The first reload used cached CSS and JavaScript. A cache-bypassing reload resolved this preview issue before review. An initial full-page capture taken after scrolling showed displaced fixed elements; the comparison uses the clean page-top capture instead. No visual code changes were needed after the final comparison.

## Validation

- Browser: Chinese/English switching, translated title and accessible labels, FAQ expansion, installation anchor navigation, and matching local image/anchor targets.
- Browser: 1440px desktop and 390px mobile layouts; no document-level horizontal overflow. Long source commands scroll within the code panel.
- Browser console checked: no warnings or errors at the recorded check.
- Temporary JSDOM checks: language query precedence, persisted language, blocked storage, anchor preservation, copy success/failure with a simulated clipboard, status reset, unique IDs, local asset paths, and useful static HTML without JavaScript.
- `npm run build`, `node --check docs/assets/pages.js`, and `git diff --check` passed.

Limitations: the browser tool stalled during an additional reference screenshot after the main captures and interaction checks. Clipboard behavior was verified with a simulated API, not a native system clipboard. External destination links were preserved from the repository and were not network-audited. Tablet widths and additional browser engines were not separately tested. Existing Google Fonts requests retain system font fallbacks.

## Figure Gallery extension

final result: passed

Source inventory: `jarxunlai/ScientificFigureLibrary-personal` at `196c99a24bb0e2eaf61f8511417a655b96dd6e3b`, verified through the GitHub tree and 46 module manifests. The application already registers this provider as Open Figure Modules; this change adds its public website presentation, not a duplicate provider.

The gallery follows the landing page's existing typography, colors, cards, and responsive navigation. Actual module previews were reviewed in `/tmp/sfl-gallery-contact-sheet.jpg`. Browser evidence: `/tmp/sfl-gallery-desktop.png` (1440 × 1000), `/tmp/sfl-gallery-mobile.png` (390 × 844), `/tmp/sfl-gallery-mobile-detail.png` (390 × 844), and `/tmp/sfl-home-gallery.png` (1440 × 1000). No artwork is stretched or cropped. Detailed module descriptions retain the source language.

Browser checks passed for combined category/search filtering, counts, empty results and reset, Chinese/English switching, URL state, modal opening, Escape close and focus restoration. Gallery layouts were checked at 1440, 768, and 390 CSS pixels; homepage navigation and featured images were also checked at 320px. No document-level horizontal overflow was observed. Console check found no warnings or errors.

An initial attempt to load full previews from raw.githubusercontent.com was slow. Detail panels now show the verified local thumbnail immediately and provide an explicit link to the full-size original. Source image and code URLs are pinned to the catalog commit. All 46 local thumbnails passed SHA-256 validation. The thumbnail snapshot is approximately 2.7 MB and card images use lazy loading.

Four new regression tests passed: source/asset integrity, bilingual search and filtering, deep-link selection and close state, and catalog failure/retry. The homepage interaction regression checks and production build passed. Gallery changes have not been deployed in this turn.
