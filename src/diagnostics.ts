import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";

export const DIAGNOSTICS_SCHEMA_VERSION = "figure-library.diagnostics-event.v1" as const;
export const DIAGNOSTICS_BUNDLE_SCHEMA_VERSION =
  "figure-library.diagnostics-bundle.v1" as const;
export const DEFAULT_DIAGNOSTIC_FILE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_DIAGNOSTIC_TOTAL_BYTES = 50 * 1024 * 1024;

export const UI_DIAGNOSTIC_EVENTS = [
  "host.capabilities_detected",
  "candidate.thumbnail_clicked",
  "candidate.detail_opened",
  "candidate.detail_closed",
  "exact_preview.image_loaded",
  "exact_preview.image_error",
  "model_context.updated",
] as const;

export type UiDiagnosticEvent = (typeof UI_DIAGNOSTIC_EVENTS)[number];

export type DiagnosticEventName =
  | "server.started"
  | "host.capabilities_detected"
  | "search.started"
  | "search.catalog_loaded"
  | "search.matched"
  | "search.page_built"
  | "search.completed"
  | "candidate.thumbnail_clicked"
  | "candidate.detail_opened"
  | "candidate.detail_closed"
  | "exact_preview.requested"
  | "exact_preview.completed"
  | "exact_preview.image_loaded"
  | "exact_preview.image_error"
  | "candidate.confirmation_requested"
  | "candidate.confirmed"
  | "model_context.updated"
  | "materialize.plan_requested"
  | "materialize.plan_created"
  | "diagnostics.export_requested"
  | "diagnostics.export_completed"
  | "tool.failed";

export type DiagnosticInvocationSource =
  | "agent"
  | "app"
  | "headless"
  | "host"
  | "server"
  | "unknown";

export interface DiagnosticEventInput {
  level?: "debug" | "info" | "warning" | "error";
  event: DiagnosticEventName;
  correlationId?: string;
  resultSetId?: string;
  candidateId?: string;
  toolName?: string;
  invocationSource?: DiagnosticInvocationSource;
  providerId?: string;
  selectorDigest?: string;
  durationMs?: number;
  payloadBytes?: number;
  previewBytes?: number;
  catalogRevision?: string;
  libraryRevision?: string;
  errorCode?: string;
  safeMessage?: string;
}

export interface DiagnosticEvent extends DiagnosticEventInput {
  timestamp: string;
  schemaVersion: typeof DIAGNOSTICS_SCHEMA_VERSION;
  level: "debug" | "info" | "warning" | "error";
  sessionId: string;
}

export interface DiagnosticsExportInput {
  scope: "last_operation" | "current_session" | "correlation_id" | "time_range";
  correlationId?: string;
  since?: string;
  until?: string;
  detail: "summary" | "sanitized_bundle" | "full_local";
  includeUserText: boolean;
  includeAbsolutePaths: boolean;
}

export interface DiagnosticsExportResult {
  bundleId: string;
  fileName: string;
  byteLength: number;
  sha256: string;
  scope: DiagnosticsExportInput["scope"];
  redacted: boolean;
  summary: {
    errors: number;
    warnings: number;
    events: number;
    slowestStage?: string;
    durationMs?: number;
  };
  resourceUri: string;
  localPath?: string;
}

interface BundleRecord {
  bundleId: string;
  fileName: string;
  filePath: string;
  resourceUri: string;
  bytes: Uint8Array;
  sha256: string;
}

interface DiagnosticsOptions {
  directory?: string;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  now?: () => Date;
}

const HASH = /^[a-f0-9]{64}$/u;
const SAFE_ID = /^[A-Za-z0-9._:-]{1,256}$/u;
const SECRET_TEXT =
  /(data:image\/[^;\s]+;base64,[A-Za-z0-9+/=]+|\b(?:preview[-_]?)?(?:receipt|challenge|token)[-_][A-Za-z0-9_-]+|\bBearer\s+[A-Za-z0-9._~-]+|(?:api[-_]?key|authorization|cookie)\s*[:=]\s*[^\s,;]+)/giu;
const WINDOWS_ABSOLUTE_PATH = /\b[A-Za-z]:\\[^\r\n"']+/gu;
const POSIX_ABSOLUTE_PATH = /(^|[\s"'(:=])\/(?!\/)[^\s"',;)}\]]+/gmu;

function hash(bytes: Uint8Array | string) {
  return createHash("sha256").update(bytes).digest("hex");
}

function boundedString(value: string | undefined, maximum: number) {
  if (value === undefined) return undefined;
  return value.normalize("NFC").slice(0, maximum);
}

function safeMessage(value: string | undefined) {
  const bounded = boundedString(value, 1_024);
  if (!bounded) return undefined;
  return bounded
    .replace(SECRET_TEXT, "<REDACTED>")
    .replace(WINDOWS_ABSOLUTE_PATH, "<ABSOLUTE_PATH>")
    .replace(POSIX_ABSOLUTE_PATH, (_match, prefix: string) => `${prefix}<ABSOLUTE_PATH>`);
}

function finiteNonNegative(value: number | undefined) {
  if (value === undefined || !Number.isFinite(value) || value < 0) return undefined;
  return Math.round(value * 1_000) / 1_000;
}

function safeId(value: string | undefined, maximum = 256) {
  if (value === undefined) return undefined;
  const bounded = boundedString(value, maximum);
  return bounded && SAFE_ID.test(bounded) ? bounded : undefined;
}

function isoTimestamp(value: string | undefined, label: string) {
  if (value === undefined) return undefined;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error(`${label} must be an ISO-8601 timestamp`);
  return new Date(time).toISOString();
}

function diagnosticFileName(sessionId: string, segment: number) {
  return `${sessionId}-${String(segment).padStart(4, "0")}.jsonl`;
}

function zipTimestamp(value: Date) {
  return value.toISOString().replace(/[:.]/gu, "-");
}

export class DiagnosticsManager {
  readonly sessionId = `session-${randomUUID()}`;
  readonly directory: string;
  readonly maxFileBytes: number;
  readonly maxTotalBytes: number;

  private readonly now: () => Date;
  private readonly events: DiagnosticEvent[] = [];
  private readonly bundles = new Map<string, BundleRecord>();
  private segment = 0;
  private writeQueue: Promise<void> = Promise.resolve();
  private lastOperationCorrelationId?: string;
  private uiWindowStartedAt = 0;
  private uiWindowEvents = 0;
  private uiTotalEvents = 0;
  private degradedReason?: string;

  constructor(options: DiagnosticsOptions = {}) {
    const configured = options.directory ?? process.env.SFL_DIAGNOSTICS_DIR;
    this.directory = configured
      ? path.resolve(configured)
      : path.join(os.tmpdir(), "scientific-figure-library", "diagnostics");
    this.maxFileBytes = options.maxFileBytes ?? DEFAULT_DIAGNOSTIC_FILE_BYTES;
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_DIAGNOSTIC_TOTAL_BYTES;
    this.now = options.now ?? (() => new Date());
    if (configured && !path.isAbsolute(configured)) {
      this.degradedReason = "SFL_DIAGNOSTICS_DIR must be absolute";
    }
  }

  get degraded() {
    return this.degradedReason !== undefined;
  }

  get degradationMessage() {
    return this.degradedReason;
  }

  createCorrelationId(prefix = "operation") {
    return `${prefix}-${randomUUID()}`;
  }

  async start() {
    await this.record({
      event: "server.started",
      invocationSource: "server",
      safeMessage: "Scientific Figure Library diagnostics session started.",
    });
  }

  private normalize(input: DiagnosticEventInput): DiagnosticEvent {
    const event: DiagnosticEvent = {
      timestamp: this.now().toISOString(),
      schemaVersion: DIAGNOSTICS_SCHEMA_VERSION,
      level: input.level ?? "info",
      event: input.event,
      sessionId: this.sessionId,
    };
    const correlationId = safeId(input.correlationId);
    const resultSetId = safeId(input.resultSetId);
    const candidateId = safeId(input.candidateId);
    const toolName = safeId(input.toolName, 128);
    const providerId = safeId(input.providerId, 200);
    const selectorDigest =
      input.selectorDigest && HASH.test(input.selectorDigest) ? input.selectorDigest : undefined;
    const catalogRevision = safeId(input.catalogRevision);
    const libraryRevision = safeId(input.libraryRevision);
    const errorCode = safeId(input.errorCode, 128);
    const message = safeMessage(input.safeMessage);
    if (correlationId) event.correlationId = correlationId;
    if (resultSetId) event.resultSetId = resultSetId;
    if (candidateId) event.candidateId = candidateId;
    if (toolName) event.toolName = toolName;
    if (input.invocationSource) event.invocationSource = input.invocationSource;
    if (providerId) event.providerId = providerId;
    if (selectorDigest) event.selectorDigest = selectorDigest;
    const durationMs = finiteNonNegative(input.durationMs);
    const payloadBytes = finiteNonNegative(input.payloadBytes);
    const previewBytes = finiteNonNegative(input.previewBytes);
    if (durationMs !== undefined) event.durationMs = durationMs;
    if (payloadBytes !== undefined) event.payloadBytes = payloadBytes;
    if (previewBytes !== undefined) event.previewBytes = previewBytes;
    if (catalogRevision) event.catalogRevision = catalogRevision;
    if (libraryRevision) event.libraryRevision = libraryRevision;
    if (errorCode) event.errorCode = errorCode;
    if (message) event.safeMessage = message;
    return event;
  }

  async record(input: DiagnosticEventInput) {
    const event = this.normalize(input);
    this.events.push(event);
    if (this.events.length > 10_000) this.events.shift();
    if (
      event.correlationId &&
      event.event !== "diagnostics.export_requested" &&
      (event.event.endsWith(".started") ||
        event.event.endsWith(".requested") ||
        event.event === "search.completed")
    ) {
      this.lastOperationCorrelationId = event.correlationId;
    }
    const line = `${JSON.stringify(event)}\n`;
    this.writeQueue = this.writeQueue
      .then(async () => {
        if (this.degradedReason) return;
        await fs.mkdir(this.directory, { recursive: true });
        let file = path.join(this.directory, diagnosticFileName(this.sessionId, this.segment));
        const size = await fs.stat(file).then((value) => value.size).catch(() => 0);
        if (size > 0 && size + Buffer.byteLength(line) > this.maxFileBytes) {
          this.segment += 1;
          file = path.join(this.directory, diagnosticFileName(this.sessionId, this.segment));
        }
        await fs.appendFile(file, line, { encoding: "utf8", mode: 0o600 });
        await this.pruneStoredFiles(file);
      })
      .catch((error: unknown) => {
        this.degradedReason = safeMessage(error instanceof Error ? error.message : String(error));
      });
    await this.writeQueue;
  }

  private async pruneStoredFiles(protectedFiles: string | string[]) {
    const protectedSet = new Set(
      (Array.isArray(protectedFiles) ? protectedFiles : [protectedFiles]).map((file) =>
        path.resolve(file),
      ),
    );
    const entries = await fs.readdir(this.directory, { withFileTypes: true });
    const files = (
      await Promise.all(
        entries
          .filter((entry) => entry.isFile() && (entry.name.endsWith(".jsonl") || entry.name.endsWith(".zip")))
          .map(async (entry) => {
            const file = path.join(this.directory, entry.name);
            const stat = await fs.stat(file);
            return { file, bytes: stat.size, modified: stat.mtimeMs };
          }),
      )
    ).sort((left, right) => left.modified - right.modified);
    let total = files.reduce((sum, item) => sum + item.bytes, 0);
    for (const item of files) {
      if (total <= this.maxTotalBytes) break;
      if (protectedSet.has(path.resolve(item.file))) continue;
      await fs.unlink(item.file).catch(() => undefined);
      total -= item.bytes;
    }
  }

  async recordUiEvent(input: {
    event: UiDiagnosticEvent;
    resultSetId: string;
    candidateId: string;
    correlationId?: string;
    durationMs?: number;
    payloadBytes?: number;
    previewBytes?: number;
  }) {
    if (!UI_DIAGNOSTIC_EVENTS.includes(input.event)) {
      throw new Error("unsupported UI diagnostic event");
    }
    if (!SAFE_ID.test(input.resultSetId) || !SAFE_ID.test(input.candidateId)) {
      throw new Error("invalid UI diagnostic result or candidate identifier");
    }
    const now = Date.now();
    if (now - this.uiWindowStartedAt >= 60_000) {
      this.uiWindowStartedAt = now;
      this.uiWindowEvents = 0;
    }
    if (this.uiWindowEvents >= 120 || this.uiTotalEvents >= 1_000) {
      throw new Error("UI diagnostic event rate limit exceeded");
    }
    this.uiWindowEvents += 1;
    this.uiTotalEvents += 1;
    await this.record({
      event: input.event,
      resultSetId: input.resultSetId,
      candidateId: input.candidateId,
      correlationId: input.correlationId,
      invocationSource: "app",
      durationMs: input.durationMs,
      payloadBytes: input.payloadBytes,
      previewBytes: input.previewBytes,
    });
  }

  private selectEvents(input: DiagnosticsExportInput) {
    let events = [...this.events];
    if (input.scope === "last_operation") {
      events = this.lastOperationCorrelationId
        ? events.filter((event) => event.correlationId === this.lastOperationCorrelationId)
        : [];
    } else if (input.scope === "correlation_id") {
      if (!input.correlationId) throw new Error("correlationId is required for correlation_id scope");
      events = events.filter((event) => event.correlationId === input.correlationId);
    } else if (input.scope === "time_range") {
      const since = isoTimestamp(input.since, "since");
      const until = isoTimestamp(input.until, "until");
      if (!since && !until) throw new Error("since or until is required for time_range scope");
      if (since && until && Date.parse(since) > Date.parse(until)) {
        throw new Error("since must not be later than until");
      }
      events = events.filter(
        (event) =>
          (!since || event.timestamp >= since) && (!until || event.timestamp <= until),
      );
    }
    return events;
  }

  async exportBundle(input: DiagnosticsExportInput): Promise<DiagnosticsExportResult> {
    await this.writeQueue;
    const events = this.selectEvents(input);
    const errors = events.filter((event) => event.level === "error");
    const warnings = events.filter((event) => event.level === "warning");
    const slowest = [...events]
      .filter((event) => event.durationMs !== undefined)
      .sort((left, right) => (right.durationMs ?? 0) - (left.durationMs ?? 0))[0];
    const summary = {
      errors: errors.length,
      warnings: warnings.length,
      events: events.length,
      ...(slowest ? { slowestStage: slowest.event, durationMs: slowest.durationMs } : {}),
    };
    const createdAt = this.now();
    const summaryMarkdown = [
      "# Scientific Figure Library diagnostics",
      "",
      `- Session: \`${this.sessionId}\``,
      `- Scope: \`${input.scope}\``,
      `- Detail: \`${input.detail}\``,
      `- Created: ${createdAt.toISOString()}`,
      `- Events: ${summary.events}`,
      `- Errors: ${summary.errors}`,
      `- Warnings: ${summary.warnings}`,
      ...(summary.slowestStage
        ? [`- Slowest stage: \`${summary.slowestStage}\` (${summary.durationMs} ms)`]
        : []),
      "",
      "The bundle excludes image bytes, Data URLs, confirmation receipts/challenges, plan tokens, secrets, selectors, and conversation text.",
      "",
    ].join("\n");
    const eventLines = input.detail === "summary" ? "" : events.map((event) => JSON.stringify(event)).join("\n");
    const errorLines = input.detail === "summary" ? "" : errors.map((event) => JSON.stringify(event)).join("\n");
    const environment = {
      schema: "figure-library.diagnostics-environment.v1",
      appVersion: "0.5.1",
      sessionId: this.sessionId,
      createdAt: createdAt.toISOString(),
      nodeVersion: process.version,
      platform: process.platform,
      architecture: process.arch,
      diagnosticsDirectory: input.includeAbsolutePaths ? this.directory : "<DIAGNOSTICS_DIR>",
      temporaryDirectory: input.includeAbsolutePaths ? os.tmpdir() : "<TEMP>",
      diagnosticsDegraded: this.degraded,
      userTextRequested: input.includeUserText,
      userTextIncluded: false,
      absolutePathsIncluded: input.includeAbsolutePaths,
    };
    const payloads: Record<string, Uint8Array> = {
      "summary.md": strToU8(`${summaryMarkdown}\n`),
      "events.jsonl": strToU8(eventLines ? `${eventLines}\n` : ""),
      "errors.jsonl": strToU8(errorLines ? `${errorLines}\n` : ""),
      "environment.json": strToU8(`${JSON.stringify(environment, null, 2)}\n`),
    };
    const files = Object.entries(payloads).map(([name, bytes]) => ({
      name,
      byteLength: bytes.byteLength,
      sha256: hash(bytes),
    }));
    const manifest = {
      schemaVersion: DIAGNOSTICS_BUNDLE_SCHEMA_VERSION,
      applicationVersion: "0.5.1",
      sessionId: this.sessionId,
      createdAt: createdAt.toISOString(),
      scope: input.scope,
      detail: input.detail,
      redactionMode: "always-secret-safe",
      includeUserText: false,
      includeAbsolutePaths: input.includeAbsolutePaths,
      files,
      totalPayloadBytes: files.reduce((sum, file) => sum + file.byteLength, 0),
      manifestSelfHashExcluded: true,
    };
    payloads["manifest.json"] = strToU8(`${JSON.stringify(manifest, null, 2)}\n`);
    const bytes = zipSync(payloads, { level: 6 });
    const bundleId = `diagnostics-${randomUUID()}`;
    const fileName = `scientific-figure-library-diagnostics-${zipTimestamp(createdAt)}.zip`;
    const resourceUri = `figure-library://diagnostics/${bundleId}`;
    const filePath = path.join(this.directory, fileName);
    try {
      await fs.mkdir(this.directory, { recursive: true });
      await fs.writeFile(filePath, bytes, { flag: "wx", mode: 0o600 });
    } catch (error) {
      this.degradedReason = safeMessage(error instanceof Error ? error.message : String(error));
      throw new Error(`diagnostics bundle could not be written: ${this.degradedReason}`);
    }
    const bundle: BundleRecord = {
      bundleId,
      fileName,
      filePath,
      resourceUri,
      bytes,
      sha256: hash(bytes),
    };
    this.bundles.set(bundleId, bundle);
    while (this.bundles.size > 32) {
      const oldest = this.bundles.keys().next().value as string | undefined;
      if (!oldest) break;
      this.bundles.delete(oldest);
    }
    await this.pruneStoredFiles([
      path.join(this.directory, diagnosticFileName(this.sessionId, this.segment)),
      filePath,
    ]).catch(() => undefined);
    return {
      bundleId,
      fileName,
      byteLength: bytes.byteLength,
      sha256: bundle.sha256,
      scope: input.scope,
      redacted: true,
      summary,
      resourceUri,
      ...(input.includeAbsolutePaths ? { localPath: filePath } : {}),
    };
  }

  readBundle(bundleId: string) {
    const bundle = this.bundles.get(bundleId);
    if (!bundle) throw new Error("diagnostics bundle is unavailable in this server session");
    return { ...bundle, bytes: new Uint8Array(bundle.bytes) };
  }

  snapshotEvents() {
    return this.events.map((event) => ({ ...event }));
  }
}
