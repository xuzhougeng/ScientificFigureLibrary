import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
// Production maintainer scripts are intentionally plain JavaScript modules.
// @ts-expect-error -- scripts/*.mjs have no emitted declarations.
const personalModules = await import("../scripts/personal-modules-lib.mjs");
const {
  archivePersonalModules,
  buildPersonalModuleCatalog,
  packagePersonalSourcePack,
  resolveGitCommit,
  validatePersonalModules,
} = personalModules;
import { ModuleCatalogIndex } from "../src/module-catalog.ts";
import { PERSONAL_MODULE_PROVIDER_ID } from "../src/providers.ts";

const execFile = promisify(execFileCallback);
const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function git(cwd: string, args: string[]) {
  await execFile("git", args, { cwd, windowsHide: true });
}

async function fixtureRepository() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-personal-scripts-"));
  const module = path.join(root, "modules", "ggsankeyfier-layout-color-combo");
  await fs.mkdir(path.join(module, "code"), { recursive: true });
  await fs.mkdir(path.join(module, "data"), { recursive: true });
  await fs.writeFile(path.join(module, "README.md"), "# Public module\n");
  await fs.writeFile(path.join(module, "description.md"), "A clean synthetic Sankey example.\n");
  await fs.writeFile(path.join(module, "code", "organized.R"), "plot(1:3)\n");
  await fs.writeFile(path.join(module, "data", "input.csv"), "x,y\n1,2\n");
  await fs.writeFile(path.join(module, "preview.png"), ONE_PIXEL_PNG);
  await fs.writeFile(path.join(module, "thumbnail.png"), ONE_PIXEL_PNG);
  const manifest = {
    schema: "figure-library.personal-module.v1",
    moduleId: "ggsankeyfier-layout-color-combo",
    title: "ggsankeyfier 桑基图",
    titleEn: "ggsankeyfier Sankey",
    description: "A clean synthetic Sankey example.",
    application: "Sankey plot layout and color.",
    dataProfile: "Synthetic CSV flow table.",
    plotFamily: "sankey",
    language: "R",
    tags: ["ggsankeyfier", "sankey"],
    packages: ["ggplot2", "ggsankeyfier"],
    codeFiles: ["code/organized.R"],
    inputFiles: ["data/input.csv"],
    canonicalCode: "code/organized.R",
    requiredFiles: ["README.md", "code/organized.R", "data/input.csv", "description.md", "module.yml", "preview.png"],
    files: ["README.md", "code/organized.R", "data/input.csv", "description.md", "module.yml", "preview.png", "thumbnail.png"],
    preview: { path: "preview.png", bytes: ONE_PIXEL_PNG.byteLength, sha256: "", mediaType: "image/png" },
    thumbnail: { path: "thumbnail.png", bytes: ONE_PIXEL_PNG.byteLength, sha256: "", mediaType: "image/png" },
    licenses: { code: "MIT", content: "CC BY 4.0", documentation: "CC BY 4.0" },
    publisher: { reviewStatus: "approved", executionStatus: "passed", executionScope: "synthetic_data" },
  };
  const { createHash } = await import("node:crypto");
  manifest.preview.sha256 = createHash("sha256").update(ONE_PIXEL_PNG).digest("hex");
  manifest.thumbnail.sha256 = manifest.preview.sha256;
  await fs.writeFile(path.join(module, "module.yml"), `${JSON.stringify(manifest, null, 2)}\n`);
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "fixture@example.invalid"]);
  await git(root, ["config", "user.name", "SFL fixture"]);
  await git(root, ["add", "modules"]);
  await git(root, ["commit", "-qm", "source module"]);
  const sourceCommit = await resolveGitCommit(root);
  return { root, module, sourceCommit };
}

test("maintainer scripts validate, archive, pin commits, build the bundled snapshot, and package a Source Pack", async (t) => {
  const fixture = await fixtureRepository();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  const validation = await validatePersonalModules({ repositoryRoot: fixture.root });
  assert.equal(validation.modules.length, 1);
  assert.deepEqual(validation.modules[0].exclude, []);

  const archived = await archivePersonalModules({
    repositoryRoot: fixture.root,
    sourceCommit: fixture.sourceCommit,
    write: true,
  });
  assert.equal(archived.entries.length, 1);
  assert.equal(archived.entries[0].sourceCommit, fixture.sourceCommit);
  await git(fixture.root, ["add", "archives", "catalog/archive-manifest.json"]);
  await git(fixture.root, ["commit", "-qm", "archive module"]);
  const archiveCommit = await resolveGitCommit(fixture.root);

  const snapshot = path.join(fixture.root, "sfl-snapshot");
  const built = await buildPersonalModuleCatalog({
    repositoryRoot: fixture.root,
    outputRoot: snapshot,
    sourceCommit: fixture.sourceCommit,
    archiveCommit,
    write: true,
  });
  assert.equal(built.catalog.modules.length, 1);
  assert.equal(built.catalog.modules[0].source.commit, fixture.sourceCommit);
  assert.equal(built.catalog.modules[0].archive.commit, archiveCommit);
  assert.equal(built.comparison.equal, true);

  const index = await ModuleCatalogIndex.load(snapshot, {
    expectedProviderId: PERSONAL_MODULE_PROVIDER_ID,
    validatePreviews: true,
  });
  const result = (await index.searchAll({ query: "ggsankeyfier sankey" }))[0];
  assert.equal(result?.providerId, PERSONAL_MODULE_PROVIDER_ID);
  assert.equal(result?.searchPreviewAvailable, true);

  const sourcePack = path.join(fixture.root, "source-pack");
  const packed = await packagePersonalSourcePack({
    repositoryRoot: fixture.root,
    catalogRoot: snapshot,
    outputRoot: sourcePack,
    write: true,
  });
  assert.equal(packed.entries.length, 1);
  assert.equal(packed.comparison.equal, true);
  assert.ok((await fs.stat(path.join(sourcePack, "archives", "ggsankeyfier-layout-color-combo.zip"))).isFile());

  const checked = await archivePersonalModules({
    repositoryRoot: fixture.root,
    sourceCommit: fixture.sourceCommit,
    write: false,
  });
  assert.equal(checked.checkPassed, true);
});

test("maintainer check detects a changed generated snapshot without writing it", async (t) => {
  const fixture = await fixtureRepository();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await archivePersonalModules({ repositoryRoot: fixture.root, sourceCommit: fixture.sourceCommit, write: true });
  await git(fixture.root, ["add", "archives", "catalog/archive-manifest.json"]);
  await git(fixture.root, ["commit", "-qm", "archive module"]);
  const archiveCommit = await resolveGitCommit(fixture.root);
  const snapshot = path.join(fixture.root, "snapshot");
  await buildPersonalModuleCatalog({ repositoryRoot: fixture.root, outputRoot: snapshot, archiveCommit, write: true });
  await fs.writeFile(path.join(snapshot, "module-catalog.json"), "tampered\n");
  const checked = await buildPersonalModuleCatalog({ repositoryRoot: fixture.root, outputRoot: snapshot, archiveCommit, write: false });
  assert.equal(checked.comparison.equal, false);
  assert.ok(checked.comparison.changed.includes("module-catalog.json"));
  assert.equal(await fs.readFile(path.join(snapshot, "module-catalog.json"), "utf8"), "tampered\n");
});

test("catalog generation rejects an archive commit that changed the pinned source tree", async (t) => {
  const fixture = await fixtureRepository();
  t.after(() => fs.rm(fixture.root, { recursive: true, force: true }));
  await archivePersonalModules({
    repositoryRoot: fixture.root,
    sourceCommit: fixture.sourceCommit,
    write: true,
  });
  await git(fixture.root, ["add", "archives", "catalog/archive-manifest.json"]);
  await git(fixture.root, ["commit", "-qm", "archive module"]);

  const codeFile = path.join(fixture.module, "code", "organized.R");
  await fs.writeFile(codeFile, "plot(4:6)\n");
  await git(fixture.root, ["add", "modules"]);
  await git(fixture.root, ["commit", "-qm", "mutate module after archive"]);
  const badArchiveCommit = await resolveGitCommit(fixture.root);

  // Keep the maintainer working tree equal to the reviewed source commit so
  // verifySourceCommit passes. The rejection must come from comparing the
  // module tree objects at sourceCommit and archiveCommit.
  await fs.writeFile(codeFile, "plot(1:3)\n");
  await assert.rejects(
    buildPersonalModuleCatalog({
      repositoryRoot: fixture.root,
      outputRoot: path.join(fixture.root, "rejected-snapshot"),
      sourceCommit: fixture.sourceCommit,
      archiveCommit: badArchiveCommit,
      write: false,
    }),
    /source tree bytes changed between source and archive commits/u,
  );
});
