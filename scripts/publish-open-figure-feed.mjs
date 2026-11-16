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

// Two signed channels share one sequence counter and one Catalog:
// - current/ (bundled): every preview and thumbnail in module-previews.zip. Read by clients <= 0.9.3.
//   It stops advancing (freezes) once that archive would exceed the client limits, so those clients
//   stay on their last good snapshot instead of failing.
// - current-on-demand/: thumbnails only in module-thumbnails.zip; every preview and thumbnail is also
//   committed loose under snapshots/<sequence>/ and fetched per file by clients >= 0.9.4.
export const BUNDLED_ARCHIVE = "module-previews.zip";
export const ON_DEMAND_ARCHIVE = "module-thumbnails.zip";
export const BUNDLED_CHANNEL_DIR = "current";
export const ON_DEMAND_CHANNEL_DIR = "current-on-demand";

export function buildPreviewZip(files) {
  return zipDeterministic(files, { level: 6 });
}

// Mirrors PROVIDER_SOURCE_PAYLOAD_LIMITS in src/provider-source-fetch.ts (a test keeps them equal).
// Installed clients reject a manifest outside these limits, so publishing one strands every client
// on its last snapshot.
export const CLIENT_PAYLOAD_LIMITS = Object.freeze({
  catalogBytes: 16 * 1024 * 1024,
  previewArchiveBytes: 64 * 1024 * 1024,
  previewExpandedBytes: 128 * 1024 * 1024,
  previewFileBytes: 64 * 1024 * 1024,
  previewFiles: 10_000,
});

const mib = (bytes) => `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;

export function assertWithinClientLimits(
  { catalogBytes, previewsBytes, previewFiles, archiveName = "module-previews.zip" },
  limits = CLIENT_PAYLOAD_LIMITS,
) {
  const entries = Object.entries(previewFiles).map(([name, data]) => ({ name, bytes: data.byteLength }));
  const expanded = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  const largest = () => [...entries].sort((a, b) => b.bytes - a.bytes).slice(0, 5)
    .map((entry) => `${entry.name} (${mib(entry.bytes)})`).join(", ");
  const problems = [];
  if (catalogBytes.byteLength > limits.catalogBytes) {
    problems.push(`catalog is ${mib(catalogBytes.byteLength)}, clients accept at most ${mib(limits.catalogBytes)}`);
  }
  if (previewsBytes.byteLength > limits.previewArchiveBytes) {
    problems.push(`${archiveName} is ${mib(previewsBytes.byteLength)}, clients accept at most ${mib(limits.previewArchiveBytes)}`);
  }
  if (expanded > limits.previewExpandedBytes) {
    problems.push(`previews expand to ${mib(expanded)}, clients accept at most ${mib(limits.previewExpandedBytes)}`);
  }
  if (entries.length > limits.previewFiles) {
    problems.push(`previews contain ${entries.length} files, clients accept at most ${limits.previewFiles}`);
  }
  for (const entry of entries) {
    if (entry.bytes > limits.previewFileBytes) problems.push(`${entry.name} is ${mib(entry.bytes)}, clients accept at most ${mib(limits.previewFileBytes)} per file`);
  }
  if (problems.length) {
    throw new Error(`Open Figure feed would be rejected by installed clients: ${problems.join("; ")}. Largest previews: ${largest()}`);
  }
}

export function buildSourceManifest({
  sequence,
  generatedAt,
  catalogBytes,
  previewsBytes,
  payloadCommit,
  tombstones = [],
  authorizedNextKeys = [],
  previewArchive = BUNDLED_ARCHIVE,
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
      url: officialPayloadUrl(payloadCommit, sequence, previewArchive),
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
    const thumbnailFiles = {};
    const built = first;
    for (const module of built.catalog.modules) {
      previewFiles[module.preview.path] = await fs.readFile(path.join(snapshotStaging, ...module.preview.path.split("/")));
      const thumbnail = await fs.readFile(path.join(snapshotStaging, ...module.thumbnail.path.split("/")));
      previewFiles[module.thumbnail.path] = thumbnail;
      thumbnailFiles[module.thumbnail.path] = thumbnail;
    }
    const deterministicZip = (files, label) => {
      const zipFirst = Buffer.from(buildPreviewZip(files));
      if (!zipFirst.equals(Buffer.from(buildPreviewZip(files)))) {
        throw new Error(`Open Figure ${label} ZIP generation is not deterministic`);
      }
      return zipFirst;
    };
    const bundledBytes = deterministicZip(previewFiles, "preview");
    const thumbnailsBytes = deterministicZip(thumbnailFiles, "thumbnail");
    // The on-demand channel is the one every current client can follow, so it must always fit.
    const limits = options.clientLimits ?? CLIENT_PAYLOAD_LIMITS;
    assertWithinClientLimits({ catalogBytes, previewsBytes: thumbnailsBytes, previewFiles: thumbnailFiles, archiveName: ON_DEMAND_ARCHIVE }, limits);
    // Loose files are fetched one at a time, so only the per-file limit applies to them.
    assertWithinClientLimits({
      catalogBytes,
      previewsBytes: new Uint8Array(0),
      previewFiles,
    }, { ...limits, previewExpandedBytes: Number.POSITIVE_INFINITY, previewFiles: Number.POSITIVE_INFINITY });
    let bundledFrozenReason;
    try {
      assertWithinClientLimits({ catalogBytes, previewsBytes: bundledBytes, previewFiles, archiveName: BUNDLED_ARCHIVE }, limits);
    } catch (error) {
      bundledFrozenReason = error instanceof Error ? error.message : String(error);
    }
    const previous = options.previousCatalog;
    const previousIds = previous?.modules?.map((module) => module.moduleId) ?? [];
    const nextIds = built.catalog.modules.map((module) => module.moduleId);
    const diff = diffModuleIds(previousIds, nextIds, options.previousTombstones ?? []);
    // Every preview identity is inside the Catalog, so an identical Catalog means identical previews.
    // The first run after this change is never "unchanged": the on-demand channel has to be created.
    const unchanged = Boolean(
      options.previousCatalogBytes &&
      options.previousOnDemandPublished &&
      Buffer.from(options.previousCatalogBytes).equals(catalogBytes) &&
      canonical(diff.tombstones) === canonical(options.previousTombstones ?? []),
    );
    const sequence = unchanged
      ? options.previousSequence
      : (options.previousSequence ?? 0) + 1;
    return {
      unchanged,
      sequence,
      catalog: built.catalog,
      catalogBytes,
      catalogSha256: sha256(catalogBytes),
      previewFiles,
      bundled: bundledFrozenReason
        ? { frozen: true, reason: bundledFrozenReason }
        : { frozen: false, bytes: bundledBytes, sha256: sha256(bundledBytes) },
      thumbnailsBytes,
      thumbnailsSha256: sha256(thumbnailsBytes),
      moduleCount: built.catalog.modules.length,
      diff,
    };
  } finally {
    if (createdStaging) await fs.rm(snapshotStaging, { recursive: true, force: true });
  }
}

async function readChannelManifest(feedRoot, channelDirectory) {
  try {
    return JSON.parse(await fs.readFile(path.join(feedRoot, channelDirectory, "source-manifest.json"), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
}

export async function readPreviousFeed(feedRoot) {
  const bundled = await readChannelManifest(feedRoot, BUNDLED_CHANNEL_DIR);
  const onDemand = await readChannelManifest(feedRoot, ON_DEMAND_CHANNEL_DIR);
  // The newest channel is the authority for the Catalog and tombstones; a frozen bundled channel
  // lags behind it. Both share one sequence counter.
  const latest = [bundled, onDemand].filter(Boolean).sort((left, right) => right.sequence - left.sequence)[0];
  if (!latest) return undefined;
  const catalogBytes = await fs.readFile(path.join(feedRoot, "snapshots", String(latest.sequence), "module-catalog.json"));
  return {
    sequence: latest.sequence,
    bundledSequence: bundled?.sequence,
    onDemandPublished: Boolean(onDemand) && onDemand.sequence === latest.sequence,
    catalogBytes,
    catalog: JSON.parse(catalogBytes.toString("utf8")),
    tombstones: latest.tombstones ?? [],
  };
}

async function writeSignedChannel(outputRoot, channelDirectory, manifest, seed, expectedKeyId) {
  const manifestBytes = Buffer.from(stableJson(manifest), "utf8");
  const signed = signManifest(manifestBytes, seed, expectedKeyId);
  await fs.mkdir(path.join(outputRoot, channelDirectory), { recursive: true });
  await fs.writeFile(path.join(outputRoot, channelDirectory, "source-manifest.json"), manifestBytes);
  await fs.writeFile(path.join(outputRoot, channelDirectory, "source-manifest.sig.json"), signed.sidecarBytes);
  return signed;
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
    const snapshotDir = path.join(outputRoot, "snapshots", String(payload.sequence));
    const catalogBytes = await fs.readFile(path.join(snapshotDir, "module-catalog.json"));
    const common = {
      sequence: payload.sequence,
      generatedAt: payload.generatedAt,
      catalogBytes,
      payloadCommit,
      tombstones: payload.tombstones,
      authorizedNextKeys: payload.authorizedNextKeys ?? [],
    };
    const signed = await writeSignedChannel(outputRoot, ON_DEMAND_CHANNEL_DIR, buildSourceManifest({
      ...common,
      previewsBytes: await fs.readFile(path.join(snapshotDir, ON_DEMAND_ARCHIVE)),
      previewArchive: ON_DEMAND_ARCHIVE,
    }), seed, expectedKeyId);
    if (!payload.bundledFrozen) {
      await writeSignedChannel(outputRoot, BUNDLED_CHANNEL_DIR, buildSourceManifest({
        ...common,
        previewsBytes: await fs.readFile(path.join(snapshotDir, BUNDLED_ARCHIVE)),
        previewArchive: BUNDLED_ARCHIVE,
      }), seed, expectedKeyId);
    }
    const summary = {
      sequence: payload.sequence,
      payloadCommit,
      catalogSha256: payload.catalogSha256,
      previewsSha256: payload.previewsSha256 ?? null,
      thumbnailsSha256: payload.thumbnailsSha256,
      bundledFrozen: payload.bundledFrozen === true,
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
    previousOnDemandPublished: previous?.onDemandPublished,
    previousTombstones: previous?.tombstones,
    previousSequence: previous?.sequence,
    generatedAt,
    writeSnapshot: false,
    snapshotStaging: argument("--snapshot-staging", argv),
  });
  const bundledSummary = payload.bundled.frozen
    ? { bundledFrozen: true, bundledFrozenAt: previous?.bundledSequence ?? null, bundledFrozenReason: payload.bundled.reason }
    : { bundledFrozen: false, previewsSha256: payload.bundled.sha256 };
  const summaryBase = {
    sequence: payload.sequence,
    catalogSha256: payload.catalogSha256,
    thumbnailsSha256: payload.thumbnailsSha256,
    moduleCount: payload.moduleCount,
    ...bundledSummary,
  };
  if (payload.bundled.frozen) {
    console.warn(`Bundled channel stays at sequence ${previous?.bundledSequence ?? "none"} for clients up to 0.9.3: ${payload.bundled.reason}`);
  }
  if (mode === "validate") {
    const summary = { unchanged: payload.unchanged, ...summaryBase, diff: payload.diff };
    console.log(JSON.stringify(summary, null, 2));
    return summary;
  }
  if (!outputRoot) throw new Error("publish-prepare requires --output");
  if (payload.unchanged) {
    const summary = { unchanged: true, ...summaryBase };
    await fs.mkdir(outputRoot, { recursive: true });
    await fs.writeFile(path.join(outputRoot, "result.json"), stableJson(summary));
    console.log(JSON.stringify(summary, null, 2));
    return payload;
  }
  const snapshotDir = path.join(outputRoot, "snapshots", String(payload.sequence));
  await fs.mkdir(snapshotDir, { recursive: true });
  await fs.writeFile(path.join(snapshotDir, "module-catalog.json"), payload.catalogBytes);
  await fs.writeFile(path.join(snapshotDir, ON_DEMAND_ARCHIVE), payload.thumbnailsBytes);
  if (!payload.bundled.frozen) await fs.writeFile(path.join(snapshotDir, BUNDLED_ARCHIVE), payload.bundled.bytes);
  // Loose copies at the Catalog paths, fetched per file by on-demand clients. Git stores unchanged
  // images once however many snapshot directories reference them.
  for (const [relative, bytes] of Object.entries(payload.previewFiles)) {
    const target = path.join(snapshotDir, ...relative.split("/"));
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, bytes);
  }
  await fs.writeFile(path.join(outputRoot, "payload.json"), stableJson({
    sequence: payload.sequence,
    generatedAt,
    catalogSha256: payload.catalogSha256,
    ...(payload.bundled.frozen ? { bundledFrozen: true } : { previewsSha256: payload.bundled.sha256 }),
    thumbnailsSha256: payload.thumbnailsSha256,
    moduleCount: payload.moduleCount,
    tombstones: payload.diff.tombstones,
    authorizedNextKeys: [],
  }));
  const summary = { unchanged: false, ...summaryBase, diff: payload.diff };
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
