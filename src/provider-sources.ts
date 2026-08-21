import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJson, compareCanonicalStrings } from "./canonical-json.ts";
import { withCrossRuntimeWriteLock } from "./cross-runtime-lock.ts";
import { assertPortableFilesystemSegment, portableCaseFold } from "./library-runtime.ts";
import { parsePublicProviderCatalog } from "./public-catalog-provider.ts";
import {
  SecureProviderSourceFetcher,
  deriveProviderSourceSignatureUrl,
  ed25519PublicKeyIdentity,
  fetchVerifiedProviderSourceSnapshot,
  parsePersonalProviderCatalogBytes,
  parseProviderSourceManifestBytes,
  parseProviderSourceSignatureBytes,
  verifyEd25519Detached,
  type Ed25519PublicKeyIdentity,
  type PersonalCatalogEntryObservation,
  type VerifiedProviderSourceSnapshot,
} from "./provider-source-fetch.ts";

export const PROVIDER_SOURCE_REGISTRY_SCHEMA = "figure-library.provider-sources.v1" as const;
export const PROVIDER_SOURCE_CHANGE_PLAN_SCHEMA =
  "figure-library.provider-source-change-plan.v1" as const;
export const PROVIDER_SOURCE_ALREADY_CURRENT_SCHEMA =
  "figure-library.provider-source-already-current.v1" as const;
export const PROVIDER_SOURCE_CHANGE_RECEIPT_SCHEMA =
  "figure-library.provider-source-change-receipt.v1" as const;
export const PROVIDER_SOURCE_CHANGE_INTENT_SCHEMA =
  "figure-library.provider-source-change-intent.v1" as const;
export const PROVIDER_SOURCE_SNAPSHOT_INVENTORY_ENTRY_SCHEMA =
  "figure-library.provider-source-snapshot-inventory-entry.v1" as const;

const HASH = /^[a-f0-9]{64}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]{1,126}[a-z0-9]$/u;
const PLAN_TTL_MS = 30 * 60 * 1_000;
const PLAN_LIMIT = 64;
const MAX_OBSERVED_REVISIONS = 10_000;

/**
 * The fetch layer validates signed bytes, the compact preview inventory, and
 * the preview ZIP. Before any of those bytes can become an active Provider,
 * validate the complete public Catalog contract used by the runtime adapter.
 * Keeping this gate here avoids a provider-source -> runtime dependency while
 * ensuring Plan, Apply re-fetch, and last-known-good loading all share the
 * authoritative public Catalog parser.
 */
function validateCompletePersonalCatalog(
  bytes: Uint8Array,
  expectedProviderId: string,
  observed?: PersonalCatalogEntryObservation[],
) {
  const catalog = parsePublicProviderCatalog(bytes);
  if (catalog.provider.providerId !== expectedProviderId) {
    throw new Error("complete public Catalog providerId does not match the personal Provider source");
  }
  const entries: PersonalCatalogEntryObservation[] = catalog.entries.map((entry) => ({
    templateId: entry.templateId,
    releaseVersion: entry.releaseVersion,
    contentDigest: entry.contentDigest,
    identity: `${entry.templateId}@${entry.releaseVersion}`,
    preview: { ...entry.preview },
  }));
  if (observed && canonicalJson(entries) !== canonicalJson(observed)) {
    throw new Error("complete public Catalog differs from its verified preview inventory observation");
  }
  return entries;
}

type Environment = Readonly<Record<string, string | undefined>>;

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertExactKeys(value: Record<string, unknown>, expected: string[], label: string) {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error(`${label} has unsupported or missing fields`);
  }
}

function assertHttpsUrl(value: unknown, label: string) {
  if (typeof value !== "string" || !value || value.length > 4_000) {
    throw new Error(`${label} is invalid`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is invalid`);
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(`${label} must be credential-free HTTPS without a fragment`);
  }
  return url.href;
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be SHA-256`);
}

function assertProviderId(value: string, label = "providerId") {
  if (!PROVIDER_ID.test(value)) throw new Error(`${label} is invalid: ${value}`);
  assertPortableFilesystemSegment(value, label);
  if (
    value === "org.figureya.module" ||
    value.startsWith("org.figureya.") ||
    value === "org.scientificfigurelibrary.local" ||
    value.startsWith("org.scientificfigurelibrary.")
  ) {
    throw new Error(`personal provider cannot claim reserved providerId: ${value}`);
  }
  return value;
}

async function assertRegularFile(file: string, label: string) {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} must be a regular file`);
}

async function assertRegularDirectory(directory: string, label: string) {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`${label} must be a regular directory`);
}

async function atomicWriteJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await assertRegularDirectory(path.dirname(file), "provider source config directory");
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function immutableWriteJson(file: string, value: unknown) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, serialized, { flag: "wx" });
    await fs.chmod(file, 0o444).catch(() => undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    await assertRegularFile(file, "provider source immutable JSON");
    if ((await fs.readFile(file, "utf8")) !== serialized) {
      throw new Error(`provider source immutable metadata collision: ${file}`);
    }
  }
}

export interface ProviderSourcePaths {
  registryFile: string;
  configRoot: string;
  dataRoot: string;
}

export function providerSourcePaths(options: {
  platform?: NodeJS.Platform;
  env?: Environment;
  homedir?: string;
  registryFile?: string;
  dataRoot?: string;
} = {}): ProviderSourcePaths {
  const platform = options.platform ?? process.platform;
  const environment = options.env ?? process.env;
  const home = options.homedir ?? os.homedir();
  const implementation = platform === "win32" ? path.win32 : path.posix;
  const configRoot = platform === "win32"
    ? implementation.join(
        environment.APPDATA?.trim() || implementation.join(home, "AppData", "Roaming"),
        "ScientificFigureLibrary",
      )
    : implementation.join(
        environment.XDG_CONFIG_HOME?.trim() || implementation.join(home, ".config"),
        "scientific-figure-library",
      );
  const dataRoot = options.dataRoot ?? (platform === "win32"
    ? implementation.join(
        environment.LOCALAPPDATA?.trim() || implementation.join(home, "AppData", "Local"),
        "ScientificFigureLibrary",
        "provider-sources",
      )
    : implementation.join(
        environment.XDG_DATA_HOME?.trim() || implementation.join(home, ".local", "share"),
        "scientific-figure-library",
        "provider-sources",
      ));
  return {
    registryFile: options.registryFile ?? implementation.join(configRoot, "provider-sources.json"),
    configRoot,
    dataRoot,
  };
}

export interface ProviderSourceSnapshotRefV1 {
  manifestSha256: string;
  sequence: number;
  generatedAt: string;
  signingKeyId: string;
  catalogSha256: string;
  catalogBytes: number;
  previewsSha256: string;
  previewsBytes: number;
  templateCount: number;
  inventorySha256: string;
  inventoryEntries: number;
}

export interface ProviderSourceRecordV1 {
  providerId: string;
  manifestUrl: string;
  enabled: boolean;
  includeInDefaultSearch: boolean;
  trustEpoch: number;
  signingKey: Ed25519PublicKeyIdentity;
  authorizedNextKeys: Ed25519PublicKeyIdentity[];
  activeSnapshot: ProviderSourceSnapshotRefV1;
  observedRevisions: Array<{
    trustEpoch: number;
    sequence: number;
    manifestSha256: string;
  }>;
  updatedAt: string;
}

export interface ProviderSourceRegistryV1 {
  schema: typeof PROVIDER_SOURCE_REGISTRY_SCHEMA;
  configRevision: number;
  sources: ProviderSourceRecordV1[];
  updatedAt: string;
}

export interface ProviderSourceSnapshotInventoryEntryV1 {
  schema: typeof PROVIDER_SOURCE_SNAPSHOT_INVENTORY_ENTRY_SCHEMA;
  sourcePayload: "source-manifest" | "signature-sidecar" | "catalog" | "previews-archive-entry";
  sourceUrl: string;
  sourcePath?: string;
  localPath: string;
  bytes: number;
  sha256: string;
  mediaType: "application/json" | "image/png";
}

export type ProviderSourceChangeAction = "add" | "update" | "configure" | "remove" | "trust_reset";

export type ProviderSourceChangeInput =
  | {
      action: "add";
      expectedProviderId: string;
      manifestUrl: string;
      publicKeyBase64: string;
      enabled?: boolean;
      includeInDefaultSearch?: boolean;
    }
  | { action: "update"; providerId: string }
  | {
      action: "configure";
      providerId: string;
      enabled?: boolean;
      includeInDefaultSearch?: boolean;
      manifestUrl?: string;
    }
  | { action: "remove"; providerId: string }
  | {
      action: "trust_reset";
      providerId: string;
      publicKeyBase64: string;
      manifestUrl?: string;
      allowSequenceReset?: boolean;
    };

export interface ProviderSourceTemplateDiffV1 {
  added: string[];
  updated: Array<{ identity: string; previousContentDigest: string; nextContentDigest: string }>;
  withdrawn: string[];
  tombstones: string[];
}

export interface ProviderSourceChangePlanV1 {
  schema: typeof PROVIDER_SOURCE_CHANGE_PLAN_SCHEMA;
  planId: string;
  action: ProviderSourceChangeAction;
  providerId: string;
  expectedRegistryDigest: string;
  expectedConfigRevision: number;
  proposedRegistryDigest: string;
  proposedConfigRevision: number;
  manifestUrl?: string;
  accessUrls: string[];
  configPath: string;
  targetSnapshotPath?: string;
  enabled?: boolean;
  includeInDefaultSearch?: boolean;
  previousSigningKeyId?: string;
  signingKeyId?: string;
  previousTrustEpoch?: number;
  trustEpoch?: number;
  snapshot?: ProviderSourceSnapshotRefV1;
  templateDiff: ProviderSourceTemplateDiffV1;
  warnings: string[];
  allowSequenceReset?: boolean;
  createdAt: string;
  planDigest: string;
}

export interface ProviderSourceAlreadyCurrentV1 {
  schema: typeof PROVIDER_SOURCE_ALREADY_CURRENT_SCHEMA;
  status: "already_current";
  action: "update" | "configure" | "trust_reset";
  providerId: string;
  sequence: number;
  manifestSha256: string;
  configRevision: number;
  observedAt: string;
}

export interface ProviderSourceChangeReceiptV1 {
  schema: typeof PROVIDER_SOURCE_CHANGE_RECEIPT_SCHEMA;
  receiptId: string;
  operationId: string;
  planDigest: string;
  action: ProviderSourceChangeAction;
  providerId: string;
  proposedRegistryDigest: string;
  configRevision: number;
  manifestSha256?: string;
  trustReset?: {
    previousKeyId: string;
    nextKeyId: string;
    previousTrustEpoch: number;
    nextTrustEpoch: number;
    allowSequenceReset: boolean;
  };
  appliedAt: string;
}

interface PreparedProviderSourcePlan {
  publicPlan: ProviderSourceChangePlanV1;
  proposedRegistry: ProviderSourceRegistryV1;
  snapshot?: VerifiedProviderSourceSnapshot;
  snapshotInventory?: ProviderSourceSnapshotInventoryEntryV1[];
  expiresAt: number;
}

interface ProviderSourceChangeIntentV1 {
  schema: typeof PROVIDER_SOURCE_CHANGE_INTENT_SCHEMA;
  operationId: string;
  planDigest: string;
  action: ProviderSourceChangeAction;
  providerId: string;
  publicPlan: ProviderSourceChangePlanV1;
  proposedRegistry: ProviderSourceRegistryV1;
  createdAt: string;
}

function emptyRegistry(): ProviderSourceRegistryV1 {
  return {
    schema: PROVIDER_SOURCE_REGISTRY_SCHEMA,
    configRevision: 0,
    sources: [],
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

function registryDigest(value: ProviderSourceRegistryV1) {
  return sha256(canonicalJson(value));
}

function sortSources(sources: ProviderSourceRecordV1[]) {
  return [...sources].sort((left, right) => compareCanonicalStrings(left.providerId, right.providerId));
}

function validateKey(value: unknown, label: string): Ed25519PublicKeyIdentity {
  if (!isRecord(value) || value.algorithm !== "ed25519" || typeof value.publicKeyBase64 !== "string") {
    throw new Error(`${label} is invalid`);
  }
  assertExactKeys(value, ["algorithm", "publicKeyBase64", "keyId"], label);
  const key = ed25519PublicKeyIdentity(value.publicKeyBase64);
  if (value.keyId !== key.keyId) throw new Error(`${label} keyId is invalid`);
  return key;
}

function validateSnapshotRef(value: unknown): asserts value is ProviderSourceSnapshotRefV1 {
  if (!isRecord(value)) throw new Error("provider source activeSnapshot is invalid");
  assertExactKeys(value, [
    "manifestSha256", "sequence", "generatedAt", "signingKeyId", "catalogSha256",
    "catalogBytes", "previewsSha256", "previewsBytes", "templateCount", "inventorySha256",
    "inventoryEntries",
  ], "provider source activeSnapshot");
  for (const field of ["manifestSha256", "signingKeyId", "catalogSha256", "previewsSha256", "inventorySha256"]) {
    assertHash(value[field], `activeSnapshot ${field}`);
  }
  if (
    !Number.isSafeInteger(value.sequence) || Number(value.sequence) < 1 ||
    typeof value.generatedAt !== "string" || Number.isNaN(Date.parse(value.generatedAt)) ||
    !Number.isSafeInteger(value.catalogBytes) || Number(value.catalogBytes) < 1 ||
    !Number.isSafeInteger(value.previewsBytes) || Number(value.previewsBytes) < 1 ||
    !Number.isSafeInteger(value.templateCount) || Number(value.templateCount) < 0 ||
    !Number.isSafeInteger(value.inventoryEntries) || Number(value.inventoryEntries) < 3
  ) {
    throw new Error("provider source activeSnapshot fields are invalid");
  }
}

function validateRecord(value: unknown): asserts value is ProviderSourceRecordV1 {
  if (!isRecord(value)) throw new Error("provider source record is invalid");
  assertExactKeys(value, [
    "providerId", "manifestUrl", "enabled", "includeInDefaultSearch", "trustEpoch", "signingKey",
    "authorizedNextKeys", "activeSnapshot", "observedRevisions", "updatedAt",
  ], "provider source record");
  const providerId = assertProviderId(String(value.providerId ?? ""));
  if (
    typeof value.manifestUrl !== "string" ||
    deriveProviderSourceSignatureUrl(value.manifestUrl).length < 1 ||
    typeof value.enabled !== "boolean" ||
    typeof value.includeInDefaultSearch !== "boolean" ||
    (value.includeInDefaultSearch && !value.enabled) ||
    !Number.isSafeInteger(value.trustEpoch) || Number(value.trustEpoch) < 1 ||
    typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))
  ) {
    throw new Error("provider source record fields are invalid");
  }
  const signingKey = validateKey(value.signingKey, "provider source signingKey");
  if (!Array.isArray(value.authorizedNextKeys) || value.authorizedNextKeys.length > 16) {
    throw new Error("provider source authorizedNextKeys is invalid");
  }
  const authorized = value.authorizedNextKeys.map((item) =>
    validateKey(item, "provider source authorized next key"));
  if (new Set(authorized.map((item) => item.keyId)).size !== authorized.length) {
    throw new Error("provider source authorizedNextKeys contains a duplicate");
  }
  validateSnapshotRef(value.activeSnapshot);
  if (value.activeSnapshot.signingKeyId !== signingKey.keyId) {
    throw new Error("provider source active snapshot signing key does not match the record");
  }
  if (!Array.isArray(value.observedRevisions) || value.observedRevisions.length > MAX_OBSERVED_REVISIONS) {
    throw new Error("provider source observed revision history is invalid");
  }
  const observed = new Set<string>();
  for (const revision of value.observedRevisions) {
    if (
      !isRecord(revision) ||
      !Number.isSafeInteger(revision.trustEpoch) || Number(revision.trustEpoch) < 1 ||
      !Number.isSafeInteger(revision.sequence) || Number(revision.sequence) < 1
    ) {
      throw new Error("provider source observed revision is invalid");
    }
    assertExactKeys(revision, ["trustEpoch", "sequence", "manifestSha256"], "provider source observed revision");
    assertHash(revision.manifestSha256, "observed manifestSha256");
    const identity = `${revision.trustEpoch}:${revision.sequence}`;
    if (observed.has(identity)) throw new Error("provider source observed revision is duplicated");
    observed.add(identity);
  }
  if (providerId !== value.providerId) throw new Error("provider source providerId is not canonical");
}

function validateRegistry(value: unknown): ProviderSourceRegistryV1 {
  if (!isRecord(value) || value.schema !== PROVIDER_SOURCE_REGISTRY_SCHEMA) {
    throw new Error("unsupported provider source registry schema");
  }
  assertExactKeys(value, ["schema", "configRevision", "sources", "updatedAt"], "provider source registry");
  if (
    !Number.isSafeInteger(value.configRevision) || Number(value.configRevision) < 0 ||
    typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt)) ||
    !Array.isArray(value.sources)
  ) {
    throw new Error("provider source registry fields are invalid");
  }
  value.sources.forEach(validateRecord);
  const providerIds = new Set<string>();
  let previous = "";
  for (const source of value.sources as ProviderSourceRecordV1[]) {
    const folded = portableCaseFold(source.providerId);
    if (providerIds.has(folded)) throw new Error("providerId case-fold collision");
    if (previous && compareCanonicalStrings(previous, source.providerId) >= 0) {
      throw new Error("provider source registry ordering is invalid");
    }
    providerIds.add(folded);
    previous = source.providerId;
  }
  return value as unknown as ProviderSourceRegistryV1;
}

function validateTemplateDiff(value: unknown): asserts value is ProviderSourceTemplateDiffV1 {
  if (
    !isRecord(value) ||
    !Array.isArray(value.added) ||
    !Array.isArray(value.updated) ||
    !Array.isArray(value.withdrawn) ||
    !Array.isArray(value.tombstones) ||
    [...value.added, ...value.withdrawn, ...value.tombstones].some((item) => typeof item !== "string")
  ) {
    throw new Error("provider source plan template diff is invalid");
  }
  for (const item of value.updated) {
    if (
      !isRecord(item) ||
      typeof item.identity !== "string" ||
      typeof item.previousContentDigest !== "string" ||
      typeof item.nextContentDigest !== "string"
    ) {
      throw new Error("provider source plan updated template diff is invalid");
    }
    assertHash(item.previousContentDigest, "provider source previous content digest");
    assertHash(item.nextContentDigest, "provider source next content digest");
  }
}

function validateChangePlan(value: unknown): ProviderSourceChangePlanV1 {
  if (!isRecord(value) || value.schema !== PROVIDER_SOURCE_CHANGE_PLAN_SCHEMA) {
    throw new Error("unsupported provider source change plan schema");
  }
  const allowedPlanKeys = new Set([
    "schema", "planId", "action", "providerId", "expectedRegistryDigest", "expectedConfigRevision",
    "proposedRegistryDigest", "proposedConfigRevision", "manifestUrl", "accessUrls",
    "configPath", "targetSnapshotPath", "enabled", "includeInDefaultSearch", "previousSigningKeyId",
    "signingKeyId", "previousTrustEpoch", "trustEpoch", "snapshot", "templateDiff", "warnings",
    "allowSequenceReset", "createdAt", "planDigest",
  ]);
  if (Object.keys(value).some((key) => !allowedPlanKeys.has(key))) {
    throw new Error("provider source change plan has unsupported fields");
  }
  if (
    typeof value.planId !== "string" || !value.planId.startsWith("provider-source-plan-") ||
    (value.action !== "add" && value.action !== "update" && value.action !== "configure" &&
      value.action !== "remove" && value.action !== "trust_reset") ||
    typeof value.providerId !== "string" ||
    !Number.isSafeInteger(value.expectedConfigRevision) || Number(value.expectedConfigRevision) < 0 ||
    !Number.isSafeInteger(value.proposedConfigRevision) ||
      Number(value.proposedConfigRevision) !== Number(value.expectedConfigRevision) + 1 ||
    typeof value.configPath !== "string" || !value.configPath ||
    !Array.isArray(value.accessUrls) || value.accessUrls.some((url) => typeof url !== "string") ||
    !Array.isArray(value.warnings) || value.warnings.some((warning) => typeof warning !== "string") ||
    typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))
  ) {
    throw new Error("provider source change plan fields are invalid");
  }
  assertProviderId(value.providerId);
  assertHash(value.expectedRegistryDigest, "provider source expected registry digest");
  assertHash(value.proposedRegistryDigest, "provider source proposed registry digest");
  assertHash(value.planDigest, "provider source plan digest");
  if (value.manifestUrl !== undefined) assertHttpsUrl(value.manifestUrl, "provider source plan manifestUrl");
  for (const url of value.accessUrls) assertHttpsUrl(url, "provider source plan access URL");
  if (value.snapshot !== undefined) validateSnapshotRef(value.snapshot);
  validateTemplateDiff(value.templateDiff);
  const { planDigest, ...unsigned } = value;
  if (sha256(canonicalJson(unsigned)) !== planDigest) {
    throw new Error("provider source change plan digest is invalid");
  }
  return value as unknown as ProviderSourceChangePlanV1;
}

function validateReceipt(value: unknown): ProviderSourceChangeReceiptV1 {
  if (!isRecord(value) || value.schema !== PROVIDER_SOURCE_CHANGE_RECEIPT_SCHEMA) {
    throw new Error("unsupported provider source change receipt schema");
  }
  const receiptKeys = [
    "schema", "receiptId", "operationId", "planDigest", "action", "providerId",
    "proposedRegistryDigest", "configRevision", ...(value.manifestSha256 === undefined ? [] : ["manifestSha256"]),
    ...(value.trustReset === undefined ? [] : ["trustReset"]), "appliedAt",
  ];
  assertExactKeys(value, receiptKeys, "provider source change receipt");
  if (
    typeof value.receiptId !== "string" || !value.receiptId.startsWith("provider-source-receipt-") ||
    typeof value.operationId !== "string" || !OPERATION_ID.test(value.operationId) ||
    (value.action !== "add" && value.action !== "update" && value.action !== "configure" &&
      value.action !== "remove" && value.action !== "trust_reset") ||
    typeof value.providerId !== "string" ||
    !Number.isSafeInteger(value.configRevision) || Number(value.configRevision) < 1 ||
    typeof value.appliedAt !== "string" || Number.isNaN(Date.parse(value.appliedAt))
  ) {
    throw new Error("provider source change receipt fields are invalid");
  }
  assertProviderId(value.providerId);
  assertHash(value.planDigest, "provider source receipt plan digest");
  assertHash(value.proposedRegistryDigest, "provider source receipt registry digest");
  if (value.manifestSha256 !== undefined) assertHash(value.manifestSha256, "provider source receipt manifest digest");
  if (value.trustReset !== undefined) {
    if (!isRecord(value.trustReset)) throw new Error("provider source trust reset receipt is invalid");
    assertExactKeys(value.trustReset, [
      "previousKeyId", "nextKeyId", "previousTrustEpoch", "nextTrustEpoch", "allowSequenceReset",
    ], "provider source trust reset receipt");
    assertHash(value.trustReset.previousKeyId, "provider source previous trust key");
    assertHash(value.trustReset.nextKeyId, "provider source next trust key");
    if (
      !Number.isSafeInteger(value.trustReset.previousTrustEpoch) ||
      !Number.isSafeInteger(value.trustReset.nextTrustEpoch) ||
      Number(value.trustReset.nextTrustEpoch) !== Number(value.trustReset.previousTrustEpoch) + 1 ||
      typeof value.trustReset.allowSequenceReset !== "boolean"
    ) {
      throw new Error("provider source trust reset receipt fields are invalid");
    }
  }
  return value as unknown as ProviderSourceChangeReceiptV1;
}

function validateIntent(value: unknown): ProviderSourceChangeIntentV1 {
  if (!isRecord(value) || value.schema !== PROVIDER_SOURCE_CHANGE_INTENT_SCHEMA) {
    throw new Error("unsupported provider source change intent schema");
  }
  assertExactKeys(value, [
    "schema", "operationId", "planDigest", "action", "providerId", "publicPlan", "proposedRegistry", "createdAt",
  ], "provider source change intent");
  if (
    typeof value.operationId !== "string" || !OPERATION_ID.test(value.operationId) ||
    typeof value.providerId !== "string" ||
    typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))
  ) {
    throw new Error("provider source change intent fields are invalid");
  }
  const plan = validateChangePlan(value.publicPlan);
  const registry = validateRegistry(value.proposedRegistry);
  if (
    value.planDigest !== plan.planDigest ||
    value.action !== plan.action ||
    value.providerId !== plan.providerId ||
    registryDigest(registry) !== plan.proposedRegistryDigest ||
    registry.configRevision !== plan.proposedConfigRevision
  ) {
    throw new Error("provider source change intent does not match its plan and registry");
  }
  return value as unknown as ProviderSourceChangeIntentV1;
}

function snapshotInventory(snapshot: VerifiedProviderSourceSnapshot) {
  const values: ProviderSourceSnapshotInventoryEntryV1[] = [
    {
      schema: PROVIDER_SOURCE_SNAPSHOT_INVENTORY_ENTRY_SCHEMA,
      sourcePayload: "source-manifest",
      sourceUrl: snapshot.accessUrls[0]!,
      localPath: "source-manifest.json",
      bytes: snapshot.manifestBytes.byteLength,
      sha256: snapshot.manifestSha256,
      mediaType: "application/json",
    },
    {
      schema: PROVIDER_SOURCE_SNAPSHOT_INVENTORY_ENTRY_SCHEMA,
      sourcePayload: "signature-sidecar",
      sourceUrl: snapshot.accessUrls[1]!,
      localPath: "source-manifest.sig.json",
      bytes: snapshot.signatureSidecarBytes.byteLength,
      sha256: snapshot.signatureSidecarSha256,
      mediaType: "application/json",
    },
    {
      schema: PROVIDER_SOURCE_SNAPSHOT_INVENTORY_ENTRY_SCHEMA,
      sourcePayload: "catalog",
      sourceUrl: snapshot.accessUrls[2]!,
      localPath: "catalog.json",
      bytes: snapshot.catalogBytes.byteLength,
      sha256: snapshot.catalogSha256,
      mediaType: "application/json",
    },
    ...snapshot.previewFiles.map((preview): ProviderSourceSnapshotInventoryEntryV1 => ({
      schema: PROVIDER_SOURCE_SNAPSHOT_INVENTORY_ENTRY_SCHEMA,
      sourcePayload: "previews-archive-entry",
      sourceUrl: snapshot.accessUrls[3]!,
      sourcePath: preview.path,
      localPath: preview.snapshotPath,
      bytes: preview.bytes,
      sha256: preview.sha256,
      mediaType: "image/png",
    })),
  ];
  return values.sort((left, right) => compareCanonicalStrings(left.localPath, right.localPath));
}

function inventoryBytes(inventory: ProviderSourceSnapshotInventoryEntryV1[]) {
  return new TextEncoder().encode(`${inventory.map((entry) => canonicalJson(entry)).join("\n")}\n`);
}

function snapshotRef(
  snapshot: VerifiedProviderSourceSnapshot,
  inventory: ProviderSourceSnapshotInventoryEntryV1[],
): ProviderSourceSnapshotRefV1 {
  return {
    manifestSha256: snapshot.manifestSha256,
    sequence: snapshot.manifest.sequence,
    generatedAt: snapshot.manifest.generatedAt,
    signingKeyId: snapshot.signingKey.keyId,
    catalogSha256: snapshot.catalogSha256,
    catalogBytes: snapshot.catalogBytes.byteLength,
    previewsSha256: snapshot.previewsArchiveSha256,
    previewsBytes: snapshot.previewsArchiveBytes,
    templateCount: snapshot.catalog.entries.length,
    inventorySha256: sha256(inventoryBytes(inventory)),
    inventoryEntries: inventory.length,
  };
}

function sameSnapshotReference(
  left: ProviderSourceSnapshotRefV1,
  right: ProviderSourceSnapshotRefV1,
) {
  return canonicalJson(left) === canonicalJson(right);
}

function appendObservation(options: {
  source?: ProviderSourceRecordV1;
  trustEpoch: number;
  snapshot: VerifiedProviderSourceSnapshot;
  allowSequenceReset: boolean;
}) {
  const { source, trustEpoch, snapshot, allowSequenceReset } = options;
  const sameEpoch = source?.observedRevisions.find(
    (item) => item.trustEpoch === trustEpoch && item.sequence === snapshot.manifest.sequence,
  );
  if (sameEpoch && sameEpoch.manifestSha256 !== snapshot.manifestSha256) {
    throw new Error(`provider source equivocation at sequence ${snapshot.manifest.sequence}`);
  }
  if (source && !allowSequenceReset && snapshot.manifest.sequence < source.activeSnapshot.sequence) {
    throw new Error(
      `provider source rollback rejected: ${snapshot.manifest.sequence} < ${source.activeSnapshot.sequence}`,
    );
  }
  if (
    source &&
    trustEpoch !== source.trustEpoch &&
    snapshot.manifest.sequence === source.activeSnapshot.sequence &&
    snapshot.manifestSha256 !== source.activeSnapshot.manifestSha256 &&
    !allowSequenceReset
  ) {
    throw new Error("provider source same-sequence trust reset requires allowSequenceReset");
  }
  const values = source ? [...source.observedRevisions] : [];
  if (!sameEpoch) {
    values.push({
      trustEpoch,
      sequence: snapshot.manifest.sequence,
      manifestSha256: snapshot.manifestSha256,
    });
  }
  if (values.length > MAX_OBSERVED_REVISIONS) {
    throw new Error("provider source observed revision history is full; automatic history GC is forbidden");
  }
  return values.sort((left, right) =>
    left.trustEpoch - right.trustEpoch || left.sequence - right.sequence);
}

function transitionVerificationKeys(source: ProviderSourceRecordV1) {
  return [source.signingKey, ...source.authorizedNextKeys].filter(
    (key, index, values) => values.findIndex((candidate) => candidate.keyId === key.keyId) === index,
  );
}

function assertAuthorizedKeyTransition(
  source: ProviderSourceRecordV1,
  snapshot: VerifiedProviderSourceSnapshot,
) {
  if (snapshot.signingKey.keyId === source.signingKey.keyId) return;
  const authorized = source.authorizedNextKeys.find(
    (key) => key.keyId === snapshot.signingKey.keyId && key.publicKeyBase64 === snapshot.signingKey.publicKeyBase64,
  );
  if (!authorized) {
    throw new Error(
      `provider source signing key ${snapshot.signingKey.keyId} was not authorized by the active verified manifest`,
    );
  }
}

function templateDiff(
  previous: PersonalCatalogEntryObservation[],
  next: PersonalCatalogEntryObservation[],
  tombstones: string[],
): ProviderSourceTemplateDiffV1 {
  const before = new Map(previous.map((entry) => [entry.identity, entry.contentDigest]));
  const after = new Map(next.map((entry) => [entry.identity, entry.contentDigest]));
  return {
    added: [...after.keys()].filter((identity) => !before.has(identity)).sort(),
    updated: [...after.entries()]
      .filter(([identity, digest]) => before.has(identity) && before.get(identity) !== digest)
      .map(([identity, nextContentDigest]) => ({
        identity,
        previousContentDigest: before.get(identity)!,
        nextContentDigest,
      }))
      .sort((left, right) => left.identity.localeCompare(right.identity, "en")),
    withdrawn: [...before.keys()].filter((identity) => !after.has(identity)).sort(),
    tombstones: [...tombstones].sort(),
  };
}

function emptyDiff(): ProviderSourceTemplateDiffV1 {
  return { added: [], updated: [], withdrawn: [], tombstones: [] };
}

export class ProviderSourceManager {
  readonly paths: ProviderSourcePaths;
  readonly fetcher: SecureProviderSourceFetcher;
  private readonly plans = new Map<string, PreparedProviderSourcePlan>();
  private readonly lastErrors = new Map<string, { observedAt: string; message: string }>();

  constructor(options: { paths?: ProviderSourcePaths; fetcher?: SecureProviderSourceFetcher } = {}) {
    this.paths = options.paths ?? providerSourcePaths();
    this.fetcher = options.fetcher ?? new SecureProviderSourceFetcher();
  }

  private async readRegistry() {
    try {
      await assertRegularFile(this.paths.registryFile, "provider source registry");
      return validateRegistry(JSON.parse(await fs.readFile(this.paths.registryFile, "utf8")) as unknown);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return emptyRegistry();
      throw error;
    }
  }

  private source(registry: ProviderSourceRegistryV1, providerId: string) {
    const source = registry.sources.find((candidate) => candidate.providerId === providerId);
    if (!source) throw new Error(`provider source not found: ${providerId}`);
    return source;
  }

  private snapshotDirectory(providerId: string, manifestSha256: string) {
    assertProviderId(providerId);
    assertHash(manifestSha256, "snapshot manifestSha256");
    return path.join(this.paths.dataRoot, "snapshots", providerId, manifestSha256);
  }

  async listSources() {
    const registry = await this.readRegistry();
    return {
      schema: registry.schema,
      configRevision: registry.configRevision,
      configPath: this.paths.registryFile,
      sources: registry.sources.map((source) => ({
        providerId: source.providerId,
        manifestUrl: source.manifestUrl,
        enabled: source.enabled,
        includeInDefaultSearch: source.includeInDefaultSearch,
        trustEpoch: source.trustEpoch,
        signingKeyId: source.signingKey.keyId,
        authorizedNextKeyIds: source.authorizedNextKeys.map((key) => key.keyId),
        activeSnapshot: { ...source.activeSnapshot },
        snapshotPath: this.snapshotDirectory(source.providerId, source.activeSnapshot.manifestSha256),
        templateCount: source.activeSnapshot.templateCount,
        signature: {
          algorithm: "Ed25519" as const,
          keyId: source.activeSnapshot.signingKeyId,
          manifestSha256: source.activeSnapshot.manifestSha256,
        },
        inventory: {
          sha256: source.activeSnapshot.inventorySha256,
          entries: source.activeSnapshot.inventoryEntries,
        },
        lastError: this.lastErrors.get(source.providerId) ?? null,
      })),
    };
  }

  private remember(plan: PreparedProviderSourcePlan) {
    const now = Date.now();
    for (const [digest, item] of this.plans) if (item.expiresAt <= now) this.plans.delete(digest);
    while (this.plans.size >= PLAN_LIMIT) {
      const first = this.plans.keys().next().value as string | undefined;
      if (!first) break;
      this.plans.delete(first);
    }
    this.plans.set(plan.publicPlan.planDigest, plan);
  }

  private async fetchSnapshot(options: {
    manifestUrl: string;
    expectedProviderId: string;
    trustedKeys: Ed25519PublicKeyIdentity[];
  }) {
    try {
      const snapshot = await fetchVerifiedProviderSourceSnapshot({ fetcher: this.fetcher, ...options });
      validateCompletePersonalCatalog(
        snapshot.catalogBytes,
        options.expectedProviderId,
        snapshot.catalog.entries,
      );
      this.lastErrors.delete(options.expectedProviderId);
      return snapshot;
    } catch (error) {
      this.lastErrors.set(options.expectedProviderId, {
        observedAt: nowIso(),
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  }

  private async previousEntries(source: ProviderSourceRecordV1 | undefined) {
    if (!source) return [];
    const loaded = await this.loadLastKnownGood(source.providerId);
    return loaded.catalogEntries;
  }

  async planChange(
    input: ProviderSourceChangeInput,
  ): Promise<ProviderSourceChangePlanV1 | ProviderSourceAlreadyCurrentV1> {
    const providerId = assertProviderId(
      input.action === "add" ? input.expectedProviderId : input.providerId,
      input.action === "add" ? "expectedProviderId" : "providerId",
    );
    const registry = await this.readRegistry();
    const existing = registry.sources.find((source) => source.providerId === providerId);
    const createdAt = nowIso();
    let snapshot: VerifiedProviderSourceSnapshot | undefined;
    let inventory: ProviderSourceSnapshotInventoryEntryV1[] | undefined;
    let proposedSource: ProviderSourceRecordV1 | undefined;
    let allowSequenceReset = false;

    if (input.action === "add") {
      if (existing) throw new Error(`provider source already exists: ${providerId}`);
      const key = ed25519PublicKeyIdentity(input.publicKeyBase64);
      snapshot = await this.fetchSnapshot({
        manifestUrl: input.manifestUrl,
        expectedProviderId: providerId,
        trustedKeys: [key],
      });
      inventory = snapshotInventory(snapshot);
      const trustEpoch = 1;
      proposedSource = {
        providerId,
        manifestUrl: snapshot.accessUrls[0]!,
        enabled: input.enabled ?? true,
        includeInDefaultSearch: input.includeInDefaultSearch ?? false,
        trustEpoch,
        signingKey: snapshot.signingKey,
        authorizedNextKeys: snapshot.authorizedNextKeys,
        activeSnapshot: snapshotRef(snapshot, inventory),
        observedRevisions: appendObservation({ snapshot, trustEpoch, allowSequenceReset: false }),
        updatedAt: createdAt,
      };
    } else if (input.action === "remove") {
      if (!existing) throw new Error(`provider source not found: ${providerId}`);
    } else if (input.action === "configure") {
      if (!existing) throw new Error(`provider source not found: ${providerId}`);
      const manifestUrl = input.manifestUrl ?? existing.manifestUrl;
      const endpointChanged = manifestUrl !== existing.manifestUrl;
      const enabled = input.enabled ?? existing.enabled;
      const includeInDefaultSearch = input.includeInDefaultSearch ?? existing.includeInDefaultSearch;
      if (!enabled && includeInDefaultSearch) {
        throw new Error("a disabled provider source cannot participate in default search");
      }
      if (!endpointChanged && input.enabled === undefined && input.includeInDefaultSearch === undefined) {
        throw new Error("provider source configure requires at least one explicit change");
      }
      if (
        !endpointChanged &&
        enabled === existing.enabled &&
        includeInDefaultSearch === existing.includeInDefaultSearch
      ) {
        return {
          schema: PROVIDER_SOURCE_ALREADY_CURRENT_SCHEMA,
          status: "already_current",
          action: "configure",
          providerId,
          sequence: existing.activeSnapshot.sequence,
          manifestSha256: existing.activeSnapshot.manifestSha256,
          configRevision: registry.configRevision,
          observedAt: createdAt,
        };
      }
      if (endpointChanged) {
        snapshot = await this.fetchSnapshot({
          manifestUrl,
          expectedProviderId: providerId,
          trustedKeys: transitionVerificationKeys(existing),
        });
        assertAuthorizedKeyTransition(existing, snapshot);
        if (
          snapshot.manifest.sequence === existing.activeSnapshot.sequence &&
          snapshot.manifestSha256 === existing.activeSnapshot.manifestSha256 &&
          enabled === existing.enabled &&
          includeInDefaultSearch === existing.includeInDefaultSearch &&
          snapshot.accessUrls[0] === existing.manifestUrl
        ) {
          return {
            schema: PROVIDER_SOURCE_ALREADY_CURRENT_SCHEMA,
            status: "already_current",
            action: "configure",
            providerId,
            sequence: snapshot.manifest.sequence,
            manifestSha256: snapshot.manifestSha256,
            configRevision: registry.configRevision,
            observedAt: createdAt,
          };
        }
        inventory = snapshotInventory(snapshot);
      }
      proposedSource = {
        ...existing,
        manifestUrl: snapshot?.accessUrls[0] ?? manifestUrl,
        enabled,
        includeInDefaultSearch,
        ...(snapshot
          ? {
              signingKey: snapshot.signingKey,
              authorizedNextKeys: snapshot.authorizedNextKeys,
              activeSnapshot: snapshotRef(snapshot, inventory!),
              observedRevisions: appendObservation({
                source: existing,
                trustEpoch: existing.trustEpoch,
                snapshot,
                allowSequenceReset: false,
              }),
            }
          : {}),
        updatedAt: createdAt,
      };
    } else if (input.action === "update") {
      if (!existing) throw new Error(`provider source not found: ${providerId}`);
      snapshot = await this.fetchSnapshot({
        manifestUrl: existing.manifestUrl,
        expectedProviderId: providerId,
        trustedKeys: transitionVerificationKeys(existing),
      });
      assertAuthorizedKeyTransition(existing, snapshot);
      if (
        snapshot.manifest.sequence === existing.activeSnapshot.sequence &&
        snapshot.manifestSha256 === existing.activeSnapshot.manifestSha256
      ) {
        return {
          schema: PROVIDER_SOURCE_ALREADY_CURRENT_SCHEMA,
          status: "already_current",
          action: "update",
          providerId,
          sequence: snapshot.manifest.sequence,
          manifestSha256: snapshot.manifestSha256,
          configRevision: registry.configRevision,
          observedAt: createdAt,
        };
      }
      inventory = snapshotInventory(snapshot);
      proposedSource = {
        ...existing,
        signingKey: snapshot.signingKey,
        authorizedNextKeys: snapshot.authorizedNextKeys,
        activeSnapshot: snapshotRef(snapshot, inventory),
        observedRevisions: appendObservation({
          source: existing,
          trustEpoch: existing.trustEpoch,
          snapshot,
          allowSequenceReset: false,
        }),
        updatedAt: createdAt,
      };
    } else {
      if (!existing) throw new Error(`provider source not found: ${providerId}`);
      const key = ed25519PublicKeyIdentity(input.publicKeyBase64);
      allowSequenceReset = input.allowSequenceReset ?? false;
      snapshot = await this.fetchSnapshot({
        manifestUrl: input.manifestUrl ?? existing.manifestUrl,
        expectedProviderId: providerId,
        trustedKeys: [key],
      });
      if (
        snapshot.signingKey.keyId === existing.signingKey.keyId &&
        snapshot.manifest.sequence === existing.activeSnapshot.sequence &&
        snapshot.manifestSha256 === existing.activeSnapshot.manifestSha256 &&
        snapshot.accessUrls[0] === existing.manifestUrl
      ) {
        return {
          schema: PROVIDER_SOURCE_ALREADY_CURRENT_SCHEMA,
          status: "already_current",
          action: "trust_reset",
          providerId,
          sequence: snapshot.manifest.sequence,
          manifestSha256: snapshot.manifestSha256,
          configRevision: registry.configRevision,
          observedAt: createdAt,
        };
      }
      inventory = snapshotInventory(snapshot);
      const trustEpoch = existing.trustEpoch + 1;
      proposedSource = {
        ...existing,
        manifestUrl: snapshot.accessUrls[0]!,
        trustEpoch,
        signingKey: snapshot.signingKey,
        authorizedNextKeys: snapshot.authorizedNextKeys,
        activeSnapshot: snapshotRef(snapshot, inventory),
        observedRevisions: appendObservation({
          source: existing,
          trustEpoch,
          snapshot,
          allowSequenceReset,
        }),
        updatedAt: createdAt,
      };
    }

    if (proposedSource && !proposedSource.enabled && proposedSource.includeInDefaultSearch) {
      throw new Error("a disabled provider source cannot participate in default search");
    }
    const nextSources = input.action === "remove"
      ? registry.sources.filter((source) => source.providerId !== providerId)
      : sortSources([
          ...registry.sources.filter((source) => source.providerId !== providerId),
          proposedSource!,
        ]);
    const proposedRegistry: ProviderSourceRegistryV1 = {
      schema: PROVIDER_SOURCE_REGISTRY_SCHEMA,
      configRevision: registry.configRevision + 1,
      sources: nextSources,
      updatedAt: createdAt,
    };
    validateRegistry(proposedRegistry);
    const previousEntries = await this.previousEntries(existing);
    const nextEntries = snapshot?.catalog.entries ?? (input.action === "remove" ? [] : previousEntries);
    const diff = templateDiff(previousEntries, nextEntries, snapshot?.manifest.tombstones ?? []);
    const warnings = [
      ...(input.action === "add" && !proposedSource!.includeInDefaultSearch
        ? ["Add defaults to includeInDefaultSearch=false; ordinary default search will not include this source."]
        : []),
      ...(diff.withdrawn.length ? [`The snapshot withdraws ${diff.withdrawn.length} template release(s).`] : []),
      ...(snapshot?.authorizedNextKeys.length
        ? [`The signed manifest authorizes ${snapshot.authorizedNextKeys.length} key(s) for a future sequence.`]
        : []),
      ...(input.action === "remove"
        ? ["Remove stops discovery but retains immutable snapshots and already materialized projects."]
        : []),
      ...(input.action === "trust_reset"
        ? ["Trust Reset replaces the independently trusted signing key and advances the trust epoch."]
        : []),
      ...(allowSequenceReset
        ? ["allowSequenceReset=true permits a lower or same sequence under the new trust epoch."]
        : []),
    ];
    const targetSnapshotPath = snapshot
      ? this.snapshotDirectory(providerId, snapshot.manifestSha256)
      : undefined;
    const withoutDigest: Omit<ProviderSourceChangePlanV1, "planDigest"> = {
      schema: PROVIDER_SOURCE_CHANGE_PLAN_SCHEMA,
      planId: `provider-source-plan-${randomUUID()}`,
      action: input.action,
      providerId,
      expectedRegistryDigest: registryDigest(registry),
      expectedConfigRevision: registry.configRevision,
      proposedRegistryDigest: registryDigest(proposedRegistry),
      proposedConfigRevision: proposedRegistry.configRevision,
      ...(proposedSource ? { manifestUrl: proposedSource.manifestUrl } : existing ? { manifestUrl: existing.manifestUrl } : {}),
      accessUrls: snapshot?.accessUrls ?? [],
      configPath: this.paths.registryFile,
      ...(targetSnapshotPath ? { targetSnapshotPath } : {}),
      ...(proposedSource
        ? {
            enabled: proposedSource.enabled,
            includeInDefaultSearch: proposedSource.includeInDefaultSearch,
            signingKeyId: proposedSource.signingKey.keyId,
            trustEpoch: proposedSource.trustEpoch,
          }
        : {}),
      ...(existing
        ? {
            previousSigningKeyId: existing.signingKey.keyId,
            previousTrustEpoch: existing.trustEpoch,
          }
        : {}),
      ...(snapshot && inventory ? { snapshot: snapshotRef(snapshot, inventory) } : {}),
      templateDiff: diff,
      warnings,
      ...(input.action === "trust_reset" ? { allowSequenceReset } : {}),
      createdAt,
    };
    const publicPlan = {
      ...withoutDigest,
      planDigest: sha256(canonicalJson(withoutDigest)),
    };
    this.remember({
      publicPlan,
      proposedRegistry,
      ...(snapshot ? { snapshot } : {}),
      ...(inventory ? { snapshotInventory: inventory } : {}),
      expiresAt: Date.now() + PLAN_TTL_MS,
    });
    return publicPlan;
  }

  private operationFile(kind: "receipts" | "intents", operationId: string) {
    if (!OPERATION_ID.test(operationId)) throw new Error(`unsafe operationId: ${operationId}`);
    return path.join(this.paths.dataRoot, "operations", kind, `${operationId}.json`);
  }

  private async readJsonIfPresent<T>(
    file: string,
    validate: (value: unknown) => T,
  ): Promise<T | undefined> {
    try {
      await assertRegularFile(file, "provider source operation object");
      const value = JSON.parse(await fs.readFile(file, "utf8")) as unknown;
      return validate(value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async walkSnapshot(directory: string, relativeDirectory = "") {
    const output: string[] = [];
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
    for (const entry of entries) {
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const absolute = path.join(directory, entry.name);
      const stat = await fs.lstat(absolute);
      if (stat.isSymbolicLink()) throw new Error(`provider source snapshot contains a symlink: ${relative}`);
      if (stat.isDirectory()) output.push(...await this.walkSnapshot(absolute, relative));
      else if (stat.isFile()) output.push(relative);
      else throw new Error(`provider source snapshot contains a non-file: ${relative}`);
    }
    return output;
  }

  private async verifySnapshotDirectory(
    directory: string,
    inventory: ProviderSourceSnapshotInventoryEntryV1[],
  ) {
    await assertRegularDirectory(directory, "provider source snapshot");
    const inventoryPayload = inventoryBytes(inventory);
    const expected = new Map(inventory.map((entry) => [entry.localPath, entry]));
    expected.set("snapshot-inventory.jsonl", {
      schema: PROVIDER_SOURCE_SNAPSHOT_INVENTORY_ENTRY_SCHEMA,
      sourcePayload: "catalog",
      sourceUrl: "inventory:self",
      localPath: "snapshot-inventory.jsonl",
      bytes: inventoryPayload.byteLength,
      sha256: sha256(inventoryPayload),
      mediaType: "application/json",
    });
    const files = await this.walkSnapshot(directory);
    if (files.length !== expected.size || files.some((file) => !expected.has(file))) {
      throw new Error("provider source immutable snapshot inventory has missing or extra files");
    }
    for (const [relative, entry] of expected) {
      const absolute = path.join(directory, ...relative.split("/"));
      await assertRegularFile(absolute, `provider source snapshot ${relative}`);
      const bytes = await fs.readFile(absolute);
      if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) {
        throw new Error(`provider source immutable snapshot file mismatch: ${relative}`);
      }
    }
  }

  private async writeSnapshot(
    providerId: string,
    snapshot: VerifiedProviderSourceSnapshot,
    inventory: ProviderSourceSnapshotInventoryEntryV1[],
  ): Promise<void> {
    const target = this.snapshotDirectory(providerId, snapshot.manifestSha256);
    try {
      await this.verifySnapshotDirectory(target, inventory);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const providerRoot = path.dirname(target);
    await fs.mkdir(providerRoot, { recursive: true });
    await assertRegularDirectory(providerRoot, "provider source provider snapshot root");
    const staging = path.join(providerRoot, `.staging-${randomUUID()}`);
    await fs.mkdir(staging, { recursive: false });
    try {
      const files = new Map<string, Uint8Array>([
        ["source-manifest.json", snapshot.manifestBytes],
        ["source-manifest.sig.json", snapshot.signatureSidecarBytes],
        ["catalog.json", snapshot.catalogBytes],
        ["snapshot-inventory.jsonl", inventoryBytes(inventory)],
        ...snapshot.previewFiles.map((preview): [string, Uint8Array] => [preview.snapshotPath, preview.data]),
      ]);
      for (const [relative, bytes] of files) {
        const output = path.join(staging, ...relative.split("/"));
        await fs.mkdir(path.dirname(output), { recursive: true });
        await fs.writeFile(output, bytes, { flag: "wx" });
      }
      await fs.rename(staging, target);
      await this.verifySnapshotDirectory(target, inventory);
      for (const relative of files.keys()) {
        await fs.chmod(path.join(target, ...relative.split("/")), 0o444).catch(() => undefined);
      }
    } catch (error) {
      await fs.rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        await this.verifySnapshotDirectory(target, inventory);
        return;
      }
      throw error;
    }
  }

  async applyChange(input: {
    planDigest: string;
    operationId: string;
    expectedAction: ProviderSourceChangeAction;
    expectedProviderId: string;
  }) {
    assertHash(input.planDigest, "provider source planDigest");
    const providerId = assertProviderId(input.expectedProviderId, "expectedProviderId");
    const receiptFile = this.operationFile("receipts", input.operationId);
    const prior = await this.readJsonIfPresent(receiptFile, validateReceipt);
    if (prior) {
      if (
        prior.planDigest !== input.planDigest ||
        prior.action !== input.expectedAction ||
        prior.providerId !== providerId
      ) {
        throw new Error(`operationId was used for a different provider source change: ${input.operationId}`);
      }
      return { ...prior, idempotentReplay: true };
    }
    let prepared = this.plans.get(input.planDigest);
    if (prepared && prepared.expiresAt <= Date.now()) {
      this.plans.delete(input.planDigest);
      prepared = undefined;
    }
    const intentFile = this.operationFile("intents", input.operationId);
    const durable = await this.readJsonIfPresent(intentFile, validateIntent);
    if (!prepared && !durable) {
      throw new Error("provider source plan is not available; create and review a new plan");
    }
    if (
      durable &&
      (durable.planDigest !== input.planDigest ||
        durable.action !== input.expectedAction ||
        durable.providerId !== providerId)
    ) {
      throw new Error(`operationId was used for a different provider source change: ${input.operationId}`);
    }
    const plan = validateChangePlan(durable?.publicPlan ?? prepared!.publicPlan);
    const proposedRegistry = validateRegistry(durable?.proposedRegistry ?? prepared!.proposedRegistry);
    if (
      plan.planDigest !== input.planDigest ||
      plan.action !== input.expectedAction ||
      plan.providerId !== providerId
    ) {
      throw new Error("provider source Apply expectations do not match the plan");
    }
    if (
      plan.configPath !== this.paths.registryFile ||
      registryDigest(proposedRegistry) !== plan.proposedRegistryDigest ||
      proposedRegistry.configRevision !== plan.proposedConfigRevision
    ) {
      throw new Error("provider source Apply plan paths or proposed registry identity are invalid");
    }
    let applySnapshot: VerifiedProviderSourceSnapshot | undefined;
    let applyInventory: ProviderSourceSnapshotInventoryEntryV1[] | undefined;
    if (plan.snapshot) {
      const proposedSource = proposedRegistry.sources.find((source) => source.providerId === providerId);
      if (!proposedSource || !plan.manifestUrl) {
        throw new Error("provider source snapshot plan is missing its proposed source or manifest URL");
      }
      const preflightRegistry = await this.readRegistry();
      const preflightDigest = registryDigest(preflightRegistry);
      if (
        preflightDigest !== plan.expectedRegistryDigest &&
        preflightDigest !== plan.proposedRegistryDigest
      ) {
        throw new Error("stale provider source plan: registry changed after planning");
      }
      if (preflightDigest === plan.proposedRegistryDigest) {
        const active = preflightRegistry.sources.find((source) => source.providerId === providerId);
        if (!active || !sameSnapshotReference(active.activeSnapshot, plan.snapshot)) {
          throw new Error("provider source durable recovery snapshot does not match the applied registry");
        }
        await this.loadLastKnownGood(providerId);
      } else {
      let revalidationKeys = [proposedSource.signingKey];
      let transitionSource: ProviderSourceRecordV1 | undefined;
      if (
        preflightDigest === plan.expectedRegistryDigest &&
        (plan.action === "update" || plan.action === "configure")
      ) {
        transitionSource = preflightRegistry.sources.find((source) => source.providerId === providerId);
        if (!transitionSource) throw new Error("stale provider source plan: transition source disappeared");
        revalidationKeys = transitionVerificationKeys(transitionSource);
      }
      try {
        applySnapshot = await this.fetchSnapshot({
          manifestUrl: plan.manifestUrl,
          expectedProviderId: providerId,
          trustedKeys: revalidationKeys,
        });
      } catch (error) {
        throw new Error(
          `stale provider source plan: remote snapshot could not be revalidated (${error instanceof Error ? error.message : String(error)})`,
        );
      }
      if (transitionSource) assertAuthorizedKeyTransition(transitionSource, applySnapshot);
      applyInventory = snapshotInventory(applySnapshot);
      const observedReference = snapshotRef(applySnapshot, applyInventory);
      if (
        !sameSnapshotReference(observedReference, plan.snapshot) ||
        canonicalJson(applySnapshot.accessUrls) !== canonicalJson(plan.accessUrls) ||
        proposedSource.signingKey.keyId !== applySnapshot.signingKey.keyId ||
        plan.targetSnapshotPath !== this.snapshotDirectory(providerId, plan.snapshot.manifestSha256)
      ) {
        throw new Error(
          "stale provider source plan: remote manifest, signing key, catalog, previews, or inventory changed after planning",
        );
      }
      }
    }
    await fs.mkdir(this.paths.configRoot, { recursive: true });
    await assertRegularDirectory(this.paths.configRoot, "provider source config root");
    return withCrossRuntimeWriteLock(
      {
        root: this.paths.configRoot,
        lockDirectory: path.join(this.paths.configRoot, ".provider-sources-write-lock"),
        libraryId: "provider-sources",
        operation: `provider-source:${input.expectedAction}:${input.operationId}`,
      },
      async () => {
        const completed = await this.readJsonIfPresent(receiptFile, validateReceipt);
        if (completed) {
          if (
            completed.planDigest !== input.planDigest ||
            completed.action !== input.expectedAction ||
            completed.providerId !== providerId
          ) {
            throw new Error(`operationId was used for a different provider source change: ${input.operationId}`);
          }
          return { ...completed, idempotentReplay: true };
        }
        const current = await this.readRegistry();
        const currentDigest = registryDigest(current);
        const alreadyApplied = currentDigest === plan.proposedRegistryDigest;
        if (
          !alreadyApplied &&
          (currentDigest !== plan.expectedRegistryDigest || current.configRevision !== plan.expectedConfigRevision)
        ) {
          throw new Error("stale provider source plan: registry changed after planning");
        }
        if (!alreadyApplied) {
          if (applySnapshot && applyInventory) {
            await this.writeSnapshot(providerId, applySnapshot, applyInventory);
          } else if (plan.snapshot) {
            const snapshotPath = this.snapshotDirectory(providerId, plan.snapshot.manifestSha256);
            await assertRegularDirectory(snapshotPath, "durable provider source snapshot");
          }
          const intent: ProviderSourceChangeIntentV1 = {
            schema: PROVIDER_SOURCE_CHANGE_INTENT_SCHEMA,
            operationId: input.operationId,
            planDigest: input.planDigest,
            action: input.expectedAction,
            providerId,
            publicPlan: plan,
            proposedRegistry,
            createdAt: nowIso(),
          };
          await immutableWriteJson(intentFile, intent);
          await atomicWriteJson(this.paths.registryFile, proposedRegistry);
          const written = await this.readRegistry();
          if (registryDigest(written) !== plan.proposedRegistryDigest) {
            throw new Error("provider source registry verification failed after atomic switch");
          }
        }
        const receipt: ProviderSourceChangeReceiptV1 = {
          schema: PROVIDER_SOURCE_CHANGE_RECEIPT_SCHEMA,
          receiptId: `provider-source-receipt-${randomUUID()}`,
          operationId: input.operationId,
          planDigest: input.planDigest,
          action: input.expectedAction,
          providerId,
          proposedRegistryDigest: plan.proposedRegistryDigest,
          configRevision: plan.proposedConfigRevision,
          ...(plan.snapshot ? { manifestSha256: plan.snapshot.manifestSha256 } : {}),
          ...(plan.action === "trust_reset" && plan.previousSigningKeyId && plan.signingKeyId &&
            plan.previousTrustEpoch !== undefined && plan.trustEpoch !== undefined
            ? {
                trustReset: {
                  previousKeyId: plan.previousSigningKeyId,
                  nextKeyId: plan.signingKeyId,
                  previousTrustEpoch: plan.previousTrustEpoch,
                  nextTrustEpoch: plan.trustEpoch,
                  allowSequenceReset: plan.allowSequenceReset === true,
                },
              }
            : {}),
          appliedAt: nowIso(),
        };
        await immutableWriteJson(receiptFile, receipt);
        this.lastErrors.delete(providerId);
        return { ...receipt, idempotentReplay: alreadyApplied };
      },
    );
  }

  async loadLastKnownGood(providerIdInput: string) {
    const providerId = assertProviderId(providerIdInput);
    const registry = await this.readRegistry();
    const source = this.source(registry, providerId);
    const directory = this.snapshotDirectory(providerId, source.activeSnapshot.manifestSha256);
    await assertRegularDirectory(directory, "provider source last-known-good snapshot");
    const inventoryFile = path.join(directory, "snapshot-inventory.jsonl");
    await assertRegularFile(inventoryFile, "provider source snapshot inventory");
    const rawInventory = await fs.readFile(inventoryFile);
    if (sha256(rawInventory) !== source.activeSnapshot.inventorySha256) {
      throw new Error("provider source snapshot inventory digest mismatch");
    }
    const lines = decodeInventory(rawInventory);
    if (lines.length !== source.activeSnapshot.inventoryEntries) {
      throw new Error("provider source snapshot inventory entry count mismatch");
    }
    await this.verifySnapshotDirectory(directory, lines);
    const [manifestBytes, signatureSidecarBytes, catalogBytes] = await Promise.all([
      fs.readFile(path.join(directory, "source-manifest.json")),
      fs.readFile(path.join(directory, "source-manifest.sig.json")),
      fs.readFile(path.join(directory, "catalog.json")),
    ]);
    if (
      sha256(manifestBytes) !== source.activeSnapshot.manifestSha256 ||
      sha256(catalogBytes) !== source.activeSnapshot.catalogSha256 ||
      catalogBytes.byteLength !== source.activeSnapshot.catalogBytes
    ) {
      throw new Error("provider source last-known-good core payload identity mismatch");
    }
    const manifest = parseProviderSourceManifestBytes(manifestBytes);
    if (
      manifest.providerId !== providerId ||
      manifest.sequence !== source.activeSnapshot.sequence ||
      manifest.generatedAt !== source.activeSnapshot.generatedAt ||
      manifest.catalog.sha256 !== source.activeSnapshot.catalogSha256 ||
      manifest.catalog.bytes !== source.activeSnapshot.catalogBytes ||
      manifest.previews.sha256 !== source.activeSnapshot.previewsSha256 ||
      manifest.previews.bytes !== source.activeSnapshot.previewsBytes ||
      canonicalJson(manifest.authorizedNextKeys) !== canonicalJson(
        source.authorizedNextKeys.map((key) => ({ keyId: key.keyId, publicKeyBase64: key.publicKeyBase64 })),
      )
    ) {
      throw new Error("provider source last-known-good manifest does not match the active snapshot");
    }
    const parsedSignature = parseProviderSourceSignatureBytes(signatureSidecarBytes);
    if (
      parsedSignature.value.keyId !== source.signingKey.keyId ||
      parsedSignature.value.manifestSha256 !== source.activeSnapshot.manifestSha256
    ) {
      throw new Error("provider source last-known-good signature sidecar is invalid");
    }
    verifyEd25519Detached(manifestBytes, parsedSignature.signature, source.signingKey);
    const compactCatalogEntries = parsePersonalProviderCatalogBytes(catalogBytes, providerId).entries;
    const catalogEntries = validateCompletePersonalCatalog(
      catalogBytes,
      providerId,
      compactCatalogEntries,
    );
    if (catalogEntries.length !== source.activeSnapshot.templateCount) {
      throw new Error("provider source last-known-good template count mismatch");
    }
    const byPayload = new Map(lines.map((entry) => [`${entry.sourcePayload}:${entry.localPath}`, entry]));
    if (lines.filter((entry) => entry.sourcePayload === "previews-archive-entry").length !== catalogEntries.length) {
      throw new Error("provider source last-known-good preview inventory count mismatch");
    }
    const manifestInventory = byPayload.get("source-manifest:source-manifest.json");
    const signatureInventory = byPayload.get("signature-sidecar:source-manifest.sig.json");
    const catalogInventory = byPayload.get("catalog:catalog.json");
    if (
      manifestInventory?.sourceUrl !== source.manifestUrl ||
      signatureInventory?.sourceUrl !== deriveProviderSourceSignatureUrl(source.manifestUrl) ||
      catalogInventory?.sourceUrl !== manifest.catalog.url
    ) {
      throw new Error("provider source last-known-good core inventory URL mapping is invalid");
    }
    for (const entry of catalogEntries) {
      const inventoryEntry = byPayload.get(`previews-archive-entry:previews/${entry.preview.path}`);
      if (
        !inventoryEntry ||
        inventoryEntry.sourceUrl !== manifest.previews.url ||
        inventoryEntry.sourcePath !== entry.preview.path ||
        inventoryEntry.bytes !== entry.preview.bytes ||
        inventoryEntry.sha256 !== entry.preview.sha256
      ) {
        throw new Error(`provider source last-known-good preview inventory mismatch: ${entry.preview.path}`);
      }
    }
    return {
      source: {
        providerId: source.providerId,
        enabled: source.enabled,
        includeInDefaultSearch: source.includeInDefaultSearch,
        trustEpoch: source.trustEpoch,
        signingKeyId: source.signingKey.keyId,
        activeSnapshot: { ...source.activeSnapshot },
      },
      snapshotDirectory: directory,
      manifestBytes: new Uint8Array(manifestBytes),
      signatureSidecarBytes: new Uint8Array(signatureSidecarBytes),
      catalogBytes: new Uint8Array(catalogBytes),
      catalogEntries,
      inventory: lines,
    };
  }
}

function decodeInventory(bytes: Uint8Array) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (!text.endsWith("\n")) throw new Error("provider source snapshot inventory must end with LF");
  const rawLines = text.slice(0, -1).split("\n");
  if (rawLines.some((line) => !line)) throw new Error("provider source snapshot inventory contains a blank line");
  const values = rawLines.map((line) => JSON.parse(line) as unknown);
  const output: ProviderSourceSnapshotInventoryEntryV1[] = [];
  const paths = new Set<string>();
  const foldedPaths = new Set<string>();
  const payloadCounts = new Map<string, number>();
  for (const value of values) {
    if (
      !isRecord(value) ||
      value.schema !== PROVIDER_SOURCE_SNAPSHOT_INVENTORY_ENTRY_SCHEMA ||
      typeof value.localPath !== "string" ||
      typeof value.sourceUrl !== "string" ||
      !Number.isSafeInteger(value.bytes) || Number(value.bytes) < 1
    ) {
      throw new Error("provider source snapshot inventory entry is invalid");
    }
    const sourcePayload = value.sourcePayload;
    if (
      sourcePayload !== "source-manifest" &&
      sourcePayload !== "signature-sidecar" &&
      sourcePayload !== "catalog" &&
      sourcePayload !== "previews-archive-entry"
    ) {
      throw new Error("provider source snapshot inventory payload type is invalid");
    }
    assertExactKeys(
      value,
      sourcePayload === "previews-archive-entry"
        ? ["schema", "sourcePayload", "sourceUrl", "sourcePath", "localPath", "bytes", "sha256", "mediaType"]
        : ["schema", "sourcePayload", "sourceUrl", "localPath", "bytes", "sha256", "mediaType"],
      "provider source snapshot inventory entry",
    );
    const sourceUrl = assertHttpsUrl(value.sourceUrl, "snapshot inventory sourceUrl");
    if (sourceUrl !== value.sourceUrl) throw new Error("snapshot inventory sourceUrl is not canonical");
    assertHash(value.sha256, "snapshot inventory sha256");
    const maximum = sourcePayload === "source-manifest"
      ? 256 * 1024
      : sourcePayload === "signature-sidecar"
        ? 16 * 1024
        : sourcePayload === "catalog"
          ? 16 * 1024 * 1024
          : 64 * 1024 * 1024;
    if (Number(value.bytes) > maximum) throw new Error("provider source snapshot inventory byte limit is invalid");
    if (sourcePayload === "source-manifest") {
      if (value.localPath !== "source-manifest.json" || value.mediaType !== "application/json") {
        throw new Error("provider source manifest inventory mapping is invalid");
      }
    } else if (sourcePayload === "signature-sidecar") {
      if (value.localPath !== "source-manifest.sig.json" || value.mediaType !== "application/json") {
        throw new Error("provider source signature inventory mapping is invalid");
      }
    } else if (sourcePayload === "catalog") {
      if (value.localPath !== "catalog.json" || value.mediaType !== "application/json") {
        throw new Error("provider source catalog inventory mapping is invalid");
      }
    } else {
      if (typeof value.sourcePath !== "string" || value.mediaType !== "image/png") {
        throw new Error("provider source preview inventory mapping is invalid");
      }
      const segments = value.sourcePath.split("/");
      if (segments.length !== 3 || segments[0] !== "thumbs" || !segments[2]!.endsWith(".png")) {
        throw new Error("provider source preview inventory sourcePath is invalid");
      }
      for (const segment of segments) assertPortableFilesystemSegment(segment, "snapshot preview segment");
      if (value.localPath !== `previews/${value.sourcePath}`) {
        throw new Error("provider source preview inventory localPath is invalid");
      }
    }
    if (paths.has(value.localPath)) throw new Error("provider source snapshot inventory path is duplicated");
    const foldedPath = portableCaseFold(value.localPath);
    if (foldedPaths.has(foldedPath)) throw new Error("provider source snapshot inventory path has a case-fold collision");
    paths.add(value.localPath);
    foldedPaths.add(foldedPath);
    payloadCounts.set(sourcePayload, (payloadCounts.get(sourcePayload) ?? 0) + 1);
    output.push(value as unknown as ProviderSourceSnapshotInventoryEntryV1);
  }
  for (let index = 1; index < output.length; index += 1) {
    if (compareCanonicalStrings(output[index - 1]!.localPath, output[index]!.localPath) >= 0) {
      throw new Error("provider source snapshot inventory paths are not strictly sorted");
    }
  }
  for (const payload of ["source-manifest", "signature-sidecar", "catalog"]) {
    if (payloadCounts.get(payload) !== 1) throw new Error(`provider source snapshot inventory requires exactly one ${payload}`);
  }
  if ((payloadCounts.get("previews-archive-entry") ?? 0) > 10_000) {
    throw new Error("provider source snapshot inventory contains too many previews");
  }
  if (inventoryBytes(output).byteLength !== bytes.byteLength || sha256(inventoryBytes(output)) !== sha256(bytes)) {
    throw new Error("provider source snapshot inventory is not canonical or sorted");
  }
  return output;
}
