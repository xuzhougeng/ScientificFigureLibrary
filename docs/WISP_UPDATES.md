# Wisp on-demand plugin updates (release-side contract)

Scientific Figure Library is an optional, separately installed plugin. Wisp does
not bundle SFL, its catalogs, or a copy for automatic initial deployment. This
keeps the host lightweight. Initial installation follows QUICKSTART.

After installation, the plugin entry should expose a link to SFL's update page:
https://github.com/xuzhougeng/ScientificFigureLibrary/releases

The intended flow is: open the installed plugin's update entry, choose Update,
and let Wisp download, verify and install the available **Wisp plugin** package.
The user does not manually download another ZIP or enter a checksum. Opening
the release-page link alone is informational and does not authorize installation.
Startup polling or bundled deployment is not required for this flow.

The feed below is a prerequisite for that future Wisp integration. It provides
a machine-readable counterpart to the release page. It does not add the update
entry or installer UI, and the MCP server does not install or update itself.

## Publish the feed

`npm run package:wisp` and `npm run package:plugins` generate
`release/scientific-figure-library-wisp-update.json` alongside the Wisp ZIP and
SHA-256 sidecar. The feed is committed in the same rollback-protected local
transaction, after the archive checks and packaged MCP smoke test pass.
The all-host packager rechecks the feed against the staged archive.

Upload all three files to the matching stable GitHub Release `v<version>` before
publishing that release. The scripts do not upload assets. The Wisp feed currently
requires a stable version; prerelease packaging through these entrypoints fails.

Discovery URL (read when the installed plugin's update flow is invoked):
https://github.com/xuzhougeng/ScientificFigureLibrary/releases/latest/download/scientific-figure-library-wisp-update.json

Schema `figure-library.wisp-update.v1` contains `plugin_id`, `version`, `channel`,
`repository`, `release_url`, `requirements.plugin_schema`, `requirements.node`,
and `asset` (`name`, version-pinned `url`, `sha256`, byte `size`). Node requirements
come from package.json; Node is not bundled. No untested minimum Wisp version is
claimed. SHA-256 detects corruption, not an independent publisher signature.

## Wisp implementation still needed

1. Provide an update-page link and an Update action for the separately installed
   SFL plugin, using the Browser Bridge update interaction as a UI precedent.
2. Read the trusted feed on demand and compare with the installed version. Show
   the available version and release information. Missing feeds, network failures,
   invalid metadata, or no newer version leave the current installation usable.
3. On Update, automatically download the Wisp-specific package. Validate feed
   schema, repository, plugin ID, runtime requirements and the version-pinned
   asset origin/path. Enforce HTTPS including redirects and bounded downloads.
   Check size, digest and extracted plugin identity/version before using Wisp's
   staged installer. Do not downgrade a newer installed plugin.
4. Serialize installs and defer replacement while the plugin is in use. Preserve
   bindings, user data and project enabled state. Keep the previous package until
   a fresh MCP initialize/tools-list and `figure_library_source_status` succeed;
   restore it on failure. `setup_required` is a setup prompt, not an installation
   failure; an update must not choose or overwrite Library/workspace roots.

Wisp Browser Bridge compares a connected extension with Wisp's bundled copy.
SFL reuses its update interaction, while obtaining packages from SFL Releases
only when requested. Browser reload commands cannot restart this stdio MCP server.
