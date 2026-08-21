import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";
import { PNG } from "pngjs";
// Production release entrypoints intentionally remain plain JavaScript modules.
// @ts-expect-error -- scripts/*.mjs have no emitted declarations.
const releaseLibrary = await import("../scripts/package-release-lib.mjs");
// @ts-expect-error -- scripts/*.mjs have no emitted declarations.
const releasePreflight = await import("../scripts/release-preflight.mjs");
const {
  BOOTSTRAP_COMMUNITY_COMMIT,
  REQUIRED_COMMUNITY_RELEASES,
  STANDARD_TOOL_NAMES,
  assertExactInventory,
  assertFinalCommunitySnapshot,
  auditPackageContents,
  readNpmTarball,
} = releaseLibrary;

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createCommunityFixture(options: {
  bootstrap?: boolean;
  omitSeed?: boolean;
  publisherVerified?: boolean;
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl release gate fixture-"));
  const community = path.join(root, "assets", "community");
  await fs.mkdir(path.join(community, "LICENSES"), { recursive: true });
  await fs.writeFile(path.join(community, "LICENSES", "MIT.txt"), "MIT fixture\n", "utf8");
  await fs.writeFile(path.join(community, "LICENSES", "CC-BY-4.0.txt"), "CC BY 4.0 fixture\n", "utf8");
  const catalog = {
    schema: "figure-library.public-provider-catalog.v1",
    provider: {
      providerId: "io.github.jarxunlai.scientific-figure-community",
      displayName: "Scientific Figure Library Community",
      catalogRepository: "jarxunlai/ScientificFigureLibrary-community",
      archiveRepository: "jarxunlai/ScientificFigureLibrary-community-archives",
    },
    generatedAt: "2026-08-21T00:00:00.000Z",
    entries: [] as Record<string, unknown>[],
  };
  const previewManifest = {
    schema: "figure-library.public-preview-manifest.v1",
    providerId: "io.github.jarxunlai.scientific-figure-community",
    entries: [] as Record<string, unknown>[],
  };
  const identities = options.omitSeed
    ? REQUIRED_COMMUNITY_RELEASES.slice(0, -1)
    : REQUIRED_COMMUNITY_RELEASES;
  for (const [index, identity] of identities.entries()) {
    const [templateId, releaseVersion] = identity.split("@");
    const image = new PNG({ width: 1, height: 1 });
    const rgba = Buffer.from([20 + index, 40 + index, 60 + index, 255]);
    image.data.set(rgba);
    const png = PNG.sync.write(image);
    const preview = {
      path: `thumbs/${templateId}/${releaseVersion}.png`,
      bytes: png.byteLength,
      sha256: sha256(png),
      mediaType: "image/png",
      width: 1,
      height: 1,
      canonicalRgbaSha256: sha256(rgba),
    };
    const entry = {
      schema: "figure-library.public-template-entry.v1",
      providerId: catalog.provider.providerId,
      templateId,
      releaseVersion,
      contentDigest: String(index + 1).repeat(64),
      title: `Fixture ${templateId}`,
      description: "Deterministic clean-room release-gate fixture.",
      search: {
        application: "Generic synthetic rendering",
        dataProfile: "Synthetic table",
        plotFamily: "fixture",
        language: "R",
        tags: ["fixture"],
        packages: ["graphics"],
        codeFiles: ["code/render.R"],
        inputFiles: ["data/input.csv"],
      },
      archive: {
        repository: catalog.provider.archiveRepository,
        commit: String.fromCharCode(98 + index).repeat(40),
        path: `archives/${templateId}/${releaseVersion}/${templateId}-${releaseVersion}.zip`,
        bytes: 123 + index,
        sha256: String.fromCharCode(99 + index).repeat(64),
      },
      preview,
      status: {
        upstreamStatus: "published",
        publisherVerified: options.publisherVerified ?? false,
        curationStatus: "curated",
        renderValidation: "ci_rendered",
        localReviewStatus: "not_reviewed",
        plotExecutionByRecipient: "not_run",
      },
      licenses: { code: "MIT", content: "CC-BY-4.0", documentation: "CC-BY-4.0" },
    };
    catalog.entries.push(entry);
    previewManifest.entries.push({ templateId, releaseVersion, ...preview });
    const previewFile = path.join(community, ...preview.path.split("/"));
    await fs.mkdir(path.dirname(previewFile), { recursive: true });
    await fs.writeFile(previewFile, png);
  }
  catalog.entries.sort((left, right) =>
    `${left.templateId}@${left.releaseVersion}`.localeCompare(
      `${right.templateId}@${right.releaseVersion}`,
      "en",
    ),
  );
  previewManifest.entries.sort((left, right) =>
    `${left.templateId}@${left.releaseVersion}`.localeCompare(
      `${right.templateId}@${right.releaseVersion}`,
      "en",
    ),
  );
  const catalogBytes = Buffer.from(`${JSON.stringify(catalog, null, 2)}\n`, "utf8");
  const previewManifestBytes = Buffer.from(`${JSON.stringify(previewManifest, null, 2)}\n`, "utf8");
  await fs.writeFile(path.join(community, "catalog.json"), catalogBytes);
  await fs.writeFile(path.join(community, "preview-manifest.json"), previewManifestBytes);
  await writeJson(path.join(community, "source.lock.json"), {
    schema: "figure-library.community-source-lock.v1",
    providerId: catalog.provider.providerId,
    catalogRepository: catalog.provider.catalogRepository,
    catalogCommit: options.bootstrap ? BOOTSTRAP_COMMUNITY_COMMIT : "a".repeat(40),
    archiveRepository: catalog.provider.archiveRepository,
    catalog: { path: "catalog.json", bytes: catalogBytes.byteLength, sha256: sha256(catalogBytes) },
    previewManifest: {
      path: "preview-manifest.json",
      bytes: previewManifestBytes.byteLength,
      sha256: sha256(previewManifestBytes),
    },
  });
  return { root, community };
}

test("release Community preflight accepts the three exact curated 1.0.0 seeds", async (t) => {
  const fixture = await createCommunityFixture();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const result = await assertFinalCommunitySnapshot({ repositoryRoot: fixture.root });
  assert.equal(result.releaseCount, 3);
  assert.deepEqual(result.requiredReleases, REQUIRED_COMMUNITY_RELEASES);
});

test("release Community preflight does not conflate clean-room curation with publisher verification", async (t) => {
  const fixture = await createCommunityFixture({ publisherVerified: true });
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await assert.rejects(
    assertFinalCommunitySnapshot({ repositoryRoot: fixture.root }),
    /falsely claims publisher verification for a frozen clean-room seed/u,
  );
});

test("release Community preflight rejects the bootstrap commit and a missing seed", async (t) => {
  const bootstrap = await createCommunityFixture({ bootstrap: true });
  const missing = await createCommunityFixture({ omitSeed: true });
  t.after(() => Promise.all([
    fs.rm(bootstrap.root, { recursive: true, force: true }),
    fs.rm(missing.root, { recursive: true, force: true }),
  ]));
  await assert.rejects(
    releasePreflight.main({ repositoryRoot: bootstrap.root, quiet: true }),
    /empty bootstrap commit be1080c/u,
  );
  await assert.rejects(
    assertFinalCommunitySnapshot({ repositoryRoot: missing.root }),
    /fewer than the three required seed releases|omitted required seed/u,
  );
  await assert.rejects(fs.stat(path.join(bootstrap.root, "release")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(missing.root, "release")), { code: "ENOENT" });
});

test("release Community preflight verifies source lock, previews, archive identity, and exact inventory", async (t) => {
  const previewFixture = await createCommunityFixture();
  const archiveFixture = await createCommunityFixture();
  const inventoryFixture = await createCommunityFixture();
  t.after(() => Promise.all([previewFixture, archiveFixture, inventoryFixture].map((fixture) =>
    fs.rm(fixture.root, { recursive: true, force: true }))));

  const catalog = JSON.parse(await fs.readFile(path.join(archiveFixture.community, "catalog.json"), "utf8"));
  catalog.entries[0].archive.repository = "example.invalid/wrong-archives";
  await fs.writeFile(
    path.join(archiveFixture.community, "catalog.json"),
    `${JSON.stringify(catalog, null, 2)}\n`,
  );
  await assert.rejects(
    assertFinalCommunitySnapshot({ repositoryRoot: archiveFixture.root }),
    /byte length differs|SHA-256 differs|repository/u,
  );

  const manifest = JSON.parse(await fs.readFile(path.join(previewFixture.community, "preview-manifest.json"), "utf8"));
  manifest.entries[0].sha256 = "f".repeat(64);
  await fs.writeFile(
    path.join(previewFixture.community, "preview-manifest.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  await assert.rejects(
    assertFinalCommunitySnapshot({ repositoryRoot: previewFixture.root }),
    /byte length differs|SHA-256 differs|preview manifest/u,
  );

  await fs.writeFile(path.join(inventoryFixture.community, "unexpected-private-state.json"), "{}\n");
  await assert.rejects(
    assertFinalCommunitySnapshot({ repositoryRoot: inventoryFixture.root }),
    /unexpected inventory/u,
  );
});

test("unified content audit rejects local state, machine paths, private keys, and credentials without URL false positives", () => {
  const repositoryRoot = path.resolve(os.tmpdir(), "synthetic sfl release checkout");
  assert.doesNotThrow(() =>
    auditPackageContents(
      new Map([
        ["dist/index.js", Buffer.from('const url = "https://example.org/C:/portable"; const relative = "dist/index.js";')],
        ["docs/guide.md", Buffer.from("Use %APPDATA%/ScientificFigureLibrary/locator.json; the runtime writes receipt.json.")],
      ]),
      { repositoryRoot, label: "fixture" },
    ));
  assert.throws(
    () => auditPackageContents(new Map([["locator.json", Buffer.from("{}")]]), { repositoryRoot }),
    /forbidden local\/private state path/u,
  );
  assert.throws(
    () => auditPackageContents(new Map([["docs/leak.txt", Buffer.from(`${repositoryRoot}/dist/index.js`)]]), { repositoryRoot }),
    /development-machine absolute path/u,
  );
  assert.throws(
    () => auditPackageContents(new Map([["docs/key.txt", Buffer.from("-----BEGIN PRIVATE KEY-----")]]), { repositoryRoot }),
    /private-key material/u,
  );
  assert.throws(
    () => auditPackageContents(new Map([["docs/token.txt", Buffer.from(`token ghp_${"a".repeat(36)}`)]]), { repositoryRoot }),
    /credential-like token/u,
  );
});

function tarOctal(value: number, width: number) {
  return `${value.toString(8).padStart(width - 1, "0")}\0`;
}

function tarEntry(relative: string, bytes: Uint8Array, type = "0") {
  const header = Buffer.alloc(512);
  header.write(`package/${relative}`, 0, 100, "utf8");
  header.write(tarOctal(0o644, 8), 100, 8, "ascii");
  header.write(tarOctal(0, 8), 108, 8, "ascii");
  header.write(tarOctal(0, 8), 116, 8, "ascii");
  header.write(tarOctal(bytes.byteLength, 12), 124, 12, "ascii");
  header.write(tarOctal(0, 12), 136, 12, "ascii");
  header.fill(0x20, 148, 156);
  header.write(type, 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (bytes.byteLength % 512)) % 512);
  return Buffer.concat([header, bytes, padding]);
}

test("npm tar parser accepts only exact regular package inventory", () => {
  const expected = new Map([
    ["dist/index.js", Buffer.from("console.log('ok')\n")],
    ["package.json", Buffer.from('{"name":"fixture"}\n')],
  ]);
  const tar = Buffer.concat([
    ...[...expected].map(([relative, bytes]) => tarEntry(relative, bytes)),
    Buffer.alloc(1024),
  ]);
  const actual = readNpmTarball(gzipSync(tar));
  assert.deepEqual(assertExactInventory(actual, expected, "fixture npm"), [...expected.keys()].sort());

  const symlinkTar = Buffer.concat([
    tarEntry("dist/index.js", Buffer.alloc(0), "2"),
    Buffer.alloc(1024),
  ]);
  assert.throws(() => readNpmTarball(gzipSync(symlinkTar)), /non-regular entry type/u);
});

test("release smoke inventory remains exactly 51 tools", () => {
  assert.equal(STANDARD_TOOL_NAMES.length, 51);
  assert.equal(new Set(STANDARD_TOOL_NAMES).size, 51);
});

test("every public package entrypoint is gated by the final Community snapshot", async () => {
  const repositoryRoot = path.resolve(import.meta.dirname, "..");
  const packageJson = JSON.parse(
    await fs.readFile(path.join(repositoryRoot, "package.json"), "utf8"),
  ) as { scripts: Record<string, string> };
  for (const host of ["wisp", "codex", "claude"]) {
    assert.match(
      packageJson.scripts[`package:${host}`] ?? "",
      /^node scripts\/release-preflight\.mjs && npm run build && node scripts\/package-[a-z]+\.mjs$/u,
      `${host} npm packaging must fail before build when the Community release gate is not ready`,
    );
    const entrypoint = await fs.readFile(
      path.join(repositoryRoot, "scripts", `package-${host}.mjs`),
      "utf8",
    );
    assert.match(entrypoint, /await assertPluginReleaseReady\(\);/u);
    assert.ok(
      entrypoint.indexOf("await assertPluginReleaseReady();") <
        entrypoint.indexOf("writeVerifiedZip("),
      `${host} direct entrypoint must recheck the release gate before producing a ZIP`,
    );
  }
});
