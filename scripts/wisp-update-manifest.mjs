import { createHash } from "node:crypto";

export const WISP_UPDATE_MANIFEST = "scientific-figure-library-wisp-update.json";
const repository = "xuzhougeng/ScientificFigureLibrary";

// Release metadata describes the exact verified ZIP, never a moving download URL.
export function buildWispUpdateManifest({ version, nodeEngine, candidate }) {
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)) {
    throw new Error("Wisp stable update feed requires a stable semantic version");
  }
  const name = `scientific-figure-library-wisp-${version}.zip`;
  const digest = createHash("sha256").update(candidate.zip).digest("hex");
  if (candidate.baseName !== name || candidate.sha256 !== digest) {
    throw new Error("Wisp update ZIP name or digest does not match the candidate");
  }
  const manifest = JSON.parse(new TextDecoder().decode(candidate.unpacked[".wisp-plugin/plugin.json"]));
  if (manifest.id !== "figure-library" || manifest.version !== version || manifest.schema !== "wisp.plugin.v1") {
    throw new Error("Wisp update manifest identity/version/schema mismatch");
  }
  if (typeof nodeEngine !== "string" || !nodeEngine.trim()) {
    throw new Error("Wisp update manifest requires the package Node engine");
  }
  const releaseUrl = `https://github.com/${repository}/releases/tag/v${version}`;
  return {
    schema: "figure-library.wisp-update.v1",
    plugin_id: manifest.id,
    version,
    channel: "stable",
    repository,
    release_url: releaseUrl,
    requirements: { plugin_schema: manifest.schema, node: nodeEngine },
    asset: {
      name,
      url: `https://github.com/${repository}/releases/download/v${version}/${name}`,
      sha256: digest,
      size: candidate.zip.byteLength,
    },
  };
}
