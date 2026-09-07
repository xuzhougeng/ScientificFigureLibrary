import path from "node:path";
import { ed25519PublicKeyIdentity } from "./provider-source-fetch.ts";
import { PERSONAL_MODULE_PROVIDER_ID } from "./providers.ts";

export const OFFICIAL_OPEN_FIGURE_PROVIDER_ID = PERSONAL_MODULE_PROVIDER_ID;
export const OFFICIAL_OPEN_FIGURE_SOURCE_LABEL = "Open Figure Modules";
export const OFFICIAL_OPEN_FIGURE_REPOSITORY =
  "jarxunlai/ScientificFigureLibrary-personal" as const;
export const OFFICIAL_OPEN_FIGURE_FEED_BRANCH = "open-figure-feed" as const;
export const OFFICIAL_OPEN_FIGURE_MANIFEST_URL =
  "https://raw.githubusercontent.com/jarxunlai/ScientificFigureLibrary-personal/open-figure-feed/current/source-manifest.json" as const;

/**
 * Production bootstrap public key. The matching 32-byte seed lives only in the GitHub Environment secret SFL_OPEN_FIGURE_ED25519_PRIVATE_KEY_BASE64 and is never stored in this repository.
 */
export const OFFICIAL_OPEN_FIGURE_BOOTSTRAP_PUBLIC_KEY_BASE64 =
  "D6jsmd16oQLZKcXqMcKodVRzr9UeVwGbvvapy+dGr0o=";

export const OFFICIAL_OPEN_FIGURE_STATE_SCHEMA =
  "figure-library.open-figure-official-state.v1" as const;
export const OFFICIAL_OPEN_FIGURE_CONFIG_SCHEMA =
  "figure-library.open-figure-modules-config.v1" as const;
export const OFFICIAL_OPEN_FIGURE_SNAPSHOT_STATE_SCHEMA =
  "figure-library.open-figure-official-snapshot.v1" as const;
export const OFFICIAL_OPEN_FIGURE_CHANGE_PLAN_SCHEMA =
  "figure-library.open-figure-official-change-plan.v1" as const;
export const OFFICIAL_OPEN_FIGURE_ALREADY_CURRENT_SCHEMA =
  "figure-library.open-figure-official-already-current.v1" as const;
export const OFFICIAL_OPEN_FIGURE_CHANGE_RECEIPT_SCHEMA =
  "figure-library.open-figure-official-change-receipt.v1" as const;

export const OFFICIAL_OPEN_FIGURE_REFRESH_TTL_MS = 6 * 60 * 60 * 1_000;
export const OFFICIAL_OPEN_FIGURE_NETWORK_BACKOFF_MS = [
  5 * 60 * 1_000,
  15 * 60 * 1_000,
  60 * 60 * 1_000,
] as const;
export const OFFICIAL_OPEN_FIGURE_DATA_DIR_NAME = "official-open-figure-modules";
export const OFFICIAL_OPEN_FIGURE_AUTO_REFRESH_ENV = "SFL_OPEN_FIGURE_AUTO_REFRESH";
export const OFFICIAL_OPEN_FIGURE_RAW_HOST = "raw.githubusercontent.com";

export const PERSONAL_MODULE_SNAPSHOT_LICENSE =
  "Open Figure Modules metadata and generated previews\n\nComplete module archives are not included in the SFL plugin; they remain in the separately maintained personal module repository and are fetched only by an exact selected identity.\n\nEach module's code, content, and documentation license is recorded in module-catalog.json. Do not infer a module license from the SFL project license.\n";

const PAYLOAD_COMMIT = /^[a-f0-9]{40}$/u;
const PAYLOAD_FILE = /^(?:module-catalog\.json|module-previews\.zip)$/u;

export function officialOpenFigureBootstrapKey(
  publicKeyBase64 = OFFICIAL_OPEN_FIGURE_BOOTSTRAP_PUBLIC_KEY_BASE64,
) {
  return ed25519PublicKeyIdentity(publicKeyBase64);
}

export const OFFICIAL_OPEN_FIGURE_BOOTSTRAP_KEY_ID = officialOpenFigureBootstrapKey().keyId;

export function isOfficialOpenFigureProviderId(value: unknown): value is typeof OFFICIAL_OPEN_FIGURE_PROVIDER_ID {
  return value === OFFICIAL_OPEN_FIGURE_PROVIDER_ID;
}

export function officialOpenFigurePayloadUrl(
  payloadCommit: string,
  sequence: number,
  file: "module-catalog.json" | "module-previews.zip",
) {
  if (!PAYLOAD_COMMIT.test(payloadCommit)) {
    throw new Error("official Open Figure payload commit must be a lowercase 40-hex SHA");
  }
  if (!Number.isSafeInteger(sequence) || sequence < 1) {
    throw new Error("official Open Figure sequence must be a positive integer");
  }
  if (!PAYLOAD_FILE.test(file)) {
    throw new Error("official Open Figure payload file is unsupported");
  }
  return `https://raw.githubusercontent.com/${OFFICIAL_OPEN_FIGURE_REPOSITORY}/${payloadCommit}/snapshots/${sequence}/${file}`;
}

export function parseOfficialOpenFigurePayloadUrl(value: string): {
  payloadCommit: string;
  sequence: number;
  file: "module-catalog.json" | "module-previews.zip";
} {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("official Open Figure payload URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) {
    throw new Error("official Open Figure payload URL must be credential-free HTTPS without query or fragment");
  }
  if (url.hostname.toLowerCase() !== OFFICIAL_OPEN_FIGURE_RAW_HOST) {
    throw new Error("official Open Figure payload URL must use raw.githubusercontent.com");
  }
  const match = url.pathname.match(
    /^\/jarxunlai\/ScientificFigureLibrary-personal\/([a-f0-9]{40})\/snapshots\/([1-9][0-9]*)\/(module-catalog\.json|module-previews\.zip)$/u,
  );
  if (!match) {
    throw new Error("official Open Figure payload URL must be commit-pinned under snapshots/<sequence>/");
  }
  return {
    payloadCommit: match[1]!,
    sequence: Number(match[2]),
    file: match[3] as "module-catalog.json" | "module-previews.zip",
  };
}

export function officialOpenFigurePaths(options: {
  platform?: NodeJS.Platform;
  env?: NodeJS.Dict<string>;
  homedir?: string;
  configFile?: string;
  dataRoot?: string;
} = {}) {
  const platform = options.platform ?? process.platform;
  const environment = options.env ?? process.env;
  const home = options.homedir ?? (process.env.HOME || process.env.USERPROFILE || "");
  const impl = platform === "win32" ? path.win32 : path.posix;
  const configRoot = platform === "win32"
    ? impl.join(environment.APPDATA?.trim() || impl.join(home, "AppData", "Roaming"), "ScientificFigureLibrary")
    : impl.join(environment.XDG_CONFIG_HOME?.trim() || impl.join(home, ".config"), "scientific-figure-library");
  const dataRoot = options.dataRoot ?? (platform === "win32"
    ? impl.join(
        environment.LOCALAPPDATA?.trim() || impl.join(home, "AppData", "Local"),
        "ScientificFigureLibrary",
        "provider-sources",
        OFFICIAL_OPEN_FIGURE_DATA_DIR_NAME,
      )
    : impl.join(
        environment.XDG_DATA_HOME?.trim() || impl.join(home, ".local", "share"),
        "scientific-figure-library",
        "provider-sources",
        OFFICIAL_OPEN_FIGURE_DATA_DIR_NAME,
      ));
  return {
    configRoot,
    configFile: options.configFile ?? impl.join(configRoot, "open-figure-modules.json"),
    dataRoot,
    lockDirectory: impl.join(dataRoot, ".write-lock"),
    snapshotsRoot: impl.join(dataRoot, "snapshots"),
    stateFile: impl.join(dataRoot, "active-state.json"),
  };
}

export function autoRefreshEnvOverride(env: NodeJS.Dict<string> = process.env) {
  const raw = env[OFFICIAL_OPEN_FIGURE_AUTO_REFRESH_ENV]?.trim();
  if (raw === undefined || raw === "") return undefined;
  if (raw === "0" || raw.toLowerCase() === "false" || raw.toLowerCase() === "off") return false;
  if (raw === "1" || raw.toLowerCase() === "true" || raw.toLowerCase() === "on") return true;
  throw new Error(`${OFFICIAL_OPEN_FIGURE_AUTO_REFRESH_ENV} must be 0 or 1`);
}

export function officialOpenFigureAutoRefreshAllowed(env: NodeJS.Dict<string> = process.env) {
  if (env.NODE_TEST_CONTEXT && env.SFL_OPEN_FIGURE_ALLOW_TEST_NETWORK !== "1") return false;
  const override = autoRefreshEnvOverride(env);
  if (override === false) return false;
  return true;
}
