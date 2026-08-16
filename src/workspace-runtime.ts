import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "./canonical-json.ts";
import { defaultLibraryLocatorPath } from "./library-runtime.ts";

export const WORKSPACE_LOCATOR_SCHEMA = "figure-library.workspace-locator.v1" as const;
export const WORKSPACE_BINDING_PLAN_SCHEMA = "figure-library.workspace-binding-plan.v1" as const;
export const WORKSPACE_BINDING_RECEIPT_SCHEMA =
  "figure-library.workspace-binding-receipt.v1" as const;
export const WORKSPACE_LAYOUT_SCHEMA = "workspace.layout.v1" as const;

const HASH = /^[a-f0-9]{64}$/u;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

export type WorkspaceKind = "missing" | "empty" | "plot-gallery" | "workspace-v1" | "foreign";

export interface WorkspaceLocatorV1 {
  schema: typeof WORKSPACE_LOCATOR_SCHEMA;
  configRevision: number;
  workspaceDirectory: string;
  updatedAt: string;
}

export interface WorkspaceInspection {
  directory: string;
  exists: boolean;
  writable: boolean;
  empty: boolean;
  kind: WorkspaceKind;
}

export interface WorkspaceRuntimeSnapshot {
  locatorPath: string;
  directory?: string;
  directorySource: "FIGURE_WORKSPACE_DIR" | "locator" | "unbound";
  configRevision: number | null;
  confirmed: boolean;
  inspection?: WorkspaceInspection;
}

export interface WorkspaceBindingPlanV1 {
  schema: typeof WORKSPACE_BINDING_PLAN_SCHEMA;
  bindingId: string;
  locatorPath: string;
  workspaceDirectory: string;
  configRevision: number;
  expectedLocatorDigest: string | null;
  expectedConfigRevision: number | null;
  workspaceKind: WorkspaceKind;
  willCreateSkeleton: boolean;
  createdAt: string;
  planDigest: string;
}

export interface WorkspaceBindingReceiptV1 {
  schema: typeof WORKSPACE_BINDING_RECEIPT_SCHEMA;
  receiptId: string;
  operationId: string;
  bindingId: string;
  planDigest: string;
  locatorPath: string;
  workspaceDirectory: string;
  configRevision: number;
  createdSkeleton: boolean;
  appliedAt: string;
  idempotentReplay?: boolean;
}

function nowIso() {
  return new Date().toISOString();
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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

export function defaultWorkspaceLocatorPath(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: string;
} = {}) {
  return path.join(
    path.dirname(
      defaultLibraryLocatorPath({
        platform: options.platform,
        env: options.env,
        homedir: options.homedir,
      }),
    ),
    "workspace-locator.json",
  );
}

function validateWorkspaceLocator(value: unknown): WorkspaceLocatorV1 {
  if (!isRecord(value) || value.schema !== WORKSPACE_LOCATOR_SCHEMA) {
    throw new Error("invalid Local workspace locator schema");
  }
  if (!Number.isSafeInteger(value.configRevision) || (value.configRevision as number) < 1) {
    throw new Error("invalid Local workspace locator configRevision");
  }
  if (typeof value.workspaceDirectory !== "string" || !path.isAbsolute(value.workspaceDirectory)) {
    throw new Error("Local workspace locator requires an absolute workspaceDirectory");
  }
  if (typeof value.updatedAt !== "string" || Number.isNaN(Date.parse(value.updatedAt))) {
    throw new Error("invalid Local workspace locator timestamp");
  }
  return value as unknown as WorkspaceLocatorV1;
}

async function readWorkspaceLocator(locatorPath: string) {
  try {
    const value = validateWorkspaceLocator(await readJson(locatorPath));
    return { value, digest: sha256(canonicalJson(value)) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

async function isWritableDirectory(directory: string) {
  try {
    await fs.access(directory, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export async function inspectWorkspaceDirectory(directory: string): Promise<WorkspaceInspection> {
  const resolved = path.resolve(directory);
  try {
    const stat = await fs.lstat(resolved);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error("Local workspace target must be a regular directory, not a symbolic link");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        directory: resolved,
        exists: false,
        writable: false,
        empty: true,
        kind: "missing",
      };
    }
    throw error;
  }
  const entries = await fs.readdir(resolved);
  const names = new Set(entries.filter((name) => name !== ".git" && name !== ".DS_Store"));
  const empty = names.size === 0;
  const has = async (relative: string) => {
    try {
      const stat = await fs.stat(path.join(resolved, relative));
      return stat.isFile() || stat.isDirectory();
    } catch {
      return false;
    }
  };
  let kind: WorkspaceKind = empty ? "empty" : "foreign";
  if (await has("workspace.yml")) {
    try {
      const raw = await fs.readFile(path.join(resolved, "workspace.yml"), "utf8");
      if (raw.includes(WORKSPACE_LAYOUT_SCHEMA)) kind = "workspace-v1";
    } catch {
      kind = "foreign";
    }
  } else if ((await has("config/gallery.yml")) || ((await has("drafts")) && (await has("gallery")))) {
    kind = "plot-gallery";
  } else if (empty) {
    kind = "empty";
  }
  return {
    directory: resolved,
    exists: true,
    writable: await isWritableDirectory(resolved),
    empty,
    kind,
  };
}

export async function ensureWorkspaceSkeleton(directory: string) {
  const resolved = path.resolve(directory);
  await fs.mkdir(resolved, { recursive: true });
  const inspection = await inspectWorkspaceDirectory(resolved);
  if (inspection.kind === "plot-gallery" || inspection.kind === "workspace-v1") {
    return { createdSkeleton: false, inspection };
  }
  if (inspection.kind === "foreign") {
    throw new Error(
      "Local workspace target is non-empty and is not a recognized inbox/drafts/gallery knowledge base",
    );
  }
  for (const relative of ["inbox", "drafts", "gallery", "registry", "R", "scripts", "tests"]) {
    await fs.mkdir(path.join(resolved, relative), { recursive: true });
    await fs.writeFile(path.join(resolved, relative, ".gitkeep"), "", { flag: "wx" }).catch(() => undefined);
  }
  const marker = [
    `schema: ${WORKSPACE_LAYOUT_SCHEMA}`,
    "role: local_draft_knowledge_base",
    "paths:",
    "  inbox: inbox",
    "  drafts: drafts",
    "  gallery: gallery",
    "  registry: registry",
    "",
  ].join("\n");
  await fs.writeFile(path.join(resolved, "workspace.yml"), marker, { flag: "wx" }).catch(() => undefined);
  return { createdSkeleton: true, inspection: await inspectWorkspaceDirectory(resolved) };
}

export class WorkspaceRuntime {
  private readonly locatorPath: string;
  private readonly options: {
    locatorPath?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    homedir?: string;
  };
  private lastSnapshot?: WorkspaceRuntimeSnapshot;

  constructor(options: {
    locatorPath?: string;
    env?: NodeJS.ProcessEnv;
    platform?: NodeJS.Platform;
    homedir?: string;
  } = {}) {
    this.options = options;
    const env = options.env ?? process.env;
    this.locatorPath =
      options.locatorPath ??
      env.SFL_WORKSPACE_LOCATOR_PATH?.trim() ??
      defaultWorkspaceLocatorPath({
        platform: options.platform,
        env,
        homedir: options.homedir,
      });
  }

  async current(): Promise<WorkspaceRuntimeSnapshot> {
    const env = this.options.env ?? process.env;
    const override = env.FIGURE_WORKSPACE_DIR?.trim();
    if (override) {
      const directory = path.resolve(override);
      const inspection = await inspectWorkspaceDirectory(directory).catch(() => undefined);
      this.lastSnapshot = {
        locatorPath: this.locatorPath,
        directory,
        directorySource: "FIGURE_WORKSPACE_DIR",
        configRevision: null,
        confirmed: Boolean(inspection?.exists),
        inspection,
      };
      return this.lastSnapshot;
    }
    const located = await readWorkspaceLocator(this.locatorPath);
    if (!located) {
      this.lastSnapshot = {
        locatorPath: this.locatorPath,
        directorySource: "unbound",
        configRevision: null,
        confirmed: false,
      };
      return this.lastSnapshot;
    }
    const inspection = await inspectWorkspaceDirectory(located.value.workspaceDirectory);
    const usable = inspection.kind === "plot-gallery" || inspection.kind === "workspace-v1";
    this.lastSnapshot = {
      locatorPath: this.locatorPath,
      directory: located.value.workspaceDirectory,
      directorySource: "locator",
      configRevision: located.value.configRevision,
      confirmed: usable,
      inspection,
    };
    return this.lastSnapshot;
  }

  async refresh() {
    return this.current();
  }

  cached() {
    return this.lastSnapshot;
  }
}

export async function planGlobalWorkspaceBinding(options: {
  workspaceDirectory: string;
  locatorPath?: string;
}): Promise<WorkspaceBindingPlanV1> {
  const locatorPath = path.resolve(options.locatorPath ?? defaultWorkspaceLocatorPath());
  const workspaceDirectory = path.resolve(options.workspaceDirectory);
  const current = await readWorkspaceLocator(locatorPath);
  const inspection = await inspectWorkspaceDirectory(workspaceDirectory);
  if (inspection.kind === "foreign") {
    throw new Error(
      "Local workspace target is non-empty and is not a recognized inbox/drafts/gallery knowledge base",
    );
  }
  const withoutDigest: Omit<WorkspaceBindingPlanV1, "planDigest"> = {
    schema: WORKSPACE_BINDING_PLAN_SCHEMA,
    bindingId: `workspace-binding-${randomUUID()}`,
    locatorPath,
    workspaceDirectory,
    configRevision: (current?.value.configRevision ?? 0) + 1,
    expectedLocatorDigest: current?.digest ?? null,
    expectedConfigRevision: current?.value.configRevision ?? null,
    workspaceKind: inspection.kind,
    willCreateSkeleton: inspection.kind === "missing" || inspection.kind === "empty",
    createdAt: nowIso(),
  };
  return {
    ...withoutDigest,
    planDigest: sha256(canonicalJson(withoutDigest)),
  };
}

function validateWorkspaceBindingPlan(plan: WorkspaceBindingPlanV1) {
  if (!isRecord(plan) || plan.schema !== WORKSPACE_BINDING_PLAN_SCHEMA) {
    throw new Error("invalid Local workspace binding plan schema");
  }
  const { planDigest, ...withoutDigest } = plan;
  if (
    !path.isAbsolute(plan.locatorPath) ||
    !path.isAbsolute(plan.workspaceDirectory) ||
    !HASH.test(planDigest) ||
    sha256(canonicalJson(withoutDigest)) !== planDigest
  ) {
    throw new Error("invalid Local workspace binding plan");
  }
}

export async function applyGlobalWorkspaceBinding(
  plan: WorkspaceBindingPlanV1,
  operationId: string,
): Promise<WorkspaceBindingReceiptV1> {
  validateWorkspaceBindingPlan(plan);
  if (!OPERATION_ID.test(operationId)) throw new Error("invalid workspace binding operationId");
  const receiptsDirectory = path.join(path.dirname(plan.locatorPath), "workspace-binding-receipts");
  const receiptFile = path.join(receiptsDirectory, `${operationId}.json`);
  try {
    const existing = await readJson(receiptFile);
    if (!isRecord(existing) || existing.schema !== WORKSPACE_BINDING_RECEIPT_SCHEMA) {
      throw new Error(`invalid Local workspace binding receipt: ${operationId}`);
    }
    if (existing.planDigest !== plan.planDigest || existing.bindingId !== plan.bindingId) {
      throw new Error(`operationId was used for a different workspace binding: ${operationId}`);
    }
    return { ...(existing as unknown as WorkspaceBindingReceiptV1), idempotentReplay: true };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }

  const current = await readWorkspaceLocator(plan.locatorPath);
  if ((current?.digest ?? null) !== plan.expectedLocatorDigest) {
    throw new Error("stale Local workspace binding plan: locator changed after planning");
  }
  const prepared = await ensureWorkspaceSkeleton(plan.workspaceDirectory);
  if (prepared.inspection.kind !== "plot-gallery" && prepared.inspection.kind !== "workspace-v1") {
    throw new Error("Local workspace skeleton is not usable after apply");
  }
  const locator: WorkspaceLocatorV1 = {
    schema: WORKSPACE_LOCATOR_SCHEMA,
    configRevision: plan.configRevision,
    workspaceDirectory: plan.workspaceDirectory,
    updatedAt: nowIso(),
  };
  await atomicWriteJson(plan.locatorPath, locator);
  const receipt: WorkspaceBindingReceiptV1 = {
    schema: WORKSPACE_BINDING_RECEIPT_SCHEMA,
    receiptId: `workspace-binding-receipt-${randomUUID()}`,
    operationId,
    bindingId: plan.bindingId,
    planDigest: plan.planDigest,
    locatorPath: plan.locatorPath,
    workspaceDirectory: plan.workspaceDirectory,
    configRevision: plan.configRevision,
    createdSkeleton: prepared.createdSkeleton,
    appliedAt: nowIso(),
  };
  await atomicWriteJson(receiptFile, receipt);
  return receipt;
}
