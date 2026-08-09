import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { canonicalJson, compareCanonicalStrings } from "./canonical-json.ts";

export const LIBRARY_WRITE_LOCK_OWNER_SCHEMA =
  "figure-library.write-lock-owner.v1" as const;
export const LIBRARY_WRITE_LOCK_HEARTBEAT_SCHEMA =
  "figure-library.write-lock-heartbeat.v1" as const;
export const LIBRARY_WRITE_LOCK_RECOVERY_PLAN_SCHEMA =
  "figure-library.write-lock-recovery-plan.v1" as const;
export const LIBRARY_WRITE_LOCK_RECOVERY_RECEIPT_SCHEMA =
  "figure-library.write-lock-recovery-receipt.v1" as const;

const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
const MAX_LOCK_FILE_BYTES = 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/u;
const SAFE_OPERATION_ID = /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

function nowIso() {
  return new Date().toISOString();
}

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function withoutDigest<T extends { planDigest?: string }>(value: T) {
  const { planDigest: _planDigest, ...rest } = value;
  return rest;
}

async function exists(file: string) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8")) as unknown;
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
      throw new Error(`immutable write-lock recovery object collision: ${file}`);
    }
  }
}

function assertOperationId(value: string) {
  if (!SAFE_OPERATION_ID.test(value)) throw new Error(`unsafe operationId: ${value}`);
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export interface LibraryWriteLockOwnerV1 {
  schema: typeof LIBRARY_WRITE_LOCK_OWNER_SCHEMA;
  lockId: string;
  libraryId: string;
  operation: string;
  hostname: string;
  platform: NodeJS.Platform;
  runtime: "node";
  processId: number;
  createdAt: string;
  heartbeatIntervalMs: number;
}

export interface LibraryWriteLockHeartbeatV1 {
  schema: typeof LIBRARY_WRITE_LOCK_HEARTBEAT_SCHEMA;
  lockId: string;
  sequence: number;
  updatedAt: string;
}

export interface LibraryWriteLockSnapshot {
  directory: string;
  exists: boolean;
  digest: string | null;
  entries: Array<{
    name: string;
    kind: "file" | "directory" | "symbolic-link" | "other";
    bytes?: number;
    sha256?: string;
  }>;
  owner?: LibraryWriteLockOwnerV1;
  heartbeat?: LibraryWriteLockHeartbeatV1;
  ownerValid: boolean;
  heartbeatValid: boolean;
  heartbeatAgeMs?: number;
}

export interface LibraryWriteLockRecoveryPlanV1 {
  schema: typeof LIBRARY_WRITE_LOCK_RECOVERY_PLAN_SCHEMA;
  recoveryId: string;
  libraryRoot: string;
  libraryId: string;
  lockDirectory: string;
  expectedLockDigest: string;
  observedOwner?: LibraryWriteLockOwnerV1;
  observedHeartbeat?: LibraryWriteLockHeartbeatV1;
  ownerValid: boolean;
  heartbeatValid: boolean;
  heartbeatAgeMs?: number;
  reason: string;
  createdAt: string;
  planDigest: string;
}

export interface LibraryWriteLockRecoveryReceiptV1 {
  schema: typeof LIBRARY_WRITE_LOCK_RECOVERY_RECEIPT_SCHEMA;
  receiptId: string;
  operationId: string;
  recoveryId: string;
  planDigest: string;
  libraryId: string;
  recoveredLockDigest: string;
  lockRelativeDirectory: "locks/write";
  archiveRelativeDirectory: string;
  recoveredAt: string;
  reason: string;
}

export interface ApplyWriteLockRecoveryResult extends LibraryWriteLockRecoveryReceiptV1 {
  idempotentReplay: boolean;
}

export class LibraryWriteLockedError extends Error {
  readonly code = "library_busy" as const;
  readonly snapshot: LibraryWriteLockSnapshot;

  constructor(snapshot: LibraryWriteLockSnapshot) {
    const owner = snapshot.owner
      ? ` by ${snapshot.owner.operation} on ${snapshot.owner.hostname}`
      : " with missing or corrupt owner metadata";
    super(
      `figure library is write-locked (library_busy)${owner}; ` +
        "do not retry automatically; create an explicit recovery plan if the owner is abandoned",
    );
    this.name = "LibraryWriteLockedError";
    this.snapshot = snapshot;
  }
}

function validateOwner(value: unknown): LibraryWriteLockOwnerV1 | undefined {
  if (!isRecord(value) || value.schema !== LIBRARY_WRITE_LOCK_OWNER_SCHEMA) return undefined;
  if (
    typeof value.lockId !== "string" ||
    !value.lockId ||
    typeof value.libraryId !== "string" ||
    !value.libraryId ||
    typeof value.operation !== "string" ||
    !value.operation ||
    typeof value.hostname !== "string" ||
    !value.hostname ||
    typeof value.platform !== "string" ||
    typeof value.runtime !== "string" ||
    value.runtime !== "node" ||
    !Number.isSafeInteger(value.processId) ||
    (value.processId as number) <= 0 ||
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt)) ||
    !Number.isSafeInteger(value.heartbeatIntervalMs) ||
    (value.heartbeatIntervalMs as number) < 10
  ) {
    return undefined;
  }
  return value as unknown as LibraryWriteLockOwnerV1;
}

function validateHeartbeat(value: unknown): LibraryWriteLockHeartbeatV1 | undefined {
  if (!isRecord(value) || value.schema !== LIBRARY_WRITE_LOCK_HEARTBEAT_SCHEMA) return undefined;
  if (
    typeof value.lockId !== "string" ||
    !value.lockId ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    typeof value.updatedAt !== "string" ||
    Number.isNaN(Date.parse(value.updatedAt))
  ) {
    return undefined;
  }
  return value as unknown as LibraryWriteLockHeartbeatV1;
}

export async function inspectLibraryWriteLock(
  lockDirectory: string,
): Promise<LibraryWriteLockSnapshot> {
  const directory = path.resolve(lockDirectory);
  let directoryEntries;
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      const entry = {
        name: path.basename(directory),
        kind: stat.isSymbolicLink() ? ("symbolic-link" as const) : ("other" as const),
      };
      return {
        directory,
        exists: true,
        digest: sha256(canonicalJson([entry])),
        entries: [entry],
        ownerValid: false,
        heartbeatValid: false,
      };
    }
    directoryEntries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        directory,
        exists: false,
        digest: null,
        entries: [],
        ownerValid: false,
        heartbeatValid: false,
      };
    }
    throw error;
  }

  const entries: LibraryWriteLockSnapshot["entries"] = [];
  for (const entry of directoryEntries.sort((left, right) => compareCanonicalStrings(left.name, right.name))) {
    if (/^\.heartbeat\.json\.[0-9a-f-]+\.tmp$/iu.test(entry.name)) {
      // Heartbeats use atomic replace. This private temporary file may disappear
      // between readdir and stat and is not part of the durable lock identity.
      continue;
    }
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) {
      entries.push({ name: entry.name, kind: "symbolic-link" });
      continue;
    }
    if (entry.isDirectory()) {
      entries.push({ name: entry.name, kind: "directory" });
      continue;
    }
    if (!entry.isFile()) {
      entries.push({ name: entry.name, kind: "other" });
      continue;
    }
    const stat = await fs.stat(file);
    if (stat.size > MAX_LOCK_FILE_BYTES) {
      entries.push({ name: entry.name, kind: "file", bytes: stat.size });
      continue;
    }
    const bytes = new Uint8Array(await fs.readFile(file));
    entries.push({
      name: entry.name,
      kind: "file",
      bytes: bytes.byteLength,
      sha256: sha256(bytes),
    });
  }
  const digest = sha256(canonicalJson(entries));
  let owner: LibraryWriteLockOwnerV1 | undefined;
  let heartbeat: LibraryWriteLockHeartbeatV1 | undefined;
  try {
    owner = validateOwner(await readJson(path.join(directory, "owner.json")));
  } catch {
    // Recovery must be possible for a corrupt owner file.
  }
  try {
    heartbeat = validateHeartbeat(await readJson(path.join(directory, "heartbeat.json")));
  } catch {
    // Recovery must be possible for a corrupt heartbeat file.
  }
  if (owner && heartbeat?.lockId !== owner.lockId) heartbeat = undefined;
  return {
    directory,
    exists: true,
    digest,
    entries,
    ...(owner ? { owner } : {}),
    ...(heartbeat ? { heartbeat } : {}),
    ownerValid: Boolean(owner),
    heartbeatValid: Boolean(heartbeat),
    ...(heartbeat
      ? { heartbeatAgeMs: Math.max(0, Date.now() - Date.parse(heartbeat.updatedAt)) }
      : {}),
  };
}

export interface CrossRuntimeWriteLockOptions {
  root: string;
  operation: string;
  libraryId: string;
  lockDirectory?: string;
  heartbeatIntervalMs?: number;
}

export class CrossRuntimeWriteLock {
  readonly root: string;
  readonly lockDirectory: string;
  readonly operation: string;
  readonly libraryId: string;
  readonly heartbeatIntervalMs: number;
  private owner?: LibraryWriteLockOwnerV1;
  private heartbeatTimer?: NodeJS.Timeout;
  private heartbeatSequence = 0;
  private heartbeatFailure?: unknown;
  private heartbeatInFlight: Promise<void> = Promise.resolve();

  constructor(options: CrossRuntimeWriteLockOptions) {
    this.root = path.resolve(options.root);
    this.lockDirectory = path.resolve(
      options.lockDirectory ?? path.join(this.root, "locks", "write"),
    );
    this.operation = options.operation.trim();
    this.libraryId = options.libraryId.trim();
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    if (!this.operation) throw new Error("write lock operation is required");
    if (!this.libraryId) throw new Error("write lock libraryId is required");
    if (
      !Number.isSafeInteger(this.heartbeatIntervalMs) ||
      this.heartbeatIntervalMs < 10
    ) {
      throw new Error("heartbeatIntervalMs must be an integer of at least 10 milliseconds");
    }
  }

  private async writeHeartbeat() {
    const owner = this.owner;
    if (!owner) return;
    const currentOwner = validateOwner(await readJson(path.join(this.lockDirectory, "owner.json")));
    if (!currentOwner || currentOwner.lockId !== owner.lockId) {
      throw new Error("figure library write-lock ownership changed during the operation");
    }
    this.heartbeatSequence += 1;
    const heartbeat: LibraryWriteLockHeartbeatV1 = {
      schema: LIBRARY_WRITE_LOCK_HEARTBEAT_SCHEMA,
      lockId: owner.lockId,
      sequence: this.heartbeatSequence,
      updatedAt: nowIso(),
    };
    await atomicWriteJson(path.join(this.lockDirectory, "heartbeat.json"), heartbeat);
  }

  async acquire() {
    if (this.owner) throw new Error("write lock instance is already acquired");
    await fs.mkdir(this.root, { recursive: true });
    await fs.mkdir(path.dirname(this.lockDirectory), { recursive: true });
    try {
      await fs.mkdir(this.lockDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new LibraryWriteLockedError(await inspectLibraryWriteLock(this.lockDirectory));
      }
      throw error;
    }

    const owner: LibraryWriteLockOwnerV1 = {
      schema: LIBRARY_WRITE_LOCK_OWNER_SCHEMA,
      lockId: randomUUID(),
      libraryId: this.libraryId,
      operation: this.operation,
      hostname: os.hostname() || "unknown-host",
      platform: process.platform,
      runtime: "node",
      processId: process.pid,
      createdAt: nowIso(),
      heartbeatIntervalMs: this.heartbeatIntervalMs,
    };
    try {
      await fs.writeFile(
        path.join(this.lockDirectory, "owner.json"),
        `${JSON.stringify(owner, null, 2)}\n`,
        { flag: "wx" },
      );
      this.owner = owner;
      await this.writeHeartbeat();
    } catch (error) {
      this.owner = undefined;
      // Once the canonical lock directory is visible, an explicit recovery may
      // move it aside and another writer may acquire the canonical path.  An
      // acquire failure therefore cannot safely remove that path: doing so
      // could delete the replacement writer's lock.  Leave even a partially
      // initialized lock fail-closed for the explicit plan/apply recovery flow.
      throw error;
    }
    this.heartbeatTimer = setInterval(() => {
      this.heartbeatInFlight = this.heartbeatInFlight
        .then(() => this.writeHeartbeat())
        .catch((error: unknown) => {
          this.heartbeatFailure ??= error;
          if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = undefined;
        });
    }, this.heartbeatIntervalMs);
    this.heartbeatTimer.unref();
    return owner;
  }

  async release() {
    const owner = this.owner;
    if (!owner) return;
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    await this.heartbeatInFlight;
    try {
      const currentOwner = validateOwner(await readJson(path.join(this.lockDirectory, "owner.json")));
      if (!currentOwner || currentOwner.lockId !== owner.lockId) {
        throw new Error("figure library write-lock ownership changed; refusing to remove the lock");
      }
      await fs.rm(this.lockDirectory, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    } finally {
      this.owner = undefined;
    }
    if (this.heartbeatFailure) {
      const failure = this.heartbeatFailure;
      this.heartbeatFailure = undefined;
      throw failure;
    }
  }

  async run<T>(callback: () => Promise<T>): Promise<T> {
    await this.acquire();
    let callbackError: unknown;
    try {
      return await callback();
    } catch (error) {
      callbackError = error;
      throw error;
    } finally {
      try {
        await this.release();
      } catch (releaseError) {
        if (!callbackError) throw releaseError;
      }
    }
  }
}

export async function withCrossRuntimeWriteLock<T>(
  options: CrossRuntimeWriteLockOptions,
  callback: () => Promise<T>,
) {
  return new CrossRuntimeWriteLock(options).run(callback);
}

export async function planLibraryWriteLockRecovery(options: {
  libraryRoot: string;
  libraryId: string;
  reason: string;
  lockDirectory?: string;
}): Promise<LibraryWriteLockRecoveryPlanV1> {
  const libraryRoot = path.resolve(options.libraryRoot);
  const libraryId = options.libraryId.trim();
  const reason = options.reason.trim();
  if (!libraryId) throw new Error("libraryId is required for write-lock recovery");
  if (!reason) throw new Error("write-lock recovery requires an explicit reason");
  const lockDirectory = path.resolve(
    options.lockDirectory ?? path.join(libraryRoot, "locks", "write"),
  );
  const snapshot = await inspectLibraryWriteLock(lockDirectory);
  if (!snapshot.exists || !snapshot.digest) {
    throw new Error("write-lock recovery is not needed: the library is not locked");
  }
  if (snapshot.owner && snapshot.owner.libraryId !== libraryId) {
    throw new Error(
      `write-lock libraryId mismatch: expected ${libraryId}, found ${snapshot.owner.libraryId}`,
    );
  }
  const withoutPlanDigest: Omit<LibraryWriteLockRecoveryPlanV1, "planDigest"> = {
    schema: LIBRARY_WRITE_LOCK_RECOVERY_PLAN_SCHEMA,
    recoveryId: `lock-recovery-${randomUUID()}`,
    libraryRoot,
    libraryId,
    lockDirectory,
    expectedLockDigest: snapshot.digest,
    ...(snapshot.owner ? { observedOwner: snapshot.owner } : {}),
    ...(snapshot.heartbeat ? { observedHeartbeat: snapshot.heartbeat } : {}),
    ownerValid: snapshot.ownerValid,
    heartbeatValid: snapshot.heartbeatValid,
    ...(snapshot.heartbeatAgeMs !== undefined
      ? { heartbeatAgeMs: snapshot.heartbeatAgeMs }
      : {}),
    reason,
    createdAt: nowIso(),
  };
  return {
    ...withoutPlanDigest,
    planDigest: sha256(canonicalJson(withoutPlanDigest)),
  };
}

function validateRecoveryPlan(plan: LibraryWriteLockRecoveryPlanV1) {
  if (!isRecord(plan) || plan.schema !== LIBRARY_WRITE_LOCK_RECOVERY_PLAN_SCHEMA) {
    throw new Error("invalid write-lock recovery plan schema");
  }
  if (
    typeof plan.planDigest !== "string" ||
    !HASH.test(plan.planDigest) ||
    sha256(canonicalJson(withoutDigest(plan))) !== plan.planDigest
  ) {
    throw new Error("invalid write-lock recovery plan digest");
  }
  assertOperationId(String(plan.recoveryId ?? ""));
  assertOperationId(String(plan.libraryId ?? ""));
  if (
    typeof plan.reason !== "string" ||
    !plan.reason.trim() ||
    plan.reason.length > 2_000 ||
    typeof plan.expectedLockDigest !== "string" ||
    !HASH.test(plan.expectedLockDigest) ||
    typeof plan.createdAt !== "string" ||
    Number.isNaN(Date.parse(plan.createdAt)) ||
    !path.isAbsolute(plan.libraryRoot) ||
    !path.isAbsolute(plan.lockDirectory)
  ) {
    throw new Error("invalid write-lock recovery plan");
  }
  if (path.resolve(plan.lockDirectory) !== path.join(path.resolve(plan.libraryRoot), "locks", "write")) {
    throw new Error("write-lock recovery plan does not target the canonical library lock");
  }
  const observedOwner = plan.observedOwner === undefined
    ? undefined
    : validateOwner(plan.observedOwner);
  const observedHeartbeat = plan.observedHeartbeat === undefined
    ? undefined
    : validateHeartbeat(plan.observedHeartbeat);
  if (
    plan.ownerValid !== Boolean(observedOwner) ||
    plan.heartbeatValid !== Boolean(observedHeartbeat) ||
    (observedOwner !== undefined && observedOwner.libraryId !== plan.libraryId) ||
    (observedOwner !== undefined &&
      observedHeartbeat !== undefined &&
      observedOwner.lockId !== observedHeartbeat.lockId) ||
    (plan.heartbeatAgeMs !== undefined &&
      (!Number.isFinite(plan.heartbeatAgeMs) || plan.heartbeatAgeMs < 0))
  ) {
    throw new Error("invalid write-lock recovery observation metadata");
  }
}

export async function applyLibraryWriteLockRecovery(
  plan: LibraryWriteLockRecoveryPlanV1,
  operationId: string,
): Promise<ApplyWriteLockRecoveryResult> {
  validateRecoveryPlan(plan);
  const safeOperationId = assertOperationId(operationId);
  const recoveryRoot = path.join(
    plan.libraryRoot,
    "store",
    "operations",
    "receipts",
    "lock-recoveries",
    safeOperationId,
  );
  const receiptFile = path.join(recoveryRoot, "receipt.json");
  const archiveDirectory = path.join(
    recoveryRoot,
    "archive",
  );
  const readReceipt = async () => {
    try {
      const value = await readJson(receiptFile);
      if (!isRecord(value) || value.schema !== LIBRARY_WRITE_LOCK_RECOVERY_RECEIPT_SCHEMA) {
        throw new Error(`invalid write-lock recovery receipt: ${safeOperationId}`);
      }
      if (value.planDigest !== plan.planDigest || value.recoveryId !== plan.recoveryId) {
        throw new Error(`operationId was used for a different lock recovery: ${safeOperationId}`);
      }
      return value as unknown as LibraryWriteLockRecoveryReceiptV1;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const prior = await readReceipt();
  if (prior) return { ...prior, idempotentReplay: true };

  const guard = new CrossRuntimeWriteLock({
    root: recoveryRoot,
    lockDirectory: path.join(plan.libraryRoot, "locks", "recovery-apply"),
    libraryId: plan.libraryId,
    operation: `write-lock-recovery:${safeOperationId}`,
  });
  return guard.run(async () => {
    const completed = await readReceipt();
    if (completed) return { ...completed, idempotentReplay: true };

    const archived = await inspectLibraryWriteLock(archiveDirectory);
    if (archived.exists) {
      if (archived.digest !== plan.expectedLockDigest) {
        throw new Error("write-lock recovery archive does not match the planned lock");
      }
    } else {
      const current = await inspectLibraryWriteLock(plan.lockDirectory);
      if (!current.exists || current.digest !== plan.expectedLockDigest) {
        throw new Error("stale write-lock recovery plan: the lock changed after planning");
      }
      await fs.mkdir(path.dirname(archiveDirectory), { recursive: true });
      await fs.rename(plan.lockDirectory, archiveDirectory);
    }

    const receipt: LibraryWriteLockRecoveryReceiptV1 = {
      schema: LIBRARY_WRITE_LOCK_RECOVERY_RECEIPT_SCHEMA,
      receiptId: `lock-recovery-receipt-${randomUUID()}`,
      operationId: safeOperationId,
      recoveryId: plan.recoveryId,
      planDigest: plan.planDigest,
      libraryId: plan.libraryId,
      recoveredLockDigest: plan.expectedLockDigest,
      lockRelativeDirectory: "locks/write",
      archiveRelativeDirectory:
        `store/operations/receipts/lock-recoveries/${safeOperationId}/archive`,
      recoveredAt: nowIso(),
      reason: plan.reason,
    };
    await immutableWriteJson(receiptFile, receipt);
    return { ...receipt, idempotentReplay: false };
  });
}

export async function hasLibraryWriteLock(root: string) {
  return exists(path.join(path.resolve(root), "locks", "write"));
}
