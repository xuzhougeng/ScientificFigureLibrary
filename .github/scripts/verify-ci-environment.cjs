"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

// Only metadata checks: do not rewrite snapshots or relax the product's gates.
function verifyEnvironment({ root, tempDirectory, filesystem = fs }) {
  const canonicalTemp = filesystem.realpathSync(tempDirectory);
  assert.equal(tempDirectory, canonicalTemp, "CI temp root must already be canonical, not an 8.3 alias or symlink");
  const directory = path.join(root, "assets", "community");
  const lock = JSON.parse(filesystem.readFileSync(path.join(directory, "source.lock.json"), "utf8"));
  const sizes = {};
  for (const [key, name] of [["catalog", "catalog.json"], ["previewManifest", "preview-manifest.json"]]) {
    const observed = filesystem.statSync(path.join(directory, name)).size;
    assert.equal(observed, lock[key].bytes, `${name}: checkout changed committed snapshot byte length`);
    sizes[name] = observed;
  }
  return { canonicalTemp: true, snapshotBytes: sizes };
}

if (require.main === module) {
  const result = verifyEnvironment({ root: path.resolve(__dirname, "../.."), tempDirectory: os.tmpdir() });
  console.log(JSON.stringify(result));
}

module.exports = { verifyEnvironment };
