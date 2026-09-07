import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createPrivateKey, createPublicKey, sign } from "node:crypto";
import {
  DEFAULT_REPOSITORY_ROOT,
  PROVIDER_ID,
  buildPersonalModuleCatalog,
  canonical,
  parseArchiveManifest,
  sha256,
  stableJson,
  validatePersonalModules,
  zipDeterministic,
} from "./personal-modules-lib.mjs";

const MANIFEST_SCHEMA = "figure-library.provider-source-manifest.v1";
const SIGNATURE_SCHEMA = "figure-library.provider-source-signature.v1";
const PKCS8_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");

function argument(name, argv = process.argv.slice(2)) {
  const index = argv.indexOf(name);
  return index < 0 ? undefined : argv[index + 1];
}

function flag(name, argv = process.argv.slice(2)) {
  return argv.includes(name);
}

export function keyFromPrivateSeedBase64(seedBase64) {
  const seed = Buffer.from(seedBase64, "base64");
  if (seed.byteLength !== 32 || seed.toString("base64") !== seedBase64) {
    throw new Error("Ed25519 private seed must be canonical base64 for exactly 32 raw bytes");
  }
  const privateKey = createPrivateKey({ key: Buffer.concat([PKCS8_PREFIX, seed]), format: "der", type: "pkcs8" });
  const publicKey = createPublicKey(privateKey);
  const rawPublic = Buffer.from(publicKey.export({ format: "der", type: "spki" })).subarray(-32);
  return {
    privateKey,
    publicKeyBase64: rawPublic.toString("base64"),
    keyId: sha256(rawPublic),
  };
}

export function officialPayloadUrl(payloadCommit, sequence, file) {
  return `https://raw.githubusercontent.com/jarxunlai/ScientificFigureLibrary-personal/${payloadCommit}/snapshots/${sequence}/${file}`;
}

export function diffModuleIds(previousIds, nextIds, previousTombstones = []) {
  const previous = new Set(previousIds);
  const next = new Set(nextIds);
  const tombstones = [...new Set([...previousTombstones, ...[...previous].filter((id) => !next.has(id))])].sort();
  const added = [...next].filter((id) => !previous.has(id)).sort();
  const withdrawn = [...previous].filter((id) => !next.has(id)).sort();
  for (const id of added) {
    if (tombstones.includes(id)) throw new Error(`tombstoned moduleId cannot return: ${id}`);
  }
  return { added, withdrawn, tombstones };
}

export function buildPreviewZip(files) {
  return zipDeterministic(files, { level: 6 });
}

export function buildSourceManifest({
  sequence,
  generatedAt,
  catalogBytes,
  previewsBytes,
  payloadCommit,
  tombstones = [],
  authorizedNextKeys = [],
}) {
  return {
    schema: MANIFEST_SCHEMA,
    providerId: PROVIDER_ID,
    sequence,
    generatedAt,
    catalog: {
      url: officialPayloadUrl(payloadCommit, sequence, "module-catalog.json"),
      bytes: catalogBytes.byteLength,
      sha256: sha256(catalogBytes),
      mediaType: "application/json",
    },
    previews: {
      url: officialPayloadUrl(payloadCommit, sequence, "module-previews.zip"),
      bytes: previewsBytes.byteLength,
      sha256: sha256(previewsBytes),
      mediaType: "application/zip",
    },
    authorizedNextKeys,
    tombstones: [...tombstones].sort(),
  };
}

export function signManifest(manifestBytes, seedBase64, expectedKeyId) {
  const key = keyFromPrivateSeedBase64(seedBase64);
  if (expectedKeyId && key.keyId !== expectedKeyId) {
    throw new Error(`signing keyId ${key.keyId} does not match expected ${expectedKeyId}`);
  }
  const signature = sign(null, manifestBytes, key.privateKey);
  return {
    keyId: key.keyId,
    publicKeyBase64: key.publicKeyBase64,
    sidecarBytes: Buffer.from(stableJson({
      schema: SIGNATURE_SCHEMA,
      algorithm: "Ed25519",
      keyId: key.keyId,
      manifestSha256: sha256(manifestBytes),
      signatureBase64: signature.toString("base64"),
    }), "utf8"),
  };
}

export async function buildOpenFigureFeedPayload(options = {}) {
  const repositoryRoot = path.resolve(options.repositoryRoot ?? DEFAULT_REPOSITORY_ROOT);
  const generatedAt = options.generatedAt ?? "2000-01-01T00:00:00.000Z";
  await validatePersonalModules({ repositoryRoot, write: false });
  const snapshotStaging = path.resolve(options.snapshotStaging ?? path.join(os.tmpdir(), `open-figure-feed-${randomUUID()}`));
  const createdStaging = !options.snapshotStaging;
  await fs.mkdir(snapshotStaging, { recursive: true });
  let first;
  try {
    first = await buildPersonalModuleCatalog({
      repositoryRoot,
      outputRoot: snapshotStaging,
      write: true,
      generatedAt,
    });
    const second = await buildPersonalModuleCatalog({
      repositoryRoot,
      outputRoot: snapshotStaging,
      write: false,
      generatedAt,
    });
    if (first.catalogSha256 !== second.catalogSha256) {
      throw new Error("Open Figure Catalog generation is not deterministic");
    }
    const catalogBytes = Buffer.from(stableJson(first.catalog), "utf8");
    const previewFiles = {};
    const built = first;
    for (const module of built.catalog.modules) {
      previewFiles[module.preview.path] = await fs.readFile(path.join(snapshotStaging, ...module.preview.path.split("/")));
      previewFiles[module.thumbnail.path] = await fs.readFile(path.join(snapshotStaging, ...module.thumbnail.path.split("/")));
    }
  const zipFirst = Buffer.from(buildPreviewZip(previewFiles));
  const zipSecond = Buffer.from(buildPreviewZip(previewFiles));
  if (!zipFirst.equals(zipSecond)) throw new Error("Open Figure preview ZIP generation is not deterministic");
  const previous = options.previousCatalog;
  const previousIds = previous?.modules?.map((module) => module.moduleId) ?? [];
  const nextIds = built.catalog.modules.map((module) => module.moduleId);
  const diff = diffModuleIds(previousIds, nextIds, options.previousTombstones ?? []);
  const unchanged = options.previousCatalogBytes &&
    Buffer.from(options.previousCatalogBytes).equals(catalogBytes) &&
    options.previousZipBytes &&
    Buffer.from(options.previousZipBytes).equals(zipFirst) &&
    canonical(diff.tombstones) === canonical(options.previousTombstones ?? []);
  const sequence = unchanged
    ? options.previousSequence
    : (options.previousSequence ?? 0) + 1;
    return {
      unchanged: Boolean(unchanged),
      sequence,
      catalog: built.catalog,
      catalogBytes,
      catalogSha256: sha256(catalogBytes),
      previewsBytes: zipFirst,
      previewsSha256: sha256(zipFirst),
      moduleCount: built.catalog.modules.length,
      diff,
    };
  } finally {
    if (createdStaging) await fs.rm(snapshotStaging, { recursive: true, force: true });
  }
}

async function readPreviousFeed(feedRoot) {
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(feedRoot, "current", "source-manifest.json"), "utf8"));
    const catalogUrl = new URL(manifest.catalog.url);
    const match = catalogUrl.pathname.match(/\/snapshots\/(\d+)\//u);
    const sequence = Number(match?.[1] ?? manifest.sequence);
    const catalogBytes = await fs.readFile(path.join(feedRoot, "snapshots", String(sequence), "module-catalog.json"));
    const zipBytes = await fs.readFile(path.join(feedRoot, "snapshots", String(sequence), "module-previews.zip"));
    return {
      manifest,
      sequence: manifest.sequence,
      catalogBytes,
      zipBytes,
      catalog: JSON.parse(catalogBytes.toString("utf8")),
      tombstones: manifest.tombstones ?? [],
    };
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function main(argv = process.argv.slice(2)) {
  const mode = argument("--mode", argv) ?? (flag("--validate", argv) ? "validate" : flag("--publish-prepare", argv) ? "publish-prepare" : flag("--sign", argv) ? "sign" : "validate");
  const repositoryRoot = argument("--repository", argv) ?? DEFAULT_REPOSITORY_ROOT;
  const outputRoot = argument("--output", argv);
  const feedRoot = argument("--feed-root", argv);
  const payloadCommit = argument("--payload-commit", argv);
  const expectedKeyId = argument("--expected-key-id", argv);
  const generatedAt = argument("--generated-at", argv) ?? new Date().toISOString();
  if (mode === "sign") {
    if (!outputRoot || !payloadCommit) throw new Error("--sign requires --output and --payload-commit");
    const seed = process.env.SFL_OPEN_FIGURE_ED25519_PRIVATE_KEY_BASE64?.trim();
    if (!seed) throw new Error("SFL_OPEN_FIGURE_ED25519_PRIVATE_KEY_BASE64 is required for signing");
    const payload = JSON.parse(await fs.readFile(path.join(outputRoot, "payload.json"), "utf8"));
    const catalogBytes = await fs.readFile(path.join(outputRoot, "snapshots", String(payload.sequence), "module-catalog.json"));
    const previewsBytes = await fs.readFile(path.join(outputRoot, "snapshots", String(payload.sequence), "module-previews.zip"));
    const manifest = buildSourceManifest({
      sequence: payload.sequence,
      generatedAt: payload.generatedAt,
      catalogBytes,
      previewsBytes,
      payloadCommit,
      tombstones: payload.tombstones,
      authorizedNextKeys: payload.authorizedNextKeys ?? [],
    });
    const manifestBytes = Buffer.from(stableJson(manifest), "utf8");
    const signed = signManifest(manifestBytes, seed, expectedKeyId);
    await fs.mkdir(path.join(outputRoot, "current"), { recursive: true });
    await fs.writeFile(path.join(outputRoot, "current", "source-manifest.json"), manifestBytes);
    await fs.writeFile(path.join(outputRoot, "current", "source-manifest.sig.json"), signed.sidecarBytes);
    const summary = {
      sequence: payload.sequence,
      payloadCommit,
      catalogSha256: payload.catalogSha256,
      previewsSha256: payload.previewsSha256,
      moduleCount: payload.moduleCount,
      signingKeyId: signed.keyId,
    };
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  }
  const previous = feedRoot ? await readPreviousFeed(feedRoot) : undefined;
  const payload = await buildOpenFigureFeedPayload({
    repositoryRoot,
    previousCatalog: previous?.catalog,
    previousCatalogBytes: previous?.catalogBytes,
    previousZipBytes: previous?.zipBytes,
    previousTombstones: previous?.tombstones,
    previousSequence: previous?.sequence,
    generatedAt,
    writeSnapshot: false,
    snapshotStaging: argument("--snapshot-staging", argv),
  });
  if (mode === "validate") {
    const summary = {
      unchanged: payload.unchanged,
      sequence: payload.sequence,
      catalogSha256: payload.catalogSha256,
      previewsSha256: payload.previewsSha256,
      moduleCount: payload.moduleCount,
      diff: payload.diff,
    };
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  }
  if (!outputRoot) throw new Error("publish-prepare requires --output");
  if (payload.unchanged) {
    const summary = { unchanged: true, sequence: payload.sequence, catalogSha256: payload.catalogSha256, previewsSha256: payload.previewsSha256, moduleCount: payload.moduleCount };
    await fs.mkdir(outputRoot, { recursive: true });
    await fs.writeFile(path.join(outputRoot, "result.json"), stableJson(summary));
    console.log(JSON.stringify(summary, null, 2));
    return payload;
  }
  const snapshotDir = path.join(outputRoot, "snapshots", String(payload.sequence));
  await fs.mkdir(snapshotDir, { recursive: true });
  await fs.writeFile(path.join(snapshotDir, "module-catalog.json"), payload.catalogBytes);
  await fs.writeFile(path.join(snapshotDir, "module-previews.zip"), payload.previewsBytes);
  await fs.writeFile(path.join(outputRoot, "payload.json"), stableJson({
    sequence: payload.sequence,
    generatedAt,
    catalogSha256: payload.catalogSha256,
    previewsSha256: payload.previewsSha256,
    moduleCount: payload.moduleCount,
    tombstones: payload.diff.tombstones,
    authorizedNextKeys: [],
  }));
  const summary = { unchanged: false, sequence: payload.sequence, catalogSha256: payload.catalogSha256, previewsSha256: payload.previewsSha256, moduleCount: payload.moduleCount, diff: payload.diff };
  await fs.writeFile(path.join(outputRoot, "result.json"), stableJson(summary));
  console.log(JSON.stringify(summary, null, 2));
  return summary;
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invoked) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
