import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJson, compareCanonicalStrings } from "./canonical-json.ts";
import { withCrossRuntimeWriteLock } from "./cross-runtime-lock.ts";
import {
  DEFAULT_PERSONAL_MODULE_ASSETS_DIR,
  ModuleCatalogIndex,
} from "./module-catalog.ts";
import {
  OFFICIAL_OPEN_FIGURE_ALREADY_CURRENT_SCHEMA,
  OFFICIAL_OPEN_FIGURE_AUTO_REFRESH_ENV,
  OFFICIAL_OPEN_FIGURE_BOOTSTRAP_KEY_ID,
  OFFICIAL_OPEN_FIGURE_CHANGE_PLAN_SCHEMA,
  OFFICIAL_OPEN_FIGURE_CHANGE_RECEIPT_SCHEMA,
  OFFICIAL_OPEN_FIGURE_CONFIG_SCHEMA,
  OFFICIAL_OPEN_FIGURE_MANIFEST_URL,
  OFFICIAL_OPEN_FIGURE_NETWORK_BACKOFF_MS,
  OFFICIAL_OPEN_FIGURE_PROVIDER_ID,
  OFFICIAL_OPEN_FIGURE_REFRESH_TTL_MS,
  OFFICIAL_OPEN_FIGURE_SNAPSHOT_STATE_SCHEMA,
  OFFICIAL_OPEN_FIGURE_SOURCE_LABEL,
  OFFICIAL_OPEN_FIGURE_STATE_SCHEMA,
  autoRefreshEnvOverride,
  officialOpenFigureAutoRefreshAllowed,
  officialOpenFigureBootstrapKey,
  officialOpenFigurePaths,
} from "./open-figure-official-channel.ts";
import {
  diffOfficialCatalogs,
  fetchVerifiedOfficialOpenFigureSnapshot,
  isUnchangedOfficialOpenFigureFetch,
  type OfficialCatalogDiff,
  type VerifiedOfficialOpenFigureSnapshot,
} from "./open-figure-feed.ts";
import {
  SecureProviderSourceFetcher,
  ed25519PublicKeyIdentity,
  type Ed25519PublicKeyIdentity,
} from "./provider-source-fetch.ts";

const HASH = /^[a-f0-9]{64}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PLAN_TTL_MS = 30 * 60 * 1_000;
const PLAN_LIMIT = 32;

function sha256(value: Uint8Array | string) {
  return createHash("sha256").update(value).digest("hex");
}

function nowIso(now: () => number) {
  return new Date(now()).toISOString();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertHash(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !HASH.test(value)) throw new Error(`${label} must be SHA-256`);
}

function safeError(error: unknown) {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/[\r\n\t]+/gu, " ").slice(0, 500) || "official Open Figure snapshot is unavailable";
}

function validateKey(value: unknown, label: string): Ed25519PublicKeyIdentity {
  if (!isRecord(value) || value.algorithm !== "ed25519" || typeof value.publicKeyBase64 !== "string") {
    throw new Error(`${label} is invalid`);
  }
  const key = ed25519PublicKeyIdentity(value.publicKeyBase64);
  if (value.keyId !== key.keyId) throw new Error(`${label} keyId is invalid`);
  return key;
}

async function atomicWriteJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function writeImmutableFile(file: string, bytes: Uint8Array) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try {
    await fs.writeFile(file, bytes, { flag: "wx" });
    await fs.chmod(file, 0o444).catch(() => undefined);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = await fs.readFile(file);
    if (!Buffer.from(existing).equals(Buffer.from(bytes))) {
      throw new Error(`official Open Figure immutable file collision: ${file}`);
    }
  }
}

export interface OfficialOpenFigureConfigV1 {
  schema: typeof OFFICIAL_OPEN_FIGURE_CONFIG_SCHEMA;
  autoRefresh: boolean;
  updatedAt: string;
}

export interface OfficialOpenFigureSnapshotRefV1 {
  schema: typeof OFFICIAL_OPEN_FIGURE_SNAPSHOT_STATE_SCHEMA;
  origin: "bundled" | "remote";
  sequence: number | null;
  manifestSha256: string | null;
  catalogSha256: string;
  directory: string;
  generatedAt: string | null;
  payloadCommit: string | null;
}

export interface OfficialOpenFigureStateV1 {
  schema: typeof OFFICIAL_OPEN_FIGURE_STATE_SCHEMA;
  activeOrigin: "bundled" | "remote-lkg";
  activeSequence: number | null;
  activeManifestSha256: string | null;
  activeCatalogSha256: string;
  signingKey: Ed25519PublicKeyIdentity;
  authorizedNextKeys: Ed25519PublicKeyIdentity[];
  observedRevisions: Array<{ sequence: number; manifestSha256: string }>;
  tombstones: string[];
  snapshots: OfficialOpenFigureSnapshotRefV1[];
  lastCheckAt: string | null;
  lastSuccessAt: string | null;
  nextCheckAt: string | null;
  lastError: { code: string; message: string } | null;
  snapshotCount: number;
  snapshotBytes: number;
  updatedAt: string;
}

export interface OfficialOpenFigureRuntime {
  currentIndex(): ModuleCatalogIndex;
  indexForCatalogSha256(catalogSha256: string): Promise<ModuleCatalogIndex | undefined>;
  isTombstoned(moduleId: string): boolean;
  statusDetails(): Record<string, unknown>;
  maybeRefresh(): void;
}

export type OfficialOpenFigureChangeAction = "update" | "configure";

export interface OfficialOpenFigureChangePlanV1 {
  schema: typeof OFFICIAL_OPEN_FIGURE_CHANGE_PLAN_SCHEMA;
  planId: string;
  action: OfficialOpenFigureChangeAction;
  providerId: typeof OFFICIAL_OPEN_FIGURE_PROVIDER_ID;
  sourceKind: "official-signed-overlay";
  autoRefresh?: boolean;
  manifestUrl: string;
  accessUrls: string[];
  signingKeyId?: string;
  previousSigningKeyId?: string;
  sequence?: number;
  previousSequence?: number | null;
  manifestSha256?: string;
  catalogSha256?: string;
  previewsSha256?: string;
  templateCount?: number;
  tombstoneCount?: number;
  payloadCommit?: string;
  templateDiff: OfficialCatalogDiff;
  warnings: string[];
  createdAt: string;
  planDigest: string;
}

export interface OfficialOpenFigureAlreadyCurrentV1 {
  schema: typeof OFFICIAL_OPEN_FIGURE_ALREADY_CURRENT_SCHEMA;
  status: "already_current";
  action: OfficialOpenFigureChangeAction;
  providerId: typeof OFFICIAL_OPEN_FIGURE_PROVIDER_ID;
  sequence: number | null;
  manifestSha256: string | null;
  autoRefresh: boolean;
  observedAt: string;
}

export interface OfficialOpenFigureChangeReceiptV1 {
  schema: typeof OFFICIAL_OPEN_FIGURE_CHANGE_RECEIPT_SCHEMA;
  receiptId: string;
  operationId: string;
  planDigest: string;
  action: OfficialOpenFigureChangeAction;
  providerId: typeof OFFICIAL_OPEN_FIGURE_PROVIDER_ID;
  appliedAt: string;
  sequence?: number | null;
  manifestSha256?: string | null;
  autoRefresh?: boolean;
}

interface PreparedOfficialPlan {
  publicPlan: OfficialOpenFigureChangePlanV1;
  snapshot?: VerifiedOfficialOpenFigureSnapshot;
  proposedConfig?: OfficialOpenFigureConfigV1;
  expiresAt: number;
}

function defaultConfig(updatedAt: string): OfficialOpenFigureConfigV1 {
  return { schema: OFFICIAL_OPEN_FIGURE_CONFIG_SCHEMA, autoRefresh: true, updatedAt };
}

function planDigest(plan: Omit<OfficialOpenFigureChangePlanV1, "planDigest">) {
  return sha256(canonicalJson(plan));
}

export class OfficialOpenFigureSourceManager implements OfficialOpenFigureRuntime {
  readonly paths: ReturnType<typeof officialOpenFigurePaths>;
  readonly bundledRoot: string;
  readonly fetcher: SecureProviderSourceFetcher;
  readonly now: () => number;
  readonly jitterRatio: number;
  readonly env: NodeJS.Dict<string>;
  readonly bootstrapKey: Ed25519PublicKeyIdentity;
  #bundled?: ModuleCatalogIndex;
  #current?: ModuleCatalogIndex;
  #state?: OfficialOpenFigureStateV1;
  #config?: OfficialOpenFigureConfigV1;
  #history = new Map<string, ModuleCatalogIndex>();
  #plans = new Map<string, PreparedOfficialPlan>();
  #inFlight?: Promise<void>;
  #timer?: NodeJS.Timeout;
  #networkFailures = 0;
  #failClosed: { code: string; message: string } | undefined;
  #loaded = false;

  constructor(options: {
    paths?: ReturnType<typeof officialOpenFigurePaths>;
    bundledRoot?: string;
    fetcher?: SecureProviderSourceFetcher;
    now?: () => number;
    jitterRatio?: number;
    env?: NodeJS.Dict<string>;
    bootstrapPublicKeyBase64?: string;
  } = {}) {
    this.paths = options.paths ?? officialOpenFigurePaths({ env: options.env });
    this.bundledRoot = options.bundledRoot ?? DEFAULT_PERSONAL_MODULE_ASSETS_DIR;
    this.fetcher = options.fetcher ?? new SecureProviderSourceFetcher();
    this.now = options.now ?? (() => Date.now());
    this.jitterRatio = options.jitterRatio ?? 0.1;
    this.env = options.env ?? process.env;
    this.bootstrapKey = officialOpenFigureBootstrapKey(options.bootstrapPublicKeyBase64);
  }

  currentIndex() {
    if (!this.#current) throw new Error("official Open Figure runtime has not been loaded");
    return this.#current;
  }

  isTombstoned(moduleId: string) {
    return this.#state?.tombstones.includes(moduleId) === true;
  }

  failClosed() {
    return this.#failClosed;
  }

  async indexForCatalogSha256(catalogSha256: string) {
    if (this.#current?.catalogSha256 === catalogSha256) return this.#current;
    const cached = this.#history.get(catalogSha256);
    if (cached) return cached;
    const snapshot = this.#state?.snapshots.find((item) => item.catalogSha256 === catalogSha256);
    if (!snapshot) return undefined;
    const index = await ModuleCatalogIndex.load(snapshot.directory, {
      expectedProviderId: OFFICIAL_OPEN_FIGURE_PROVIDER_ID,
      expectedRepository: "jarxunlai/ScientificFigureLibrary-personal",
      validatePreviews: false,
    });
    if (index.catalogSha256 !== catalogSha256) {
      throw new Error("official Open Figure historical snapshot catalog digest mismatch");
    }
    this.#history.set(catalogSha256, index);
    return index;
  }

  statusDetails(): Record<string, unknown> {
    const envOverride = autoRefreshEnvOverride(this.env);
    const configAutoRefresh = this.#config?.autoRefresh !== false;
    const autoRefreshEnabled = officialOpenFigureAutoRefreshAllowed(this.env) && configAutoRefresh;
    return {
      sourceKind: "official-signed-overlay",
      sourceLabel: OFFICIAL_OPEN_FIGURE_SOURCE_LABEL,
      providerId: OFFICIAL_OPEN_FIGURE_PROVIDER_ID,
      activeOrigin: this.#state?.activeOrigin ?? "bundled",
      autoRefreshEnabled,
      autoRefreshConfigured: configAutoRefresh,
      autoRefreshEnvOverride: envOverride ?? null,
      refreshTtlMs: OFFICIAL_OPEN_FIGURE_REFRESH_TTL_MS,
      activeSequence: this.#state?.activeSequence ?? null,
      manifestSha256: this.#state?.activeManifestSha256 ?? null,
      catalogSha256: this.#current?.catalogSha256 ?? this.#state?.activeCatalogSha256 ?? null,
      templateCount: this.#current?.catalog.modules.length ?? 0,
      snapshotCount: this.#state?.snapshotCount ?? 1,
      snapshotBytes: this.#state?.snapshotBytes ?? 0,
      lastCheckAt: this.#state?.lastCheckAt ?? null,
      lastSuccessAt: this.#state?.lastSuccessAt ?? null,
      nextCheckAt: this.#state?.nextCheckAt ?? null,
      lastError: this.#state?.lastError ?? this.#failClosed ?? null,
      signingKeyId: this.#state?.signingKey.keyId ?? this.bootstrapKey.keyId,
      bootstrapKeyId: OFFICIAL_OPEN_FIGURE_BOOTSTRAP_KEY_ID,
      tombstoneCount: this.#state?.tombstones.length ?? 0,
      bundledBootstrapPresent: Boolean(this.#bundled),
      remoteLkgComplete: this.#state?.activeOrigin === "remote-lkg",
      startupNetworkPolicy: "async-if-due",
      searchNetworkPolicy: "stale-while-revalidate",
      requestBlocksOnNetwork: false,
      envKillSwitch: this.env[OFFICIAL_OPEN_FIGURE_AUTO_REFRESH_ENV] ?? null,
      failClosed: Boolean(this.#failClosed),
    };
  }

  maybeRefresh() {
    if (!this.#loaded || this.#failClosed) return;
    if (!this.autoRefreshEffective()) return;
    const due = !this.#state?.nextCheckAt || Date.parse(this.#state.nextCheckAt) <= this.now();
    if (!due) return;
    void this.refreshInBackground();
  }

  refreshOnProcessStart() {
    if (!this.#loaded || this.#failClosed) return;
    if (!this.autoRefreshEffective()) return;
    return this.refreshInBackground({ ignoreTtl: true });
  }

  scheduleBackgroundRefresh() {
    this.clearTimer();
    if (!this.autoRefreshEffective() || this.#failClosed) return;
    const delay = Math.max(
      0,
      (this.#state?.nextCheckAt ? Date.parse(this.#state.nextCheckAt) : this.now()) - this.now(),
    );
    this.#timer = setTimeout(() => this.maybeRefresh(), delay);
    this.#timer.unref?.();
  }

  dispose() {
    this.clearTimer();
  }

  autoRefreshEffective() {
    return officialOpenFigureAutoRefreshAllowed(this.env) && this.#config?.autoRefresh !== false;
  }

  async load() {
    this.#bundled = await ModuleCatalogIndex.load(this.bundledRoot, {
      expectedProviderId: OFFICIAL_OPEN_FIGURE_PROVIDER_ID,
      expectedRepository: "jarxunlai/ScientificFigureLibrary-personal",
      validatePreviews: false,
    });
    this.#history.set(this.#bundled.catalogSha256, this.#bundled);
    this.#config = await this.readConfig();
    try {
      const state = await this.readState();
      if (!state) {
        this.#state = this.bundledState(this.#bundled);
        this.#current = this.#bundled;
      } else {
        const loaded = await this.activateExistingState(state);
        this.#state = loaded.state;
        this.#current = loaded.index;
      }
    } catch (error) {
      this.#failClosed = { code: "official_open_figure_state_corrupt", message: safeError(error) };
      this.#current = this.#bundled;
    }
    this.#loaded = true;
    return this;
  }

  async refresh(options: { ignoreTtl?: boolean } = {}) {
    if (!this.#loaded) await this.load();
    if (this.#failClosed) throw new Error(`${this.#failClosed.code}: ${this.#failClosed.message}`);
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.refreshLocked(options).finally(() => {
      this.#inFlight = undefined;
    });
    return this.#inFlight;
  }

  async planChange(input: { action: OfficialOpenFigureChangeAction; autoRefresh?: boolean }) {
    if (!this.#loaded) await this.load();
    if (this.#failClosed) throw new Error(`${this.#failClosed.code}: ${this.#failClosed.message}`);
    if (input.action === "configure") {
      if (input.autoRefresh === undefined) throw new Error("official Open Figure configure requires autoRefresh");
      const current = this.#config?.autoRefresh !== false;
      if (current === input.autoRefresh) return this.alreadyCurrent("configure");
      const publicPlan: Omit<OfficialOpenFigureChangePlanV1, "planDigest"> = {
        schema: OFFICIAL_OPEN_FIGURE_CHANGE_PLAN_SCHEMA,
        planId: `open-figure-plan-${randomUUID()}`,
        action: "configure",
        providerId: OFFICIAL_OPEN_FIGURE_PROVIDER_ID,
        sourceKind: "official-signed-overlay",
        autoRefresh: input.autoRefresh,
        manifestUrl: OFFICIAL_OPEN_FIGURE_MANIFEST_URL,
        accessUrls: [],
        templateDiff: { added: [], updated: [], withdrawn: [], tombstones: this.#state?.tombstones ?? [] },
        warnings: ["Configure changes only the official Open Figure Modules autoRefresh standing policy."],
        createdAt: nowIso(this.now),
      };
      const plan = { ...publicPlan, planDigest: planDigest(publicPlan) };
      this.rememberPlan({
        publicPlan: plan,
        proposedConfig: { schema: OFFICIAL_OPEN_FIGURE_CONFIG_SCHEMA, autoRefresh: input.autoRefresh, updatedAt: nowIso(this.now) },
        expiresAt: this.now() + PLAN_TTL_MS,
      });
      return plan;
    }
    const snapshot = await this.fetchSnapshot();
    if (isUnchangedOfficialOpenFigureFetch(snapshot)) return this.alreadyCurrent("update");
    if (this.#state?.activeManifestSha256 === snapshot.manifestSha256 && this.#state.activeSequence === snapshot.manifest.sequence) {
      return this.alreadyCurrent("update");
    }
    const templateDiff = diffOfficialCatalogs({
      previous: this.#current?.catalog,
      next: snapshot.catalog,
      previousTombstones: this.#state?.tombstones,
      nextTombstones: snapshot.tombstones,
    });
    const publicPlan: Omit<OfficialOpenFigureChangePlanV1, "planDigest"> = {
      schema: OFFICIAL_OPEN_FIGURE_CHANGE_PLAN_SCHEMA,
      planId: `open-figure-plan-${randomUUID()}`,
      action: "update",
      providerId: OFFICIAL_OPEN_FIGURE_PROVIDER_ID,
      sourceKind: "official-signed-overlay",
      manifestUrl: OFFICIAL_OPEN_FIGURE_MANIFEST_URL,
      accessUrls: snapshot.accessUrls,
      signingKeyId: snapshot.signingKey.keyId,
      previousSigningKeyId: this.#state?.signingKey.keyId,
      sequence: snapshot.manifest.sequence,
      previousSequence: this.#state?.activeSequence ?? null,
      manifestSha256: snapshot.manifestSha256,
      catalogSha256: snapshot.catalogSha256,
      previewsSha256: snapshot.previewsArchiveSha256,
      templateCount: snapshot.catalog.modules.length,
      tombstoneCount: snapshot.tombstones.length,
      payloadCommit: snapshot.payloadCommit,
      templateDiff,
      warnings: ["Apply re-fetches the exact signed Open Figure Modules feed and activates it only after every verification gate passes."],
      createdAt: nowIso(this.now),
    };
    const plan = { ...publicPlan, planDigest: planDigest(publicPlan) };
    this.rememberPlan({ publicPlan: plan, snapshot, expiresAt: this.now() + PLAN_TTL_MS });
    return plan;
  }

  async applyChange(input: { planDigest: string; operationId: string; expectedAction: OfficialOpenFigureChangeAction }) {
    assertHash(input.planDigest, "official Open Figure planDigest");
    if (!OPERATION_ID.test(input.operationId)) throw new Error("official Open Figure operationId is invalid");
    const prepared = this.#plans.get(input.planDigest);
    if (!prepared || prepared.expiresAt <= this.now()) {
      this.#plans.delete(input.planDigest);
      throw new Error("official Open Figure plan is not available; create and review a new plan");
    }
    if (prepared.publicPlan.action !== input.expectedAction) {
      throw new Error("official Open Figure Apply expectations do not match the plan");
    }
    if (prepared.publicPlan.action === "configure") {
      if (!prepared.proposedConfig) throw new Error("official Open Figure configure plan is missing its config");
      await atomicWriteJson(this.paths.configFile, prepared.proposedConfig);
      this.#config = prepared.proposedConfig;
      this.scheduleBackgroundRefresh();
      return {
        schema: OFFICIAL_OPEN_FIGURE_CHANGE_RECEIPT_SCHEMA,
        receiptId: `open-figure-receipt-${randomUUID()}`,
        operationId: input.operationId,
        planDigest: input.planDigest,
        action: "configure" as const,
        providerId: OFFICIAL_OPEN_FIGURE_PROVIDER_ID,
        appliedAt: nowIso(this.now),
        autoRefresh: prepared.proposedConfig.autoRefresh,
      };
    }
    const snapshot = await this.fetchSnapshot();
    if (isUnchangedOfficialOpenFigureFetch(snapshot)) {
      throw new Error("stale official Open Figure plan: remote snapshot changed after planning");
    }
    if (
      !prepared.snapshot ||
      snapshot.manifestSha256 !== prepared.snapshot.manifestSha256 ||
      snapshot.catalogSha256 !== prepared.snapshot.catalogSha256 ||
      canonicalJson(snapshot.accessUrls) !== canonicalJson(prepared.publicPlan.accessUrls)
    ) {
      throw new Error("stale official Open Figure plan: remote snapshot changed after planning");
    }
    await this.activateSnapshot(snapshot);
    return {
      schema: OFFICIAL_OPEN_FIGURE_CHANGE_RECEIPT_SCHEMA,
      receiptId: `open-figure-receipt-${randomUUID()}`,
      operationId: input.operationId,
      planDigest: input.planDigest,
      action: "update" as const,
      providerId: OFFICIAL_OPEN_FIGURE_PROVIDER_ID,
      appliedAt: nowIso(this.now),
      sequence: snapshot.manifest.sequence,
      manifestSha256: snapshot.manifestSha256,
    };
  }

  private alreadyCurrent(action: OfficialOpenFigureChangeAction): OfficialOpenFigureAlreadyCurrentV1 {
    return {
      schema: OFFICIAL_OPEN_FIGURE_ALREADY_CURRENT_SCHEMA,
      status: "already_current",
      action,
      providerId: OFFICIAL_OPEN_FIGURE_PROVIDER_ID,
      sequence: this.#state?.activeSequence ?? null,
      manifestSha256: this.#state?.activeManifestSha256 ?? null,
      autoRefresh: this.#config?.autoRefresh !== false,
      observedAt: nowIso(this.now),
    };
  }

  private rememberPlan(plan: PreparedOfficialPlan) {
    if (this.#plans.size >= PLAN_LIMIT) {
      const oldest = [...this.#plans.entries()].sort((left, right) => left[1].expiresAt - right[1].expiresAt)[0];
      if (oldest) this.#plans.delete(oldest[0]);
    }
    this.#plans.set(plan.publicPlan.planDigest, plan);
  }

  private refreshInBackground(options: { ignoreTtl?: boolean } = {}) {
    if (this.#inFlight) return this.#inFlight;
    this.#inFlight = this.refreshLocked({ ignoreTtl: options.ignoreTtl === true }).catch(() => undefined).finally(() => {
      this.#inFlight = undefined;
      this.scheduleBackgroundRefresh();
    });
    return this.#inFlight;
  }

  private async refreshLocked(options: { ignoreTtl?: boolean }) {
    if (!options.ignoreTtl && this.#state?.nextCheckAt && Date.parse(this.#state.nextCheckAt) > this.now()) return;
    try {
      const snapshot = await this.fetchSnapshot({ skipUnchangedPayload: true });
      if (isUnchangedOfficialOpenFigureFetch(snapshot)) {
        await this.touchCheck({ success: true });
        this.#networkFailures = 0;
        return;
      }
      if (this.#state?.activeManifestSha256 === snapshot.manifestSha256 && this.#state.activeSequence === snapshot.manifest.sequence) {
        await this.touchCheck({ success: true });
        this.#networkFailures = 0;
        return;
      }
      await this.activateSnapshot(snapshot);
      this.#networkFailures = 0;
    } catch (error) {
      const message = safeError(error);
      const integrity = /signature|rollback|equivocation|schema|tombstone|identity|ZIP|catalog/i.test(message);
      if (integrity) this.#networkFailures = 0;
      else this.#networkFailures += 1;
      await this.touchCheck({
        success: false,
        error: {
          code: integrity ? "official_open_figure_integrity_error" : "official_open_figure_network_error",
          message,
        },
        integrity,
      });
    }
  }

  private async fetchSnapshot(options: { skipUnchangedPayload?: boolean } = {}) {
    const trusted = this.#state
      ? [this.#state.signingKey, ...this.#state.authorizedNextKeys].filter(
          (key, index, values) => values.findIndex((item) => item.keyId === key.keyId) === index,
        )
      : [this.bootstrapKey];
    return fetchVerifiedOfficialOpenFigureSnapshot({
      fetcher: this.fetcher,
      manifestUrl: OFFICIAL_OPEN_FIGURE_MANIFEST_URL,
      trustedKeys: trusted,
      skipUnchangedPayload: options.skipUnchangedPayload === true,
      previous: {
        catalog: this.#current?.catalog,
        tombstones: this.#state?.tombstones,
        sequence: this.#state?.activeOrigin === "remote-lkg" ? this.#state.activeSequence ?? undefined : undefined,
        manifestSha256: this.#state?.activeOrigin === "remote-lkg" ? this.#state.activeManifestSha256 ?? undefined : undefined,
        signingKey: this.#state?.activeOrigin === "remote-lkg" ? this.#state.signingKey : this.bootstrapKey,
        authorizedNextKeys: this.#state?.authorizedNextKeys,
        observed: this.#state?.observedRevisions,
      },
    });
  }

  private async activateSnapshot(snapshot: VerifiedOfficialOpenFigureSnapshot) {
    const snapshotDirectory = path.join(this.paths.snapshotsRoot, snapshot.manifestSha256);
    const catalogDirectory = path.join(snapshotDirectory, "catalog");
    await withCrossRuntimeWriteLock(
      {
        root: this.paths.dataRoot,
        lockDirectory: this.paths.lockDirectory,
        libraryId: "official-open-figure-modules",
        operation: `official-open-figure:${snapshot.manifest.sequence}:${snapshot.manifestSha256.slice(0, 12)}`,
      },
      async () => {
        await this.writeSnapshotDirectory(snapshot, snapshotDirectory, catalogDirectory);
        const index = await ModuleCatalogIndex.load(catalogDirectory, {
          expectedProviderId: OFFICIAL_OPEN_FIGURE_PROVIDER_ID,
          expectedRepository: "jarxunlai/ScientificFigureLibrary-personal",
          validatePreviews: false,
        });
        if (index.catalogSha256 !== snapshot.catalogSha256) {
          throw new Error("official Open Figure activated catalog digest mismatch");
        }
        const snapshotBytes = await this.directoryBytes(this.paths.snapshotsRoot).catch(() => 0);
        const nextState = this.stateFromSnapshot(snapshot, catalogDirectory, snapshotBytes);
        nextState.lastCheckAt = nowIso(this.now);
        nextState.lastSuccessAt = nowIso(this.now);
        nextState.nextCheckAt = this.nextCheckIso(false);
        nextState.lastError = null;
        await atomicWriteJson(this.paths.stateFile, nextState);
        this.#state = nextState;
        this.#current = index;
        this.#history.set(index.catalogSha256, index);
      },
    );
  }

  private async writeSnapshotDirectory(
    snapshot: VerifiedOfficialOpenFigureSnapshot,
    snapshotDirectory: string,
    catalogDirectory: string,
  ) {
    await fs.mkdir(path.join(snapshotDirectory, "signed"), { recursive: true });
    await writeImmutableFile(path.join(snapshotDirectory, "signed", "source-manifest.json"), snapshot.manifestBytes);
    await writeImmutableFile(path.join(snapshotDirectory, "signed", "source-manifest.sig.json"), snapshot.signatureSidecarBytes);
    await writeImmutableFile(path.join(snapshotDirectory, "signed", "module-previews.zip"), snapshot.previewsArchiveBytes);
    for (const [relative, bytes] of snapshot.snapshotFiles) {
      await writeImmutableFile(path.join(catalogDirectory, ...relative.split("/")), bytes);
    }
    const meta = {
      schema: OFFICIAL_OPEN_FIGURE_SNAPSHOT_STATE_SCHEMA,
      origin: "remote",
      sequence: snapshot.manifest.sequence,
      manifestSha256: snapshot.manifestSha256,
      catalogSha256: snapshot.catalogSha256,
      directory: catalogDirectory,
      generatedAt: snapshot.manifest.generatedAt,
      payloadCommit: snapshot.payloadCommit,
      tombstones: snapshot.tombstones,
    };
    await writeImmutableFile(
      path.join(snapshotDirectory, "snapshot-meta.json"),
      Buffer.from(`${JSON.stringify(meta, null, 2)}\n`, "utf8"),
    );
  }

  private stateFromSnapshot(
    snapshot: VerifiedOfficialOpenFigureSnapshot,
    catalogDirectory: string,
    snapshotBytes: number,
  ): OfficialOpenFigureStateV1 {
    const snapshots = [...(this.#state?.snapshots ?? [])];
    if (!snapshots.some((item) => item.catalogSha256 === snapshot.catalogSha256)) {
      snapshots.push({
        schema: OFFICIAL_OPEN_FIGURE_SNAPSHOT_STATE_SCHEMA,
        origin: "remote",
        sequence: snapshot.manifest.sequence,
        manifestSha256: snapshot.manifestSha256,
        catalogSha256: snapshot.catalogSha256,
        directory: catalogDirectory,
        generatedAt: snapshot.manifest.generatedAt,
        payloadCommit: snapshot.payloadCommit,
      });
    }
    const observed = [...(this.#state?.observedRevisions ?? [])];
    if (!observed.some((item) => item.sequence === snapshot.manifest.sequence && item.manifestSha256 === snapshot.manifestSha256)) {
      observed.push({ sequence: snapshot.manifest.sequence, manifestSha256: snapshot.manifestSha256 });
    }
    return {
      schema: OFFICIAL_OPEN_FIGURE_STATE_SCHEMA,
      activeOrigin: "remote-lkg",
      activeSequence: snapshot.manifest.sequence,
      activeManifestSha256: snapshot.manifestSha256,
      activeCatalogSha256: snapshot.catalogSha256,
      signingKey: snapshot.signingKey,
      authorizedNextKeys: snapshot.authorizedNextKeys,
      observedRevisions: observed.sort((left, right) => left.sequence - right.sequence),
      tombstones: [...snapshot.tombstones].sort(compareCanonicalStrings),
      snapshots,
      lastCheckAt: this.#state?.lastCheckAt ?? null,
      lastSuccessAt: this.#state?.lastSuccessAt ?? null,
      nextCheckAt: this.#state?.nextCheckAt ?? null,
      lastError: null,
      snapshotCount: snapshots.length,
      snapshotBytes,
      updatedAt: nowIso(this.now),
    };
  }

  private bundledState(index: ModuleCatalogIndex): OfficialOpenFigureStateV1 {
    return {
      schema: OFFICIAL_OPEN_FIGURE_STATE_SCHEMA,
      activeOrigin: "bundled",
      activeSequence: null,
      activeManifestSha256: null,
      activeCatalogSha256: index.catalogSha256,
      signingKey: this.bootstrapKey,
      authorizedNextKeys: [],
      observedRevisions: [],
      tombstones: [],
      snapshots: [{
        schema: OFFICIAL_OPEN_FIGURE_SNAPSHOT_STATE_SCHEMA,
        origin: "bundled",
        sequence: null,
        manifestSha256: null,
        catalogSha256: index.catalogSha256,
        directory: index.assetsDir,
        generatedAt: index.catalog.generatedAt,
        payloadCommit: null,
      }],
      lastCheckAt: null,
      lastSuccessAt: null,
      nextCheckAt: nowIso(this.now),
      lastError: null,
      snapshotCount: 1,
      snapshotBytes: 0,
      updatedAt: nowIso(this.now),
    };
  }

  private async activateExistingState(state: OfficialOpenFigureStateV1) {
    if (state.activeOrigin === "bundled") return { state, index: this.#bundled! };
    const active = state.snapshots.find((item) => item.catalogSha256 === state.activeCatalogSha256);
    const candidates = [...state.snapshots]
      .filter((item) => item.origin === "remote")
      .sort((left, right) => (right.sequence ?? 0) - (left.sequence ?? 0));
    const ordered = active ? [active, ...candidates.filter((item) => item !== active)] : candidates;
    let lastError: unknown;
    for (const snapshot of ordered) {
      try {
        const index = await ModuleCatalogIndex.load(snapshot.directory, {
          expectedProviderId: OFFICIAL_OPEN_FIGURE_PROVIDER_ID,
          expectedRepository: "jarxunlai/ScientificFigureLibrary-personal",
          validatePreviews: false,
        });
        if (index.catalogSha256 !== snapshot.catalogSha256) {
          throw new Error("official Open Figure stored catalog digest mismatch");
        }
        this.#history.set(index.catalogSha256, index);
        return {
          state: {
            ...state,
            activeOrigin: "remote-lkg" as const,
            activeCatalogSha256: index.catalogSha256,
            activeSequence: snapshot.sequence,
            activeManifestSha256: snapshot.manifestSha256,
          },
          index,
        };
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError ?? new Error("official Open Figure remote last-known-good snapshot is missing");
  }

  private async touchCheck(options: { success: boolean; error?: { code: string; message: string }; integrity?: boolean }) {
    if (!this.#state) return;
    const next: OfficialOpenFigureStateV1 = {
      ...this.#state,
      lastCheckAt: nowIso(this.now),
      lastSuccessAt: options.success ? nowIso(this.now) : this.#state.lastSuccessAt,
      nextCheckAt: this.nextCheckIso(Boolean(options.error) && !options.integrity),
      lastError: options.error ?? null,
      updatedAt: nowIso(this.now),
    };
    try {
      await atomicWriteJson(this.paths.stateFile, next);
      this.#state = next;
    } catch {
      this.#state = next;
    }
  }

  private nextCheckIso(networkFailure: boolean) {
    const ttl = networkFailure
      ? OFFICIAL_OPEN_FIGURE_NETWORK_BACKOFF_MS[Math.min(Math.max(this.#networkFailures - 1, 0), OFFICIAL_OPEN_FIGURE_NETWORK_BACKOFF_MS.length - 1)] ?? OFFICIAL_OPEN_FIGURE_REFRESH_TTL_MS
      : OFFICIAL_OPEN_FIGURE_REFRESH_TTL_MS;
    const jitter = ttl * this.jitterRatio * (Math.random() * 2 - 1);
    return new Date(this.now() + Math.min(OFFICIAL_OPEN_FIGURE_REFRESH_TTL_MS, Math.max(ttl + jitter, 60_000))).toISOString();
  }

  private async readConfig() {
    try {
      const raw = JSON.parse(await fs.readFile(this.paths.configFile, "utf8")) as unknown;
      if (!isRecord(raw) || raw.schema !== OFFICIAL_OPEN_FIGURE_CONFIG_SCHEMA) {
        throw new Error("official Open Figure config schema is unsupported");
      }
      if (typeof raw.autoRefresh !== "boolean") throw new Error("official Open Figure autoRefresh is invalid");
      return {
        schema: OFFICIAL_OPEN_FIGURE_CONFIG_SCHEMA,
        autoRefresh: raw.autoRefresh,
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : nowIso(this.now),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return defaultConfig(nowIso(this.now));
      throw error;
    }
  }

  private async readState(): Promise<OfficialOpenFigureStateV1 | undefined> {
    try {
      const raw = JSON.parse(await fs.readFile(this.paths.stateFile, "utf8")) as unknown;
      return this.validateState(raw);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }

  private validateState(value: unknown): OfficialOpenFigureStateV1 {
    if (!isRecord(value) || value.schema !== OFFICIAL_OPEN_FIGURE_STATE_SCHEMA) {
      throw new Error("official Open Figure state schema is unsupported");
    }
    validateKey(value.signingKey, "official Open Figure signingKey");
    if (!Array.isArray(value.authorizedNextKeys) || !Array.isArray(value.observedRevisions) || !Array.isArray(value.snapshots) || !Array.isArray(value.tombstones)) {
      throw new Error("official Open Figure state collections are invalid");
    }
    if (value.activeOrigin !== "bundled" && value.activeOrigin !== "remote-lkg") {
      throw new Error("official Open Figure activeOrigin is invalid");
    }
    assertHash(value.activeCatalogSha256, "activeCatalogSha256");
    return value as unknown as OfficialOpenFigureStateV1;
  }

  private async directoryBytes(root: string) {
    let total = 0;
    const walk = async (directory: string): Promise<void> => {
      let entries: import("node:fs").Dirent[];
      try {
        entries = await fs.readdir(directory, { withFileTypes: true });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
        throw error;
      }
      for (const entry of entries) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await walk(absolute);
        else if (entry.isFile()) total += (await fs.stat(absolute)).size;
      }
    };
    await walk(root);
    return total;
  }

  private clearTimer() {
    if (this.#timer) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }
  }
}

export function isOfficialAlreadyCurrent(
  value: OfficialOpenFigureChangePlanV1 | OfficialOpenFigureAlreadyCurrentV1,
): value is OfficialOpenFigureAlreadyCurrentV1 {
  return "status" in value;
}
