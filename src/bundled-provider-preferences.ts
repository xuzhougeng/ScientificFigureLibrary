import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { canonicalJson } from "./canonical-json.ts";
import type { MutableProviderRegistry } from "./provider-registry.ts";
import { FIGUREYA_PROVIDER_ID, LOCAL_LIBRARY_PROVIDER_ID, PERSONAL_MODULE_PROVIDER_ID } from "./providers.ts";
import { COMMUNITY_PROVIDER_ID } from "./public-catalog-provider.ts";
import { providerSourcePaths } from "./provider-sources.ts";

export const BUNDLED_PROVIDER_PREFERENCES_SCHEMA = "figure-library.bundled-provider-preferences.v1" as const;
export const BUNDLED_PROVIDER_CHANGE_PLAN_SCHEMA = "figure-library.bundled-provider-change-plan.v1" as const;
const HASH = /^[a-f0-9]{64}$/u;
const PLAN_TTL_MS = 30 * 60 * 1000;

export const REMOVABLE_BUNDLED_PROVIDER_IDS = new Set([
  FIGUREYA_PROVIDER_ID,
  PERSONAL_MODULE_PROVIDER_ID,
  COMMUNITY_PROVIDER_ID,
]);

export function isRemovableBundledProviderId(value: string) {
  return REMOVABLE_BUNDLED_PROVIDER_IDS.has(value);
}

export function bundledPreferencesFile(configRoot = providerSourcePaths().configRoot) {
  return path.join(configRoot, "bundled-provider-preferences.json");
}

interface PreferenceFile {
  schema: typeof BUNDLED_PROVIDER_PREFERENCES_SCHEMA;
  providers: Record<string, { enabled: boolean }>;
  updatedAt: string;
}

export interface BundledProviderChangePlan {
  schema: typeof BUNDLED_PROVIDER_CHANGE_PLAN_SCHEMA;
  action: "remove" | "configure";
  providerId: string;
  enabled: boolean;
  warnings: string[];
  createdAt: string;
  planDigest: string;
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}

function nowIso() {
  return new Date().toISOString();
}

async function atomicWriteJson(file: string, value: unknown) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${randomUUID()}.tmp`);
  await fs.writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: "wx" });
  await fs.rename(temporary, file);
}

export class BundledProviderPreferenceStore {
  readonly file: string;
  private readonly registry?: MutableProviderRegistry;
  private providers = new Map<string, boolean>();
  private readonly plans = new Map<string, { plan: BundledProviderChangePlan; expiresAt: number }>();

  constructor(options: { file?: string; registry?: MutableProviderRegistry } = {}) {
    this.file = options.file ?? bundledPreferencesFile();
    this.registry = options.registry;
  }

  enabled(providerId: string) {
    return this.providers.get(providerId) !== false;
  }

  hasPlan(planDigest: string) {
    const item = this.plans.get(planDigest);
    if (!item) return false;
    if (item.expiresAt <= Date.now()) {
      this.plans.delete(planDigest);
      return false;
    }
    return true;
  }

  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.file, "utf8")) as PreferenceFile;
      if (raw.schema !== BUNDLED_PROVIDER_PREFERENCES_SCHEMA || !raw.providers || typeof raw.providers !== "object") {
        throw new Error("bundled provider preferences file is invalid");
      }
      this.providers = new Map(
        Object.entries(raw.providers)
          .filter(([providerId]) => isRemovableBundledProviderId(providerId))
          .map(([providerId, value]) => [providerId, value?.enabled !== false]),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.providers = new Map();
    }
    this.registry?.applyEnabledOverrides(this.providers);
  }

  async planChange(input: { action: "remove" | "configure"; providerId: string; enabled?: boolean }) {
    if (input.providerId === LOCAL_LIBRARY_PROVIDER_ID) {
      throw new Error("Local Published is the local knowledge library and cannot be removed");
    }
    if (!isRemovableBundledProviderId(input.providerId)) {
      throw new Error(`bundled provider cannot be removed: ${input.providerId}`);
    }
    const enabled = input.action === "remove" ? false : input.enabled;
    if (enabled === undefined) throw new Error("bundled provider configure requires enabled");
    if (this.enabled(input.providerId) === enabled) {
      return {
        status: "already_current" as const,
        action: input.action,
        providerId: input.providerId,
        enabled,
      };
    }
    const publicPlan = {
      schema: BUNDLED_PROVIDER_CHANGE_PLAN_SCHEMA,
      action: input.action,
      providerId: input.providerId,
      enabled,
      warnings: [
        enabled
          ? "Restoring a bundled catalog returns it to ordinary search. Existing materialized projects are unchanged."
          : "Removing a bundled catalog stops ordinary search. The install files remain and can be restored. Materialized projects are not deleted.",
      ],
      createdAt: nowIso(),
    };
    const plan = { ...publicPlan, planDigest: sha256(canonicalJson(publicPlan)) };
    this.plans.set(plan.planDigest, { plan, expiresAt: Date.now() + PLAN_TTL_MS });
    return plan;
  }

  async applyChange(input: {
    planDigest: string;
    operationId: string;
    expectedAction: "remove" | "configure";
    expectedProviderId: string;
  }) {
    if (!HASH.test(input.planDigest)) throw new Error("bundled provider planDigest is invalid");
    const prepared = this.plans.get(input.planDigest);
    if (!prepared || prepared.expiresAt <= Date.now()) {
      this.plans.delete(input.planDigest);
      throw new Error("bundled provider plan is not available; create and review a new plan");
    }
    const plan = prepared.plan;
    if (plan.action !== input.expectedAction || plan.providerId !== input.expectedProviderId) {
      throw new Error("bundled provider Apply expectations do not match the plan");
    }
    this.providers.set(plan.providerId, plan.enabled);
    await atomicWriteJson(this.file, {
      schema: BUNDLED_PROVIDER_PREFERENCES_SCHEMA,
      providers: Object.fromEntries([...this.providers].map(([providerId, enabled]) => [providerId, { enabled }])),
      updatedAt: nowIso(),
    });
    this.registry?.applyEnabledOverrides(this.providers);
    this.plans.delete(input.planDigest);
    return {
      action: plan.action,
      providerId: plan.providerId,
      enabled: plan.enabled,
      planDigest: plan.planDigest,
      operationId: input.operationId,
    };
  }
}
