import fsPromises from "node:fs/promises";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

export type CacheKind = "preview" | "source-archive";

export interface CacheState {
  providerId: string;
  kind: CacheKind;
  sourceIdentity: string;
  sourceLabel?: string;
  cacheRoot: string;
  declaredCount: number;
  cachedCount: number;
  missingCount: number;
  bytesDeclared: number;
  bytesCached: number;
  lastScannedAt?: string;
  lastCachedAt?: string;
  lastVerifiedAt?: string;
  taskId?: string;
  taskState?: string;
  taskProcessed?: number;
  taskTotal?: number;
  lastError?: string;
}

function nullableString(value: unknown) {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function rowToState(row: Record<string, unknown> | undefined): CacheState | undefined {
  if (!row) return undefined;
  return {
    providerId: String(row.provider_id),
    kind: String(row.cache_kind) as CacheKind,
    sourceIdentity: String(row.source_identity),
    sourceLabel: nullableString(row.source_label),
    cacheRoot: String(row.cache_root),
    declaredCount: Number(row.declared_count),
    cachedCount: Number(row.cached_count),
    missingCount: Number(row.missing_count),
    bytesDeclared: Number(row.bytes_declared),
    bytesCached: Number(row.bytes_cached),
    lastScannedAt: nullableString(row.last_scanned_at),
    lastCachedAt: nullableString(row.last_cached_at),
    lastVerifiedAt: nullableString(row.last_verified_at),
    taskId: nullableString(row.task_id),
    taskState: nullableString(row.task_state),
    taskProcessed: row.task_processed === null ? undefined : Number(row.task_processed),
    taskTotal: row.task_total === null ? undefined : Number(row.task_total),
    lastError: nullableString(row.last_error),
  };
}

/** Persistent, rebuildable metadata for local cache directories. */
export class CacheStateDatabase {
  readonly file: string;
  private readonly db: DatabaseSync;

  private constructor(file: string, db: DatabaseSync) {
    this.file = file;
    this.db = db;
  }

  static async open(libraryRoot: string) {
    const directory = path.join(libraryRoot, "indexes");
    await fsPromises.mkdir(directory, { recursive: true });
    const file = path.join(directory, "cache-state.sqlite");
    const db = new DatabaseSync(file);
    db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    db.exec(`
      CREATE TABLE IF NOT EXISTS cache_state_schema (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version INTEGER NOT NULL
      );
      INSERT OR IGNORE INTO cache_state_schema (id, version) VALUES (1, 1);
      CREATE TABLE IF NOT EXISTS gallery_cache_state (
        provider_id TEXT NOT NULL,
        cache_kind TEXT NOT NULL CHECK (cache_kind IN ('preview', 'source-archive')),
        source_identity TEXT NOT NULL,
        source_label TEXT,
        cache_root TEXT NOT NULL,
        declared_count INTEGER NOT NULL DEFAULT 0,
        cached_count INTEGER NOT NULL DEFAULT 0,
        missing_count INTEGER NOT NULL DEFAULT 0,
        bytes_declared INTEGER NOT NULL DEFAULT 0,
        bytes_cached INTEGER NOT NULL DEFAULT 0,
        last_scanned_at TEXT,
        last_cached_at TEXT,
        last_verified_at TEXT,
        task_id TEXT,
        task_state TEXT,
        task_processed INTEGER,
        task_total INTEGER,
        last_error TEXT,
        PRIMARY KEY (provider_id, cache_kind)
      );
    `);
    const schema = db.prepare("SELECT version FROM cache_state_schema WHERE id = 1").get() as { version?: number } | undefined;
    if (Number(schema?.version ?? 0) < 2) {
      db.exec("DELETE FROM gallery_cache_state; UPDATE cache_state_schema SET version = 2 WHERE id = 1;");
    }
    return new CacheStateDatabase(file, db);
  }

  get(providerId: string, kind: CacheKind, sourceIdentity: string) {
    const row = this.db.prepare(`
      SELECT * FROM gallery_cache_state
      WHERE provider_id = ? AND cache_kind = ? AND source_identity = ?
    `).get(providerId, kind, sourceIdentity) as Record<string, unknown> | undefined;
    return rowToState(row);
  }

  put(state: CacheState) {
    this.db.prepare(`
      INSERT INTO gallery_cache_state (
        provider_id, cache_kind, source_identity, source_label, cache_root,
        declared_count, cached_count, missing_count, bytes_declared, bytes_cached,
        last_scanned_at, last_cached_at, last_verified_at, task_id, task_state,
        task_processed, task_total, last_error
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(provider_id, cache_kind) DO UPDATE SET
        source_identity = excluded.source_identity,
        source_label = excluded.source_label,
        cache_root = excluded.cache_root,
        declared_count = excluded.declared_count,
        cached_count = excluded.cached_count,
        missing_count = excluded.missing_count,
        bytes_declared = excluded.bytes_declared,
        bytes_cached = excluded.bytes_cached,
        last_scanned_at = excluded.last_scanned_at,
        last_cached_at = excluded.last_cached_at,
        last_verified_at = excluded.last_verified_at,
        task_id = excluded.task_id,
        task_state = excluded.task_state,
        task_processed = excluded.task_processed,
        task_total = excluded.task_total,
        last_error = excluded.last_error
    `).run(
      state.providerId, state.kind, state.sourceIdentity, state.sourceLabel ?? null, state.cacheRoot,
      state.declaredCount, state.cachedCount, state.missingCount, state.bytesDeclared, state.bytesCached,
      state.lastScannedAt ?? null, state.lastCachedAt ?? null, state.lastVerifiedAt ?? null,
      state.taskId ?? null, state.taskState ?? null, state.taskProcessed ?? null, state.taskTotal ?? null,
      state.lastError ?? null,
    );
  }

  close() {
    this.db.close();
  }
}

export async function cacheStateDatabase(libraryRoot: string) {
  // Keep the file check explicit so a replaced database path fails closed.
  const directory = path.join(libraryRoot, "indexes");
  await fsPromises.mkdir(directory, { recursive: true });
  const file = path.join(directory, "cache-state.sqlite");
  try {
    const stat = await fsPromises.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) throw new Error("cache state database must be a regular file");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  try {
    return await CacheStateDatabase.open(libraryRoot);
  } catch (error) {
    // This database is derived state. Preserve a corrupt file for diagnosis and
    // rebuild a clean index so a bad cache index cannot block the local client.
    if (error instanceof Error && /sqlite|database|malformed|corrupt/iu.test(error.message)) {
      const backup = `${file}.corrupt-${Date.now()}`;
      await fsPromises.rename(file, backup).catch(() => undefined);
      return CacheStateDatabase.open(libraryRoot);
    }
    throw error;
  }
}
