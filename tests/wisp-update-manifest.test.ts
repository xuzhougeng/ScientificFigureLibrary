import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { zipSync } from "fflate";
// @ts-expect-error -- release scripts are plain JavaScript without declarations.
import { buildWispUpdateManifest } from "../scripts/wisp-update-manifest.mjs";

function fixture() {
  const unpacked = {
    ".wisp-plugin/plugin.json": new TextEncoder().encode(JSON.stringify({
      id: "figure-library", version: "1.2.3", schema: "wisp.plugin.v1",
    })),
  };
  const zip = zipSync(unpacked);
  return { version: "1.2.3", nodeEngine: ">=22", candidate: {
    baseName: "scientific-figure-library-wisp-1.2.3.zip", unpacked, zip,
    sha256: createHash("sha256").update(zip).digest("hex"),
  } };
}

test("feed pins the verified Wisp ZIP and runtime", () => {
  const input = fixture();
  const manifest = buildWispUpdateManifest(input);
  assert.equal(manifest.plugin_id, "figure-library");
  assert.equal(manifest.asset.url, "https://github.com/xuzhougeng/ScientificFigureLibrary/releases/download/v1.2.3/scientific-figure-library-wisp-1.2.3.zip");
  assert.equal(manifest.asset.sha256, input.candidate.sha256);
  assert.equal(manifest.asset.size, input.candidate.zip.byteLength);
  assert.deepEqual(manifest.requirements, { plugin_schema: "wisp.plugin.v1", node: ">=22" });
});

test("reject mismatched package and unstable release metadata", () => {
  for (const mutate of [
    (x: any) => { x.candidate.baseName = "cursor.zip"; },
    (x: any) => { x.candidate.sha256 = "0".repeat(64); },
    (x: any) => { x.candidate.zip = new Uint8Array([1]); },
    (x: any) => { x.version = "1.2.3-beta.1"; },
    (x: any) => { x.version = "../1.2.3"; },
    (x: any) => { x.nodeEngine = ""; },
    (x: any) => { x.candidate.unpacked[".wisp-plugin/plugin.json"] = new TextEncoder().encode('{"id":"other"}'); },
  ]) {
    const input = fixture();
    mutate(input);
    assert.throws(() => buildWispUpdateManifest(input));
  }
});
