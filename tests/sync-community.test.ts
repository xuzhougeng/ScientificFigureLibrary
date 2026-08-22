import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { PNG } from "pngjs";
import { parsePublicProviderCatalog } from "../src/public-catalog-provider.ts";
// The production sync entrypoint intentionally remains a plain JavaScript CLI module.
// @ts-expect-error -- no declaration file is emitted for scripts/*.mjs.
import { syncCommunitySnapshot } from "../scripts/sync-community.mjs";

const execFile = promisify(execFileCallback);
const CENTRAL_ORIGIN = "https://github.com/jarxunlai/ScientificFigureLibrary-community.git";
const PROVIDER_ID = "io.github.jarxunlai.scientific-figure-community";

type ExecFileRunner = (
  executable: string,
  args: readonly string[],
  options: Record<string, unknown>,
) => Promise<{ stdout: string | Buffer; stderr?: string | Buffer }>;

type FixtureOptions = {
  entry?: boolean;
  badPreviewDigest?: boolean;
  badPreviewInventory?: boolean;
  malformedSearch?: boolean;
  malformedProvenance?: boolean;
  missingMitLicense?: boolean;
  contentLicense?: string;
  releaseVersion?: string;
};

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

async function git(repository: string, ...args: string[]) {
  const { stdout } = await execFile("git", ["-C", repository, ...args], {
    encoding: "utf8",
    windowsHide: true,
    timeout: 30_000,
  });
  return stdout.trim();
}

async function writeJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function createCommunityFixture(root: string, options: FixtureOptions = {}) {
  const repository = path.join(root, "community checkout");
  await fs.mkdir(repository, { recursive: true });
  await git(repository, "init");
  await git(repository, "config", "user.name", "SFL Test");
  await git(repository, "config", "user.email", "sfl-test@example.invalid");
  await git(repository, "remote", "add", "origin", CENTRAL_ORIGIN);
  await fs.writeFile(
    path.join(repository, ".gitignore"),
    "LICENSES/ignored-extra.txt\nthumbs/ignored-preview.png\n",
    "utf8",
  );

  const catalog = {
    schema: "figure-library.public-provider-catalog.v1",
    provider: {
      providerId: PROVIDER_ID,
      displayName: "Scientific Figure Library Community",
      catalogRepository: "jarxunlai/ScientificFigureLibrary-community",
      archiveRepository: "jarxunlai/ScientificFigureLibrary-community-archives",
    },
    generatedAt: "2026-08-21T00:00:00.000Z",
    entries: [] as Record<string, unknown>[],
  };
  const previewManifest = {
    schema: "figure-library.public-preview-manifest.v1",
    providerId: PROVIDER_ID,
    entries: [] as Record<string, unknown>[],
  };

  if (options.entry) {
    const templateId = "fixture-template";
    const releaseVersion = options.releaseVersion ?? "1.0.0";
    const image = new PNG({ width: 1, height: 1 });
    image.data.set([20, 40, 60, 255]);
    const png = PNG.sync.write(image);
    const preview = {
      path: `thumbs/${templateId}/${releaseVersion}.png`,
      bytes: png.byteLength,
      sha256: options.badPreviewDigest ? "f".repeat(64) : sha256(png),
      mediaType: "image/png",
      width: 1,
      height: 1,
      canonicalRgbaSha256: sha256(Buffer.from([20, 40, 60, 255])),
    };
    const entry = {
      schema: "figure-library.public-template-entry.v1",
      providerId: PROVIDER_ID,
      templateId,
      releaseVersion,
      contentDigest: "a".repeat(64),
      title: "Fixture template",
      description: "A deterministic synthetic test fixture.",
      search: {
        application: "Generic test rendering",
        dataProfile: "Synthetic scalar table",
        plotFamily: "fixture",
        language: "R",
        tags: ["fixture"],
        packages: ["graphics"],
        codeFiles: ["code/render.R"],
        inputFiles: ["data/input.csv"],
        ...(options.malformedSearch ? { unsupportedSearchField: true } : {}),
      },
      archive: {
        repository: "jarxunlai/ScientificFigureLibrary-community-archives",
        commit: "b".repeat(40),
        path: `archives/${templateId}/${releaseVersion}/${templateId}-${releaseVersion}.zip`,
        bytes: 123,
        sha256: "c".repeat(64),
      },
      preview,
      status: {
        upstreamStatus: "published",
        publisherVerified: true,
        curationStatus: "curated",
        renderValidation: "ci_rendered",
        localReviewStatus: "not_reviewed",
        plotExecutionByRecipient: "not_run",
      },
      licenses: {
        code: "MIT",
        content: options.contentLicense ?? "CC-BY-4.0",
        documentation: "CC-BY-4.0",
      },
      ...(options.malformedProvenance ? { provenance: ["not-an-object"] } : {}),
    };
    catalog.entries.push(entry);
    previewManifest.entries.push({ templateId, releaseVersion, ...preview });
    if (options.badPreviewInventory) previewManifest.entries = [];
    await writeJson(
      path.join(repository, "catalog", "entries", templateId, `${releaseVersion}.json`),
      entry,
    );
    const previewFile = path.join(repository, ...preview.path.split("/"));
    await fs.mkdir(path.dirname(previewFile), { recursive: true });
    await fs.writeFile(previewFile, png);
  }

  await writeJson(path.join(repository, "catalog", "catalog.json"), catalog);
  await writeJson(path.join(repository, "catalog", "preview-manifest.json"), previewManifest);
  await fs.mkdir(path.join(repository, "catalog", "entries"), { recursive: true });
  await fs.writeFile(path.join(repository, "catalog", "entries", ".gitkeep"), "", "utf8");
  await fs.mkdir(path.join(repository, "thumbs"), { recursive: true });
  await fs.writeFile(path.join(repository, "thumbs", ".gitkeep"), "", "utf8");
  await fs.mkdir(path.join(repository, "LICENSES"), { recursive: true });
  await fs.writeFile(path.join(repository, "LICENSES", "CC-BY-4.0.txt"), "CC BY 4.0 fixture\n", "utf8");
  if (!options.missingMitLicense) {
    await fs.writeFile(path.join(repository, "LICENSES", "MIT.txt"), "MIT fixture\n", "utf8");
  }
  await git(repository, "add", "--all");
  await git(repository, "commit", "-m", "test: add Community fixture");
  return { repository, commit: await git(repository, "rev-parse", "HEAD") };
}

function freshCentralMainRunner(
  expectedCommit: string,
  source: string,
  calls: string[][] = [],
): ExecFileRunner {
  return async (executable, args, options) => {
    calls.push([...args]);
    const fetchIndex = args.indexOf("fetch");
    if (fetchIndex !== -1) {
      assert.equal(executable, "git");
      assert.deepEqual(args.slice(fetchIndex, fetchIndex + 7), [
        "fetch",
        "--no-tags",
        "--force",
        "--depth=1",
        CENTRAL_ORIGIN,
        "refs/heads/main:refs/sfl-community-sync/fresh-main",
      ]);
      return { stdout: options.encoding === null ? Buffer.alloc(0) : "" };
    }
    if (args.includes("refs/sfl-community-sync/fresh-main^{commit}")) {
      return { stdout: `${expectedCommit}\n` };
    }
    const repositoryIndex = args.indexOf("-C");
    const repository = repositoryIndex === -1 ? undefined : args[repositoryIndex + 1];
    if (
      repository !== source &&
      (args.includes("ls-tree") || args.includes("show")) &&
      args.some((argument) => argument === expectedCommit || argument.startsWith(`${expectedCommit}:`))
    ) {
      const rewritten = [...args];
      rewritten[repositoryIndex + 1] = source;
      return execFile(executable, rewritten, options as never) as never;
    }
    return execFile(executable, args as string[], options as never) as never;
  };
}

function syncFixtureOptions<T extends { repository: string; commit: string }>(
  fixture: T,
  extra: Record<string, unknown> = {},
) {
  return {
    source: fixture.repository,
    commit: fixture.commit,
    execFile: freshCentralMainRunner(fixture.commit, fixture.repository),
    ...extra,
  };
}

async function seedTarget(target: string) {
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "sentinel.txt"), "original target\n", "utf8");
}

async function assertTargetUnchanged(target: string) {
  assert.equal(await fs.readFile(path.join(target, "sentinel.txt"), "utf8"), "original target\n");
  assert.deepEqual(await fs.readdir(target), ["sentinel.txt"]);
  const parentEntries = await fs.readdir(path.dirname(target));
  const prefix = `.${path.basename(target)}`;
  assert.equal(
    parentEntries.some((entry) => entry.startsWith(`${prefix}-sync-`) || entry.startsWith(`${prefix}-backup-`)),
    false,
    "failed sync must not leave staging or backup directories",
  );
}

test("syncCommunitySnapshot vendors an empty exact-commit Catalog into an isolated target", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-community-sync-empty-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const fixture = await createCommunityFixture(temporary);
  const target = path.join(temporary, "isolated output", "community");

  const result = await syncCommunitySnapshot(syncFixtureOptions(fixture, { target }));

  assert.equal(result.releases, 0);
  assert.equal(result.commit, fixture.commit);
  assert.deepEqual((await fs.readdir(target)).sort(), [
    "LICENSES",
    "catalog.json",
    "preview-manifest.json",
    "source.lock.json",
  ]);
  assert.equal(await fs.readFile(path.join(target, "LICENSES", "CC-BY-4.0.txt"), "utf8"), "CC BY 4.0 fixture\n");
  const sourceLock = JSON.parse(await fs.readFile(path.join(target, "source.lock.json"), "utf8"));
  assert.equal(sourceLock.catalogCommit, fixture.commit);
  assert.equal(sourceLock.catalog.sha256, result.catalogSha256);
  assert.equal(sourceLock.previewManifest.sha256, result.previewManifestSha256);
  assert.deepEqual(result.warnings, []);
});

test("syncCommunitySnapshot restores the prior target when candidate activation fails", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-community-sync-switch-fail-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const fixture = await createCommunityFixture(temporary);
  const target = path.join(temporary, "output", "community");
  await seedTarget(target);
  let renameCall = 0;

  await assert.rejects(
    syncCommunitySnapshot(syncFixtureOptions(fixture, {
      target,
      fileOperations: {
        rename: async (from: string, to: string) => {
          renameCall += 1;
          if (renameCall === 2) throw Object.assign(new Error("injected candidate activation failure"), { code: "EIO" });
          await fs.rename(from, to);
        },
      },
    })),
    /injected candidate activation failure/u,
  );
  assert.equal(renameCall, 3, "the third rename must restore backup to target");
  await assertTargetUnchanged(target);
});

test("syncCommunitySnapshot preserves backup and staging and reports both errors when rollback fails", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-community-sync-restore-fail-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const fixture = await createCommunityFixture(temporary);
  const target = path.join(temporary, "output", "community");
  await seedTarget(target);
  let renameCall = 0;
  let failure: unknown;

  try {
    await syncCommunitySnapshot(syncFixtureOptions(fixture, {
      target,
      fileOperations: {
        rename: async (from: string, to: string) => {
          renameCall += 1;
          if (renameCall === 2) throw Object.assign(new Error("injected candidate activation failure"), { code: "EIO" });
          if (renameCall === 3) throw Object.assign(new Error("injected backup restoration failure"), { code: "EACCES" });
          await fs.rename(from, to);
        },
      },
    }));
  } catch (error) {
    failure = error;
  }

  assert.ok(failure instanceof AggregateError);
  const detail = failure as AggregateError & {
    code: string;
    target: string;
    backup: string;
    staging: string;
    errors: Error[];
  };
  assert.equal(detail.code, "community_sync_restore_failed");
  assert.equal(detail.target, target);
  assert.match(detail.message, /prior snapshot remains at .*backup.*candidate remains at .*sync/u);
  assert.deepEqual(detail.errors.map((error) => error.message), [
    "injected candidate activation failure",
    "injected backup restoration failure",
  ]);
  assert.equal(await fs.readFile(path.join(detail.backup, "sentinel.txt"), "utf8"), "original target\n");
  assert.equal(await fs.stat(path.join(detail.staging, "catalog.json")).then((stat) => stat.isFile()), true);
  await assert.rejects(fs.access(target), { code: "ENOENT" });
});

test("syncCommunitySnapshot returns an explicit warning and retains backup when post-switch cleanup fails", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-community-sync-cleanup-warn-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const fixture = await createCommunityFixture(temporary);
  const target = path.join(temporary, "output", "community");
  await seedTarget(target);

  const result = await syncCommunitySnapshot(syncFixtureOptions(fixture, {
    target,
    fileOperations: {
      remove: async (candidate: string, options: { recursive: boolean; force: boolean }) => {
        if (path.basename(candidate).startsWith(".community-backup-")) {
          throw Object.assign(new Error("injected backup cleanup failure"), { code: "EACCES" });
        }
        await fs.rm(candidate, options);
      },
    },
  }));

  assert.equal(result.warnings.length, 1);
  assert.equal(result.warnings[0]?.code, "community_sync_backup_cleanup_failed");
  assert.match(result.warnings[0]?.message ?? "", /injected backup cleanup failure/u);
  const retainedBackup = result.warnings[0]?.path;
  assert.equal(typeof retainedBackup, "string");
  assert.equal(await fs.readFile(path.join(retainedBackup, "sentinel.txt"), "utf8"), "original target\n");
  assert.equal(await fs.stat(path.join(target, "catalog.json")).then((stat) => stat.isFile()), true);
});

for (const releaseVersion of ["1.0.0+build.9", "1.0.0-rc.1+build"] as const) {
  test(`syncCommunitySnapshot and the runtime parser accept strict SemVer ${releaseVersion}`, async (t) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-community-sync-semver-"));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const fixture = await createCommunityFixture(temporary, { entry: true, releaseVersion });
    const target = path.join(temporary, "output", "community");

    const result = await syncCommunitySnapshot(syncFixtureOptions(fixture, { target }));

    assert.equal(result.releases, 1);
    const vendoredCatalog = new Uint8Array(await fs.readFile(path.join(target, "catalog.json")));
    assert.equal(parsePublicProviderCatalog(vendoredCatalog).entries[0]?.releaseVersion, releaseVersion);
    assert.equal(
      await fs.stat(path.join(target, "thumbs", "fixture-template", `${releaseVersion}.png`)).then((stat) => stat.isFile()),
      true,
    );
  });
}

for (const releaseVersion of ["1.0.0-01", "1.0.0-alpha..1"] as const) {
  test(`syncCommunitySnapshot rejects invalid SemVer ${releaseVersion} without replacing target`, async (t) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-community-sync-bad-semver-"));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const fixture = await createCommunityFixture(temporary, { entry: true, releaseVersion });
    const target = path.join(temporary, "output", "community");
    await seedTarget(target);

    await assert.rejects(
      syncCommunitySnapshot(syncFixtureOptions(fixture, { target })),
      /releaseVersion is not semantic/u,
    );
    await assertTargetUnchanged(target);
  });
}

test("syncCommunitySnapshot rejects dirty tracked vendored input without replacing target", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-community-sync-dirty-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const fixture = await createCommunityFixture(temporary);
  const target = path.join(temporary, "output", "community");
  await seedTarget(target);
  await fs.appendFile(path.join(fixture.repository, "catalog", "catalog.json"), " \n", "utf8");

  await assert.rejects(
    syncCommunitySnapshot(syncFixtureOptions(fixture, { target })),
    /dirty vendored input: catalog\/catalog\.json/u,
  );
  await assertTargetUnchanged(target);
});

test("syncCommunitySnapshot compares normalized worktree identity with the exact commit even when Git status is suppressed", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-community-sync-hidden-dirty-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const fixture = await createCommunityFixture(temporary);
  const target = path.join(temporary, "output", "community");
  await seedTarget(target);
  await git(fixture.repository, "update-index", "--assume-unchanged", "catalog/catalog.json");
  await fs.appendFile(path.join(fixture.repository, "catalog", "catalog.json"), " \n", "utf8");

  await assert.rejects(
    syncCommunitySnapshot(syncFixtureOptions(fixture, { target })),
    /Community catalog normalized Git identity differs from the exact Community commit/u,
  );
  await assertTargetUnchanged(target);
});

test("syncCommunitySnapshot accepts a clean core.autocrlf CRLF checkout and vendors committed LF bytes", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-community-sync-autocrlf-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const fixture = await createCommunityFixture(temporary);
  const target = path.join(temporary, "output", "community");
  const relative = "catalog/catalog.json";
  const absolute = path.join(fixture.repository, ...relative.split("/"));
  const { stdout: committedOutput } = await execFile(
    "git",
    ["-C", fixture.repository, "show", `${fixture.commit}:${relative}`],
    { encoding: null, windowsHide: true, timeout: 30_000 },
  );
  const committedBytes = Buffer.isBuffer(committedOutput)
    ? committedOutput
    : Buffer.from(committedOutput);
  assert.equal(committedBytes.includes(Buffer.from("\r\n")), false);

  await git(fixture.repository, "config", "core.autocrlf", "true");
  // Re-check out the committed tree so Git writes the CRLF representation and
  // refreshes its index stat data exactly as it does for a normal clean clone.
  await fs.rm(absolute);
  await git(fixture.repository, "reset", "--hard", fixture.commit);
  const crlfBytes = await fs.readFile(absolute);
  assert.equal(crlfBytes.includes(Buffer.from("\r\n")), true);
  assert.notDeepEqual(crlfBytes, committedBytes);
  assert.equal(
    await git(
      fixture.repository,
      "status",
      "--porcelain=v1",
      "--",
      relative,
    ),
    "",
    "the CRLF worktree representation must remain clean under core.autocrlf=true",
  );

  await syncCommunitySnapshot(syncFixtureOptions(fixture, { target }));

  const vendoredBytes = await fs.readFile(path.join(target, "catalog.json"));
  assert.deepEqual(vendoredBytes, committedBytes);
  assert.notDeepEqual(vendoredBytes, crlfBytes);
});

test("syncCommunitySnapshot rejects an exact commit mismatch without replacing target", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-community-sync-commit-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const fixture = await createCommunityFixture(temporary);
  const target = path.join(temporary, "output", "community");
  await seedTarget(target);

  await assert.rejects(
    syncCommunitySnapshot(syncFixtureOptions(
      { ...fixture, commit: "0".repeat(40) },
      { target, execFile: freshCentralMainRunner(fixture.commit, fixture.repository) },
    )),
    /differs from --commit/u,
  );
  await assertTargetUnchanged(target);
});

test("syncCommunitySnapshot rejects a non-central origin without replacing target", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-community-sync-origin-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const fixture = await createCommunityFixture(temporary);
  const target = path.join(temporary, "output", "community");
  await seedTarget(target);
  await git(fixture.repository, "remote", "set-url", "origin", "https://github.com/example/not-central.git");

  await assert.rejects(
    syncCommunitySnapshot(syncFixtureOptions(fixture, { target })),
    /origin is not the fixed central Catalog repository/u,
  );
  await assertTargetUnchanged(target);
});

test("syncCommunitySnapshot requires the requested commit to be freshly fetched central main", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-community-sync-fresh-main-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const fixture = await createCommunityFixture(temporary);
  const target = path.join(temporary, "output", "community");
  await seedTarget(target);
  const catalogPath = path.join(fixture.repository, "catalog", "catalog.json");
  const forgedCatalog = JSON.parse(await fs.readFile(catalogPath, "utf8"));
  forgedCatalog.generatedAt = "2026-08-21T00:00:01.000Z";
  await writeJson(catalogPath, forgedCatalog);
  await git(fixture.repository, "add", "catalog/catalog.json");
  await git(fixture.repository, "commit", "-m", "test: locally forge a plausible central commit");
  const forgedCommit = await git(fixture.repository, "rev-parse", "HEAD");
  const centralMain = fixture.commit;
  const calls: string[][] = [];

  await assert.rejects(
    syncCommunitySnapshot(syncFixtureOptions({ ...fixture, commit: forgedCommit }, {
      target,
      execFile: freshCentralMainRunner(centralMain, fixture.repository, calls),
    })),
    new RegExp(`is not the freshly fetched central main ${centralMain}`, "u"),
  );
  assert.equal(calls.some((args) => args.includes("fetch") && args.includes(CENTRAL_ORIGIN)), true);
  await assertTargetUnchanged(target);
});

test("syncCommunitySnapshot fetches the fixed HTTPS origin despite a matching local origin label", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-community-sync-fixed-fetch-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const fixture = await createCommunityFixture(temporary);
  const target = path.join(temporary, "output", "community");
  const calls: string[][] = [];

  await syncCommunitySnapshot(syncFixtureOptions(fixture, {
    target,
    execFile: freshCentralMainRunner(fixture.commit, fixture.repository, calls),
  }));

  const fetch = calls.find((args) => args.includes("fetch"));
  assert.ok(fetch);
  assert.equal(fetch.includes(CENTRAL_ORIGIN), true);
  assert.equal(fetch.includes("origin"), false);
});

test("syncCommunitySnapshot rejects a committed preview digest mismatch without replacing target", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-community-sync-digest-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const fixture = await createCommunityFixture(temporary, { entry: true, badPreviewDigest: true });
  const target = path.join(temporary, "output", "community");
  await seedTarget(target);

  await assert.rejects(
    syncCommunitySnapshot(syncFixtureOptions(fixture, { target })),
    /preview byte identity mismatch/u,
  );
  await assertTargetUnchanged(target);
});

test("syncCommunitySnapshot rejects inconsistent preview inventory without replacing target", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-community-sync-inventory-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const fixture = await createCommunityFixture(temporary, { entry: true, badPreviewInventory: true });
  const target = path.join(temporary, "output", "community");
  await seedTarget(target);

  await assert.rejects(
    syncCommunitySnapshot(syncFixtureOptions(fixture, { target })),
    /preview manifest does not exactly match Catalog previews/u,
  );
  await assertTargetUnchanged(target);
});

test("syncCommunitySnapshot rejects an ignored license extra without replacing target", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-community-sync-ignored-license-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const fixture = await createCommunityFixture(temporary);
  const target = path.join(temporary, "output", "community");
  await seedTarget(target);
  await fs.writeFile(path.join(fixture.repository, "LICENSES", "ignored-extra.txt"), "ignored bytes\n", "utf8");

  await assert.rejects(
    syncCommunitySnapshot(syncFixtureOptions(fixture, { target })),
    /ignored or untracked vendored input: LICENSES\/ignored-extra\.txt/u,
  );
  await assertTargetUnchanged(target);
});

test("syncCommunitySnapshot rejects an ignored preview extra without replacing target", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-community-sync-ignored-preview-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const fixture = await createCommunityFixture(temporary);
  const target = path.join(temporary, "output", "community");
  await seedTarget(target);
  await fs.writeFile(path.join(fixture.repository, "thumbs", "ignored-preview.png"), "not a tracked preview\n", "utf8");

  await assert.rejects(
    syncCommunitySnapshot(syncFixtureOptions(fixture, { target })),
    /ignored or untracked vendored input: thumbs\/ignored-preview\.png/u,
  );
  await assertTargetUnchanged(target);
});

test("syncCommunitySnapshot rejects a committed orphan thumbnail without replacing target", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-community-sync-orphan-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const fixture = await createCommunityFixture(temporary);
  const target = path.join(temporary, "output", "community");
  await seedTarget(target);
  await fs.writeFile(path.join(fixture.repository, "thumbs", "orphan.png"), "tracked orphan\n", "utf8");
  await git(fixture.repository, "add", "thumbs/orphan.png");
  await git(fixture.repository, "commit", "-m", "test: add orphan thumbnail");
  const commit = await git(fixture.repository, "rev-parse", "HEAD");

  await assert.rejects(
    syncCommunitySnapshot(syncFixtureOptions({ ...fixture, commit }, { target })),
    /orphan Catalog\/thumbnail assets: thumbs\/orphan\.png/u,
  );
  await assertTargetUnchanged(target);
});

for (const malformed of ["search", "provenance"] as const) {
  test(`syncCommunitySnapshot rejects malformed Catalog ${malformed} before replacing target`, async (t) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), `sfl-community-sync-${malformed}-`));
    t.after(() => fs.rm(temporary, { recursive: true, force: true }));
    const fixture = await createCommunityFixture(temporary, {
      entry: true,
      ...(malformed === "search" ? { malformedSearch: true } : { malformedProvenance: true }),
    });
    const target = path.join(temporary, "output", "community");
    await seedTarget(target);

    await assert.rejects(
      syncCommunitySnapshot(syncFixtureOptions(fixture, { target })),
      malformed === "search" ? /search\.unsupportedSearchField is not supported/u : /provenance must be an array/u,
    );
    await assertTargetUnchanged(target);
  });
}

test("syncCommunitySnapshot requires the bootstrap MIT and CC-BY-4.0 license texts", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-community-sync-bootstrap-license-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const fixture = await createCommunityFixture(temporary, { missingMitLicense: true });
  const target = path.join(temporary, "output", "community");
  await seedTarget(target);

  await assert.rejects(
    syncCommunitySnapshot(syncFixtureOptions(fixture, { target })),
    /missing required tracked license texts: LICENSES\/MIT\.txt/u,
  );
  await assertTargetUnchanged(target);
});

test("syncCommunitySnapshot requires each Catalog license identifier to map to a tracked text", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-community-sync-entry-license-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const fixture = await createCommunityFixture(temporary, {
    entry: true,
    contentLicense: "Apache-2.0",
  });
  const target = path.join(temporary, "output", "community");
  await seedTarget(target);

  await assert.rejects(
    syncCommunitySnapshot(syncFixtureOptions(fixture, { target })),
    /missing required tracked license texts: LICENSES\/Apache-2\.0\.txt/u,
  );
  await assertTargetUnchanged(target);
});

test("syncCommunitySnapshot rejects non-segment license identifiers", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-community-sync-license-path-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const fixture = await createCommunityFixture(temporary, {
    entry: true,
    contentLicense: "../MIT",
  });
  const target = path.join(temporary, "output", "community");
  await seedTarget(target);

  await assert.rejects(
    syncCommunitySnapshot(syncFixtureOptions(fixture, { target })),
    /must be one portable license identifier/u,
  );
  await assertTargetUnchanged(target);
});
