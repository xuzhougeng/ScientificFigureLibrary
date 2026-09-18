# GitHub Release notes

Stable GitHub Releases (`vX.Y.Z`) must match the [v0.8.0](https://github.com/xuzhougeng/ScientificFigureLibrary/releases/tag/v0.8.0) page: bilingual notes, download-selection tables, the full changelog since the previous tag, and a complete asset set (local clients, host plugins, npm tarball, SHA-256 sidecars, Wisp update feed).

`v0.8.0.md` is the published snapshot of that page. Later versions do **not** copy its download tables. Write only front matter plus the bilingual changelog; GitHub Actions fills tables, sizes, links, tool count, and the tagged commit SHA from the files it just built.

## Before tagging

1. `npm run version:set -- <x.y.z>`
2. Copy [TEMPLATE.md](TEMPLATE.md) to `v<x.y.z>.md`
3. Set `previous_tag` to the previous stable tag
4. Write `summary_en` / `summary_zh` for the **whole** tag range, not only local clients
5. Fill `## Changes since <previous_tag>` and `## 相对 <previous_tag> 的变化`
6. Commit those files on `main`, then push the tag. The release workflow waits for `SFL / CI required` on that commit:

```bash
git tag v<x.y.z>
git push origin v<x.y.z>
```

Pushing that tag runs [.github/workflows/release.yml](../workflows/release.yml). Re-running the workflow for an existing tag replaces assets and notes; it does not require deleting the tag.

Do not put “Choose a download”, “Getting started”, “Upgrade”, or “Release provenance” in the source file. Missing notes, a tag/version mismatch, or a missing Wisp feed fail the release job before publish.
