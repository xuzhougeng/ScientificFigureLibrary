import { createHash, randomUUID } from "node:crypto";
import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJson, compareCanonicalStrings } from "./canonical-json.ts";
import { withCrossRuntimeWriteLock } from "./cross-runtime-lock.ts";

export const LIBRARY_ROOT_MARKER_SCHEMA = "figure-library.root.v1" as const;
export const LIBRARY_LOCATOR_SCHEMA = "figure-library.locator.v2" as const;
export const LIBRARY_BINDING_PLAN_SCHEMA = "figure-library.binding-plan.v2" as const;
export const LIBRARY_BINDING_RECEIPT_SCHEMA =
  "figure-library.binding-receipt.v1" as const;
export const LEGACY_LIBRARY_COPY_RECEIPT_SCHEMA =
  "figure-library.legacy-flat-stage-receipt.v1" as const;
export const LIBRARY_ROOT_MARKER_FILE = "library.json" as const;

const HASH = /^[a-f0-9]{64}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const PORTABLE_ASCII_SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const WINDOWS_RESERVED_BASENAME = /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$/iu;
const MAX_BINDING_INVENTORY_FILES = 20_000;

type Environment = Readonly<Record<string, string | undefined>>;

function nowIso() {
  return new Date().toISOString();
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
}

function readJsonSync(file: string): unknown {
  return JSON.parse(fsSync.readFileSync(file, "utf8")) as unknown;
}

async function atomicWriteJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await fs.rename(temporary, file);
}

async function immutableWriteJson(file: string, value: unknown) {
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, serialized, { flag: "wx" });
    await fs.chmod(file, 0o444).catch(() => undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if ((await fs.readFile(file, "utf8")) !== serialized) {
      throw new Error(`immutable library metadata collision: ${file}`);
    }
  }
}

function pathImplementation(platform: NodeJS.Platform) {
  return platform === "win32" ? path.win32 : path.posix;
}

function resolveForPlatform(value: string, platform: NodeJS.Platform) {
  return pathImplementation(platform).resolve(value);
}

function isAbsoluteForPlatform(value: string, platform: NodeJS.Platform) {
  return pathImplementation(platform).isAbsolute(value);
}

function samePathForPlatform(left: string, right: string, platform: NodeJS.Platform) {
  const implementation = pathImplementation(platform);
  const normalize = (value: string) => {
    const resolved = implementation.resolve(value);
    return platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  return normalize(left) === normalize(right);
}

export function portableCaseFold(value: string) {
  return value.normalize("NFC").toLowerCase();
}

export function assertPortableSegment(value: string, label = "path segment") {
  if (
    value !== value.normalize("NFC") ||
    !PORTABLE_ASCII_SEGMENT.test(value) ||
    value.endsWith(".") ||
    value.endsWith(" ") ||
    WINDOWS_RESERVED_BASENAME.test(value)
  ) {
    throw new Error(`unsafe portable ${label}: ${value}`);
  }
  return value;
}

export function assertPortableFilesystemSegment(value: string, label = "path segment") {
  if (
    !value ||
    value !== value.normalize("NFC") ||
    value === "." ||
    value === ".." ||
    /[\u0000-\u001F<>:"/\\|?*]/u.test(value) ||
    value.endsWith(".") ||
    value.endsWith(" ") ||
    WINDOWS_RESERVED_BASENAME.test(value)
  ) {
    throw new Error(`unsafe portable ${label}: ${value}`);
  }
  return value;
}

export function assertNoPortableCaseCollision(values: Iterable<string>, label = "path") {
  const observed = new Map<string, string>();
  for (const value of values) {
    const folded = portableCaseFold(value);
    const prior = observed.get(folded);
    if (prior !== undefined && prior !== value) {
      throw new Error(`portable case-fold collision in ${label}: ${prior}, ${value}`);
    }
    observed.set(folded, value);
  }
}

export interface LibraryRootMarkerV1 {
  schema: typeof LIBRARY_ROOT_MARKER_SCHEMA;
  libraryId: string;
  createdAt: string;
  storageFormat: {
    major: 1;
    minor: number;
    layout: "figure-library.store-layout.v1";
    pathPolicy: "portable-relative-posix";
    canonicalJson: "RFC8785";
    digestAlgorithm: "sha256";
  };
  requiredCapabilities: string[];
  extensions: Record<string, unknown>;
  forkedFromLibraryId?: string;
}

export interface LibraryLocatorV1 {
  schema: typeof LIBRARY_LOCATOR_SCHEMA;
  configRevision: number;
  libraryId: string;
  libraryDirectory: string;
  updatedAt: string;
}

export type LibraryDirectorySource =
  | "argument"
  | "FIGURE_LIBRARY_DIR"
  | "locator"
  | "legacy-default";

export interface LibraryOperationContext {
  libraryId: string;
  configRevision: number | null;
}

export interface LibraryRuntimeSnapshot {
  root: string;
  directorySource: LibraryDirectorySource;
  locatorPath: string;
  configRevision: number | null;
  locatorDigest: string | null;
  libraryId?: string;
  markerDigest?: string;
  writesEnabled: boolean;
  legacyDefault: boolean;
  contextKey: string;
}

export interface LibraryRuntimeOptions {
  root?: string;
  locatorPath?: string;
  platform?: NodeJS.Platform;
  env?: Environment;
  homedir?: string;
}

export type GlobalLibraryLocatorStatus =
  | "missing"
  | "valid_v2"
  | "malformed_json"
  | "unsupported_or_v1_schema"
  | "dangling_target"
  | "target_missing_root_marker"
  | "library_id_mismatch";

export interface GlobalLibraryLocatorObservation {
  status: GlobalLibraryLocatorStatus;
  rawDigest: string | null;
  configRevision: number | null;
}

export interface LibraryBindingRuntimeContext {
  locatorPath: string;
  environmentOverrideRoot?: string;
}

export function defaultLibraryLocatorPath(options: {
  platform?: NodeJS.Platform;
  env?: Environment;
  homedir?: string;
} = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.env ?? process.env;
  const home = options.homedir ?? os.homedir();
  const implementation = pathImplementation(platform);
  if (platform === "win32") {
    const appData = environment.APPDATA?.trim() || implementation.join(home, "AppData", "Roaming");
    return implementation.join(appData, "ScientificFigureLibrary", "locator.json");
  }
  const configHome = environment.XDG_CONFIG_HOME?.trim() || implementation.join(home, ".config");
  return implementation.join(configHome, "scientific-figure-library", "locator.json");
}

export function legacyDefaultLibraryRoot(options: {
  platform?: NodeJS.Platform;
  homedir?: string;
} = {}) {
  const platform = options.platform ?? process.platform;
  return pathImplementation(platform).join(options.homedir ?? os.homedir(), ".figure-library");
}

export function libraryBindingRuntimeContext(
  options: LibraryRuntimeOptions = {},
): LibraryBindingRuntimeContext {
  const platform = options.platform ?? process.platform;
  const environment = options.env ?? process.env;
  const home = options.homedir ?? os.homedir();
  const locatorPath = resolveForPlatform(
    options.locatorPath ?? defaultLibraryLocatorPath({ platform, env: environment, homedir: home }),
    platform,
  );
  const environmentRoot = environment.FIGURE_LIBRARY_DIR?.trim();
  return {
    locatorPath,
    ...(environmentRoot
      ? { environmentOverrideRoot: resolveForPlatform(environmentRoot, platform) }
      : {}),
  };
}

function validateRootMarker(value: unknown): LibraryRootMarkerV1 {
  if (!isRecord(value) || value.schema !== LIBRARY_ROOT_MARKER_SCHEMA) {
    throw new Error("invalid ScientificFigureLibrary root marker schema");
  }
  if (typeof value.libraryId !== "string" || !UUID.test(value.libraryId)) {
    throw new Error("invalid ScientificFigureLibrary root marker libraryId");
  }
  if (typeof value.createdAt !== "string" || Number.isNaN(Date.parse(value.createdAt))) {
    throw new Error("invalid ScientificFigureLibrary root marker timestamp");
  }
  if (
    !isRecord(value.storageFormat) ||
    value.storageFormat.major !== 1 ||
    !Number.isSafeInteger(value.storageFormat.minor) ||
    (value.storageFormat.minor as number) < 0 ||
    value.storageFormat.layout !== "figure-library.store-layout.v1" ||
    value.storageFormat.pathPolicy !== "portable-relative-posix" ||
    value.storageFormat.canonicalJson !== "RFC8785" ||
    value.storageFormat.digestAlgorithm !== "sha256"
  ) {
    throw new Error("unsupported ScientificFigureLibrary storage format");
  }
  if (
    !Array.isArray(value.requiredCapabilities) ||
    value.requiredCapabilities.some((item) => typeof item !== "string" || !item.trim()) ||
    value.requiredCapabilities.length > 0
  ) {
    throw new Error("ScientificFigureLibrary requires unsupported storage capabilities");
  }
  if (!isRecord(value.extensions)) {
    throw new Error("invalid ScientificFigureLibrary extensions object");
  }
  if (
    value.forkedFromLibraryId !== undefined &&
    (typeof value.forkedFromLibraryId !== "string" || !UUID.test(value.forkedFromLibraryId))
  ) {
    throw new Error("invalid ScientificFigureLibrary forkedFromLibraryId");
  }
  return value as unknown as LibraryRootMarkerV1;
}

function validateLocator(value: unknown, platform: NodeJS.Platform): LibraryLocatorV1 {
  if (!isRecord(value) || value.schema !== LIBRARY_LOCATOR_SCHEMA) {
    throw new Error("invalid ScientificFigureLibrary locator schema");
  }
  if (!Number.isSafeInteger(value.configRevision) || (value.configRevision as number) < 1) {
    throw new Error("invalid ScientificFigureLibrary locator configRevision");
  }
  if (typeof value.libraryId !== "string" || !UUID.test(value.libraryId)) {
    throw new Error("invalid ScientificFigureLibrary locator libraryId");
  }
  if (
    typeof value.libraryDirectory !== "string" ||
    !isAbsoluteForPlatform(value.libraryDirectory, platform)
  ) {
    throw new Error("ScientificFigureLibrary locator requires an absolute native libraryDirectory");
  }
  if (typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))) {
    throw new Error("invalid ScientificFigureLibrary locator timestamp");
  }
  return value as unknown as LibraryLocatorV1;
}

async function assertRegularJsonFile(file: string, label: string) {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} is not a regular file`);
}

function assertRegularJsonFileSync(file: string, label: string) {
  const stat = fsSync.lstatSync(file);
  if (stat.isSymbolicLink() || !stat.isFile()) throw new Error(`${label} is not a regular file`);
}

export async function readLibraryRootMarker(root: string) {
  const file = path.join(path.resolve(root), LIBRARY_ROOT_MARKER_FILE);
  try {
    await assertRegularJsonFile(file, "ScientificFigureLibrary root marker");
    const value = validateRootMarker(await readJson(file));
    return { value, digest: sha256(canonicalJson(value)), file };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function readLibraryRootMarkerSync(root: string) {
  const file = path.join(path.resolve(root), LIBRARY_ROOT_MARKER_FILE);
  try {
    assertRegularJsonFileSync(file, "ScientificFigureLibrary root marker");
    const value = validateRootMarker(readJsonSync(file));
    return { value, digest: sha256(canonicalJson(value)), file };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

export async function ensureLibraryRootMarker(
  root: string,
  expectedLibraryId?: string,
  options: { forkedFromLibraryId?: string } = {},
) {
  const resolved = path.resolve(root);
  await fs.mkdir(resolved, { recursive: true });
  const stat = await fs.lstat(resolved);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error("ScientificFigureLibrary root must be a regular directory, not a symbolic link");
  }
  const file = path.join(resolved, LIBRARY_ROOT_MARKER_FILE);
  const proposed: LibraryRootMarkerV1 = {
    schema: LIBRARY_ROOT_MARKER_SCHEMA,
    libraryId: expectedLibraryId ?? randomUUID(),
    createdAt: nowIso(),
    storageFormat: {
      major: 1,
      minor: 0,
      layout: "figure-library.store-layout.v1",
      pathPolicy: "portable-relative-posix",
      canonicalJson: "RFC8785",
      digestAlgorithm: "sha256",
    },
    requiredCapabilities: [],
    extensions: {},
    ...(options.forkedFromLibraryId
      ? { forkedFromLibraryId: options.forkedFromLibraryId }
      : {}),
  };
  try {
    await fs.writeFile(file, `${JSON.stringify(proposed, null, 2)}\n`, { flag: "wx" });
    await fs.chmod(file, 0o444).catch(() => undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const marker = await readLibraryRootMarker(resolved);
  if (!marker) throw new Error("ScientificFigureLibrary root marker disappeared after creation");
  if (expectedLibraryId && marker.value.libraryId !== expectedLibraryId) {
    throw new Error(
      `ScientificFigureLibrary libraryId mismatch: expected ${expectedLibraryId}, found ${marker.value.libraryId}`,
    );
  }
  const authoritativeDirectories = [
    "store/templates",
    "store/operations/intents",
    "store/operations/receipts",
    "store/imports",
    "store/migrations/flat-v1",
    "store/exports",
    "store/quarantine",
  ];
  const derivedOrRuntimeDirectories = ["indexes", "locks"];
  await Promise.all(
    [...authoritativeDirectories, ...derivedOrRuntimeDirectories].map((relative) =>
      fs.mkdir(path.join(resolved, ...relative.split("/")), { recursive: true }),
    ),
  );
  return marker;
}

async function readLocator(locatorPath: string, platform: NodeJS.Platform) {
  try {
    await assertRegularJsonFile(locatorPath, "ScientificFigureLibrary locator");
    const value = validateLocator(await readJson(locatorPath), platform);
    return { value, digest: sha256(canonicalJson(value)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

interface ObservedGlobalLibraryLocator extends GlobalLibraryLocatorObservation {
  value?: LibraryLocatorV1;
}

async function observeGlobalLibraryLocator(
  locatorPath: string,
  platform: NodeJS.Platform,
): Promise<ObservedGlobalLibraryLocator> {
  let bytes: Uint8Array;
  try {
    await assertRegularJsonFile(locatorPath, "ScientificFigureLibrary locator");
    bytes = new Uint8Array(await fs.readFile(locatorPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { status: "missing", rawDigest: null, configRevision: null };
    }
    throw error;
  }

  const rawDigest = sha256(bytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  } catch {
    return { status: "malformed_json", rawDigest, configRevision: null };
  }
  const observedRevision =
    isRecord(parsed) &&
    Number.isSafeInteger(parsed.configRevision) &&
    Number(parsed.configRevision) >= 1
      ? Number(parsed.configRevision)
      : null;

  let value: LibraryLocatorV1;
  try {
    value = validateLocator(parsed, platform);
  } catch {
    return {
      status: "unsupported_or_v1_schema",
      rawDigest,
      configRevision: observedRevision,
    };
  }

  const root = resolveForPlatform(value.libraryDirectory, platform);
  try {
    const stat = await fs.lstat(root);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      return {
        status: "dangling_target",
        rawDigest,
        configRevision: value.configRevision,
        value,
      };
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        status: "dangling_target",
        rawDigest,
        configRevision: value.configRevision,
        value,
      };
    }
    throw error;
  }

  let marker: Awaited<ReturnType<typeof readLibraryRootMarker>>;
  try {
    marker = await readLibraryRootMarker(root);
  } catch {
    marker = undefined;
  }
  if (!marker) {
    return {
      status: "target_missing_root_marker",
      rawDigest,
      configRevision: value.configRevision,
      value,
    };
  }
  if (marker.value.libraryId !== value.libraryId) {
    return {
      status: "library_id_mismatch",
      rawDigest,
      configRevision: value.configRevision,
      value,
    };
  }
  return {
    status: "valid_v2",
    rawDigest,
    configRevision: value.configRevision,
    value,
  };
}

function readLocatorSync(locatorPath: string, platform: NodeJS.Platform) {
  try {
    assertRegularJsonFileSync(locatorPath, "ScientificFigureLibrary locator");
    const value = validateLocator(readJsonSync(locatorPath), platform);
    return { value, digest: sha256(canonicalJson(value)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function snapshot(options: {
  root: string;
  directorySource: LibraryDirectorySource;
  locatorPath: string;
  configRevision: number | null;
  locatorDigest: string | null;
  marker?: { value: LibraryRootMarkerV1; digest: string };
}) : LibraryRuntimeSnapshot {
  const writesEnabled = options.directorySource !== "legacy-default";
  const libraryId = options.marker?.value.libraryId;
  return {
    root: options.root,
    directorySource: options.directorySource,
    locatorPath: options.locatorPath,
    configRevision: options.configRevision,
    locatorDigest: options.locatorDigest,
    ...(libraryId ? { libraryId } : {}),
    ...(options.marker ? { markerDigest: options.marker.digest } : {}),
    writesEnabled,
    legacyDefault: options.directorySource === "legacy-default",
    contextKey: canonicalJson({
      root: options.root,
      directorySource: options.directorySource,
      configRevision: options.configRevision,
      libraryId: libraryId ?? null,
    }),
  };
}

export async function resolveLibraryRuntimeSnapshot(
  options: LibraryRuntimeOptions = {},
): Promise<LibraryRuntimeSnapshot> {
  const platform = options.platform ?? process.platform;
  const environment = options.env ?? process.env;
  const home = options.homedir ?? os.homedir();
  const locatorPath = options.locatorPath ??
    defaultLibraryLocatorPath({ platform, env: environment, homedir: home });
  if (options.root) {
    const root = resolveForPlatform(options.root, platform);
    const marker = platform === process.platform ? await readLibraryRootMarker(root) : undefined;
    return snapshot({
      root,
      directorySource: "argument",
      locatorPath,
      configRevision: null,
      locatorDigest: null,
      ...(marker ? { marker } : {}),
    });
  }
  const environmentRoot = environment.FIGURE_LIBRARY_DIR?.trim();
  if (environmentRoot) {
    const root = resolveForPlatform(environmentRoot, platform);
    const marker = platform === process.platform ? await readLibraryRootMarker(root) : undefined;
    return snapshot({
      root,
      directorySource: "FIGURE_LIBRARY_DIR",
      locatorPath,
      configRevision: null,
      locatorDigest: null,
      ...(marker ? { marker } : {}),
    });
  }
  const located = await readLocator(locatorPath, platform);
  if (located) {
    const root = resolveForPlatform(located.value.libraryDirectory, platform);
    const marker = await readLibraryRootMarker(root);
    if (!marker) throw new Error("ScientificFigureLibrary locator target has no root marker");
    if (marker.value.libraryId !== located.value.libraryId) {
      throw new Error(
        `ScientificFigureLibrary locator/root libraryId mismatch: ${located.value.libraryId}, ${marker.value.libraryId}`,
      );
    }
    return snapshot({
      root,
      directorySource: "locator",
      locatorPath,
      configRevision: located.value.configRevision,
      locatorDigest: located.digest,
      marker,
    });
  }
  const root = resolveForPlatform(legacyDefaultLibraryRoot({ platform, homedir: home }), platform);
  const marker = platform === process.platform ? await readLibraryRootMarker(root) : undefined;
  return snapshot({
    root,
    directorySource: "legacy-default",
    locatorPath,
    configRevision: null,
    locatorDigest: null,
    ...(marker ? { marker } : {}),
  });
}

export function resolveLibraryRuntimeSnapshotSync(
  options: LibraryRuntimeOptions = {},
): LibraryRuntimeSnapshot {
  const platform = options.platform ?? process.platform;
  const environment = options.env ?? process.env;
  const home = options.homedir ?? os.homedir();
  const locatorPath = options.locatorPath ??
    defaultLibraryLocatorPath({ platform, env: environment, homedir: home });
  if (options.root) {
    const root = resolveForPlatform(options.root, platform);
    const marker = platform === process.platform ? readLibraryRootMarkerSync(root) : undefined;
    return snapshot({ root, directorySource: "argument", locatorPath, configRevision: null, locatorDigest: null, ...(marker ? { marker } : {}) });
  }
  const environmentRoot = environment.FIGURE_LIBRARY_DIR?.trim();
  if (environmentRoot) {
    const root = resolveForPlatform(environmentRoot, platform);
    const marker = platform === process.platform ? readLibraryRootMarkerSync(root) : undefined;
    return snapshot({ root, directorySource: "FIGURE_LIBRARY_DIR", locatorPath, configRevision: null, locatorDigest: null, ...(marker ? { marker } : {}) });
  }
  const located = readLocatorSync(locatorPath, platform);
  if (located) {
    const root = resolveForPlatform(located.value.libraryDirectory, platform);
    const marker = readLibraryRootMarkerSync(root);
    if (!marker) throw new Error("ScientificFigureLibrary locator target has no root marker");
    if (marker.value.libraryId !== located.value.libraryId) {
      throw new Error("ScientificFigureLibrary locator/root libraryId mismatch");
    }
    return snapshot({
      root,
      directorySource: "locator",
      locatorPath,
      configRevision: located.value.configRevision,
      locatorDigest: located.digest,
      marker,
    });
  }
  const root = resolveForPlatform(legacyDefaultLibraryRoot({ platform, homedir: home }), platform);
  const marker = platform === process.platform ? readLibraryRootMarkerSync(root) : undefined;
  return snapshot({ root, directorySource: "legacy-default", locatorPath, configRevision: null, locatorDigest: null, ...(marker ? { marker } : {}) });
}

export class LibraryRuntime {
  private readonly options: LibraryRuntimeOptions;
  private lastSnapshot?: LibraryRuntimeSnapshot;

  constructor(options: LibraryRuntimeOptions = {}) {
    this.options = { ...options };
  }

  async current() {
    this.lastSnapshot = await resolveLibraryRuntimeSnapshot(this.options);
    return this.lastSnapshot;
  }

  async refresh() {
    return this.current();
  }

  bindingContext() {
    return libraryBindingRuntimeContext(this.options);
  }

  cached() {
    return this.lastSnapshot;
  }
}

export function operationContextForSnapshot(
  value: Pick<LibraryRuntimeSnapshot, "libraryId" | "configRevision">,
): LibraryOperationContext | undefined {
  return value.libraryId
    ? { libraryId: value.libraryId, configRevision: value.configRevision }
    : undefined;
}

export function assertLibraryOperationContext(
  actual: LibraryOperationContext | undefined,
  expected: LibraryOperationContext | undefined,
) {
  if (canonicalJson(actual ?? null) !== canonicalJson(expected ?? null)) {
    throw new Error(
      "stale library context: libraryId or locator configRevision changed after planning",
    );
  }
}

export interface GlobalLibraryBindingPlanV1 {
  schema: typeof LIBRARY_BINDING_PLAN_SCHEMA;
  bindingId: string;
  locatorPath: string;
  libraryDirectory: string;
  libraryId: string;
  configRevision: number;
  expectedLocatorStatus: GlobalLibraryLocatorStatus;
  expectedLocatorRawDigest: string | null;
  expectedConfigRevision: number | null;
  expectedTargetMarkerDigest: string | null;
  expectedTargetInventory: LibraryFileInventoryEntry[];
  expectedTargetStateDigest: string;
  migration:
    | { mode: "none" }
    | {
        mode: "copy_legacy";
        sourceDirectory: string;
        sourceInventory: LibraryFileInventoryEntry[];
        sourceInventoryDigest: string;
      };
  createdAt: string;
  planDigest: string;
}

export interface GlobalLibraryBindingReceiptV1 {
  schema: typeof LIBRARY_BINDING_RECEIPT_SCHEMA;
  receiptId: string;
  operationId: string;
  bindingId: string;
  planDigest: string;
  locatorPath: string;
  libraryDirectory: string;
  libraryId: string;
  configRevision: number;
  migrationMode: "none" | "copy_legacy";
  migrationReceiptFile?: string;
  appliedAt: string;
}

export interface LibraryFileInventoryEntry {
  relativePath: string;
  bytes: number;
  sha256: string;
}

export interface LegacyLibraryCopyReceiptV1 {
  schema: typeof LEGACY_LIBRARY_COPY_RECEIPT_SCHEMA;
  receiptId: string;
  bindingId: string;
  bindingPlanDigest: string;
  sourceInventoryDigest: string;
  stagedRelativeDirectory: string;
  copiedFiles: number;
  copiedBytes: number;
  copiedAt: string;
  sourcePreserved: true;
}

export interface ApplyGlobalLibraryBindingResult extends GlobalLibraryBindingReceiptV1 {
  idempotentReplay: boolean;
}

function inventoryDigest(entries: LibraryFileInventoryEntry[]) {
  return sha256(canonicalJson(entries));
}

async function inventoryTree(options: {
  root: string;
  relativePrefix?: string;
  exclude?: (relativePath: string, isDirectory: boolean) => boolean;
}) {
  const root = path.resolve(options.root);
  const prefix = options.relativePrefix ?? "";
  const output: LibraryFileInventoryEntry[] = [];
  const foldedPaths = new Map<string, string>();
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" && directory === root) return;
      throw error;
    }
    entries.sort((left, right) => compareCanonicalStrings(left.name, right.name));
    for (const entry of entries) {
      assertPortableFilesystemSegment(entry.name, "library inventory path segment");
      const relative = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const publicRelative = prefix ? `${prefix}/${relative}` : relative;
      if (options.exclude?.(publicRelative, entry.isDirectory())) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`library inventory cannot contain symbolic links: ${publicRelative}`);
      }
      if (entry.isDirectory()) {
        await walk(absolute, relative);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`library inventory contains a non-regular file: ${publicRelative}`);
      }
      const stat = await fs.stat(absolute);
      const bytes = new Uint8Array(await fs.readFile(absolute));
      if (stat.size !== bytes.byteLength) {
        throw new Error(`library file changed while inventorying: ${publicRelative}`);
      }
      const folded = portableCaseFold(publicRelative);
      const prior = foldedPaths.get(folded);
      if (prior !== undefined && prior !== publicRelative) {
        throw new Error(`portable case-fold collision in library inventory: ${prior}, ${publicRelative}`);
      }
      foldedPaths.set(folded, publicRelative);
      output.push({ relativePath: publicRelative, bytes: bytes.byteLength, sha256: sha256(bytes) });
      if (output.length > MAX_BINDING_INVENTORY_FILES) {
        throw new Error(`library binding inventory exceeds ${MAX_BINDING_INVENTORY_FILES} files`);
      }
    }
  };
  await walk(root, "");
  return output.sort((left, right) => compareCanonicalStrings(left.relativePath, right.relativePath));
}

function excludedTargetBindingState(relativePath: string) {
  return (
    relativePath === LIBRARY_ROOT_MARKER_FILE ||
    relativePath === "locks" ||
    relativePath.startsWith("locks/") ||
    relativePath === "indexes" ||
    relativePath.startsWith("indexes/") ||
    /^store\/migrations\/flat-v1\/[^/]+\/receipt\.json$/u.test(relativePath)
  );
}

async function targetBindingInventory(root: string) {
  return inventoryTree({
    root,
    exclude: (relativePath) => excludedTargetBindingState(relativePath),
  });
}

async function isRecognizedUnmarkedLibrary(root: string, inventory: LibraryFileInventoryEntry[]) {
  if (!inventory.length) return false;
  const allowedTopLevel = new Set([
    "templates",
    "store",
    "indexes",
    "locks",
    "migrations",
    "transactions",
    ".write-lock-recovery",
  ]);
  if (inventory.some((item) => !allowedTopLevel.has(item.relativePath.split("/")[0] ?? ""))) {
    return false;
  }
  let recognizedObjects = 0;
  const legacyObjectIds = new Set<string>();
  const validLegacyObjectIds = new Set<string>();
  const seriesObjectIds = new Set<string>();
  const validSeriesObjectIds = new Set<string>();
  for (const entry of inventory) {
    const segments = entry.relativePath.split("/");
    if (segments[0] === "templates" && segments[1]) legacyObjectIds.add(segments[1]);
    if (segments[0] === "store" && segments[1] === "templates" && segments[2]) {
      seriesObjectIds.add(segments[2]);
    }
    const legacyManifest =
      segments.length === 3 && segments[0] === "templates" && segments[2] === "template.json";
    const seriesManifest =
      segments.length === 4 &&
      segments[0] === "store" &&
      segments[1] === "templates" &&
      segments[3] === "series.json";
    if (!legacyManifest && !seriesManifest) continue;
    let value: unknown;
    try {
      value = await readJson(path.join(root, ...segments));
    } catch {
      return false;
    }
    if (
      legacyManifest &&
      (!isRecord(value) ||
        value.schema !== "figure-library.template.v1" ||
        value.templateId !== segments[1])
    ) {
      return false;
    }
    if (legacyManifest) validLegacyObjectIds.add(String(segments[1]));
    if (
      seriesManifest &&
      (!isRecord(value) ||
        value.schema !== "figure-library.template-series.v1" ||
        value.templateId !== segments[2])
    ) {
      return false;
    }
    if (seriesManifest) validSeriesObjectIds.add(String(segments[2]));
    recognizedObjects += 1;
  }
  return (
    recognizedObjects > 0 &&
    [...legacyObjectIds].every((id) => validLegacyObjectIds.has(id)) &&
    [...seriesObjectIds].every((id) => validSeriesObjectIds.has(id))
  );
}

async function assertMigrationTargetConflicts(
  targetRoot: string,
  sourceInventory: LibraryFileInventoryEntry[],
) {
  const sourceTemplateIds = new Set(
    sourceInventory.map((entry) => entry.relativePath.split("/")[1]).filter(Boolean) as string[],
  );
  const targetNames: string[] = [];
  for (const templatesDirectory of [
    path.join(targetRoot, "templates"),
    path.join(targetRoot, "store", "templates"),
  ]) {
    try {
      targetNames.push(
        ...(await fs.readdir(templatesDirectory, { withFileTypes: true }))
          .filter((entry) => entry.isDirectory())
          .map((entry) => entry.name),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  for (const sourceId of sourceTemplateIds) {
    assertPortableSegment(sourceId, "legacy templateId");
    const collision = targetNames.find(
      (targetId) => portableCaseFold(targetId) === portableCaseFold(sourceId),
    );
    if (collision) {
      throw new Error(`legacy copy target template conflict: ${sourceId}, ${collision}`);
    }
  }
}

function stagedLegacyRelativePath(bindingId: string, relativePath: string) {
  return `store/migrations/flat-v1/${bindingId}/source/${relativePath}`;
}

function stagedLegacyInventory(
  bindingId: string,
  sourceInventory: LibraryFileInventoryEntry[],
) {
  return sourceInventory.map((entry) => ({
    ...entry,
    relativePath: stagedLegacyRelativePath(bindingId, entry.relativePath),
  }));
}

function migrationProgressCompatible(
  expectedTarget: LibraryFileInventoryEntry[],
  currentTarget: LibraryFileInventoryEntry[],
  sourceInventory: LibraryFileInventoryEntry[],
) {
  const allowed = new Map(
    [...expectedTarget, ...sourceInventory].map((entry) => [entry.relativePath, entry]),
  );
  return currentTarget.every((entry) => {
    const expected = allowed.get(entry.relativePath);
    return expected?.bytes === entry.bytes && expected.sha256 === entry.sha256;
  });
}

async function copyLegacyInventory(
  sourceRoot: string,
  targetRoot: string,
  inventory: LibraryFileInventoryEntry[],
  bindingId: string,
) {
  for (const entry of inventory) {
    const segments = entry.relativePath.split("/");
    for (const segment of segments) assertPortableFilesystemSegment(segment, "legacy copy path segment");
    const source = path.join(sourceRoot, ...segments);
    const staged = stagedLegacyRelativePath(bindingId, entry.relativePath);
    const target = path.join(targetRoot, ...staged.split("/"));
    const stat = await fs.lstat(source);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size !== entry.bytes) {
      throw new Error(`legacy source changed after planning: ${entry.relativePath}`);
    }
    const bytes = new Uint8Array(await fs.readFile(source));
    if (bytes.byteLength !== entry.bytes || sha256(bytes) !== entry.sha256) {
      throw new Error(`legacy source changed after planning: ${entry.relativePath}`);
    }
    try {
      const existingStat = await fs.lstat(target);
      if (existingStat.isSymbolicLink() || !existingStat.isFile()) {
        throw new Error(`legacy copy target conflict: ${entry.relativePath}`);
      }
      const existing = new Uint8Array(await fs.readFile(target));
      if (existing.byteLength !== entry.bytes || sha256(existing) !== entry.sha256) {
        throw new Error(`legacy copy target conflict: ${entry.relativePath}`);
      }
      continue;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    try {
      await fs.writeFile(target, bytes, { flag: "wx" });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const existing = new Uint8Array(await fs.readFile(target));
      if (existing.byteLength !== entry.bytes || sha256(existing) !== entry.sha256) {
        throw new Error(`legacy copy target conflict: ${entry.relativePath}`);
      }
    }
  }
}

export async function planGlobalLibraryBinding(options: {
  libraryDirectory: string;
  locatorPath?: string;
  environmentOverrideRoot?: string;
  migrationMode?: "none" | "copy_legacy";
  legacySourceDirectory?: string;
}): Promise<GlobalLibraryBindingPlanV1> {
  const locatorPath = path.resolve(options.locatorPath ?? defaultLibraryLocatorPath());
  const libraryDirectory = path.resolve(options.libraryDirectory);
  if (
    options.environmentOverrideRoot &&
    !samePathForPlatform(options.environmentOverrideRoot, libraryDirectory, process.platform)
  ) {
    throw new Error(
      "binding blocked by FIGURE_LIBRARY_DIR environment override: the explicit target differs",
    );
  }
  let directoryExists = false;
  try {
    const stat = await fs.lstat(libraryDirectory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("global ScientificFigureLibrary target must be a regular directory");
    }
    directoryExists = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const current = await observeGlobalLibraryLocator(locatorPath, process.platform);
  const marker = directoryExists ? await readLibraryRootMarker(libraryDirectory) : undefined;
  const targetInventory = directoryExists ? await targetBindingInventory(libraryDirectory) : [];
  let targetHasUnmarkedEntries = false;
  if (directoryExists && !marker) {
    targetHasUnmarkedEntries = (await fs.readdir(libraryDirectory)).some(
      (name) => name !== ".write-lock" && name !== LIBRARY_ROOT_MARKER_FILE,
    );
  }
  if (
    directoryExists &&
    !marker &&
    targetHasUnmarkedEntries &&
    !(await isRecognizedUnmarkedLibrary(libraryDirectory, targetInventory))
  ) {
    throw new Error(
      "global ScientificFigureLibrary target is non-empty and has no root marker or recognized legacy library structure",
    );
  }
  const migrationMode = options.migrationMode ?? "none";
  let migration: GlobalLibraryBindingPlanV1["migration"] = { mode: "none" };
  if (migrationMode === "copy_legacy") {
    const sourceDirectory = path.resolve(
      options.legacySourceDirectory ?? legacyDefaultLibraryRoot(),
    );
    if (sourceDirectory === libraryDirectory) {
      throw new Error("copy_legacy requires different source and target directories");
    }
    if (await readLibraryRootMarker(sourceDirectory)) {
      throw new Error("copy_legacy source is already a marked canonical library");
    }
    const sourceRootInventory = await targetBindingInventory(sourceDirectory);
    if (!(await isRecognizedUnmarkedLibrary(sourceDirectory, sourceRootInventory))) {
      throw new Error("copy_legacy source is not a recognized unmarked ScientificFigureLibrary");
    }
    const sourceInventory = await inventoryTree({
      root: path.join(sourceDirectory, "templates"),
      relativePrefix: "templates",
    });
    if (!sourceInventory.some((entry) => entry.relativePath.endsWith("/template.json"))) {
      throw new Error("copy_legacy source has no flat templates to migrate");
    }
    migration = {
      mode: "copy_legacy",
      sourceDirectory,
      sourceInventory,
      sourceInventoryDigest: inventoryDigest(sourceInventory),
    };
  }
  const libraryId = marker?.value.libraryId ?? randomUUID();
  const configRevision = (current.configRevision ?? 0) + 1;
  if (!Number.isSafeInteger(configRevision)) {
    throw new Error("ScientificFigureLibrary locator configRevision cannot be incremented safely");
  }
  const withoutPlanDigest: Omit<GlobalLibraryBindingPlanV1, "planDigest"> = {
    schema: LIBRARY_BINDING_PLAN_SCHEMA,
    bindingId: `library-binding-${randomUUID()}`,
    locatorPath,
    libraryDirectory,
    libraryId,
    configRevision,
    expectedLocatorStatus: current.status,
    expectedLocatorRawDigest: current.rawDigest,
    expectedConfigRevision: current.configRevision,
    expectedTargetMarkerDigest: marker?.digest ?? null,
    expectedTargetInventory: targetInventory,
    expectedTargetStateDigest: inventoryDigest(targetInventory),
    migration,
    createdAt: nowIso(),
  };
  return {
    ...withoutPlanDigest,
    planDigest: sha256(canonicalJson(withoutPlanDigest)),
  };
}

function validateBindingPlan(plan: GlobalLibraryBindingPlanV1) {
  if (!isRecord(plan) || plan.schema !== LIBRARY_BINDING_PLAN_SCHEMA) {
    throw new Error("invalid global library binding plan schema");
  }
  const { planDigest, ...withoutDigest } = plan;
  const validateInventory = (inventory: LibraryFileInventoryEntry[], label: string) => {
    if (!Array.isArray(inventory) || inventory.length > MAX_BINDING_INVENTORY_FILES) {
      throw new Error(`invalid ${label} inventory`);
    }
    let previous = "";
    for (const entry of inventory) {
      if (
        !isRecord(entry) ||
        typeof entry.relativePath !== "string" ||
        !Number.isSafeInteger(entry.bytes) ||
        entry.bytes < 0 ||
        typeof entry.sha256 !== "string" ||
        !HASH.test(entry.sha256) ||
        (previous && compareCanonicalStrings(previous, entry.relativePath) >= 0)
      ) {
        throw new Error(`invalid ${label} inventory entry`);
      }
      for (const segment of entry.relativePath.split("/")) {
        assertPortableFilesystemSegment(segment, `${label} inventory path segment`);
      }
      previous = entry.relativePath;
    }
  };
  if (!Array.isArray(plan.expectedTargetInventory)) {
    throw new Error("invalid binding target inventory");
  }
  validateInventory(plan.expectedTargetInventory, "binding target");
  if (inventoryDigest(plan.expectedTargetInventory) !== plan.expectedTargetStateDigest) {
    throw new Error("invalid binding target inventory digest");
  }
  if (!isRecord(plan.migration) || typeof plan.migration.mode !== "string") {
    throw new Error("invalid global library migration mode");
  }
  if (plan.migration.mode === "copy_legacy") {
    if (!Array.isArray(plan.migration.sourceInventory)) {
      throw new Error("invalid legacy source inventory");
    }
    validateInventory(plan.migration.sourceInventory, "legacy source");
    if (
      !path.isAbsolute(plan.migration.sourceDirectory) ||
      path.resolve(plan.migration.sourceDirectory) === path.resolve(plan.libraryDirectory) ||
      !HASH.test(plan.migration.sourceInventoryDigest) ||
      inventoryDigest(plan.migration.sourceInventory) !== plan.migration.sourceInventoryDigest
    ) {
      throw new Error("invalid legacy source inventory digest");
    }
    if (
      !plan.migration.sourceInventory.length ||
      plan.migration.sourceInventory.some(
        (entry) =>
          !entry.relativePath.startsWith("templates/") ||
          entry.relativePath.split("/").length < 3,
      ) ||
      !plan.migration.sourceInventory.some((entry) =>
        /^templates\/[^/]+\/template\.json$/u.test(entry.relativePath),
      )
    ) {
      throw new Error("invalid legacy source inventory scope");
    }
  } else if (plan.migration.mode !== "none") {
    throw new Error("invalid global library migration mode");
  }
  const expectedConfigRevision = plan.expectedConfigRevision;
  const locatorStatuses = new Set<GlobalLibraryLocatorStatus>([
    "missing",
    "valid_v2",
    "malformed_json",
    "unsupported_or_v1_schema",
    "dangling_target",
    "target_missing_root_marker",
    "library_id_mismatch",
  ]);
  if (
    expectedConfigRevision !== null &&
    (!Number.isSafeInteger(expectedConfigRevision) || expectedConfigRevision < 1)
  ) {
    throw new Error("invalid binding expectedConfigRevision");
  }
  const locatorStatusRequiresRevision = ([
    "valid_v2",
    "dangling_target",
    "target_missing_root_marker",
    "library_id_mismatch",
  ] as GlobalLibraryLocatorStatus[]).includes(plan.expectedLocatorStatus);
  if (
    !locatorStatuses.has(plan.expectedLocatorStatus) ||
    (plan.expectedLocatorStatus === "missing") !==
      (plan.expectedLocatorRawDigest === null) ||
    (plan.expectedLocatorStatus === "missing" && expectedConfigRevision !== null) ||
    (locatorStatusRequiresRevision && expectedConfigRevision === null) ||
    plan.configRevision !== (expectedConfigRevision ?? 0) + 1
  ) {
    throw new Error("invalid binding locator revision transition");
  }
  if (
    assertPortableSegment(plan.bindingId, "bindingId") !== plan.bindingId ||
    !UUID.test(plan.libraryId) ||
    !Number.isSafeInteger(plan.configRevision) ||
    plan.configRevision < 1 ||
    !path.isAbsolute(plan.locatorPath) ||
    !path.isAbsolute(plan.libraryDirectory) ||
    typeof plan.createdAt !== "string" ||
    Number.isNaN(Date.parse(plan.createdAt)) ||
    (plan.expectedLocatorRawDigest !== null && !HASH.test(plan.expectedLocatorRawDigest)) ||
    (plan.expectedTargetMarkerDigest !== null && !HASH.test(plan.expectedTargetMarkerDigest)) ||
    !HASH.test(plan.expectedTargetStateDigest) ||
    !HASH.test(planDigest) ||
    sha256(canonicalJson(withoutDigest)) !== planDigest
  ) {
    throw new Error("invalid global library binding plan");
  }
}

export async function applyGlobalLibraryBinding(
  plan: GlobalLibraryBindingPlanV1,
  operationId: string,
): Promise<ApplyGlobalLibraryBindingResult> {
  validateBindingPlan(plan);
  const safeOperationId = assertPortableSegment(operationId, "operationId");
  const configDirectory = path.dirname(plan.locatorPath);
  const receiptsDirectory = path.join(configDirectory, "binding-receipts");
  const receiptFile = path.join(receiptsDirectory, `${safeOperationId}.json`);

  const readReceipt = async () => {
    try {
      const value = await readJson(receiptFile);
      if (!isRecord(value) || value.schema !== LIBRARY_BINDING_RECEIPT_SCHEMA) {
        throw new Error(`invalid global library binding receipt: ${safeOperationId}`);
      }
      if (value.planDigest !== plan.planDigest || value.bindingId !== plan.bindingId) {
        throw new Error(`operationId was used for a different library binding: ${safeOperationId}`);
      }
      return value as unknown as GlobalLibraryBindingReceiptV1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };

  const prior = await readReceipt();
  if (prior) return { ...prior, idempotentReplay: true };
  await fs.mkdir(configDirectory, { recursive: true });
  return withCrossRuntimeWriteLock(
    {
      root: configDirectory,
      lockDirectory: path.join(configDirectory, ".locator-write-lock"),
      libraryId: plan.libraryId,
      operation: `bind-global-library:${safeOperationId}`,
    },
    async () => {
      const completed = await readReceipt();
      if (completed) return { ...completed, idempotentReplay: true };

      const current = await observeGlobalLibraryLocator(plan.locatorPath, process.platform);
      const desiredAlreadyWritten =
        current.status === "valid_v2" &&
        current.value?.libraryId === plan.libraryId &&
        path.resolve(current.value.libraryDirectory) === plan.libraryDirectory &&
        current.value.configRevision === plan.configRevision;
      if (
        !desiredAlreadyWritten &&
        (current.status !== plan.expectedLocatorStatus ||
          current.rawDigest !== plan.expectedLocatorRawDigest ||
          current.configRevision !== plan.expectedConfigRevision)
      ) {
        throw new Error("stale global library binding plan: locator changed after planning");
      }

      return withCrossRuntimeWriteLock(
        {
          root: plan.libraryDirectory,
          libraryId: plan.libraryId,
          operation: `bind-library-root:${safeOperationId}`,
        },
        async () => {
          const beforeMarker = await readLibraryRootMarker(plan.libraryDirectory);
          const plannedMissingNowCreated =
            plan.expectedTargetMarkerDigest === null &&
            beforeMarker?.value.libraryId === plan.libraryId;
          if (
            !plannedMissingNowCreated &&
            (beforeMarker?.digest ?? null) !== plan.expectedTargetMarkerDigest
          ) {
            throw new Error("stale global library binding plan: target root marker changed");
          }
          const currentTargetInventory = await targetBindingInventory(plan.libraryDirectory);
          const targetStateUnchanged =
            inventoryDigest(currentTargetInventory) === plan.expectedTargetStateDigest;
          if (
            !targetStateUnchanged &&
            !(
              plan.migration.mode === "copy_legacy" &&
              migrationProgressCompatible(
                plan.expectedTargetInventory,
                currentTargetInventory,
                stagedLegacyInventory(plan.bindingId, plan.migration.sourceInventory),
              )
            )
          ) {
            throw new Error("stale global library binding plan: target contents changed");
          }
          const marker = await ensureLibraryRootMarker(plan.libraryDirectory, plan.libraryId);
          if (marker.value.libraryId !== plan.libraryId) {
            throw new Error("global library binding target has a different libraryId");
          }

          let migrationReceiptFile: string | undefined;
          if (plan.migration.mode === "copy_legacy") {
            const sourceInventory = await inventoryTree({
              root: path.join(plan.migration.sourceDirectory, "templates"),
              relativePrefix: "templates",
            });
            if (
              inventoryDigest(sourceInventory) !== plan.migration.sourceInventoryDigest ||
              canonicalJson(sourceInventory) !== canonicalJson(plan.migration.sourceInventory)
            ) {
              throw new Error("stale global library binding plan: legacy source changed");
            }
            await copyLegacyInventory(
              plan.migration.sourceDirectory,
              plan.libraryDirectory,
              plan.migration.sourceInventory,
              plan.bindingId,
            );
            const stagedInventory = stagedLegacyInventory(
              plan.bindingId,
              plan.migration.sourceInventory,
            );
            const afterCopy = await targetBindingInventory(plan.libraryDirectory);
            if (
              !migrationProgressCompatible(
                plan.expectedTargetInventory,
                afterCopy,
                stagedInventory,
              ) ||
              stagedInventory.some((source) => {
                const copied = afterCopy.find((entry) => entry.relativePath === source.relativePath);
                return copied?.bytes !== source.bytes || copied.sha256 !== source.sha256;
              })
            ) {
              throw new Error("legacy copy verification failed");
            }
            migrationReceiptFile = path.join(
              plan.libraryDirectory,
              "store",
              "migrations",
              "flat-v1",
              assertPortableSegment(plan.bindingId, "bindingId"),
              "receipt.json",
            );
            let migrationReceipt: LegacyLibraryCopyReceiptV1 | undefined;
            try {
              const value = await readJson(migrationReceiptFile);
              if (!isRecord(value) || value.schema !== LEGACY_LIBRARY_COPY_RECEIPT_SCHEMA) {
                throw new Error("invalid legacy library copy receipt");
              }
              migrationReceipt = value as unknown as LegacyLibraryCopyReceiptV1;
              if (
                migrationReceipt.bindingPlanDigest !== plan.planDigest ||
                migrationReceipt.sourceInventoryDigest !== plan.migration.sourceInventoryDigest
              ) {
                throw new Error("legacy library copy receipt belongs to a different binding plan");
              }
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            if (!migrationReceipt) {
              const receipt: LegacyLibraryCopyReceiptV1 = {
                schema: LEGACY_LIBRARY_COPY_RECEIPT_SCHEMA,
                receiptId: `legacy-copy-receipt-${plan.bindingId}`,
                bindingId: plan.bindingId,
                bindingPlanDigest: plan.planDigest,
                sourceInventoryDigest: plan.migration.sourceInventoryDigest,
                stagedRelativeDirectory: `store/migrations/flat-v1/${plan.bindingId}/source`,
                copiedFiles: plan.migration.sourceInventory.length,
                copiedBytes: plan.migration.sourceInventory.reduce(
                  (total, entry) => total + entry.bytes,
                  0,
                ),
                copiedAt: nowIso(),
                sourcePreserved: true,
              };
              await immutableWriteJson(migrationReceiptFile, receipt);
            }
          }

          if (!desiredAlreadyWritten) {
            const locator: LibraryLocatorV1 = {
              schema: LIBRARY_LOCATOR_SCHEMA,
              configRevision: plan.configRevision,
              libraryId: plan.libraryId,
              libraryDirectory: plan.libraryDirectory,
              updatedAt: nowIso(),
            };
            await atomicWriteJson(plan.locatorPath, locator);
          }
          const receipt: GlobalLibraryBindingReceiptV1 = {
            schema: LIBRARY_BINDING_RECEIPT_SCHEMA,
            receiptId: `library-binding-receipt-${randomUUID()}`,
            operationId: safeOperationId,
            bindingId: plan.bindingId,
            planDigest: plan.planDigest,
            locatorPath: plan.locatorPath,
            libraryDirectory: plan.libraryDirectory,
            libraryId: plan.libraryId,
            configRevision: plan.configRevision,
            migrationMode: plan.migration.mode,
            ...(migrationReceiptFile ? { migrationReceiptFile } : {}),
            appliedAt: nowIso(),
          };
          await immutableWriteJson(receiptFile, receipt);
          return { ...receipt, idempotentReplay: desiredAlreadyWritten };
        },
      );
    },
  );
}
