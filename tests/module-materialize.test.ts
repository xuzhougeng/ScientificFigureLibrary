import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { strToU8, zipSync } from "fflate";
import { ModuleCatalogIndex } from "../src/module-catalog.ts";
import {
  materializeModuleTemplate,
  cacheModuleSourceArchive,
  validateModuleArchive,
} from "../src/module-materialize.ts";
import { defaultOpenModulesSourcePackDir } from "../src/open-modules.ts";
import {
  exactSelectorDigest,
  moduleArchiveExactSelector,
  PERSONAL_MODULE_PROVIDER_ID,
} from "../src/providers.ts";
import { resetNetworkAccessForTests, setNetworkAccessForTests } from "../src/network-access.ts";
import type { ModuleCatalog, ModuleCatalogEntry } from "../src/types.ts";

const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const sourceCommit = "1".repeat(40);
const archiveCommit = "2".repeat(40);

function fixtureArchive() {
  const files: Record<string, Uint8Array> = {
    "README.md": strToU8("# Fixture\n"),
    "code/example.R": strToU8("plot(1:3)\n"),
    "data/input.csv": strToU8("x,y\n1,2\n"),
    "description.md": strToU8("A portable fixture.\n"),
    "module.yml": strToU8("schema: figure-library.personal-module.v1\n"),
    "preview.png": ONE_PIXEL_PNG,
    "thumbnail.png": ONE_PIXEL_PNG,
  };
  const archive = zipSync(files, { level: 6, mtime: new Date("2000-01-01T00:00:00.000Z") });
  return { files, archive, sha256: digest(archive) };
}

function fixtureCatalog() {
  const { files, archive, sha256 } = fixtureArchive();
  const inventory = Object.entries(files)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([file, bytes]) => ({ path: file, bytes: bytes.byteLength, sha256: digest(bytes) }));
  const module: ModuleCatalogEntry = {
    moduleId: "materialize-module-fixture",
    title: "个人模块物化测试",
    titleEn: "Materialize module fixture",
    description: "A portable fixture.",
    application: "Security tests.",
    dataProfile: "Synthetic CSV.",
    plotFamily: "scatter",
    language: "R",
    tags: ["fixture", "scatter"],
    packages: ["ggplot2"],
    codeFiles: ["code/example.R"],
    inputFiles: ["data/input.csv"],
    canonicalCode: "code/example.R",
    requiredFiles: ["README.md", "code/example.R", "data/input.csv", "description.md", "module.yml", "preview.png"],
    files: inventory,
    source: { repository: "jarxunlai/ScientificFigureLibrary-personal", commit: sourceCommit, path: "modules/materialize-module-fixture" },
    archive: { repository: "jarxunlai/ScientificFigureLibrary-personal", commit: archiveCommit, path: "archives/materialize-module-fixture.zip", bytes: archive.byteLength, sha256 },
    preview: { path: "previews/materialize-module-fixture/preview.png", bytes: ONE_PIXEL_PNG.byteLength, sha256: digest(ONE_PIXEL_PNG), mediaType: "image/png" },
    thumbnail: { path: "thumbs/materialize-module-fixture.png", bytes: ONE_PIXEL_PNG.byteLength, sha256: digest(ONE_PIXEL_PNG), mediaType: "image/png" },
    licenses: { code: "MIT", content: "CC BY 4.0", documentation: "CC BY 4.0" },
    publisher: { reviewStatus: "approved", executionStatus: "passed", executionScope: "synthetic_data" },
  };
  const catalog: ModuleCatalog = {
    schema: "figure-library.module-catalog.v1",
    generatedAt: "2000-01-01T00:00:00.000Z",
    provider: { providerId: PERSONAL_MODULE_PROVIDER_ID, displayName: "Open Figure Modules", repository: "jarxunlai/ScientificFigureLibrary-personal" },
    modules: [module],
  };
  return { module, catalog, archiveBytes: archive, archiveSha256: sha256 };
}

async function writeIndex(root: string, fixture = fixtureCatalog()) {
  await fs.mkdir(path.join(root, "previews", fixture.module.moduleId), { recursive: true });
  await fs.mkdir(path.join(root, "thumbs"), { recursive: true });
  await fs.writeFile(path.join(root, "module-catalog.json"), `${JSON.stringify(fixture.catalog)}\n`);
  await fs.writeFile(path.join(root, "module-preview.manifest.json"), `${JSON.stringify({
    schema: "figure-library.module-preview-manifest.v1",
    providerId: PERSONAL_MODULE_PROVIDER_ID,
    entries: [
      { moduleId: fixture.module.moduleId, role: "primary", ...fixture.module.preview },
      { moduleId: fixture.module.moduleId, role: "thumbnail", ...fixture.module.thumbnail },
    ],
  })}\n`);
  await fs.writeFile(path.join(root, "module-source-pack.manifest.json"), `${JSON.stringify({
    schema: "figure-library.module-source-pack.v1",
    providerId: PERSONAL_MODULE_PROVIDER_ID,
    repository: fixture.catalog.provider.repository,
    entries: [{
      moduleId: fixture.module.moduleId,
      sourceRepository: fixture.module.source.repository,
      sourceCommit: fixture.module.source.commit,
      archiveRepository: fixture.module.archive.repository,
      archiveCommit: fixture.module.archive.commit,
      file: fixture.module.archive.path,
      bytes: fixture.module.archive.bytes,
      sha256: fixture.module.archive.sha256,
    }],
  })}\n`);
  await fs.writeFile(path.join(root, "PERSONAL_MODULES_LICENSE.txt"), "Personal module fixture\n");
  await fs.writeFile(path.join(root, ...fixture.module.preview.path.split("/")), ONE_PIXEL_PNG);
  await fs.writeFile(path.join(root, ...fixture.module.thumbnail.path.split("/")), ONE_PIXEL_PNG);
  return fixture;
}

async function writePack(root: string, fixture: ReturnType<typeof fixtureCatalog>) {
  await fs.mkdir(path.join(root, "archives"), { recursive: true });
  await fs.writeFile(path.join(root, fixture.module.archive.path), fixture.archiveBytes);
  await fs.writeFile(path.join(root, "module-source-pack.manifest.json"), `${JSON.stringify({
    schema: "figure-library.module-source-pack.v1",
    providerId: PERSONAL_MODULE_PROVIDER_ID,
    repository: fixture.catalog.provider.repository,
    entries: [{
      moduleId: fixture.module.moduleId,
      sourceRepository: fixture.module.source.repository,
      sourceCommit: fixture.module.source.commit,
      archiveRepository: fixture.module.archive.repository,
      archiveCommit: fixture.module.archive.commit,
      file: fixture.module.archive.path,
      bytes: fixture.module.archive.bytes,
      sha256: fixture.module.archive.sha256,
    }],
  })}\n`);
}

test("Open Modules Source Pack defaults to the global Library sibling", () => {
  const globalRoot = "E:\\ScientificFigureLibrary";
  assert.equal(
    defaultOpenModulesSourcePackDir(globalRoot),
    path.resolve(globalRoot, "source-packs", "open-modules"),
  );
});

test("personal module template/full materialization uses Source Pack and never executes code", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-module-materialize-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  const pack = path.join(root, "source pack");
  const fixture = await writeIndex(assets);
  await writePack(pack, fixture);
  const index = await ModuleCatalogIndex.load(assets, { expectedProviderId: PERSONAL_MODULE_PROVIDER_ID, validatePreviews: true });
  const targetParent = path.join(root, "output");
  assert.equal(await cacheModuleSourceArchive(index, fixture.module, pack), "cached");
  await assert.rejects(fs.stat(targetParent), { code: "ENOENT" });
  const template = await materializeModuleTemplate({
    providerId: PERSONAL_MODULE_PROVIDER_ID,
    index,
    module: fixture.module,
    destination: targetParent,
    mode: "template",
    exactSelector: moduleArchiveExactSelector(PERSONAL_MODULE_PROVIDER_ID, fixture.module, index.catalogSha256, "template"),
    sourcePackDir: pack,
    allowNetwork: false,
    operationId: "module-template-operation",
    planDigest: "a".repeat(64),
  });
  assert.equal(template.archiveSource, "source-pack");
  assert.equal(template.sha256, fixture.archiveSha256);
  const lock = JSON.parse(await fs.readFile(path.join(template.target, "template.lock.json"), "utf8"));
  assert.equal(lock.schema, "figure-library.module-template-lock.v1");
  assert.equal(lock.codeExecutedBySflClient, false);
  assert.equal(lock.selectorDigest, exactSelectorDigest(lock.exactSelector));
  assert.ok(lock.files.some((file: { file: string }) => file.file === "upstream/code/example.R"));
  assert.equal(lock.files.some((file: { file: string }) => file.file === "upstream/preview.png"), true);

  const fullParent = path.join(root, "full output");
  const full = await materializeModuleTemplate({
    providerId: PERSONAL_MODULE_PROVIDER_ID,
    index,
    module: fixture.module,
    destination: fullParent,
    mode: "full",
    sourcePackDir: pack,
    allowNetwork: false,
    operationId: "module-full-operation",
    planDigest: "b".repeat(64),
  });
  const fullLock = JSON.parse(await fs.readFile(path.join(full.target, "template.lock.json"), "utf8"));
  assert.equal(fullLock.mode, "full");
  assert.equal(fullLock.files.some((file: { file: string }) => file.file === "upstream/thumbnail.png"), true);
  assert.equal(lock.files.some((file: { file: string }) => file.file === "upstream/thumbnail.png"), false);
  assert.equal(fullLock.codeExecutedBySflClient, false);
  assert.equal((await fs.readFile(path.join(full.target, "TEMPLATE.md"), "utf8")).includes("No downloaded code has been executed"), false);
  assert.equal((await fs.readFile(path.join(full.target, "TEMPLATE.md"), "utf8")).includes("does not execute"), true);
});

test("personal module archive validation rejects traversal, collisions, and malformed ZIPs", () => {
  const fixture = fixtureCatalog();
  assert.doesNotThrow(() => validateModuleArchive(fixture.archiveBytes, fixture.module));
  for (const name of ["../escape.txt", "/absolute.txt", "C:\\absolute.txt", "CON", "a/../b.txt"]) {
    const archive = zipSync({ [name]: strToU8("x") });
    assert.throws(() => validateModuleArchive(archive, fixture.module), /archive|portable|path|inventory/u);
  }
  const duplicate = zipSync({ "README.md": strToU8("x"), "readme.md": strToU8("y") });
  assert.throws(() => validateModuleArchive(duplicate, fixture.module), /collision|inventory/u);
  const hiddenExtraDirectory = zipSync({
    ...fixtureArchive().files,
    "undeclared-empty/": new Uint8Array(),
  });
  assert.throws(
    () => validateModuleArchive(hiddenExtraDirectory, fixture.module),
    /undeclared directory|inventory/u,
  );
  assert.throws(() => validateModuleArchive(new Uint8Array([1, 2, 3]), fixture.module), /ZIP|archive/u);
});

test("personal module materialization fails closed for Source Pack identity mismatch and target collisions", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-module-materialize-fail-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  const pack = path.join(root, "pack");
  const fixture = await writeIndex(assets);
  await writePack(pack, fixture);
  const index = await ModuleCatalogIndex.load(assets, { expectedProviderId: PERSONAL_MODULE_PROVIDER_ID });
  const badManifest = JSON.parse(await fs.readFile(path.join(pack, "module-source-pack.manifest.json"), "utf8"));
  badManifest.entries[0].archiveCommit = "f".repeat(40);
  await fs.writeFile(path.join(pack, "module-source-pack.manifest.json"), `${JSON.stringify(badManifest)}\n`);
  await assert.rejects(
    materializeModuleTemplate({ providerId: PERSONAL_MODULE_PROVIDER_ID, index, module: fixture.module, destination: path.join(root, "bad"), mode: "template", sourcePackDir: pack, allowNetwork: false }),
    /Source Pack rejected|does not match/u,
  );
  await writePack(pack, fixture);
  const destination = path.join(root, "collision");
  await fs.mkdir(path.join(destination, fixture.module.moduleId), { recursive: true });
  await assert.rejects(
    materializeModuleTemplate({ providerId: PERSONAL_MODULE_PROVIDER_ID, index, module: fixture.module, destination, mode: "template", allowNetwork: false }),
    /target already exists/u,
  );
  await fs.writeFile(path.join(pack, "unlisted.zip"), Buffer.from("unexpected"));
  await assert.rejects(
    materializeModuleTemplate({
      providerId: PERSONAL_MODULE_PROVIDER_ID,
      index,
      module: fixture.module,
      destination: path.join(root, "extra-pack"),
      mode: "template",
      sourcePackDir: pack,
      allowNetwork: false,
    }),
    /Source Pack rejected|inventory differs/u,
  );
});

test("personal module network acquisition uses only the fixed raw commit URL and verifies bytes", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-module-network-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  const fixture = await writeIndex(assets);
  const index = await ModuleCatalogIndex.load(assets, { expectedProviderId: PERSONAL_MODULE_PROVIDER_ID });
  const previousFetch = globalThis.fetch;
  let observedUrl = "";
  let observedRedirect: RequestRedirect | undefined;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    observedUrl = String(input);
    observedRedirect = init?.redirect;
    return new Response(fixture.archiveBytes, {
      status: 200,
      headers: { "content-length": String(fixture.archiveBytes.byteLength) },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const result = await materializeModuleTemplate({
    providerId: PERSONAL_MODULE_PROVIDER_ID,
    index,
    module: fixture.module,
    destination: path.join(root, "network output"),
    mode: "template",
    allowNetwork: true,
  });
  assert.equal(result.archiveSource, "network");
  assert.equal(result.sha256, fixture.archiveSha256);
  assert.equal(observedRedirect, "error");
  assert.equal(
    observedUrl,
    `https://raw.githubusercontent.com/jarxunlai/ScientificFigureLibrary-personal/${archiveCommit}/archives/materialize-module-fixture.zip`,
  );
});

test("Open Modules prefers the global Gitee mirror, persists the archive, and reuses the Source Pack", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-open-modules-cache-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  const sourcePack = path.join(root, "source-packs", "open-modules");
  const fixture = await writeIndex(assets);
  await fs.mkdir(path.join(root, "network"), { recursive: true });
  await fs.writeFile(
    path.join(root, "network", "mirrors.json"),
    `${JSON.stringify({
      openModules: {
        sources: [{
          kind: "gitee-mirror",
          urlTemplate: "https://gitee.com/example/ScientificFigureLibrary-personal/raw/{archiveCommit}/{archivePath}",
          priority: 1,
        }],
      },
    })}\n`,
  );
  const index = await ModuleCatalogIndex.load(assets, { expectedProviderId: PERSONAL_MODULE_PROVIDER_ID });
  const previousFetch = globalThis.fetch;
  const observed: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    observed.push(String(input));
    assert.equal(init?.redirect, "manual");
    return new Response(fixture.archiveBytes, {
      status: 200,
      headers: { "content-length": String(fixture.archiveBytes.byteLength) },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });

  const first = await materializeModuleTemplate({
    providerId: PERSONAL_MODULE_PROVIDER_ID,
    index,
    module: fixture.module,
    destination: path.join(root, "first-output"),
    mode: "template",
    sourcePackDir: sourcePack,
    allowNetwork: true,
  });
  assert.equal(first.archiveSource, "network");
  assert.equal(first.transportSource, "gitee-mirror");
  assert.equal(first.cachePersisted, true);
  assert.equal(observed.length, 1);
  assert.match(observed[0]!, /gitee\.com\/example\/ScientificFigureLibrary-personal\/raw/u);
  assert.equal(
    await fs.readFile(path.join(sourcePack, fixture.module.archive.path)).then((bytes) => digest(bytes)),
    fixture.archiveSha256,
  );
  assert.equal(
    await fs.stat(path.join(sourcePack, "templates", fixture.module.moduleId, "upstream", "code", "example.R")).then(() => true),
    true,
  );

  const second = await materializeModuleTemplate({
    providerId: PERSONAL_MODULE_PROVIDER_ID,
    index,
    module: fixture.module,
    destination: path.join(root, "second-output"),
    mode: "template",
    sourcePackDir: sourcePack,
    allowNetwork: false,
  });
  assert.equal(second.archiveSource, "source-pack");
  assert.equal(second.transportSource, "source-pack");
  assert.equal(observed.length, 1);
});

test("Open Modules accepts Gitee's signed raw.giteeusercontent redirect without weakening GitHub policy", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-open-modules-redirect-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  const sourcePack = path.join(root, "source-packs", "open-modules");
  const fixture = await writeIndex(assets);
  await fs.mkdir(path.join(root, "network"), { recursive: true });
  await fs.writeFile(
    path.join(root, "network", "mirrors.json"),
    `${JSON.stringify({
      openModules: {
        sources: [{
          kind: "gitee-mirror",
          urlTemplate: "https://gitee.com/example/ScientificFigureLibrary-personal/raw/{archiveCommit}/{archivePath}",
          priority: 1,
        }],
      },
    })}\n`,
  );
  const index = await ModuleCatalogIndex.load(assets, { expectedProviderId: PERSONAL_MODULE_PROVIDER_ID });
  const previousFetch = globalThis.fetch;
  const observed: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];
  const signedUrl = `https://raw.giteeusercontent.com/example/ScientificFigureLibrary-personal/raw/${archiveCommit}/archives/materialize-module-fixture.zip?metadata=signed&signature=test`;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    observed.push({ url, redirect: init?.redirect });
    if (url.startsWith("https://gitee.com/")) {
      return new Response(null, { status: 302, headers: { location: signedUrl } });
    }
    assert.equal(url, signedUrl);
    assert.equal(init?.redirect, "error");
    return new Response(fixture.archiveBytes, {
      status: 200,
      headers: { "content-length": String(fixture.archiveBytes.byteLength) },
    });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const result = await materializeModuleTemplate({
    providerId: PERSONAL_MODULE_PROVIDER_ID,
    index,
    module: fixture.module,
    destination: path.join(root, "output"),
    mode: "template",
    sourcePackDir: sourcePack,
    allowNetwork: true,
  });
  assert.equal(result.transportSource, "gitee-mirror");
  assert.deepEqual(observed.map((item) => item.redirect), ["manual", "error"]);
});

test("Open Modules falls back from a mismatched Gitee archive to the canonical GitHub archive", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-open-modules-fallback-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  const sourcePack = path.join(root, "source-packs", "open-modules");
  const fixture = await writeIndex(assets);
  await fs.mkdir(path.join(root, "network"), { recursive: true });
  await fs.writeFile(
    path.join(root, "network", "mirrors.json"),
    `${JSON.stringify({
      openModules: {
        sources: [{
          kind: "gitee-mirror",
          urlTemplate: "https://gitee.com/example/ScientificFigureLibrary-personal/raw/{archiveCommit}/{archivePath}",
          priority: 1,
        }],
      },
    })}\n`,
  );
  const index = await ModuleCatalogIndex.load(assets, { expectedProviderId: PERSONAL_MODULE_PROVIDER_ID });
  const previousFetch = globalThis.fetch;
  const observed: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = String(input);
    observed.push(url);
    const bytes = url.includes("gitee.com") ? new Uint8Array([1, 2, 3]) : fixture.archiveBytes;
    return new Response(bytes, { status: 200, headers: { "content-length": String(bytes.byteLength) } });
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  const result = await materializeModuleTemplate({
    providerId: PERSONAL_MODULE_PROVIDER_ID,
    index,
    module: fixture.module,
    destination: path.join(root, "output"),
    mode: "template",
    sourcePackDir: sourcePack,
    allowNetwork: true,
  });
  assert.equal(result.transportSource, "github-upstream");
  assert.equal(observed.length, 2);
  assert.match(observed[0]!, /gitee\.com/u);
  assert.match(observed[1]!, /raw\.githubusercontent\.com/u);
});

test("Open Modules archive download uses the saved loopback proxy instead of direct fetch", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-module-proxy-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const assets = path.join(root, "assets");
  const fixture = await writeIndex(assets);
  const index = await ModuleCatalogIndex.load(assets, { expectedProviderId: PERSONAL_MODULE_PROVIDER_ID });
  const seen: string[] = [];
  const server = http.createServer();
  server.on("connect", (request, socket) => {
    seen.push(request.url ?? "");
    socket.write("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
    socket.end();
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  t.after(() => new Promise<void>((resolve) => {
    server.close(() => resolve());
  }));
  const port = (server.address() as AddressInfo).port;
  setNetworkAccessForTests({ useSystemProxy: true, httpsProxy: `http://127.0.0.1:${port}` });
  t.after(() => resetNetworkAccessForTests());
  const previousFetch = globalThis.fetch;
  let directFetch = 0;
  globalThis.fetch = (async () => {
    directFetch += 1;
    throw new Error("direct fetch should not run when a proxy is configured");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = previousFetch;
  });
  await assert.rejects(
    materializeModuleTemplate({
      providerId: PERSONAL_MODULE_PROVIDER_ID,
      index,
      module: fixture.module,
      destination: path.join(root, "output"),
      mode: "template",
      allowNetwork: true,
    }),
    /proxy CONNECT failed with status 502/u,
  );
  assert.equal(directFetch, 0);
  assert.ok(seen.some((value) => value.includes("raw.githubusercontent.com:443")));
});
