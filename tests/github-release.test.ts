import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

// @ts-expect-error -- release scripts are plain JavaScript without declarations.
const githubRelease = await import("../scripts/github-release.mjs");
const {
  WISP_UPDATE_MANIFEST: feedName,
  expectedReleaseAssets,
  formatAssetSize,
  parseReleaseNotesSource,
  verifyReleaseDirectory,
  buildGitHubReleaseBody,
  prepareGitHubRelease,
  checkReleaseTag,
  pluginFileName,
} = githubRelease;

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const tagSha = "f7d9f8749598906675acb1bae8af8e9b28146f18";

function sha256(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function notesSource(overrides: Record<string, string> = {}) {
  return `---
previous_tag: v0.8.0
previous_mcp_tools: 56
summary_en: This release rebuilds every installer and plugin from the tagged commit.
summary_zh: 本版本按该标签重新打包全部安装包和宿主插件。
---

## Changes since v0.8.0

- Rebuild local clients, host plugins, the npm tarball, and the Wisp update feed.
- Keep gallery cache under the bound Library.

## 相对 v0.8.0 的变化

- 重新打包本地客户端、宿主插件、npm 包和 Wisp 更新 feed。
- 图库缓存仍放在已绑定 Library 下。
${overrides.extra ?? ""}`;
}

async function writeInventory(directory: string, version: string, options: { omitFeed?: boolean; corruptSidecar?: string } = {}) {
  const names = expectedReleaseAssets(version);
  const sizes = new Map<string, number>();
  let index = 0;
  for (const name of names) {
    if (name.endsWith(".sha256") || name === feedName) continue;
    const bytes = Buffer.from(`sfl-release-fixture:${name}:${index++}\n`);
    await fs.writeFile(path.join(directory, name), bytes);
    await fs.writeFile(path.join(directory, `${name}.sha256`), `${sha256(bytes)}  ${name}\n`);
    sizes.set(name, bytes.byteLength);
  }
  const zipName = pluginFileName("wisp", version);
  const zip = await fs.readFile(path.join(directory, zipName));
  if (!options.omitFeed) {
    const feed = {
      schema: "figure-library.wisp-update.v1",
      plugin_id: "figure-library",
      version,
      channel: "stable",
      repository: "xuzhougeng/ScientificFigureLibrary",
      release_url: `https://github.com/xuzhougeng/ScientificFigureLibrary/releases/tag/v${version}`,
      requirements: { plugin_schema: "wisp.plugin.v1", node: ">=22" },
      asset: {
        name: zipName,
        url: `https://github.com/xuzhougeng/ScientificFigureLibrary/releases/download/v${version}/${zipName}`,
        sha256: sha256(zip),
        size: zip.byteLength,
      },
    };
    await fs.writeFile(path.join(directory, feedName), `${JSON.stringify(feed)}\n`);
  }
  if (options.corruptSidecar) {
    await fs.writeFile(path.join(directory, `${options.corruptSidecar}.sha256`), "0".repeat(64) + `  ${options.corruptSidecar}\n`);
  }
  return sizes;
}

test("stable GitHub Release inventory is the v0.8.0 asset set", () => {
  const names = expectedReleaseAssets("0.8.0");
  assert.equal(names.length, 31);
  assert.equal(names.filter((name: string) => name.endsWith(".sha256")).length, 15);
  assert.ok(names.includes("ScientificFigureLibrary-0.8.0-macos-arm64.dmg"));
  assert.ok(names.includes("ScientificFigureLibrary-0.8.0-macos-arm64-no-node.dmg"));
  assert.ok(names.includes("ScientificFigureLibrary-0.8.0-windows-x64-no-node.zip"));
  assert.ok(names.includes("ScientificFigureLibrary-0.8.0-linux-arm64.zip"));
  assert.ok(names.includes("scientific-figure-library-wisp-0.8.0.zip"));
  assert.ok(names.includes("scientific-figure-library-0.8.0.tgz"));
  assert.ok(names.includes(feedName));
});

test("published v0.8.0 notes mention every uploaded installer, plugin, tarball and Wisp feed", async () => {
  const notes = await fs.readFile(path.join(repositoryRoot, ".github", "release-notes", "v0.8.0.md"), "utf8");
  for (const name of expectedReleaseAssets("0.8.0")) {
    if (name.endsWith(".sha256")) continue;
    assert.ok(notes.includes(name), `v0.8.0 notes omit ${name}`);
  }
  assert.ok(notes.includes("## Choose a download"));
  assert.ok(notes.includes("## 选择下载"));
  assert.ok(notes.includes("## Changes since v0.7.0"));
  assert.ok(notes.includes("## 相对 v0.7.0 的变化"));
});

test("release notes source requires bilingual changelog and rejects generated sections", () => {
  const parsed = parseReleaseNotesSource(notesSource(), "0.9.0");
  assert.equal(parsed.previousTag, "v0.8.0");
  assert.equal(parsed.previousMcpTools, 56);
  assert.match(parsed.summaryEn, /every installer/);
  assert.throws(() => parseReleaseNotesSource("no front matter\n", "0.9.0"), /front matter/);
  assert.throws(
    () => parseReleaseNotesSource(notesSource({ extra: "\n## Choose a download\n\n" }), "0.9.0"),
    /Choose a download/,
  );
  assert.throws(
    () =>
      parseReleaseNotesSource(
        notesSource().replace("## Changes since v0.8.0", "## Changes since 0.8.0"),
        "0.9.0",
      ),
    /must start with/,
  );
});

test("verifyReleaseDirectory requires the Wisp feed and matching SHA-256 sidecars", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-github-release-"));
  try {
    await writeInventory(directory, "0.9.0");
    const inventory = await verifyReleaseDirectory(directory, "0.9.0");
    assert.equal(inventory.files.length, 31);

    await fs.rm(path.join(directory, feedName));
    await assert.rejects(() => verifyReleaseDirectory(directory, "0.9.0"), /missing=scientific-figure-library-wisp-update.json/);
    await writeInventory(directory, "0.9.0", {
      corruptSidecar: "scientific-figure-library-0.9.0.tgz",
    });
    await assert.rejects(() => verifyReleaseDirectory(directory, "0.9.0"), /does not match/);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("generated GitHub notes keep the v0.8.0 bilingual download tables and provenance", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-github-notes-"));
  const assets = path.join(directory, "assets");
  const notesFile = path.join(directory, "notes.md");
  const outDir = path.join(directory, "meta");
  try {
    await fs.mkdir(assets);
    await writeInventory(assets, "0.9.0");
    await fs.writeFile(notesFile, notesSource(), "utf8");
    const prepared = await prepareGitHubRelease({
      directory: assets,
      version: "0.9.0",
      tagSha,
      notesFile,
      repository: "xuzhougeng/ScientificFigureLibrary",
      outDir,
    });
    const body = prepared.body as string;
    assert.match(body, /# Scientific Figure Library v0.9.0/);
    assert.match(body, /compare\/v0\.8\.0\.\.\.v0\.9\.0/);
    assert.match(body, /\*\*56 tools\*\* \(56 in v0\.8\.0\)/);
    assert.match(body, /\[`macos-arm64\.dmg`\]\(https:\/\/github.com\/xuzhougeng\/ScientificFigureLibrary\/releases\/download\/v0\.9\.0\/ScientificFigureLibrary-0\.9\.0-macos-arm64\.dmg\)/);
    assert.match(body, /scientific-figure-library-wisp-update\.json/);
    assert.ok(body.includes(`Tag \`v0.9.0\` points to \`${tagSha}\``));
    assert.match(body, /## 选择下载/);
    assert.match(body, /## 相对 v0\.8\.0 的变化/);
    assert.match(body, /重新打包本地客户端/);
    assert.equal(formatAssetSize(44 * 1024 * 1024), "44 MB");
    const create = JSON.parse(await fs.readFile(path.join(outDir, "github-release-create.json"), "utf8"));
    const update = JSON.parse(await fs.readFile(path.join(outDir, "github-release-update.json"), "utf8"));
    assert.equal(create.draft, true);
    assert.equal(create.make_latest, "true");
    assert.equal(create.target_commitish, tagSha);
    assert.equal(update.draft, false);
    assert.equal(create.body, body);
    assert.ok(!create.body.includes("\uFFFD"));
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
});

test("checkReleaseTag compares the tag with package.json without requiring git", async () => {
  await assert.rejects(() => checkReleaseTag({ tag: "v0.8.0-beta.1", gitCheck: false }), /stable vX\.Y\.Z/);
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-github-tag-"));
  try {
    await fs.mkdir(path.join(fixture, ".github", "release-notes"), { recursive: true });
    await fs.writeFile(path.join(fixture, "package.json"), `${JSON.stringify({ version: "0.9.0" })}\n`);
    await fs.writeFile(path.join(fixture, ".github", "release-notes", "v0.9.0.md"), notesSource());
    const result = await checkReleaseTag({ tag: "v0.9.0", repositoryRoot: fixture, gitCheck: false });
    assert.deepEqual(result, { tag: "v0.9.0", version: "0.9.0", sha: "", previous_tag: "v0.8.0" });
    await fs.writeFile(path.join(fixture, "package.json"), `${JSON.stringify({ version: "0.8.0" })}\n`);
    await assert.rejects(
      () => checkReleaseTag({ tag: "v0.9.0", repositoryRoot: fixture, gitCheck: false }),
      /package.json version 0.8.0/,
    );
  } finally {
    await fs.rm(fixture, { recursive: true, force: true });
  }
});

test("buildGitHubReleaseBody rejects a truncated SHA", () => {
  const notes = parseReleaseNotesSource(notesSource(), "0.9.0");
  const sizes = Object.fromEntries(expectedReleaseAssets("0.9.0").map((name: string) => [name, name === feedName ? 120 : 2_000_000]));
  assert.throws(
    () =>
      buildGitHubReleaseBody({
        version: "0.9.0",
        tagSha: "abc",
        repository: "xuzhougeng/ScientificFigureLibrary",
        notes,
        sizes,
      }),
    /40-character/,
  );
});
