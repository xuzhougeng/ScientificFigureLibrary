import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { CatalogIndex } from "./catalog.ts";
import type { ModuleCatalogIndex } from "./module-catalog.ts";
import { parseModuleTemplateLock } from "./module-materialize.ts";
import { canonicalJson, compareCanonicalStrings } from "./canonical-json.ts";
import type { DiagnosticsManager } from "./diagnostics.ts";
import { withCrossRuntimeWriteLock } from "./cross-runtime-lock.ts";
import {
  FIGUREYA_PROVIDER_ID,
  LOCAL_LIBRARY_PROVIDER_ID,
  assertExactTemplateSelector,
  assertFigureYaExactSelector,
  assertModuleArchiveExactSelector,
} from "./providers.ts";
import type { ExactTemplateSelector } from "./types.ts";
import {
  createDefaultProviderRegistry,
  createProviderContext,
  type ProviderRegistry,
} from "./provider-registry.ts";
import {
  PUBLIC_TEMPLATE_LOCK_SCHEMA,
  assertPublicTemplateSelector,
} from "./public-catalog-provider.ts";
import type { CurrentLibraryContext, ToolOutcomeEnvelope } from "./library-binding-tools.ts";
import {
  PreviewConfirmationStore,
  PreviewProtocolError,
} from "./preview-confirmation.ts";
import {
  libraryBindingDigest,
  loadProviderPreview,
} from "./preview-service.ts";
import {
  assertLibraryOperationContext,
  readLibraryRootMarker,
  type LibraryOperationContext,
} from "./library-runtime.ts";

const HASH = /^[a-f0-9]{64}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const PLAN_TTL_MS = 30 * 60 * 1_000;
const PLAN_LIMIT = 64;
const PUBLIC_MATERIALIZATION_RECEIPT_SCHEMA =
  "figure-library.public-materialization-receipt.v1" as const;
const PUBLIC_MATERIALIZATION_INTENT_SCHEMA =
  "figure-library.public-materialization-intent.v1" as const;

type MaterializationFaultPoint = "after_public_intent" | "before_public_receipt";

interface MaterializationPlan {
  schema: "figure-library.materialization-plan.v2";
  providerId: string;
  exactSelector: ExactTemplateSelector;
  libraryContext: LibraryOperationContext;
  destination: string;
  target: string;
  sourcePackDir?: string;
  allowNetwork: boolean;
  previewConfirmation: {
    protocolVersion: 2;
    confirmationMode: "app" | "headless";
    resultSetId: string;
    previewSha256: string;
    receiptDigest: string;
  };
  expectedTargetState: "missing";
  createdAt: string;
  planDigest: string;
  written: false;
}

interface CachedPlan {
  plan: MaterializationPlan;
  expiresAt: number;
}

interface MaterializationResult {
  operationId: string;
  planDigest: string;
  providerId: string;
  exactSelector: ExactTemplateSelector;
  target: string;
  files: string[];
  materializationSource: string;
  archiveSha256?: string;
  replayed: boolean;
  recovered?: boolean;
}

interface MaterializedFileInventoryEntry {
  file: string;
  bytes: number;
  sha256: string;
}

interface PublicMaterializationReceiptV1 {
  schema: typeof PUBLIC_MATERIALIZATION_RECEIPT_SCHEMA;
  receiptId: string;
  libraryId: string;
  operationId: string;
  /** Digest of the public figure_library_plan_materialize result. */
  planDigest: string;
  providerId: string;
  plannedSelector: ExactTemplateSelector;
  plannedSelectorDigest: string;
  exactSelector: ExactTemplateSelector;
  exactSelectorDigest: string;
  targetPathDigest: string;
  fileInventory: MaterializedFileInventoryEntry[];
  fileInventoryDigest: string;
  materializationSource: string;
  archiveSha256?: string;
  appliedAt: string;
}

interface PublicMaterializationIntentV1 {
  schema: typeof PUBLIC_MATERIALIZATION_INTENT_SCHEMA;
  intentId: string;
  libraryContext: LibraryOperationContext;
  operationId: string;
  planDigest: string;
  providerId: string;
  exactSelector: ExactTemplateSelector;
  exactSelectorDigest: string;
  targetPathDigest: string;
  expectedTargetState: "missing";
  createdAt: string;
}

function digest(value: unknown) {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function envelope(
  outcome: ToolOutcomeEnvelope["outcome"],
  code: string,
  summary: string,
  nextAction: ToolOutcomeEnvelope["nextAction"],
): ToolOutcomeEnvelope {
  return {
    schema: "figure-library.tool-outcome.v1",
    outcome,
    terminal: true,
    retrySameCall: false,
    code,
    summary,
    nextAction,
  };
}

function reply(
  value: ToolOutcomeEnvelope,
  detail: Record<string, unknown> = {},
  lines: string[] = [],
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: [
          `OUTCOME: ${value.outcome}`,
          "TERMINAL: true",
          "RETRY_SAME_CALL: false",
          `CODE: ${value.code}`,
          `NEXT_ACTION: ${value.nextAction}`,
          value.summary,
          ...lines,
        ].join("\n"),
      },
    ],
    structuredContent: { envelope: value, ...detail },
  };
}

function failure(error: unknown): CallToolResult {
  if (error instanceof PreviewProtocolError) {
    const blocked = [
      "preview_required",
      "preview_receipt_used",
      "ui_confirmation_required",
    ].includes(error.code);
    return reply(
      envelope(
        blocked ? "blocked" : "conflict",
        error.code,
        `Materialization was not planned: ${error.message}`,
        "preview_selected_candidate",
      ),
    );
  }
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLocaleLowerCase("en-US");
  if (lower.includes("library_busy") || lower.includes("write-lock")) {
    return reply(
      envelope(
        "blocked",
        "library_busy",
        `Materialization was not completed: ${message}`,
        "stop_other_writers",
      ),
    );
  }
  if (lower.includes("library_not_bound")) {
    return reply(
      envelope(
        "blocked",
        "library_binding_required",
        `Materialization was not completed: ${message}`,
        "rebind_library",
      ),
    );
  }
  const conflict =
    lower.includes("target already exists") ||
    lower.includes("stale") ||
    lower.includes("authoritative materialization receipt") ||
    lower.includes("authoritative materialization intent");
  return reply(
    envelope(
      conflict ? "conflict" : "failed",
      conflict ? "materialization_target_conflict" : "materialization_failed",
      `Materialization was not completed: ${message}`,
      conflict ? "create_new_plan" : "none",
    ),
  );
}

function localIdentity(selector: ExactTemplateSelector) {
  if (selector.providerId !== LOCAL_LIBRARY_PROVIDER_ID || selector.kind !== "local-published.v1") {
    throw new Error("exactSelector is not a Local Published selector");
  }
  const { templateId, revisionId, contentDigest, releaseId } = selector.identity;
  if (
    typeof templateId !== "string" ||
    typeof revisionId !== "string" ||
    typeof releaseId !== "string" ||
    typeof contentDigest !== "string" ||
    !HASH.test(contentDigest)
  ) {
    throw new Error("invalid Local Published exact selector");
  }
  return { templateId, revisionId, contentDigest, releaseId };
}

async function targetMissing(target: string) {
  try {
    await fs.lstat(target);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

function sameNativePath(left: string, right: string) {
  const normalize = (value: string) => {
    const resolved = path.resolve(value).normalize("NFC");
    return process.platform === "win32" ? resolved.toLocaleLowerCase("en-US") : resolved;
  };
  return normalize(left) === normalize(right);
}

function validateInventory(
  value: unknown,
  label: string,
  requireCanonicalOrder: boolean,
): MaterializedFileInventoryEntry[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} has no file inventory`);
  }
  const output = value.map((item) => {
    if (
      !isRecord(item) ||
      typeof item.file !== "string" ||
      !item.file ||
      item.file.includes("\\") ||
      path.posix.isAbsolute(item.file) ||
      path.posix.normalize(item.file) !== item.file ||
      item.file.split("/").some((segment) => !segment || segment === "." || segment === "..") ||
      !Number.isSafeInteger(item.bytes) ||
      Number(item.bytes) < 0 ||
      typeof item.sha256 !== "string" ||
      !HASH.test(item.sha256)
    ) {
      throw new Error(`${label} has an invalid file inventory entry`);
    }
    return { file: item.file, bytes: Number(item.bytes), sha256: item.sha256 };
  });
  const sorted = [...output].sort((left, right) => compareCanonicalStrings(left.file, right.file));
  if (sorted.some((entry, index) => index > 0 && entry.file === sorted[index - 1]?.file)) {
    throw new Error(`${label} has a duplicate file inventory entry`);
  }
  if (requireCanonicalOrder && canonicalJson(output) !== canonicalJson(sorted)) {
    throw new Error(`${label} file inventory is not canonically ordered`);
  }
  return sorted;
}

async function inspectMaterializedTarget(target: string) {
  const targetStat = await fs.lstat(target);
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    throw new Error(`target is not a regular directory: ${target}`);
  }
  const output: MaterializedFileInventoryEntry[] = [];
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    const entries = (await fs.readdir(directory, { withFileTypes: true })).sort((left, right) =>
      compareCanonicalStrings(left.name, right.name),
    );
    for (const entry of entries) {
      if (
        !entry.name ||
        entry.name === "." ||
        entry.name === ".." ||
        entry.name.includes("\\") ||
        entry.name.includes("\0")
      ) {
        throw new Error(`unsafe materialized output path segment: ${entry.name}`);
      }
      const relativePath = relativeDirectory
        ? `${relativeDirectory}/${entry.name}`
        : entry.name;
      const absolute = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`materialized output contains a symbolic link: ${relativePath}`);
      }
      if (entry.isDirectory()) {
        await walk(absolute, relativePath);
      } else if (entry.isFile()) {
        const bytes = new Uint8Array(await fs.readFile(absolute));
        output.push({
          file: relativePath,
          bytes: bytes.byteLength,
          sha256: createHash("sha256").update(bytes).digest("hex"),
        });
      } else {
        throw new Error(`materialized output contains a non-file: ${relativePath}`);
      }
    }
  };
  await walk(target, "");
  return output.sort((left, right) => compareCanonicalStrings(left.file, right.file));
}

function targetPathDigest(target: string) {
  let normalized = path.resolve(target).normalize("NFC");
  if (process.platform === "win32") normalized = normalized.toLocaleLowerCase("en-US");
  return digest({
    schema: "figure-library.native-target-path.v1",
    platform: process.platform,
    path: normalized,
  });
}

function receiptFile(context: CurrentLibraryContext, providerId: string, operationId: string) {
  return path.join(
    context.snapshot.root,
    "store",
    "operations",
    "receipts",
    "public-materializations",
    providerId,
    `${operationId}.json`,
  );
}

function intentFile(context: CurrentLibraryContext, providerId: string, operationId: string) {
  return path.join(
    context.snapshot.root,
    "store",
    "operations",
    "intents",
    "public-materializations",
    providerId,
    `${operationId}.json`,
  );
}

async function requireLibraryAuthority(context: CurrentLibraryContext) {
  if (!context.snapshot.writesEnabled) {
    throw new Error(
      "library_not_bound: authoritative materialization receipts require a writable global Library",
    );
  }
  if (!sameNativePath(context.snapshot.root, context.versionedLibrary.root)) {
    throw new Error("library runtime and VersionedTemplateLibrary roots disagree");
  }
  const marker = await readLibraryRootMarker(context.snapshot.root);
  if (!marker) throw new Error("library is not initialized; library.json is required");
  if (context.snapshot.libraryId && context.snapshot.libraryId !== marker.value.libraryId) {
    throw new Error("stale library runtime: libraryId changed");
  }
  return marker.value;
}

function currentOperationContext(
  context: CurrentLibraryContext,
  libraryId: string,
): LibraryOperationContext {
  return { libraryId, configRevision: context.snapshot.configRevision };
}

function validateIntentValue(
  value: unknown,
  libraryId: string,
  registry: ProviderRegistry = createDefaultProviderRegistry(),
): PublicMaterializationIntentV1 {
  if (!isRecord(value) || value.schema !== PUBLIC_MATERIALIZATION_INTENT_SCHEMA) {
    throw new Error("invalid authoritative materialization intent schema");
  }
  if (
    typeof value.intentId !== "string" ||
    !value.intentId ||
    !isRecord(value.libraryContext) ||
    value.libraryContext.libraryId !== libraryId ||
    (value.libraryContext.configRevision !== null &&
      (!Number.isSafeInteger(value.libraryContext.configRevision) ||
        Number(value.libraryContext.configRevision) < 1)) ||
    typeof value.operationId !== "string" ||
    !OPERATION_ID.test(value.operationId) ||
    typeof value.planDigest !== "string" ||
    !HASH.test(value.planDigest) ||
    typeof value.providerId !== "string" ||
    typeof value.exactSelectorDigest !== "string" ||
    !HASH.test(value.exactSelectorDigest) ||
    typeof value.targetPathDigest !== "string" ||
    !HASH.test(value.targetPathDigest) ||
    value.expectedTargetState !== "missing" ||
    typeof value.createdAt !== "string" ||
    Number.isNaN(Date.parse(value.createdAt))
  ) {
    throw new Error("invalid authoritative materialization intent fields");
  }
  assertExactTemplateSelector(value.exactSelector);
  if (
    value.exactSelector.providerId !== value.providerId ||
    value.exactSelectorDigest !== digest(value.exactSelector)
  ) {
    throw new Error("authoritative materialization intent selector binding is invalid");
  }
  registry.get(value.providerId).assertSelector(value.exactSelector, "materialize");
  return value as unknown as PublicMaterializationIntentV1;
}

async function readAuthoritativeIntent(
  context: CurrentLibraryContext,
  providerId: string,
  operationId: string,
  libraryId: string,
  registry: ProviderRegistry = createDefaultProviderRegistry(),
) {
  const file = intentFile(context, providerId, operationId);
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("authoritative materialization intent is not a regular file");
    }
    return validateIntentValue(
      JSON.parse(await fs.readFile(file, "utf8")) as unknown,
      libraryId,
      registry,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `invalid authoritative materialization intent: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

function assertIntentBinding(input: {
  intent: PublicMaterializationIntentV1;
  providerId: string;
  operationId: string;
  planDigest: string;
  target: string;
  exactSelector?: ExactTemplateSelector;
  libraryContext?: LibraryOperationContext;
}) {
  const { intent } = input;
  if (
    intent.providerId !== input.providerId ||
    intent.operationId !== input.operationId ||
    intent.planDigest !== input.planDigest ||
    intent.targetPathDigest !== targetPathDigest(input.target) ||
    (input.exactSelector !== undefined &&
      canonicalJson(intent.exactSelector) !== canonicalJson(input.exactSelector))
  ) {
    throw new Error(
      "authoritative materialization intent conflicts with the requested operation, plan, selector, or target",
    );
  }
  if (input.libraryContext !== undefined) {
    assertLibraryOperationContext(input.libraryContext, intent.libraryContext);
  }
}

function assertIntentReceiptBinding(
  intent: PublicMaterializationIntentV1,
  receipt: PublicMaterializationReceiptV1,
) {
  if (
    intent.libraryContext.libraryId !== receipt.libraryId ||
    intent.operationId !== receipt.operationId ||
    intent.planDigest !== receipt.planDigest ||
    intent.providerId !== receipt.providerId ||
    intent.targetPathDigest !== receipt.targetPathDigest ||
    canonicalJson(intent.exactSelector) !== canonicalJson(receipt.plannedSelector)
  ) {
    throw new Error("authoritative materialization intent and receipt disagree");
  }
}

function validateReceiptValue(
  value: unknown,
  libraryId: string,
  registry: ProviderRegistry = createDefaultProviderRegistry(),
): PublicMaterializationReceiptV1 {
  if (!isRecord(value) || value.schema !== PUBLIC_MATERIALIZATION_RECEIPT_SCHEMA) {
    throw new Error("invalid authoritative materialization receipt schema");
  }
  if (
    typeof value.receiptId !== "string" ||
    !value.receiptId ||
    value.libraryId !== libraryId ||
    typeof value.operationId !== "string" ||
    !OPERATION_ID.test(value.operationId) ||
    typeof value.planDigest !== "string" ||
    !HASH.test(value.planDigest) ||
    typeof value.providerId !== "string" ||
    typeof value.targetPathDigest !== "string" ||
    !HASH.test(value.targetPathDigest) ||
    typeof value.fileInventoryDigest !== "string" ||
    !HASH.test(value.fileInventoryDigest) ||
    typeof value.materializationSource !== "string" ||
    !["versioned-library", "source-pack", "network", "existing", "intent-recovery"].includes(
      value.materializationSource,
    ) ||
    typeof value.appliedAt !== "string" ||
    Number.isNaN(Date.parse(value.appliedAt)) ||
    (value.archiveSha256 !== undefined &&
      (typeof value.archiveSha256 !== "string" || !HASH.test(value.archiveSha256)))
  ) {
    throw new Error("invalid authoritative materialization receipt fields");
  }
  assertExactTemplateSelector(value.plannedSelector);
  assertExactTemplateSelector(value.exactSelector);
  if (
    value.plannedSelector.providerId !== value.providerId ||
    value.exactSelector.providerId !== value.providerId ||
    typeof value.plannedSelectorDigest !== "string" ||
    value.plannedSelectorDigest !== digest(value.plannedSelector) ||
    typeof value.exactSelectorDigest !== "string" ||
    value.exactSelectorDigest !== digest(value.exactSelector)
  ) {
    throw new Error("authoritative materialization receipt selector binding is invalid");
  }
  registry.get(value.providerId).assertSelector(value.plannedSelector, "replay");
  registry.get(value.providerId).assertSelector(value.exactSelector, "replay");
  if (value.providerId === LOCAL_LIBRARY_PROVIDER_ID) {
    localIdentity(value.plannedSelector);
    localIdentity(value.exactSelector);
    if (value.archiveSha256 !== undefined) {
      throw new Error("Local Published receipt must not contain a FigureYa archive digest");
    }
  } else if (value.providerId === FIGUREYA_PROVIDER_ID) {
    assertFigureYaExactSelector(value.plannedSelector);
    assertFigureYaExactSelector(value.exactSelector);
    if (
      value.exactSelector.identity.archive.algorithm !== "sha256" ||
      value.archiveSha256 !== value.exactSelector.identity.archive.digest
    ) {
      throw new Error("FigureYa receipt archive digest does not match its resolved selector");
    }
  } else if (value.plannedSelector.kind === "module-archive.v1") {
    assertModuleArchiveExactSelector(value.plannedSelector);
    assertModuleArchiveExactSelector(value.exactSelector);
    if (value.archiveSha256 !== value.exactSelector.identity.archive.digest) {
      throw new Error("personal module receipt archive digest does not match its exact selector");
    }
  } else {
    assertPublicTemplateSelector(value.plannedSelector);
    assertPublicTemplateSelector(value.exactSelector);
    if (value.archiveSha256 !== value.exactSelector.identity.archive.sha256) {
      throw new Error("public Provider receipt archive digest does not match its exact selector");
    }
  }
  const fileInventory = validateInventory(
    value.fileInventory,
    "authoritative materialization receipt",
    true,
  );
  if (
    digest(fileInventory) !== value.fileInventoryDigest ||
    !fileInventory.some((entry) => entry.file === "template.lock.json")
  ) {
    throw new Error("authoritative materialization receipt inventory digest is invalid");
  }
  return value as unknown as PublicMaterializationReceiptV1;
}

async function readAuthoritativeReceipt(
  context: CurrentLibraryContext,
  providerId: string,
  operationId: string,
  libraryId: string,
  registry: ProviderRegistry = createDefaultProviderRegistry(),
) {
  const file = receiptFile(context, providerId, operationId);
  try {
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error("authoritative materialization receipt is not a regular file");
    }
    return validateReceiptValue(
      JSON.parse(await fs.readFile(file, "utf8")) as unknown,
      libraryId,
      registry,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `invalid authoritative materialization receipt: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function ensureAuthoritativeIntent(input: {
  context: CurrentLibraryContext;
  plan: MaterializationPlan;
  operationId: string;
  registry: ProviderRegistry;
}) {
  const marker = await requireLibraryAuthority(input.context);
  const actualLibraryContext = currentOperationContext(input.context, marker.libraryId);
  assertLibraryOperationContext(actualLibraryContext, input.plan.libraryContext);
  return withCrossRuntimeWriteLock(
    {
      root: input.context.snapshot.root,
      lockDirectory: path.join(input.context.snapshot.root, "locks", "write"),
      libraryId: marker.libraryId,
      operation: `public-materialization-intent:${input.plan.providerId}:${input.operationId}`,
    },
    async () => {
      const prior = await readAuthoritativeIntent(
        input.context,
        input.plan.providerId,
        input.operationId,
        marker.libraryId,
        input.registry,
      );
      if (prior) {
        assertIntentBinding({
          intent: prior,
          providerId: input.plan.providerId,
          operationId: input.operationId,
          planDigest: input.plan.planDigest,
          target: input.plan.target,
          exactSelector: input.plan.exactSelector,
          libraryContext: input.plan.libraryContext,
        });
        return prior;
      }
      const intent: PublicMaterializationIntentV1 = {
        schema: PUBLIC_MATERIALIZATION_INTENT_SCHEMA,
        intentId: `public-materialization-intent-${randomUUID()}`,
        libraryContext: input.plan.libraryContext,
        operationId: input.operationId,
        planDigest: input.plan.planDigest,
        providerId: input.plan.providerId,
        exactSelector: input.plan.exactSelector,
        exactSelectorDigest: digest(input.plan.exactSelector),
        targetPathDigest: targetPathDigest(input.plan.target),
        expectedTargetState: "missing",
        createdAt: new Date().toISOString(),
      };
      validateIntentValue(intent, marker.libraryId, input.registry);
      const file = intentFile(input.context, input.plan.providerId, input.operationId);
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, `${JSON.stringify(intent, null, 2)}\n`, { flag: "wx" });
      await fs.chmod(file, 0o444).catch(() => undefined);
      return intent;
    },
  );
}

async function inspectTargetBinding(input: {
  target: string;
  providerId: string;
  operationId: string;
  planDigest: string;
  registry?: ProviderRegistry;
}) {
  try {
    const inventory = await inspectMaterializedTarget(input.target);
    const lockEntry = inventory.find((entry) => entry.file === "template.lock.json");
    if (!lockEntry) throw new Error("materialization lock is missing");
    const lockFile = path.join(input.target, "template.lock.json");
    const lock = JSON.parse(await fs.readFile(lockFile, "utf8")) as unknown;
    if (!isRecord(lock) || lock.providerId !== input.providerId) {
      throw new Error("materialization lock provider is invalid");
    }
    const registry = input.registry ?? createDefaultProviderRegistry();
    let exactSelector: ExactTemplateSelector;
    let plannedSelector: ExactTemplateSelector;
    let lockOperationId: unknown;
    let lockPlanDigest: unknown;
    if (
      input.providerId === LOCAL_LIBRARY_PROVIDER_ID &&
      lock.schema === "figure-library.template-lock.v1"
    ) {
      if (!isRecord(lock.selector)) throw new Error("Local Published selector is missing");
      exactSelector = {
        schema: "figure-library.provider-selector.v1",
        providerId: LOCAL_LIBRARY_PROVIDER_ID,
        kind: "local-published.v1",
        identity: {
          templateId: lock.selector.templateId,
          revisionId: lock.selector.revisionId,
          contentDigest: lock.selector.contentDigest,
          releaseId: lock.selector.releaseId,
        },
      };
      registry.get(input.providerId).assertSelector(exactSelector, "replay");
      plannedSelector = exactSelector;
      lockOperationId = lock.operationId;
      lockPlanDigest = lock.planDigest;
    } else if (
      input.providerId === FIGUREYA_PROVIDER_ID &&
      lock.schema === "figure-library.template-lock.v2"
    ) {
      if (!isRecord(lock.operation)) throw new Error("FigureYa operation binding is missing");
      exactSelector = lock.exactSelector as ExactTemplateSelector;
      plannedSelector = lock.plannedSelector as ExactTemplateSelector;
      registry.get(input.providerId).assertSelector(exactSelector, "replay");
      registry.get(input.providerId).assertSelector(plannedSelector, "replay");
      assertFigureYaExactSelector(exactSelector);
      if (
        exactSelector.identity.archive.algorithm !== "sha256" ||
        lock.archiveSha256 !== exactSelector.identity.archive.digest ||
        lock.archiveBytes !== exactSelector.identity.archive.bytes
      ) {
        throw new Error("FigureYa lock archive identity does not match its resolved selector");
      }
      lockOperationId = lock.operation.operationId;
      lockPlanDigest = lock.operation.planDigest;
    } else if (lock.schema === "figure-library.module-template-lock.v1") {
      const moduleLock = parseModuleTemplateLock(lock);
      if (!moduleLock.operation) throw new Error("personal module operation binding is missing");
      exactSelector = moduleLock.exactSelector;
      plannedSelector = moduleLock.plannedSelector;
      registry.get(input.providerId).assertSelector(exactSelector, "replay");
      registry.get(input.providerId).assertSelector(plannedSelector, "replay");
      if (exactSelector.providerId !== input.providerId || plannedSelector.providerId !== input.providerId) {
        throw new Error("personal module lock provider differs from its target binding");
      }
      lockOperationId = moduleLock.operation.operationId;
      lockPlanDigest = moduleLock.operation.planDigest;
    } else if (lock.schema === PUBLIC_TEMPLATE_LOCK_SCHEMA) {
      if (!isRecord(lock.operation)) throw new Error("public Provider operation binding is missing");
      exactSelector = lock.exactSelector as ExactTemplateSelector;
      plannedSelector = lock.plannedSelector as ExactTemplateSelector;
      registry.get(input.providerId).assertSelector(exactSelector, "replay");
      registry.get(input.providerId).assertSelector(plannedSelector, "replay");
      assertPublicTemplateSelector(exactSelector);
      assertPublicTemplateSelector(plannedSelector);
      if (
        exactSelector.providerId !== input.providerId ||
        plannedSelector.providerId !== input.providerId ||
        !isRecord(lock.archive) ||
        lock.archive.sha256 !== exactSelector.identity.archive.sha256 ||
        lock.archive.bytes !== exactSelector.identity.archive.bytes
      ) {
        throw new Error("public Provider lock archive identity does not match its exact selector");
      }
      lockOperationId = lock.operation.operationId;
      lockPlanDigest = lock.operation.planDigest;
    } else {
      throw new Error("materialization lock schema is incompatible with its provider");
    }
    if (lockOperationId !== input.operationId || lockPlanDigest !== input.planDigest) {
      throw new Error("materialization lock has a different operation or stale public plan");
    }
    const lockInventory = validateInventory(lock.files, "materialization lock", false);
    const payloadInventory = inventory.filter((entry) => entry.file !== "template.lock.json");
    if (canonicalJson(lockInventory) !== canonicalJson(payloadInventory)) {
      throw new Error("materialization lock inventory is not the complete target payload");
    }
    return { inventory, exactSelector, plannedSelector };
  } catch (error) {
    throw new Error(
      `target already exists but authoritative materialization verification failed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function validateCurrentSelection(input: {
  context: CurrentLibraryContext;
  index: CatalogIndex;
  registry: ProviderRegistry;
  providerId: string;
  plannedSelector: ExactTemplateSelector;
  exactSelector: ExactTemplateSelector;
  target: string;
  operationId: string;
  planDigest: string;
  inventory: MaterializedFileInventoryEntry[];
  moduleCatalogs?: ReadonlyMap<string, ModuleCatalogIndex>;
}) {
  const providerContext = createProviderContext(input.context, input.index, {
    ...(input.moduleCatalogs ? { moduleCatalogs: input.moduleCatalogs } : {}),
  });
  await input.registry.get(input.providerId).verifyMaterialized(providerContext, {
    plannedSelector: input.plannedSelector,
    exactSelector: input.exactSelector,
    target: input.target,
    operationId: input.operationId,
    planDigest: input.planDigest,
    inventory: input.inventory,
  });
}

async function verifyReceiptAndTarget(input: {
  context: CurrentLibraryContext;
  index: CatalogIndex;
  registry: ProviderRegistry;
  receipt: PublicMaterializationReceiptV1;
  target: string;
  expectedProviderId: string;
  operationId: string;
  planDigest: string;
  moduleCatalogs?: ReadonlyMap<string, ModuleCatalogIndex>;
}) {
  const { receipt } = input;
  if (
    receipt.providerId !== input.expectedProviderId ||
    receipt.operationId !== input.operationId ||
    receipt.planDigest !== input.planDigest
  ) {
    throw new Error("target already exists with a receipt for a different operation or stale public plan");
  }
  const observedPathDigest = targetPathDigest(input.target);
  if (observedPathDigest !== receipt.targetPathDigest) {
    throw new Error("target already exists at a path that does not match its authoritative receipt");
  }
  const binding = await inspectTargetBinding({
    target: input.target,
    providerId: input.expectedProviderId,
    operationId: input.operationId,
    planDigest: input.planDigest,
    registry: input.registry,
  });
  if (
    canonicalJson(binding.plannedSelector) !== canonicalJson(receipt.plannedSelector) ||
    canonicalJson(binding.exactSelector) !== canonicalJson(receipt.exactSelector) ||
    canonicalJson(binding.inventory) !== canonicalJson(receipt.fileInventory)
  ) {
    throw new Error("target already exists but its lock, selector, or files disagree with the authoritative receipt");
  }
  await validateCurrentSelection({
    context: input.context,
    index: input.index,
    registry: input.registry,
    providerId: receipt.providerId,
    plannedSelector: receipt.plannedSelector,
    exactSelector: receipt.exactSelector,
    target: input.target,
    operationId: input.operationId,
    planDigest: input.planDigest,
    inventory: binding.inventory,
    moduleCatalogs: input.moduleCatalogs,
  });
  return {
    operationId: input.operationId,
    planDigest: input.planDigest,
    providerId: receipt.providerId,
    exactSelector: receipt.exactSelector,
    target: input.target,
    files: receipt.fileInventory.map((entry) => entry.file),
    materializationSource: "authoritative-receipt-replay",
    ...(receipt.archiveSha256 ? { archiveSha256: receipt.archiveSha256 } : {}),
    replayed: true,
  } satisfies MaterializationResult;
}

async function durableReplay(input: {
  context: CurrentLibraryContext;
  index: CatalogIndex;
  registry: ProviderRegistry;
  target: string;
  expectedProviderId: string;
  operationId: string;
  planDigest: string;
  cachedPlan?: MaterializationPlan;
  moduleCatalogs?: ReadonlyMap<string, ModuleCatalogIndex>;
}): Promise<MaterializationResult | undefined> {
  const marker = await requireLibraryAuthority(input.context);
  const actualLibraryContext = currentOperationContext(input.context, marker.libraryId);
  const [receipt, intent] = await Promise.all([
    readAuthoritativeReceipt(
      input.context,
      input.expectedProviderId,
      input.operationId,
      marker.libraryId,
      input.registry,
    ),
    readAuthoritativeIntent(
      input.context,
      input.expectedProviderId,
      input.operationId,
      marker.libraryId,
      input.registry,
    ),
  ]);
  if (intent) {
    assertIntentBinding({
      intent,
      providerId: input.expectedProviderId,
      operationId: input.operationId,
      planDigest: input.planDigest,
      target: input.target,
      ...(input.cachedPlan
        ? {
            exactSelector: input.cachedPlan.exactSelector,
            libraryContext: input.cachedPlan.libraryContext,
          }
        : {}),
    });
  }
  if (receipt) {
    if (intent) assertIntentReceiptBinding(intent, receipt);
    return verifyReceiptAndTarget({ ...input, receipt });
  }
  // A portable target lock alone is not server authority. Only an immutable
  // pre-write Library intent may authorize crash roll-forward.
  if (!intent) return undefined;
  assertLibraryOperationContext(actualLibraryContext, intent.libraryContext);
  if (await targetMissing(input.target)) return undefined;

  return withCrossRuntimeWriteLock(
    {
      root: input.context.snapshot.root,
      lockDirectory: path.join(input.context.snapshot.root, "locks", "write"),
      libraryId: marker.libraryId,
      operation: `public-materialization-recover:${input.expectedProviderId}:${input.operationId}`,
    },
    async () => {
      const prior = await readAuthoritativeReceipt(
        input.context,
        input.expectedProviderId,
        input.operationId,
        marker.libraryId,
        input.registry,
      );
      const currentIntent = await readAuthoritativeIntent(
        input.context,
        input.expectedProviderId,
        input.operationId,
        marker.libraryId,
        input.registry,
      );
      if (!currentIntent) {
        throw new Error("authoritative materialization intent disappeared during recovery");
      }
      assertIntentBinding({
        intent: currentIntent,
        providerId: input.expectedProviderId,
        operationId: input.operationId,
      planDigest: input.planDigest,
        target: input.target,
        ...(input.cachedPlan ? { exactSelector: input.cachedPlan.exactSelector } : {}),
        libraryContext: actualLibraryContext,
      });
      if (prior) {
        assertIntentReceiptBinding(currentIntent, prior);
        return verifyReceiptAndTarget({ ...input, receipt: prior });
      }
      const binding = await inspectTargetBinding({
        target: input.target,
        providerId: input.expectedProviderId,
        operationId: input.operationId,
        planDigest: input.planDigest,
        registry: input.registry,
      });
      if (canonicalJson(binding.plannedSelector) !== canonicalJson(currentIntent.exactSelector)) {
        throw new Error(
          "target already exists but its selector disagrees with the authoritative materialization intent",
        );
      }
      await validateCurrentSelection({
        context: input.context,
        index: input.index,
        providerId: input.expectedProviderId,
        plannedSelector: binding.plannedSelector,
        exactSelector: binding.exactSelector,
        target: input.target,
        operationId: input.operationId,
        planDigest: input.planDigest,
        registry: input.registry,
        inventory: binding.inventory,
        moduleCatalogs: input.moduleCatalogs,
      });
      let archiveSha256: string | undefined;
      if (input.expectedProviderId === FIGUREYA_PROVIDER_ID) {
        assertFigureYaExactSelector(binding.exactSelector);
        if (binding.exactSelector.identity.archive.algorithm === "sha256") {
          archiveSha256 = binding.exactSelector.identity.archive.digest;
        }
      } else if (binding.exactSelector.kind === "module-archive.v1") {
        assertModuleArchiveExactSelector(binding.exactSelector);
        archiveSha256 = binding.exactSelector.identity.archive.digest;
      } else if (input.expectedProviderId !== LOCAL_LIBRARY_PROVIDER_ID) {
        assertPublicTemplateSelector(binding.exactSelector);
        archiveSha256 = binding.exactSelector.identity.archive.sha256;
      }
      const recoveredReceipt = await writeAuthoritativeReceipt({
        context: input.context,
        libraryId: marker.libraryId,
        intent: currentIntent,
        exactSelector: binding.exactSelector,
        inventory: binding.inventory,
        materializationSource:
          input.expectedProviderId === LOCAL_LIBRARY_PROVIDER_ID
            ? "versioned-library"
            : "intent-recovery",
        ...(archiveSha256 ? { archiveSha256 } : {}),
        registry: input.registry,
      });
      return {
        operationId: input.operationId,
        planDigest: input.planDigest,
        providerId: recoveredReceipt.providerId,
        exactSelector: recoveredReceipt.exactSelector,
        target: input.target,
        files: recoveredReceipt.fileInventory.map((entry) => entry.file),
        materializationSource: "authoritative-intent-recovery",
        ...(recoveredReceipt.archiveSha256
          ? { archiveSha256: recoveredReceipt.archiveSha256 }
          : {}),
        replayed: true,
        recovered: true,
      } satisfies MaterializationResult;
    },
  );
}

async function writeAuthoritativeReceipt(input: {
  context: CurrentLibraryContext;
  libraryId: string;
  intent: PublicMaterializationIntentV1;
  exactSelector: ExactTemplateSelector;
  inventory: MaterializedFileInventoryEntry[];
  materializationSource: string;
  archiveSha256?: string;
  registry: ProviderRegistry;
}) {
  const receipt: PublicMaterializationReceiptV1 = {
    schema: PUBLIC_MATERIALIZATION_RECEIPT_SCHEMA,
    receiptId: `public-materialization-receipt-${randomUUID()}`,
    libraryId: input.libraryId,
    operationId: input.intent.operationId,
    planDigest: input.intent.planDigest,
    providerId: input.intent.providerId,
    plannedSelector: input.intent.exactSelector,
    plannedSelectorDigest: input.intent.exactSelectorDigest,
    exactSelector: input.exactSelector,
    exactSelectorDigest: digest(input.exactSelector),
    targetPathDigest: input.intent.targetPathDigest,
    fileInventory: input.inventory,
    fileInventoryDigest: digest(input.inventory),
    materializationSource: input.materializationSource,
    ...(input.archiveSha256 ? { archiveSha256: input.archiveSha256 } : {}),
    appliedAt: new Date().toISOString(),
  };
  validateReceiptValue(receipt, input.libraryId, input.registry);
  assertIntentReceiptBinding(input.intent, receipt);
  const file = receiptFile(
    input.context,
    input.intent.providerId,
    input.intent.operationId,
  );
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx" });
  await fs.chmod(file, 0o444).catch(() => undefined);
  return receipt;
}

async function persistAuthoritativeReceipt(input: {
  context: CurrentLibraryContext;
  index: CatalogIndex;
  plan: MaterializationPlan;
  result: MaterializationResult;
  operationId: string;
  registry: ProviderRegistry;
  moduleCatalogs?: ReadonlyMap<string, ModuleCatalogIndex>;
}) {
  const marker = await requireLibraryAuthority(input.context);
  return withCrossRuntimeWriteLock(
    {
      root: input.context.snapshot.root,
      lockDirectory: path.join(input.context.snapshot.root, "locks", "write"),
      libraryId: marker.libraryId,
      operation: `public-materialization-receipt:${input.plan.providerId}:${input.operationId}`,
    },
    async () => {
      const intent = await readAuthoritativeIntent(
        input.context,
        input.plan.providerId,
        input.operationId,
        marker.libraryId,
        input.registry,
      );
      if (!intent) {
        throw new Error("authoritative materialization intent is missing before receipt finalization");
      }
      assertIntentBinding({
        intent,
        providerId: input.plan.providerId,
        operationId: input.operationId,
        planDigest: input.plan.planDigest,
        target: input.plan.target,
        exactSelector: input.plan.exactSelector,
        libraryContext: input.plan.libraryContext,
      });
      const prior = await readAuthoritativeReceipt(
        input.context,
        input.plan.providerId,
        input.operationId,
        marker.libraryId,
        input.registry,
      );
      if (prior) {
        assertIntentReceiptBinding(intent, prior);
        await verifyReceiptAndTarget({
          context: input.context,
          index: input.index,
          receipt: prior,
          target: input.plan.target,
          expectedProviderId: input.plan.providerId,
          operationId: input.operationId,
          planDigest: input.plan.planDigest,
          registry: input.registry,
          moduleCatalogs: input.moduleCatalogs,
        });
        return prior;
      }
      if (!sameNativePath(input.plan.target, input.result.target)) {
        throw new Error("materialization result target does not match the public plan");
      }
      const binding = await inspectTargetBinding({
        target: input.plan.target,
        providerId: input.plan.providerId,
        operationId: input.operationId,
        planDigest: input.plan.planDigest,
        registry: input.registry,
      });
      if (
        canonicalJson(binding.plannedSelector) !== canonicalJson(input.plan.exactSelector) ||
        canonicalJson(binding.exactSelector) !== canonicalJson(input.result.exactSelector)
      ) {
        throw new Error("target already exists but its selector does not match the applied public plan");
      }
      await validateCurrentSelection({
        context: input.context,
        index: input.index,
        registry: input.registry,
        providerId: input.plan.providerId,
        plannedSelector: binding.plannedSelector,
        exactSelector: binding.exactSelector,
        target: input.plan.target,
        operationId: input.operationId,
        planDigest: input.plan.planDigest,
        inventory: binding.inventory,
        moduleCatalogs: input.moduleCatalogs,
      });
      return writeAuthoritativeReceipt({
        context: input.context,
        libraryId: marker.libraryId,
        intent,
        exactSelector: binding.exactSelector,
        inventory: binding.inventory,
        materializationSource: input.result.materializationSource,
        ...(input.result.archiveSha256 ? { archiveSha256: input.result.archiveSha256 } : {}),
        registry: input.registry,
      });
    },
  );
}

const ExactSelectorSchema = z
  .record(z.string(), z.unknown())
  .describe("Provider-qualified exact selector returned by figure_library_search.");
const PlanInput = z.object({
  providerId: z.string().min(1).max(200),
  exactSelector: ExactSelectorSchema,
  previewReceipt: z.string().min(1).max(256).optional().describe(
    "Required one-time receipt returned by figure_library_confirm_selection or figure_library_confirm_selection_headless.",
  ),
  destination: z.string().min(1).max(4_000),
  sourcePackDir: z.string().min(1).max(4_000).optional(),
  allowNetwork: z.boolean().optional().default(true),
});
const ApplyInput = z.object({
  planDigest: z.string().regex(HASH),
  operationId: z.string().regex(OPERATION_ID),
  expectedProviderId: z.string().min(1).max(200),
  expectedTarget: z.string().min(1).max(4_000),
});

export function registerMaterializationTools(options: {
  server: McpServer;
  index: CatalogIndex;
  registry?: ProviderRegistry;
  currentLibraries: () => Promise<CurrentLibraryContext>;
  previewConfirmations: PreviewConfirmationStore;
  diagnostics?: DiagnosticsManager;
  moduleCatalogs?: ReadonlyMap<string, ModuleCatalogIndex>;
  faultInjector?: (
    point: MaterializationFaultPoint,
    operation: { operationId: string; planDigest: string; providerId: string },
  ) => Promise<void> | void;
}) {
  const {
    server,
    index,
    currentLibraries,
    previewConfirmations,
    diagnostics,
    faultInjector,
    moduleCatalogs,
  } = options;
  const registry = options.registry ?? createDefaultProviderRegistry();
  const plans = new Map<string, CachedPlan>();

  function prune() {
    const now = Date.now();
    for (const [key, value] of plans) if (value.expiresAt <= now) plans.delete(key);
    while (plans.size > PLAN_LIMIT) {
      const first = plans.keys().next().value as string | undefined;
      if (!first) break;
      plans.delete(first);
    }
  }

  server.registerTool(
    "figure_library_plan_materialize",
    {
      title: "Plan exact template materialization",
      description:
        "Require a one-time confirmed exact preview receipt, then resolve the provider-qualified selector and check the destination without writing files.",
      inputSchema: PlanInput.shape,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (input): Promise<CallToolResult> => {
      const correlationId = diagnostics?.createCorrelationId("materialize-plan");
      const operationStartedAt = performance.now();
      await diagnostics?.record({
        event: "materialize.plan_requested",
        correlationId,
        toolName: "figure_library_plan_materialize",
        invocationSource: "agent",
        providerId: input.providerId,
      });
      try {
        if (!input.previewReceipt) {
          return reply(
            envelope(
              "blocked",
              "preview_required",
              "A confirmed exact preview receipt is required before materialization can be planned.",
              "preview_selected_candidate",
            ),
          );
        }
        if (!path.isAbsolute(input.destination)) {
          return reply(
            envelope(
              "needs_user_input",
              "absolute_destination_required",
              "Materialization requires an absolute user/project destination.",
              "ask_user",
            ),
          );
        }
        if (input.sourcePackDir && !path.isAbsolute(input.sourcePackDir)) {
          return reply(
            envelope(
              "needs_user_input",
              "absolute_source_pack_required",
              "sourcePackDir must be an absolute trusted host path.",
              "ask_user",
            ),
          );
        }
        const exactSelector = input.exactSelector as unknown as ExactTemplateSelector;
        assertExactTemplateSelector(exactSelector);
        const context = await currentLibraries();
        const providerContext = createProviderContext(context, index, {
          ...(moduleCatalogs ? { moduleCatalogs } : {}),
        });
        const adapter = registry.get(input.providerId);
        const resolved = await adapter.resolve(providerContext, exactSelector, "materialize");
        const templateId = resolved.templateId;
        const marker = await requireLibraryAuthority(context);
        const libraryContext: LibraryOperationContext = {
          libraryId: marker.libraryId,
          configRevision: context.snapshot.configRevision,
        };
        const pendingReceipt = previewConfirmations.getReceipt(input.previewReceipt);
        const resultSet = previewConfirmations.getResultSet(pendingReceipt.resultSetId);
        const catalogRevision = await registry.catalogRevision(
          resultSet.providerIds,
          providerContext,
        );
        const currentPreview = await loadProviderPreview({
          context,
          index,
          providerId: input.providerId,
          exactSelector,
          registry,
          moduleCatalogs,
        });
        const confirmedPreview = previewConfirmations.requireReceipt({
          previewReceipt: input.previewReceipt,
          providerId: input.providerId,
          exactSelector,
          previewSha256: currentPreview.sha256,
          catalogRevision,
          libraryBindingDigest: libraryBindingDigest(context),
        });
        const destination = path.resolve(input.destination);
        const target = path.join(destination, templateId);
        if (!(await targetMissing(target))) throw new Error(`target already exists: ${target}`);
        const withoutDigest = {
          schema: "figure-library.materialization-plan.v2" as const,
          providerId: input.providerId,
          exactSelector,
          libraryContext,
          destination,
          target,
          ...(input.sourcePackDir ? { sourcePackDir: path.resolve(input.sourcePackDir) } : {}),
          allowNetwork: input.allowNetwork,
          previewConfirmation: {
            protocolVersion: 2 as const,
            confirmationMode: confirmedPreview.confirmationMode,
            resultSetId: confirmedPreview.resultSetId,
            previewSha256: confirmedPreview.previewSha256,
            receiptDigest: digest(input.previewReceipt),
          },
          expectedTargetState: "missing" as const,
          createdAt: new Date().toISOString(),
          written: false as const,
        };
        const plan: MaterializationPlan = {
          ...withoutDigest,
          planDigest: digest(withoutDigest),
        };
        prune();
        previewConfirmations.consumeReceipt(input.previewReceipt);
        plans.set(plan.planDigest, { plan, expiresAt: Date.now() + PLAN_TTL_MS });
        await diagnostics?.record({
          event: "materialize.plan_created",
          correlationId,
          resultSetId: confirmedPreview.resultSetId,
          toolName: "figure_library_plan_materialize",
          invocationSource: "agent",
          providerId: input.providerId,
          selectorDigest: digest(exactSelector),
          durationMs: performance.now() - operationStartedAt,
          catalogRevision,
          libraryRevision: libraryBindingDigest(context),
        });
        return reply(
          envelope(
            "needs_user_confirmation",
            "materialization_plan_ready",
            `No files were written. Review exact provider, selector, destination, and acquisition policy for ${templateId}.`,
            "apply_confirmed_plan",
          ),
          { plan },
          [
            `PLAN_DIGEST: ${plan.planDigest}`,
            `PROVIDER_ID: ${plan.providerId}`,
            `LIBRARY_ID: ${plan.libraryContext.libraryId}`,
            `CONFIG_REVISION: ${plan.libraryContext.configRevision ?? "none"}`,
            `EXACT_SELECTOR: ${JSON.stringify(plan.exactSelector)}`,
            `TARGET: ${plan.target}`,
            `ALLOW_NETWORK: ${plan.allowNetwork}`,
            `SOURCE_PACK_DIR: ${plan.sourcePackDir ?? "none"}`,
            `PREVIEW_CONFIRMATION_MODE: ${plan.previewConfirmation.confirmationMode}`,
            `PREVIEW_SHA256: ${plan.previewConfirmation.previewSha256}`,
          ],
        );
      } catch (error) {
        await diagnostics?.record({
          level: "error",
          event: "tool.failed",
          correlationId,
          toolName: "figure_library_plan_materialize",
          invocationSource: "agent",
          providerId: input.providerId,
          durationMs: performance.now() - operationStartedAt,
          errorCode: error instanceof PreviewProtocolError ? error.code : "materialization_plan_failed",
          safeMessage: error instanceof Error ? error.message : String(error),
        });
        return failure(error);
      }
    },
  );

  server.registerTool(
    "figure_library_apply_materialize",
    {
      title: "Apply confirmed exact materialization",
      description:
        "Apply the cached exact plan once. All failures are terminal and must not be retried with another mode, provider, downloader, or substitute template.",
      inputSchema: ApplyInput.shape,
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async (input): Promise<CallToolResult> => {
      try {
        registry.get(input.expectedProviderId);
        const expectedTarget = path.resolve(input.expectedTarget);
        const context = await currentLibraries();
        const marker = await requireLibraryAuthority(context);
        const actualLibraryContext: LibraryOperationContext = {
          libraryId: marker.libraryId,
          configRevision: context.snapshot.configRevision,
        };
        prune();
        const cached = plans.get(input.planDigest);
        if (cached) {
          assertLibraryOperationContext(
            actualLibraryContext,
            cached.plan.libraryContext,
          );
        }
        const replay = await durableReplay({
          context,
          index,
          target: expectedTarget,
          expectedProviderId: input.expectedProviderId,
          operationId: input.operationId,
          planDigest: input.planDigest,
          registry,
          moduleCatalogs,
          ...(cached ? { cachedPlan: cached.plan } : {}),
        });
        if (replay) {
          return reply(
            envelope(
              "replayed",
              replay.recovered ? "materialization_recovered" : "materialization_replayed",
              replay.recovered
                ? `Recovered and finalized the exact output at ${expectedTarget} from its authoritative pre-write intent.`
                : `Verified existing exact output at ${expectedTarget}.`,
              "none",
            ),
            { planDigest: input.planDigest, result: replay },
          );
        }
        if (!cached) {
          return reply(
            envelope(
              "blocked",
              "materialization_plan_not_available",
              "The read-only plan expired or belongs to another server process. Create and review a new plan; do not repeat this Apply call.",
              "create_new_plan",
            ),
          );
        }
        const { plan } = cached;
        if (plan.providerId !== input.expectedProviderId) {
          throw new Error("expectedProviderId does not match the cached plan");
        }
        if (!sameNativePath(expectedTarget, plan.target)) {
          throw new Error("expectedTarget does not match the cached plan");
        }
        if (!(await targetMissing(plan.target))) throw new Error(`target already exists: ${plan.target}`);
        await ensureAuthoritativeIntent({
          context,
          plan,
          operationId: input.operationId,
          registry,
        });
        await faultInjector?.("after_public_intent", {
          operationId: input.operationId,
          planDigest: plan.planDigest,
          providerId: plan.providerId,
        });
        if (!(await targetMissing(plan.target))) {
          throw new Error(`target already exists after intent creation: ${plan.target}`);
        }
        const providerContext = createProviderContext(context, index, {
          ...(moduleCatalogs ? { moduleCatalogs } : {}),
          materialization: {
            operationId: input.operationId,
            planDigest: plan.planDigest,
            ...(plan.sourcePackDir ? { sourcePackDir: plan.sourcePackDir } : {}),
          },
        });
        const adapter = registry.get(plan.providerId);
        const resolved = await adapter.resolve(
          providerContext,
          plan.exactSelector,
          "materialize",
        );
        const applied = await adapter.stageMaterialization(
          providerContext,
          resolved,
          plan.destination,
          plan.allowNetwork,
        );
        let result: MaterializationResult = {
          operationId: input.operationId,
          planDigest: plan.planDigest,
          providerId: plan.providerId,
          exactSelector: applied.exactSelector,
          target: applied.target,
          files: applied.files,
          materializationSource: applied.materializationSource,
          ...(applied.archiveSha256 ? { archiveSha256: applied.archiveSha256 } : {}),
          replayed: false,
        };
        await faultInjector?.("before_public_receipt", {
          operationId: input.operationId,
          planDigest: plan.planDigest,
          providerId: plan.providerId,
        });
        const receipt = await persistAuthoritativeReceipt({
          context,
          index,
          plan,
          result,
          operationId: input.operationId,
          registry,
          moduleCatalogs,
        });
        result = {
          ...result,
          exactSelector: receipt.exactSelector,
          files: receipt.fileInventory.map((entry) => entry.file),
        };
        plans.delete(plan.planDigest);
        return reply(
          envelope(
            "applied",
            "materialization_applied",
            `Materialized exact ${plan.providerId} selection at ${result.target}. No code was executed.`,
            "none",
          ),
          { planDigest: plan.planDigest, result },
        );
      } catch (error) {
        return failure(error);
      }
    },
  );
}
