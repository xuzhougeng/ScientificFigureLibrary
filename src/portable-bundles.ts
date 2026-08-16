import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJson, compareCanonicalStrings } from "./canonical-json.ts";
import { withCrossRuntimeWriteLock } from "./cross-runtime-lock.ts";
import {
  assertNoPortableCaseCollision,
  assertPortableFilesystemSegment,
  assertPortableSegment,
  ensureLibraryRootMarker,
  portableCaseFold,
  readLibraryRootMarker,
  type LibraryRootMarkerV1,
} from "./library-runtime.ts";
import {
  VersionedTemplateLibrary,
  type JsonValue,
  type LifecycleApplyResult,
  type ReviewSnapshotV1,
  type StoredRevisionAsset,
  type TemplateContentV1,
  type TemplateReleaseV1,
  type TemplateSeriesV1,
  type VersionedTemplateCandidate,
  type WorkingRevisionPlan,
} from "./versioned-library.ts";

export const FULL_LIBRARY_BUNDLE_SCHEMA = "figure-library.full-backup-bundle.v1" as const;
export const TEMPLATE_BUNDLE_SCHEMA = "figure-library.published-template-bundle.v1" as const;
export const BUNDLE_EXPORT_PLAN_SCHEMA = "figure-library.bundle-export-plan.v1" as const;
export const BUNDLE_RESTORE_PLAN_SCHEMA = "figure-library.bundle-restore-plan.v1" as const;
export const TEMPLATE_BUNDLE_IMPORT_PLAN_SCHEMA =
  "figure-library.template-bundle-import-plan.v1" as const;
export const BUNDLE_OPERATION_RECEIPT_SCHEMA =
  "figure-library.bundle-operation-receipt.v1" as const;
export const BUNDLE_EXPORT_INTENT_SCHEMA =
  "figure-library.bundle-export-intent.v1" as const;

const HASH = /^[a-f0-9]{64}$/u;
const MAX_FILES = 100_000;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;

export interface PortableInventoryEntry {
  relativePath: string;
  bytes: number;
  sha256: string;
}

export interface FullLibraryBundleV1 {
  schema: typeof FULL_LIBRARY_BUNDLE_SCHEMA;
  bundleId: string;
  sourceLibraryId: string;
  storageFormat: LibraryRootMarkerV1["storageFormat"];
  payloadInventoryDigest: string;
  createdAt: string;
  excludes: ["indexes", "locks"];
}

export interface PublishedTemplateBundleV1 {
  schema: typeof TEMPLATE_BUNDLE_SCHEMA;
  bundleId: string;
  sourceLibraryId: string;
  providerId: "org.scientificfigurelibrary.local";
  selector: {
    templateId: string;
    revisionId: string;
    contentDigest: string;
    releaseId: string;
    releaseDigest: string;
  };
  payloadInventoryDigest: string;
  createdAt: string;
  importAuthorityPolicy: "working_revision_requires_local_review";
}

export interface BundleExportPlanV1 {
  schema: typeof BUNDLE_EXPORT_PLAN_SCHEMA;
  planId: string;
  kind: "full_library" | "published_template";
  sourceLibraryId: string;
  destination: string;
  targetName: string;
  bundle: FullLibraryBundleV1 | PublishedTemplateBundleV1;
  payloadInventory: PortableInventoryEntry[];
  expectedTargetAbsent: true;
  createdAt: string;
  planDigest: string;
}

export interface FullLibraryRestorePlanV1 {
  schema: typeof BUNDLE_RESTORE_PLAN_SCHEMA;
  planId: string;
  mode: "restore" | "fork";
  bundleDirectory: string;
  bundleId: string;
  sourceLibraryId: string;
  targetLibraryId: string;
  targetDirectory: string;
  authorityTransferConfirmed: boolean;
  payloadInventoryDigest: string;
  expectedTargetAbsent: true;
  createdAt: string;
  planDigest: string;
}

export interface TemplateBundleImportPlanV1 {
  schema: typeof TEMPLATE_BUNDLE_IMPORT_PLAN_SCHEMA;
  planId: string;
  bundleDirectory: string;
  bundleId: string;
  bundleInventoryDigest: string;
  targetTemplateId: string;
  mode: "create" | "update_published" | "update_working";
  lifecyclePlan: WorkingRevisionPlan;
  createdAt: string;
  planDigest: string;
}

export interface BundleOperationReceiptV1 {
  schema: typeof BUNDLE_OPERATION_RECEIPT_SCHEMA;
  receiptId: string;
  operationId: string;
  action: "export" | "restore" | "fork";
  planId: string;
  planDigest: string;
  bundleId: string;
  inventoryDigest: string;
  sourceLibraryId: string;
  targetLibraryId?: string;
  appliedAt: string;
}

export interface BundleExportIntentV1 {
  schema: typeof BUNDLE_EXPORT_INTENT_SCHEMA;
  intentId: string;
  operationId: string;
  planId: string;
  planDigest: string;
  kind: "full_library" | "published_template";
  sourceLibraryId: string;
  bundleId: string;
  bundleMetadataDigest: string;
  inventoryDigest: string;
  targetPathDigest: string;
  expectedTargetState: "missing";
  createdAt: string;
}

export type PortableBundleFaultPoint =
  | "after_export_intent"
  | "before_export_receipt";

export interface PortableBundleManagerOptions {
  /** Test/host fault-injection hook. Production callers should omit this option. */
  faultInjector?: (
    point: PortableBundleFaultPoint,
    context: { operationId: string; planDigest: string; target: string },
  ) => void | Promise<void>;
}

export interface BundleExportResult {
  target: string;
  bundleId: string;
  inventoryDigest: string;
  operationId: string;
  idempotentReplay: boolean;
  recovered?: boolean;
}

export interface FullLibraryRestoreResult {
  target: string;
  sourceLibraryId: string;
  targetLibraryId: string;
  mode: "restore" | "fork";
  operationId: string;
  idempotentReplay: boolean;
}

function nowIso() {
  return new Date().toISOString();
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function nativePathDigest(value: string) {
  const resolved = path.resolve(value).normalize("NFC");
  return sha256(process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`invalid ${label}`);
}

function safeRelativePath(value: string) {
  if (
    !value ||
    value !== value.normalize("NFC") ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    throw new Error(`unsafe portable bundle path: ${value}`);
  }
  const segments = value.split("/");
  for (const segment of segments) assertPortableFilesystemSegment(segment, "bundle path segment");
  return segments.join("/");
}

function resolveContained(root: string, relativePath: string) {
  const safe = safeRelativePath(relativePath);
  const resolved = path.resolve(root, ...safe.split("/"));
  if (!resolved.startsWith(`${path.resolve(root)}${path.sep}`)) {
    throw new Error(`unsafe portable bundle path: ${relativePath}`);
  }
  return resolved;
}

function containsPath(parent: string, candidate: string) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

function assertDisjointDirectories(left: string, right: string, label: string) {
  if (containsPath(left, right) || containsPath(right, left)) {
    throw new Error(`${label} must be outside and must not contain the source directory`);
  }
}

async function prospectivePhysicalPath(value: string) {
  let cursor = path.resolve(value);
  const missing: string[] = [];
  for (;;) {
    try {
      const physical = await fs.realpath(cursor);
      return path.join(physical, ...missing.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      missing.push(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function assertPhysicallyDisjointDirectories(
  left: string,
  right: string,
  label: string,
) {
  const [physicalLeft, physicalRight] = await Promise.all([
    prospectivePhysicalPath(left),
    prospectivePhysicalPath(right),
  ]);
  assertDisjointDirectories(physicalLeft, physicalRight, label);
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
}

async function requireRegularDirectory(directory: string, label: string) {
  const stat = await fs.lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`${label} must be a regular directory`);
  }
}

async function requireRegularFile(file: string, label: string) {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
}

async function readBundleMetadata(bundleDirectory: string) {
  await requireRegularDirectory(bundleDirectory, "bundle directory");
  const file = path.join(bundleDirectory, "bundle.json");
  await requireRegularFile(file, "bundle.json");
  return readJson(file);
}

async function immutableWrite(file: string, bytes: Uint8Array | string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, bytes, { flag: "wx" });
  await fs.chmod(file, 0o444).catch(() => undefined);
}

async function immutableJson(file: string, value: unknown) {
  await immutableWrite(file, `${JSON.stringify(value, null, 2)}\n`);
}

function inventoryDigest(inventory: PortableInventoryEntry[]) {
  return sha256(canonicalJson(inventory));
}

function inventoryJsonl(inventory: PortableInventoryEntry[]) {
  return `${inventory.map((entry) => canonicalJson(entry)).join("\n")}\n`;
}

function validateInventory(value: unknown): PortableInventoryEntry[] {
  if (!Array.isArray(value) || value.length > MAX_FILES) throw new Error("invalid bundle inventory");
  let previous = "";
  const folded: string[] = [];
  const output = value.map((item) => {
    if (!isRecord(item) || typeof item.relativePath !== "string") {
      throw new Error("invalid bundle inventory entry");
    }
    const relativePath = safeRelativePath(item.relativePath);
    if (
      relativePath !== item.relativePath ||
      (previous && compareCanonicalStrings(previous, relativePath) >= 0) ||
      !Number.isSafeInteger(item.bytes) ||
      (item.bytes as number) < 0 ||
      (item.bytes as number) > MAX_FILE_BYTES
    ) {
      throw new Error("invalid bundle inventory ordering or size");
    }
    assertHash(item.sha256, "bundle inventory digest");
    previous = relativePath;
    folded.push(relativePath);
    return {
      relativePath,
      bytes: item.bytes as number,
      sha256: item.sha256,
    };
  });
  assertNoPortableCaseCollision(folded, "bundle inventory");
  return output;
}

function validatePayloadInventory(value: unknown) {
  const inventory = validateInventory(value);
  if (
    inventory.some(
      (entry) =>
        !entry.relativePath.startsWith("payload/") ||
        entry.relativePath.length === "payload/".length,
    )
  ) {
    throw new Error("bundle inventory entries must be contained below payload/");
  }
  return inventory;
}

function exactPublishedSeries(
  series: TemplateSeriesV1,
  release: TemplateReleaseV1,
): TemplateSeriesV1 {
  return {
    schema: "figure-library.template-series.v1",
    templateId: release.templateId,
    status: series.status,
    createdAt: series.createdAt,
    updatedAt: release.publishedAt,
    publishedHead: {
      revisionId: release.revisionId,
      contentDigest: release.contentDigest,
      releaseId: release.releaseId,
      publishedAt: release.publishedAt,
    },
  };
}

function digestWithout<T extends Record<string, unknown>>(value: T, field: keyof T) {
  const copy = { ...value };
  delete copy[field];
  return sha256(canonicalJson(copy));
}

async function inventoryTree(options: {
  root: string;
  prefix?: string;
  excludeTopLevel?: Set<string>;
}) {
  const root = path.resolve(options.root);
  const output: PortableInventoryEntry[] = [];
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = await fs.readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => compareCanonicalStrings(left.name, right.name));
    for (const entry of entries) {
      assertPortableFilesystemSegment(entry.name, "bundle source path segment");
      if (!relativeDirectory && options.excludeTopLevel?.has(entry.name)) continue;
      const relative = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      const file = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`bundle source contains a symbolic link: ${relative}`);
      if (entry.isDirectory()) {
        await walk(file, relative);
        continue;
      }
      if (!entry.isFile()) throw new Error(`bundle source contains a non-file: ${relative}`);
      const stat = await fs.stat(file);
      if (stat.size > MAX_FILE_BYTES) throw new Error(`bundle source file is too large: ${relative}`);
      const bytes = new Uint8Array(await fs.readFile(file));
      const relativePath = options.prefix ? `${options.prefix}/${relative}` : relative;
      output.push({ relativePath, bytes: bytes.byteLength, sha256: sha256(bytes) });
      if (output.length > MAX_FILES) throw new Error(`bundle exceeds ${MAX_FILES} files`);
    }
  };
  await walk(root, "");
  return validateInventory(
    output.sort((left, right) => compareCanonicalStrings(left.relativePath, right.relativePath)),
  );
}

async function verifyInventory(root: string, expected: PortableInventoryEntry[]) {
  const actual = await inventoryTree({ root });
  if (canonicalJson(actual) !== canonicalJson(expected)) {
    throw new Error("bundle payload inventory mismatch");
  }
}

async function copyInventory(
  sourceRoot: string,
  targetRoot: string,
  inventory: PortableInventoryEntry[],
  sourcePrefix = "",
) {
  for (const entry of inventory) {
    const sourceRelative = sourcePrefix
      ? entry.relativePath.slice(`${sourcePrefix}/`.length)
      : entry.relativePath;
    const source = resolveContained(sourceRoot, sourceRelative);
    const bytes = new Uint8Array(await fs.readFile(source));
    if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw new Error(`bundle source changed after planning: ${entry.relativePath}`);
    }
    await immutableWrite(resolveContained(targetRoot, entry.relativePath), bytes);
  }
}

async function readInventoryFile(bundleDirectory: string) {
  await requireRegularDirectory(bundleDirectory, "bundle directory");
  const file = path.join(bundleDirectory, "inventory.jsonl");
  await requireRegularFile(file, "inventory.jsonl");
  const lines = (await fs.readFile(file, "utf8"))
    .split(/\r?\n/u)
    .filter(Boolean);
  return validatePayloadInventory(lines.map((line) => JSON.parse(line) as unknown));
}

async function verifyBundlePayload(
  bundleDirectory: string,
  inventory: PortableInventoryEntry[],
) {
  const payloadDirectory = path.join(bundleDirectory, "payload");
  await requireRegularDirectory(payloadDirectory, "bundle payload");
  await verifyInventory(
    payloadDirectory,
    inventory.map((entry) => ({
      ...entry,
      relativePath: entry.relativePath.slice("payload/".length),
    })),
  );
}

function exportPlanDigest(plan: Omit<BundleExportPlanV1, "planDigest"> | BundleExportPlanV1) {
  const { planDigest: _digest, ...withoutDigest } = plan as BundleExportPlanV1;
  return sha256(canonicalJson(withoutDigest));
}

function restorePlanDigest(
  plan: Omit<FullLibraryRestorePlanV1, "planDigest"> | FullLibraryRestorePlanV1,
) {
  const { planDigest: _digest, ...withoutDigest } = plan as FullLibraryRestorePlanV1;
  return sha256(canonicalJson(withoutDigest));
}

function importPlanDigest(
  plan: Omit<TemplateBundleImportPlanV1, "planDigest"> | TemplateBundleImportPlanV1,
) {
  const value = plan as TemplateBundleImportPlanV1;
  return sha256(
    canonicalJson({
      schema: value.schema,
      planId: value.planId,
      bundleDirectory: value.bundleDirectory,
      bundleId: value.bundleId,
      bundleInventoryDigest: value.bundleInventoryDigest,
      targetTemplateId: value.targetTemplateId,
      mode: value.mode,
      lifecyclePlanDigest: value.lifecyclePlan.planDigest,
      createdAt: value.createdAt,
    }),
  );
}

function validateRestoreReceiptForPlan(
  value: unknown,
  plan: FullLibraryRestorePlanV1,
  operationId: string,
) {
  const expectedKeys = [
    "action",
    "appliedAt",
    "bundleId",
    "inventoryDigest",
    "operationId",
    "planDigest",
    "planId",
    "receiptId",
    "schema",
    "sourceLibraryId",
    "targetLibraryId",
  ];
  if (
    !isRecord(value) ||
    canonicalJson(Object.keys(value).sort(compareCanonicalStrings)) !==
      canonicalJson(expectedKeys.sort(compareCanonicalStrings)) ||
    value.schema !== BUNDLE_OPERATION_RECEIPT_SCHEMA ||
    value.operationId !== operationId ||
    value.action !== plan.mode ||
    value.planId !== plan.planId ||
    value.planDigest !== plan.planDigest ||
    value.bundleId !== plan.bundleId ||
    value.inventoryDigest !== plan.payloadInventoryDigest ||
    value.sourceLibraryId !== plan.sourceLibraryId ||
    value.targetLibraryId !== plan.targetLibraryId ||
    typeof value.receiptId !== "string" ||
    typeof value.appliedAt !== "string" ||
    Number.isNaN(Date.parse(value.appliedAt))
  ) {
    throw new Error("operationId was used for a different restore/fork");
  }
  assertPortableSegment(value.receiptId, "receiptId");
  return value as unknown as BundleOperationReceiptV1;
}

function validateExportIntent(
  value: unknown,
  input: {
    operationId: string;
    planDigest: string;
    sourceLibraryId: string;
    target: string;
  },
) {
  if (
    !isRecord(value) ||
    value.schema !== BUNDLE_EXPORT_INTENT_SCHEMA ||
    value.operationId !== input.operationId ||
    value.planDigest !== input.planDigest ||
    value.sourceLibraryId !== input.sourceLibraryId ||
    value.targetPathDigest !== nativePathDigest(input.target) ||
    (value.kind !== "full_library" && value.kind !== "published_template") ||
    value.expectedTargetState !== "missing" ||
    typeof value.intentId !== "string" ||
    typeof value.planId !== "string" ||
    typeof value.bundleId !== "string" ||
    typeof value.bundleMetadataDigest !== "string" ||
    !HASH.test(value.bundleMetadataDigest) ||
    typeof value.inventoryDigest !== "string" ||
    !HASH.test(value.inventoryDigest) ||
    typeof value.targetPathDigest !== "string" ||
    !HASH.test(value.targetPathDigest) ||
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt))
  ) {
    throw new Error("authoritative bundle export intent conflicts with the requested operation, plan, Library, or target");
  }
  assertPortableSegment(value.intentId, "intentId");
  assertPortableSegment(value.operationId, "operationId");
  assertPortableSegment(value.planId, "planId");
  assertPortableSegment(value.sourceLibraryId, "sourceLibraryId");
  assertPortableSegment(value.bundleId, "bundleId");
  return value as unknown as BundleExportIntentV1;
}

function assertExportIntentMatchesPlan(
  intent: BundleExportIntentV1,
  plan: BundleExportPlanV1,
) {
  if (
    intent.planId !== plan.planId ||
    intent.kind !== plan.kind ||
    intent.bundleId !== plan.bundle.bundleId ||
    intent.bundleMetadataDigest !== sha256(canonicalJson(plan.bundle)) ||
    intent.inventoryDigest !== plan.bundle.payloadInventoryDigest
  ) {
    throw new Error("authoritative bundle export intent conflicts with the supplied export plan");
  }
}

function validateExportReceiptForIntent(
  value: unknown,
  intent: BundleExportIntentV1,
) {
  if (
    !isRecord(value) ||
    value.schema !== BUNDLE_OPERATION_RECEIPT_SCHEMA ||
    value.action !== "export" ||
    value.operationId !== intent.operationId ||
    value.planId !== intent.planId ||
    value.planDigest !== intent.planDigest ||
    value.bundleId !== intent.bundleId ||
    value.inventoryDigest !== intent.inventoryDigest ||
    value.sourceLibraryId !== intent.sourceLibraryId ||
    value.targetLibraryId !== undefined ||
    typeof value.receiptId !== "string" ||
    typeof value.appliedAt !== "string" ||
    Number.isNaN(Date.parse(value.appliedAt))
  ) {
    throw new Error("operationId was used for a different bundle export");
  }
  assertPortableSegment(value.receiptId, "receiptId");
  return value as unknown as BundleOperationReceiptV1;
}

export class PortableBundleManager {
  readonly root: string;
  readonly library: VersionedTemplateLibrary;
  private readonly faultInjector?: PortableBundleManagerOptions["faultInjector"];

  constructor(
    root: string,
    library = new VersionedTemplateLibrary(root),
    options: PortableBundleManagerOptions = {},
  ) {
    this.root = path.resolve(root);
    this.library = library;
    this.faultInjector = options.faultInjector;
  }

  private async requireMarker() {
    const marker = await readLibraryRootMarker(this.root);
    if (!marker) throw new Error("library is not initialized; library.json is required");
    return marker.value;
  }

  private async withWriteLock<T>(operation: string, callback: () => Promise<T>) {
    const marker = await this.requireMarker();
    return withCrossRuntimeWriteLock(
      {
        root: this.root,
        lockDirectory: path.join(this.root, "locks", "write"),
        libraryId: marker.libraryId,
        operation: `portable-bundle:${operation}`,
      },
      callback,
    );
  }

  private exportReceiptFile(operationId: string) {
    return path.join(
      this.root,
      "store",
      "operations",
      "receipts",
      "exports",
      `${assertPortableSegment(operationId, "operationId")}.json`,
    );
  }

  private exportIntentFile(operationId: string) {
    return path.join(
      this.root,
      "store",
      "operations",
      "intents",
      "bundle-exports",
      `${assertPortableSegment(operationId, "operationId")}.json`,
    );
  }

  private async readExportIntent(input: {
    operationId: string;
    planDigest: string;
    sourceLibraryId: string;
    target: string;
  }) {
    try {
      return validateExportIntent(await readJson(this.exportIntentFile(input.operationId)), input);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async readExportReceipt(intent: BundleExportIntentV1) {
    try {
      return validateExportReceiptForIntent(
        await readJson(this.exportReceiptFile(intent.operationId)),
        intent,
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private async ensureExportIntent(input: {
    plan: BundleExportPlanV1;
    operationId: string;
    target: string;
  }) {
    const proposed: BundleExportIntentV1 = {
      schema: BUNDLE_EXPORT_INTENT_SCHEMA,
      intentId: `bundle-export-intent-${randomUUID()}`,
      operationId: input.operationId,
      planId: input.plan.planId,
      planDigest: input.plan.planDigest,
      kind: input.plan.kind,
      sourceLibraryId: input.plan.sourceLibraryId,
      bundleId: input.plan.bundle.bundleId,
      bundleMetadataDigest: sha256(canonicalJson(input.plan.bundle)),
      inventoryDigest: input.plan.bundle.payloadInventoryDigest,
      targetPathDigest: nativePathDigest(input.target),
      expectedTargetState: "missing",
      createdAt: nowIso(),
    };
    const file = this.exportIntentFile(input.operationId);
    try {
      await immutableJson(file, proposed);
      return proposed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      return validateExportIntent(await readJson(file), {
        operationId: input.operationId,
        planDigest: input.plan.planDigest,
        sourceLibraryId: input.plan.sourceLibraryId,
        target: input.target,
      });
    }
  }

  private async verifyExportTargetAgainstIntent(
    target: string,
    intent: BundleExportIntentV1,
  ) {
    await requireRegularDirectory(target, "bundle target");
    const observedBundle = await readJson(path.join(target, "bundle.json"));
    if (
      !isRecord(observedBundle) ||
      sha256(canonicalJson(observedBundle)) !== intent.bundleMetadataDigest ||
      observedBundle.bundleId !== intent.bundleId ||
      observedBundle.sourceLibraryId !== intent.sourceLibraryId ||
      observedBundle.payloadInventoryDigest !== intent.inventoryDigest ||
      (intent.kind === "full_library"
        ? observedBundle.schema !== FULL_LIBRARY_BUNDLE_SCHEMA
        : observedBundle.schema !== TEMPLATE_BUNDLE_SCHEMA)
    ) {
      throw new Error("bundle target metadata does not match the authoritative export intent");
    }
    const observed = await readInventoryFile(target);
    if (inventoryDigest(observed) !== intent.inventoryDigest) {
      throw new Error("bundle target payload inventory does not match the authoritative export intent");
    }
    await verifyInventory(
      path.join(target, "payload"),
      observed.map((entry) => ({
        ...entry,
        relativePath: entry.relativePath.slice("payload/".length),
      })),
    );
  }

  async recoverExport(input: {
    planDigest: string;
    operationId: string;
    expectedTarget: string;
  }): Promise<BundleExportResult | undefined> {
    assertHash(input.planDigest, "bundle export plan digest");
    const safeOperationId = assertPortableSegment(input.operationId, "operationId");
    const target = path.resolve(input.expectedTarget);
    return this.withWriteLock(`recover-export:${safeOperationId}`, async () => {
      const marker = await this.requireMarker();
      const intent = await this.readExportIntent({
        operationId: safeOperationId,
        planDigest: input.planDigest,
        sourceLibraryId: marker.libraryId,
        target,
      });
      if (!intent) return undefined;
      const prior = await this.readExportReceipt(intent);
      let targetExists = false;
      try {
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error("bundle target exists but is not a regular directory");
        }
        targetExists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (!targetExists) {
        if (prior) {
          throw new Error("authoritative bundle export receipt exists but its target is missing");
        }
        return undefined;
      }
      await this.verifyExportTargetAgainstIntent(target, intent);
      if (!prior) {
        const receipt: BundleOperationReceiptV1 = {
          schema: BUNDLE_OPERATION_RECEIPT_SCHEMA,
          receiptId: `bundle-export-receipt-${randomUUID()}`,
          operationId: safeOperationId,
          action: "export",
          planId: intent.planId,
          planDigest: intent.planDigest,
          bundleId: intent.bundleId,
          inventoryDigest: intent.inventoryDigest,
          sourceLibraryId: intent.sourceLibraryId,
          appliedAt: nowIso(),
        };
        await immutableJson(this.exportReceiptFile(safeOperationId), receipt);
      }
      return {
        target,
        bundleId: intent.bundleId,
        inventoryDigest: intent.inventoryDigest,
        operationId: safeOperationId,
        idempotentReplay: true,
        ...(!prior ? { recovered: true } : {}),
      };
    });
  }

  async planFullBackup(options: { destination: string; targetName?: string }) {
    const marker = await this.requireMarker();
    const rootInventory = await inventoryTree({
      root: this.root,
      prefix: "payload",
      excludeTopLevel: new Set(["indexes", "locks"]),
    });
    const bundleId = `full-backup-${randomUUID()}`;
    const bundle: FullLibraryBundleV1 = {
      schema: FULL_LIBRARY_BUNDLE_SCHEMA,
      bundleId,
      sourceLibraryId: marker.libraryId,
      storageFormat: marker.storageFormat,
      payloadInventoryDigest: inventoryDigest(rootInventory),
      createdAt: nowIso(),
      excludes: ["indexes", "locks"],
    };
    const destination = path.resolve(options.destination);
    const targetName = assertPortableFilesystemSegment(
      options.targetName ?? bundleId,
      "backup directory name",
    );
    assertDisjointDirectories(this.root, path.join(destination, targetName), "backup target");
    await assertPhysicallyDisjointDirectories(
      this.root,
      path.join(destination, targetName),
      "backup target",
    );
    const withoutDigest: Omit<BundleExportPlanV1, "planDigest"> = {
      schema: BUNDLE_EXPORT_PLAN_SCHEMA,
      planId: `bundle-export-plan-${randomUUID()}`,
      kind: "full_library",
      sourceLibraryId: marker.libraryId,
      destination,
      targetName,
      bundle,
      payloadInventory: rootInventory,
      expectedTargetAbsent: true,
      createdAt: nowIso(),
    };
    return { ...withoutDigest, planDigest: exportPlanDigest(withoutDigest) };
  }

  async planPublishedTemplateExport(options: {
    templateId: string;
    releaseId?: string;
    destination: string;
    targetName?: string;
  }) {
    const marker = await this.requireMarker();
    const templateId = assertPortableSegment(options.templateId, "templateId");
    const history = await this.library.history(templateId);
    const releaseId = options.releaseId ?? history.series.publishedHead?.releaseId;
    if (!releaseId) throw new Error("template has no Published Release");
    const release = history.releases.find((item) => item.releaseId === releaseId);
    if (!release) throw new Error("Release is not reachable from the current Published Head");
    const content = await this.library.getContent(templateId, release.revisionId, release.contentDigest);
    const review = await this.library.getReview(templateId, release.reviewId);
    if (!content || !review || review.reviewDigest !== release.reviewDigest) {
      throw new Error("Published Release has missing or mismatched immutable objects");
    }
    const payloadFiles = new Map<string, Uint8Array>();
    const bundleSeries = exactPublishedSeries(history.series, release);
    payloadFiles.set(
      "payload/series/series.json",
      new TextEncoder().encode(`${JSON.stringify(bundleSeries, null, 2)}\n`),
    );
    payloadFiles.set(
      "payload/revision/content.json",
      new TextEncoder().encode(`${JSON.stringify(content, null, 2)}\n`),
    );
    payloadFiles.set(
      "payload/review/review.json",
      new TextEncoder().encode(`${JSON.stringify(review, null, 2)}\n`),
    );
    payloadFiles.set(
      "payload/release/release.json",
      new TextEncoder().encode(`${JSON.stringify(release, null, 2)}\n`),
    );
    for (const asset of content.assets) {
      const read = await this.library.readAsset({
        templateId,
        revisionId: content.revisionId,
        contentDigest: content.contentDigest,
        logicalPath: asset.logicalPath,
      });
      payloadFiles.set(`payload/revision/${asset.file}`, read.bytes);
    }
    const payloadInventory = validatePayloadInventory(
      [...payloadFiles.entries()]
        .map(([relativePath, bytes]) => ({
          relativePath,
          bytes: bytes.byteLength,
          sha256: sha256(bytes),
        }))
        .sort((left, right) => compareCanonicalStrings(left.relativePath, right.relativePath)),
    );
    const bundleId = `template-bundle-${randomUUID()}`;
    const bundle: PublishedTemplateBundleV1 = {
      schema: TEMPLATE_BUNDLE_SCHEMA,
      bundleId,
      sourceLibraryId: marker.libraryId,
      providerId: "org.scientificfigurelibrary.local",
      selector: {
        templateId,
        revisionId: content.revisionId,
        contentDigest: content.contentDigest,
        releaseId: release.releaseId,
        releaseDigest: release.releaseDigest,
      },
      payloadInventoryDigest: inventoryDigest(payloadInventory),
      createdAt: nowIso(),
      importAuthorityPolicy: "working_revision_requires_local_review",
    };
    const destination = path.resolve(options.destination);
    const targetName = assertPortableFilesystemSegment(
      options.targetName ?? bundleId,
      "template bundle directory name",
    );
    assertDisjointDirectories(this.root, path.join(destination, targetName), "bundle target");
    await assertPhysicallyDisjointDirectories(
      this.root,
      path.join(destination, targetName),
      "bundle target",
    );
    const withoutDigest: Omit<BundleExportPlanV1, "planDigest"> = {
      schema: BUNDLE_EXPORT_PLAN_SCHEMA,
      planId: `bundle-export-plan-${randomUUID()}`,
      kind: "published_template",
      sourceLibraryId: marker.libraryId,
      destination,
      targetName,
      bundle,
      payloadInventory,
      expectedTargetAbsent: true,
      createdAt: nowIso(),
    };
    return { ...withoutDigest, planDigest: exportPlanDigest(withoutDigest) };
  }

  private validateExportPlan(plan: BundleExportPlanV1) {
    if (!isRecord(plan) || plan.schema !== BUNDLE_EXPORT_PLAN_SCHEMA) {
      throw new Error("invalid bundle export plan schema");
    }
    assertPortableSegment(plan.planId, "planId");
    assertPortableFilesystemSegment(plan.targetName, "bundle target name");
    assertHash(plan.planDigest, "bundle export plan digest");
    if (
      exportPlanDigest(plan) !== plan.planDigest ||
      !path.isAbsolute(plan.destination) ||
      plan.expectedTargetAbsent !== true
    ) {
      throw new Error("invalid bundle export plan");
    }
    validatePayloadInventory(plan.payloadInventory);
    if (inventoryDigest(plan.payloadInventory) !== plan.bundle.payloadInventoryDigest) {
      throw new Error("bundle export inventory digest mismatch");
    }
  }

  async applyExport(plan: BundleExportPlanV1, operationId: string): Promise<BundleExportResult> {
    this.validateExportPlan(plan);
    const safeOperationId = assertPortableSegment(operationId, "operationId");
    return this.withWriteLock(`export:${safeOperationId}`, async () => {
      const marker = await this.requireMarker();
      if (marker.libraryId !== plan.sourceLibraryId) {
        throw new Error("stale export plan: libraryId changed");
      }
      const target = path.join(plan.destination, plan.targetName);
      assertDisjointDirectories(this.root, target, "bundle target");
      await assertPhysicallyDisjointDirectories(this.root, target, "bundle target");
      let intent = await this.readExportIntent({
        operationId: safeOperationId,
        planDigest: plan.planDigest,
        sourceLibraryId: marker.libraryId,
        target,
      });
      if (intent) assertExportIntentMatchesPlan(intent, plan);

      let prior: BundleOperationReceiptV1 | undefined;
      if (intent) {
        prior = await this.readExportReceipt(intent);
      } else {
        // Compatibility with receipts written before authoritative export
        // intents were introduced. Cached exact plans can still replay them.
        try {
          const value = await readJson(this.exportReceiptFile(safeOperationId));
          if (
            !isRecord(value) ||
            value.schema !== BUNDLE_OPERATION_RECEIPT_SCHEMA ||
            value.action !== "export" ||
            value.operationId !== safeOperationId ||
            value.planId !== plan.planId ||
            value.planDigest !== plan.planDigest ||
            value.bundleId !== plan.bundle.bundleId ||
            value.inventoryDigest !== plan.bundle.payloadInventoryDigest ||
            value.sourceLibraryId !== plan.sourceLibraryId
          ) {
            throw new Error("operationId was used for a different bundle export");
          }
          prior = value as unknown as BundleOperationReceiptV1;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }

      const verifyExportTarget = async () => {
        await requireRegularDirectory(target, "bundle target");
        const observedBundle = await readJson(path.join(target, "bundle.json"));
        if (canonicalJson(observedBundle) !== canonicalJson(plan.bundle)) {
          throw new Error("bundle target metadata does not match the export plan");
        }
        const observed = await readInventoryFile(target);
        if (canonicalJson(observed) !== canonicalJson(plan.payloadInventory)) {
          throw new Error("bundle target payload inventory does not match the export plan");
        }
        await verifyInventory(
          path.join(target, "payload"),
          plan.payloadInventory.map((entry) => ({
            ...entry,
            relativePath: entry.relativePath.slice("payload/".length),
          })),
        );
      };
      if (prior) {
        await verifyExportTarget();
        return {
          target,
          bundleId: plan.bundle.bundleId,
          inventoryDigest: plan.bundle.payloadInventoryDigest,
          operationId: safeOperationId,
          idempotentReplay: true,
        };
      }

      const observedSourceInventory =
        plan.kind === "full_library"
          ? await inventoryTree({
              root: this.root,
              prefix: "payload",
              excludeTopLevel: new Set(["indexes", "locks"]),
            })
          : plan.payloadInventory;
      const ownIntentRelativePath =
        `payload/store/operations/intents/bundle-exports/${safeOperationId}.json`;
      const sourceInventory = intent
        ? observedSourceInventory.filter(
            (entry) => entry.relativePath !== ownIntentRelativePath,
          )
        : observedSourceInventory;
      if (canonicalJson(sourceInventory) !== canonicalJson(plan.payloadInventory)) {
        throw new Error("stale bundle export plan: source inventory changed");
      }
      let targetExists = false;
      try {
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink() || !stat.isDirectory()) {
          throw new Error("bundle target is not a directory");
        }
        targetExists = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (targetExists && !intent) {
        throw new Error("bundle target already exists without an authoritative export intent");
      }
      if (!intent) {
        intent = await this.ensureExportIntent({
          plan,
          operationId: safeOperationId,
          target,
        });
        assertExportIntentMatchesPlan(intent, plan);
        await this.faultInjector?.("after_export_intent", {
          operationId: safeOperationId,
          planDigest: plan.planDigest,
          target,
        });
        try {
          await fs.lstat(target);
          throw new Error("bundle target already exists after export intent creation");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }

      if (!targetExists) {
        await fs.mkdir(plan.destination, { recursive: true });
        const staging = path.join(plan.destination, `.${plan.targetName}.${randomUUID()}.tmp`);
        await fs.mkdir(staging);
        try {
          if (plan.kind === "full_library") {
            await copyInventory(this.root, staging, plan.payloadInventory, "payload");
          } else {
            for (const entry of plan.payloadInventory) {
              const selector = (plan.bundle as PublishedTemplateBundleV1).selector;
              let bytes: Uint8Array;
              if (entry.relativePath === "payload/series/series.json") {
                const [series, release] = await Promise.all([
                  this.library.getSeries(selector.templateId),
                  this.library.getRelease(selector.templateId, selector.releaseId),
                ]);
                if (!series || !release) throw new Error("template bundle source is incomplete");
                bytes = new TextEncoder().encode(
                  `${JSON.stringify(exactPublishedSeries(series, release), null, 2)}\n`,
                );
              } else if (entry.relativePath === "payload/revision/content.json") {
                bytes = new TextEncoder().encode(
                  `${JSON.stringify(await this.library.getContent(selector.templateId, selector.revisionId, selector.contentDigest), null, 2)}\n`,
                );
              } else if (entry.relativePath === "payload/review/review.json") {
                const release = await this.library.getRelease(selector.templateId, selector.releaseId);
                bytes = new TextEncoder().encode(
                  `${JSON.stringify(release ? await this.library.getReview(selector.templateId, release.reviewId) : undefined, null, 2)}\n`,
                );
              } else if (entry.relativePath === "payload/release/release.json") {
                bytes = new TextEncoder().encode(
                  `${JSON.stringify(await this.library.getRelease(selector.templateId, selector.releaseId), null, 2)}\n`,
                );
              } else {
                const logicalPath = entry.relativePath.slice("payload/revision/assets/".length);
                bytes = (await this.library.readAsset({
                  templateId: selector.templateId,
                  revisionId: selector.revisionId,
                  contentDigest: selector.contentDigest,
                  logicalPath,
                })).bytes;
              }
              if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) {
                throw new Error(`template bundle source changed: ${entry.relativePath}`);
              }
              await immutableWrite(resolveContained(staging, entry.relativePath), bytes);
            }
          }
          await immutableJson(path.join(staging, "bundle.json"), plan.bundle);
          await immutableWrite(
            path.join(staging, "inventory.jsonl"),
            inventoryJsonl(plan.payloadInventory),
          );
          await fs.rename(staging, target);
        } catch (error) {
          await fs.rm(staging, { recursive: true, force: true });
          throw error;
        }
      } else {
        await verifyExportTarget();
      }

      await this.faultInjector?.("before_export_receipt", {
        operationId: safeOperationId,
        planDigest: plan.planDigest,
        target,
      });
      const receipt: BundleOperationReceiptV1 = {
        schema: BUNDLE_OPERATION_RECEIPT_SCHEMA,
        receiptId: `bundle-export-receipt-${randomUUID()}`,
        operationId: safeOperationId,
        action: "export",
        planId: intent.planId,
        planDigest: intent.planDigest,
        bundleId: intent.bundleId,
        inventoryDigest: intent.inventoryDigest,
        sourceLibraryId: intent.sourceLibraryId,
        appliedAt: nowIso(),
      };
      await immutableJson(this.exportReceiptFile(safeOperationId), receipt);
      return {
        target,
        bundleId: plan.bundle.bundleId,
        inventoryDigest: plan.bundle.payloadInventoryDigest,
        operationId: safeOperationId,
        idempotentReplay: targetExists,
      };
    });
  }

  static async planFullLibraryRestore(options: {
    bundleDirectory: string;
    targetDirectory: string;
    mode: "restore" | "fork";
    authorityTransferConfirmed?: boolean;
  }): Promise<FullLibraryRestorePlanV1> {
    const bundleDirectory = await fs.realpath(path.resolve(options.bundleDirectory));
    const bundleValue = await readBundleMetadata(bundleDirectory);
    if (!isRecord(bundleValue) || bundleValue.schema !== FULL_LIBRARY_BUNDLE_SCHEMA) {
      throw new Error("not a full-library backup bundle");
    }
    const bundle = bundleValue as unknown as FullLibraryBundleV1;
    assertPortableSegment(bundle.bundleId, "bundleId");
    assertPortableSegment(bundle.sourceLibraryId, "sourceLibraryId");
    assertHash(bundle.payloadInventoryDigest, "bundle inventory digest");
    const inventory = await readInventoryFile(bundleDirectory);
    if (inventoryDigest(inventory) !== bundle.payloadInventoryDigest) {
      throw new Error("full backup inventory digest mismatch");
    }
    await verifyBundlePayload(bundleDirectory, inventory);
    if (options.mode === "restore" && options.authorityTransferConfirmed !== true) {
      throw new Error("restore requires explicit authorityTransferConfirmed; use fork for an independent clone");
    }
    const targetDirectory = path.resolve(options.targetDirectory);
    assertDisjointDirectories(bundleDirectory, targetDirectory, "restore/fork target");
    await assertPhysicallyDisjointDirectories(
      bundleDirectory,
      targetDirectory,
      "restore/fork target",
    );
    try {
      await fs.lstat(targetDirectory);
      throw new Error("restore/fork target must not already exist");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const withoutDigest: Omit<FullLibraryRestorePlanV1, "planDigest"> = {
      schema: BUNDLE_RESTORE_PLAN_SCHEMA,
      planId: `bundle-restore-plan-${randomUUID()}`,
      mode: options.mode,
      bundleDirectory,
      bundleId: bundle.bundleId,
      sourceLibraryId: bundle.sourceLibraryId,
      targetLibraryId: options.mode === "restore" ? bundle.sourceLibraryId : randomUUID(),
      targetDirectory,
      authorityTransferConfirmed: options.mode === "restore",
      payloadInventoryDigest: bundle.payloadInventoryDigest,
      expectedTargetAbsent: true,
      createdAt: nowIso(),
    };
    return { ...withoutDigest, planDigest: restorePlanDigest(withoutDigest) };
  }

  static async applyFullLibraryRestore(
    plan: FullLibraryRestorePlanV1,
    operationId: string,
  ): Promise<FullLibraryRestoreResult> {
    if (!isRecord(plan) || plan.schema !== BUNDLE_RESTORE_PLAN_SCHEMA) {
      throw new Error("invalid full-library restore plan schema");
    }
    assertPortableSegment(plan.planId, "planId");
    const safeOperationId = assertPortableSegment(operationId, "operationId");
    assertHash(plan.planDigest, "restore plan digest");
    assertHash(plan.payloadInventoryDigest, "restore inventory digest");
    if (
      restorePlanDigest(plan) !== plan.planDigest ||
      !path.isAbsolute(plan.bundleDirectory) ||
      !path.isAbsolute(plan.targetDirectory) ||
      plan.expectedTargetAbsent !== true ||
      (plan.mode === "restore" && plan.authorityTransferConfirmed !== true)
    ) {
      throw new Error("invalid full-library restore plan");
    }
    await assertPhysicallyDisjointDirectories(
      plan.bundleDirectory,
      plan.targetDirectory,
      "restore/fork target",
    );
    const bundleValue = await readBundleMetadata(plan.bundleDirectory);
    if (!isRecord(bundleValue) || bundleValue.schema !== FULL_LIBRARY_BUNDLE_SCHEMA) {
      throw new Error("stale restore plan: bundle schema changed");
    }
    const bundle = bundleValue as unknown as FullLibraryBundleV1;
    if (bundle.bundleId !== plan.bundleId) {
      throw new Error("stale restore plan: bundleId changed");
    }
    if (bundle.sourceLibraryId !== plan.sourceLibraryId) {
      throw new Error("stale restore plan: sourceLibraryId changed");
    }
    if (bundle.payloadInventoryDigest !== plan.payloadInventoryDigest) {
      throw new Error("stale restore plan: bundle inventory digest changed");
    }
    const inventory = await readInventoryFile(plan.bundleDirectory);
    if (inventoryDigest(inventory) !== plan.payloadInventoryDigest) {
      throw new Error("stale restore plan: bundle inventory changed");
    }
    await verifyBundlePayload(plan.bundleDirectory, inventory);
    const bundledReceiptPath =
      `payload/store/operations/receipts/bundle-restores/${safeOperationId}.json`;
    const bundledReceiptEntry = inventory.find(
      (entry) => portableCaseFold(entry.relativePath) === portableCaseFold(bundledReceiptPath),
    );
    let bundledReceipt: BundleOperationReceiptV1 | undefined;
    if (bundledReceiptEntry) {
      if (bundledReceiptEntry.relativePath !== bundledReceiptPath) {
        throw new Error("operationId was used for a different restore/fork");
      }
      const bytes = new Uint8Array(
        await fs.readFile(
          resolveContained(plan.bundleDirectory, bundledReceiptEntry.relativePath),
        ),
      );
      if (
        bytes.byteLength !== bundledReceiptEntry.bytes ||
        sha256(bytes) !== bundledReceiptEntry.sha256
      ) {
        throw new Error(`restore bundle changed: ${bundledReceiptPath}`);
      }
      bundledReceipt = validateRestoreReceiptForPlan(
        JSON.parse(new TextDecoder().decode(bytes)) as unknown,
        plan,
        safeOperationId,
      );
    }
    const restoreReceipt: BundleOperationReceiptV1 = bundledReceipt ?? {
      schema: BUNDLE_OPERATION_RECEIPT_SCHEMA,
      receiptId: `bundle-restore-receipt-${randomUUID()}`,
      operationId: safeOperationId,
      action: plan.mode,
      planId: plan.planId,
      planDigest: plan.planDigest,
      bundleId: plan.bundleId,
      inventoryDigest: plan.payloadInventoryDigest,
      sourceLibraryId: plan.sourceLibraryId,
      targetLibraryId: plan.targetLibraryId,
      appliedAt: nowIso(),
    };
    let targetExists = false;
    try {
      const stat = await fs.lstat(plan.targetDirectory);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("restore target exists but is not a regular directory");
      }
      const marker = await readLibraryRootMarker(plan.targetDirectory);
      if (!marker || marker.value.libraryId !== plan.targetLibraryId) {
        throw new Error("restore target already exists with a different identity");
      }
      targetExists = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const verifyExistingTarget = async () => {
      const actual = await inventoryTree({
        root: plan.targetDirectory,
        prefix: "payload",
        excludeTopLevel: new Set(["indexes", "locks"]),
      });
      const generatedReceipt =
        `payload/store/operations/receipts/bundle-restores/${safeOperationId}.json`;
      const filter = (inventory: PortableInventoryEntry[]) =>
        inventory.filter(
          (entry) =>
            entry.relativePath !== generatedReceipt &&
            !(plan.mode === "fork" && entry.relativePath === "payload/library.json"),
        );
      const expected = inventory.filter(
        (entry) => !(plan.mode === "fork" && entry.relativePath === "payload/library.json"),
      );
      if (canonicalJson(filter(actual)) !== canonicalJson(filter(expected))) {
        throw new Error("restore/fork target inventory does not match the planned backup");
      }
    };
    if (targetExists) await verifyExistingTarget();
    if (!targetExists) {
      const parent = path.dirname(plan.targetDirectory);
      await fs.mkdir(parent, { recursive: true });
      const staging = path.join(parent, `.${path.basename(plan.targetDirectory)}.${randomUUID()}.tmp`);
      await fs.mkdir(staging);
      try {
        let forkSourceMarker: LibraryRootMarkerV1 | undefined;
        for (const entry of inventory) {
          const bytes = new Uint8Array(
            await fs.readFile(
              resolveContained(
                plan.bundleDirectory,
                entry.relativePath,
              ),
            ),
          );
          if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) {
            throw new Error(`restore bundle changed: ${entry.relativePath}`);
          }
          const targetRelative = entry.relativePath.slice("payload/".length);
          if (plan.mode === "fork" && targetRelative === "library.json") {
            const markerValue = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
            if (
              !isRecord(markerValue) ||
              markerValue.schema !== "figure-library.root.v1" ||
              markerValue.libraryId !== plan.sourceLibraryId
            ) {
              throw new Error("restore bundle has an invalid source Library marker");
            }
            forkSourceMarker = markerValue as unknown as LibraryRootMarkerV1;
            continue;
          }
          await immutableWrite(resolveContained(staging, targetRelative), bytes);
        }
        if (plan.mode === "fork") {
          if (!forkSourceMarker) {
            throw new Error("restore bundle is missing its source Library marker");
          }
          const forkMarker: LibraryRootMarkerV1 = {
            ...forkSourceMarker,
            libraryId: plan.targetLibraryId,
            createdAt: nowIso(),
            forkedFromLibraryId: plan.sourceLibraryId,
          };
          await immutableJson(path.join(staging, "library.json"), forkMarker);
        }
        if (!bundledReceipt) {
          // The authoritative target and its operation receipt must become
          // visible together.  A crash after the directory rename can then be
          // replayed without relying on the process-local plan cache.
          await immutableJson(
            path.join(
              staging,
              "store",
              "operations",
              "receipts",
              "bundle-restores",
              `${safeOperationId}.json`,
            ),
            restoreReceipt,
          );
        }
        await fs.rename(staging, plan.targetDirectory);
      } catch (error) {
        await fs.rm(staging, { recursive: true, force: true });
        throw error;
      }
    }
    await ensureLibraryRootMarker(plan.targetDirectory, plan.targetLibraryId);
    const receiptFile = path.join(
      plan.targetDirectory,
      "store",
      "operations",
      "receipts",
      "bundle-restores",
      `${safeOperationId}.json`,
    );
    let prior = false;
    try {
      const value = await readJson(receiptFile);
      validateRestoreReceiptForPlan(value, plan, safeOperationId);
      prior = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (!prior) {
      // Compatibility recovery for a target created by an older build in the
      // rename-before-receipt crash window.  New targets always carry this
      // receipt inside staging before the atomic rename above.
      await immutableJson(receiptFile, restoreReceipt);
    }
    return {
      target: plan.targetDirectory,
      sourceLibraryId: plan.sourceLibraryId,
      targetLibraryId: plan.targetLibraryId,
      mode: plan.mode,
      operationId: safeOperationId,
      idempotentReplay: targetExists,
    };
  }

  async planTemplateBundleImport(options: {
    bundleDirectory: string;
    targetTemplateId: string;
    mode: "create" | "update_published" | "update_working";
  }): Promise<TemplateBundleImportPlanV1> {
    const bundleDirectory = await fs.realpath(path.resolve(options.bundleDirectory));
    const bundleValue = await readBundleMetadata(bundleDirectory);
    if (!isRecord(bundleValue) || bundleValue.schema !== TEMPLATE_BUNDLE_SCHEMA) {
      throw new Error("not a Published template bundle");
    }
    const bundle = bundleValue as unknown as PublishedTemplateBundleV1;
    assertPortableSegment(bundle.bundleId, "bundleId");
    assertPortableSegment(bundle.sourceLibraryId, "sourceLibraryId");
    if (
      bundle.providerId !== "org.scientificfigurelibrary.local" ||
      bundle.importAuthorityPolicy !== "working_revision_requires_local_review" ||
      !isRecord(bundle.selector)
    ) {
      throw new Error("template bundle has invalid provider or authority metadata");
    }
    for (const field of ["templateId", "revisionId", "releaseId"] as const) {
      assertPortableSegment(bundle.selector[field], `selector.${field}`);
    }
    assertHash(bundle.selector.contentDigest, "selector content digest");
    assertHash(bundle.selector.releaseDigest, "selector Release digest");
    assertHash(bundle.payloadInventoryDigest, "template bundle inventory digest");
    const inventory = await readInventoryFile(bundleDirectory);
    if (inventoryDigest(inventory) !== bundle.payloadInventoryDigest) {
      throw new Error("template bundle inventory digest mismatch");
    }
    await verifyBundlePayload(bundleDirectory, inventory);
    const contentValue = await readJson(path.join(bundleDirectory, "payload", "revision", "content.json"));
    const reviewValue = await readJson(path.join(bundleDirectory, "payload", "review", "review.json"));
    const releaseValue = await readJson(path.join(bundleDirectory, "payload", "release", "release.json"));
    const seriesValue = await readJson(path.join(bundleDirectory, "payload", "series", "series.json"));
    if (!isRecord(contentValue) || contentValue.schema !== "figure-library.template-content.v1") {
      throw new Error("template bundle has invalid content.json");
    }
    if (!isRecord(releaseValue) || releaseValue.schema !== "figure-library.template-release.v1") {
      throw new Error("template bundle has invalid release.json");
    }
    if (!isRecord(reviewValue) || reviewValue.schema !== "figure-library.review-snapshot.v1") {
      throw new Error("template bundle has invalid review.json");
    }
    if (!isRecord(seriesValue) || seriesValue.schema !== "figure-library.template-series.v1") {
      throw new Error("template bundle has invalid series.json");
    }
    const content = contentValue as unknown as TemplateContentV1;
    const review = reviewValue as unknown as ReviewSnapshotV1;
    const release = releaseValue as unknown as TemplateReleaseV1;
    const bundleSeries = seriesValue as unknown as TemplateSeriesV1;
    if (
      digestWithout(content as unknown as Record<string, unknown>, "contentDigest") !==
        content.contentDigest ||
      digestWithout(review as unknown as Record<string, unknown>, "reviewDigest") !==
        review.reviewDigest ||
      digestWithout(release as unknown as Record<string, unknown>, "releaseDigest") !==
        release.releaseDigest ||
      content.templateId !== bundle.selector.templateId ||
      content.revisionId !== bundle.selector.revisionId ||
      content.contentDigest !== bundle.selector.contentDigest ||
      release.releaseId !== bundle.selector.releaseId ||
      release.releaseDigest !== bundle.selector.releaseDigest ||
      release.revisionId !== content.revisionId ||
      release.contentDigest !== content.contentDigest ||
      release.reviewId !== review.reviewId ||
      release.reviewDigest !== review.reviewDigest ||
      review.revisionId !== content.revisionId ||
      bundleSeries.templateId !== content.templateId ||
      bundleSeries.workingHead !== undefined ||
      bundleSeries.publishedHead?.revisionId !== release.revisionId ||
      bundleSeries.publishedHead.contentDigest !== release.contentDigest ||
      bundleSeries.publishedHead.releaseId !== release.releaseId
    ) {
      throw new Error("template bundle selector does not match immutable payload");
    }
    const inventoryByPath = new Map(
      inventory.map((entry) => [entry.relativePath, entry]),
    );
    for (const asset of content.assets) {
      const logicalPath = safeRelativePath(asset.logicalPath);
      const storedFile = safeRelativePath(asset.file);
      if (storedFile !== `assets/${logicalPath}`) {
        throw new Error(`template bundle asset file mismatch: ${storedFile}`);
      }
      const entry = inventoryByPath.get(`payload/revision/${storedFile}`);
      if (
        !entry ||
        entry.bytes !== asset.bytes ||
        entry.sha256 !== asset.sha256
      ) {
        throw new Error(`template bundle asset inventory mismatch: ${logicalPath}`);
      }
    }
    const targetTemplateId = assertPortableSegment(options.targetTemplateId, "targetTemplateId");
    const series = await this.library.getSeries(targetTemplateId);
    if (options.mode === "create" && series) throw new Error("create import target already exists");
    if (options.mode === "update_published" && (!series?.publishedHead || series.workingHead)) {
      throw new Error("update_published requires a Published series without a Working Head");
    }
    if (options.mode === "update_working" && !series?.workingHead) {
      throw new Error("update_working requires an existing Working Head");
    }
    const requiredAssetSha256 = content.assets.map((asset) => asset.sha256).sort();
    const importId = `bundle-${sha256(`${bundle.bundleId}:${targetTemplateId}`).slice(0, 24)}`;
    const candidate: VersionedTemplateCandidate = {
      title: content.title,
      description: content.description,
      tags: content.tags,
      visualProfile: content.visualProfile,
      dataProfile: content.dataProfile,
      ...(content.scientificQuestion ? { scientificQuestion: content.scientificQuestion } : {}),
      packages: content.packages,
      license: content.license,
      assetKind: content.assetKind,
      language: content.language,
      plotFamily: content.plotFamily,
      codeStatus: content.codeStatus,
      executionStatus: content.executionStatus,
      ...(content.primaryPreview ? { primaryPreview: content.primaryPreview } : {}),
      ...(content.canonicalImplementation
        ? { canonicalImplementation: content.canonicalImplementation }
        : {}),
      ...(content.visualGrouping ? { visualGrouping: content.visualGrouping } : {}),
      figureCodeLinks: content.figureCodeLinks,
      ...(content.provenance !== undefined ? { provenance: content.provenance } : {}),
      annotations: {
        ...(isRecord(content.annotations) ? content.annotations : {}),
        bundleImport: {
          sourceLibraryId: bundle.sourceLibraryId,
          selector: bundle.selector,
          authorityInherited: false,
        },
      } as JsonValue,
      intakeBinding: {
        adapterId: "template-bundle",
        importId,
        sourceManifest: bundle as unknown as JsonValue,
        requiredAssetSha256,
      },
      assets: content.assets.map((asset: StoredRevisionAsset) => ({
        logicalPath: asset.logicalPath,
        role: asset.role,
        ...(asset.visualRole ? { visualRole: asset.visualRole } : {}),
        ...(asset.codeOrigin ? { codeOrigin: asset.codeOrigin } : {}),
        mediaType: asset.mediaType,
        ...(asset.language ? { language: asset.language } : {}),
        sourcePath: (() => {
          const logicalPath = safeRelativePath(asset.logicalPath);
          const storedFile = safeRelativePath(asset.file);
          if (storedFile !== `assets/${logicalPath}`) {
            throw new Error(`template bundle asset file mismatch: ${storedFile}`);
          }
          return resolveContained(
            path.join(bundleDirectory, "payload", "revision"),
            storedFile,
          );
        })(),
        ...(asset.origin !== undefined ? { origin: asset.origin } : {}),
      })),
    };
    const assessment = {
      warnings: [
        {
          code: "imported_approval_not_inherited",
          message: "The source Library's approval is provenance only; this import remains Working until local review and publish.",
          source: "migration" as const,
        },
      ],
    };
    const lifecyclePlan =
      options.mode === "update_working"
        ? await this.library.planUpdateWorking({
            templateId: targetTemplateId,
            candidate,
            assessment,
          })
        : await this.library.planCreateWorking({
            templateId: targetTemplateId,
            candidate,
            assessment,
          });
    const withoutDigest: Omit<TemplateBundleImportPlanV1, "planDigest"> = {
      schema: TEMPLATE_BUNDLE_IMPORT_PLAN_SCHEMA,
      planId: `template-bundle-import-plan-${randomUUID()}`,
      bundleDirectory,
      bundleId: bundle.bundleId,
      bundleInventoryDigest: bundle.payloadInventoryDigest,
      targetTemplateId,
      mode: options.mode,
      lifecyclePlan,
      createdAt: nowIso(),
    };
    return { ...withoutDigest, planDigest: importPlanDigest(withoutDigest) };
  }

  async applyTemplateBundleImport(
    plan: TemplateBundleImportPlanV1,
    operationId: string,
  ): Promise<LifecycleApplyResult> {
    if (!isRecord(plan) || plan.schema !== TEMPLATE_BUNDLE_IMPORT_PLAN_SCHEMA) {
      throw new Error("invalid template bundle import plan schema");
    }
    assertPortableSegment(plan.planId, "planId");
    assertPortableSegment(operationId, "operationId");
    assertHash(plan.planDigest, "template bundle import plan digest");
    if (!path.isAbsolute(plan.bundleDirectory) || importPlanDigest(plan) !== plan.planDigest) {
      throw new Error("invalid template bundle import plan digest");
    }
    const intakeBinding = plan.lifecyclePlan.content.intakeBinding;
    if (
      !intakeBinding ||
      intakeBinding.adapterId !== "template-bundle" ||
      !isRecord(intakeBinding.sourceManifest) ||
      intakeBinding.sourceManifest.schema !== TEMPLATE_BUNDLE_SCHEMA
    ) {
      throw new Error("invalid template bundle import plan source manifest");
    }
    const bundleValue = await readBundleMetadata(plan.bundleDirectory);
    if (!isRecord(bundleValue) || bundleValue.schema !== TEMPLATE_BUNDLE_SCHEMA) {
      throw new Error("stale template bundle import plan: bundle schema changed");
    }
    if (
      bundleValue.bundleId !== plan.bundleId ||
      bundleValue.payloadInventoryDigest !== plan.bundleInventoryDigest
    ) {
      throw new Error("stale template bundle import plan: bundle identity changed");
    }
    if (canonicalJson(bundleValue) !== canonicalJson(intakeBinding.sourceManifest)) {
      throw new Error("stale template bundle import plan: bundle metadata changed");
    }
    const inventory = await readInventoryFile(plan.bundleDirectory);
    if (inventoryDigest(inventory) !== plan.bundleInventoryDigest) {
      throw new Error("stale template bundle import plan: inventory changed");
    }
    await verifyBundlePayload(plan.bundleDirectory, inventory);
    const result =
      plan.lifecyclePlan.action === "update_working"
        ? await this.library.applyUpdateWorking(plan.lifecyclePlan, operationId)
        : await this.library.applyCreateWorking(plan.lifecyclePlan, operationId);
    const series = await this.library.getSeries(plan.targetTemplateId);
    if (!series?.workingHead || series.publishedHead?.revisionId === result.revisionId) {
      throw new Error("template bundle import did not create a distinct Working Head");
    }
    return result;
  }
}
