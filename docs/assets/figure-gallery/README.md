# Open Figure Modules website gallery

Source: https://github.com/jarxunlai/ScientificFigureLibrary-personal

Maintainers and attribution: [jarxunlai](https://github.com/jarxunlai) and [xuzhougeng](https://github.com/xuzhougeng).

The 46 unmodified JPEG thumbnails and module metadata in this snapshot come from source commit `196c99a24bb0e2eaf61f8511417a655b96dd6e3b`. Each entry in `catalog.json` records its module source link, original preview link, content/code/documentation licenses, and SHA-256 thumbnail digest. Contents and documentation are licensed CC BY 4.0 (https://creativecommons.org/licenses/by/4.0/); module code is MIT. Source modules describe their own data provenance and external references. These previews demonstrate plotting methods and do not establish scientific conclusions.

The gallery uses local thumbnails for cards and detail previews. Full-size source images and code are linked at the recorded commit. No plotting code, source datasets, or ZIP archives are copied or executed by the website.

To refresh from the public repository, with project dependencies installed and GitHub CLI available:

```sh
node scripts/sync-figure-gallery.mjs main
# Or reproduce an exact source snapshot:
node scripts/sync-figure-gallery.mjs 196c99a24bb0e2eaf61f8511417a655b96dd6e3b
```

The script reads module YAML and thumbnails via the GitHub API, verifies thumbnail lengths and SHA-256 hashes, and writes the website snapshot only after all downloads validate. Review the resulting diff and update this snapshot note before publishing. It does not modify the application's existing Open Figure Modules provider or bypass its signed-feed update path.
