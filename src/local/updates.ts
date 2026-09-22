import { fetchWithOptionalProxy } from "../proxy-fetch.ts";
import { isStrictSemVer } from "../semver.ts";
import { VERSION } from "../version.ts";

export const RELEASES_URL = "https://github.com/xuzhougeng/ScientificFigureLibrary/releases";
const LATEST_RELEASE_URL = "https://api.github.com/repos/xuzhougeng/ScientificFigureLibrary/releases/latest";
export type ClientUpdateResult = {
  currentVersion: string;
  checkedAt: string;
  releaseUrl: string;
} & ({ status: "available" | "current"; latestVersion: string } | { status: "error"; message: string });

/** Compare a stable candidate to any installed SemVer; build metadata is ignored. */
export function isNewerStableVersion(candidate: string, current: string): boolean {
  if (candidate.trim() !== candidate || current.trim() !== current || !isStrictSemVer(candidate) || !isStrictSemVer(current)) throw new Error("Invalid semantic version");
  const latestCore = candidate.split("+")[0]!;
  const currentCore = current.split("+")[0]!;
  if (latestCore.includes("-")) throw new Error("Expected a stable release");
  const latest = latestCore.split(".").map(BigInt);
  const installed = currentCore.split("-")[0]!.split(".").map(BigInt);
  for (let index = 0; index < 3; index++) {
    if (latest[index] !== installed[index]) return latest[index]! > installed[index]!;
  }
  return currentCore.includes("-");
}

/** Per-server cache and single flight; constructing the checker does not access the network. */
export function createClientUpdateChecker(options: {
  currentVersion?: string;
  fetch?: typeof fetchWithOptionalProxy;
  now?: () => number;
  timeoutMs?: number;
} = {}) {
  const currentVersion = options.currentVersion ?? VERSION;
  const fetchRelease = options.fetch ?? fetchWithOptionalProxy;
  const now = options.now ?? Date.now;
  let cached: ClientUpdateResult | undefined;
  let expiresAt = 0;
  let pending: Promise<ClientUpdateResult> | undefined;
  async function request(): Promise<ClientUpdateResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // Bound the complete request, including body parsing and proxy connections.
      const release = await Promise.race([
        (async () => {
          const response = await fetchRelease(LATEST_RELEASE_URL, {
            headers: { Accept: "application/vnd.github+json", "User-Agent": `ScientificFigureLibrary/${currentVersion}` },
            signal: controller.signal, redirect: "error",
          });
          if (response.status === 403 || response.status === 429) throw new Error("GitHub 暂时拒绝请求或请求次数已达上限，请稍后重试。");
          if (response.status === 404) throw new Error("暂未找到可用的稳定版本，请稍后重试或查看发布页面。");
          if (!response.ok) throw new Error(`GitHub 返回 HTTP ${response.status}，请稍后重试。`);
          return await response.json() as unknown;
        })(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error("检查更新超时，请检查网络或系统代理后重试。"));
            controller.abort();
          }, options.timeoutMs ?? 10_000);
        }),
      ]);
      if (!release || typeof release !== "object") throw new Error("发布信息格式无效，请稍后重试。");
      const value = release as Record<string, unknown>;
      const tag = typeof value.tag_name === "string" ? value.tag_name : "";
      const latestVersion = tag.replace(/^v/u, "");
      if (value.draft !== false || value.prerelease !== false || !isStrictSemVer(latestVersion) || latestVersion.trim() !== latestVersion || latestVersion.split("+")[0]!.includes("-")) throw new Error("未获得有效的稳定版本信息，请稍后重试。");
      return {
        status: isNewerStableVersion(latestVersion, currentVersion) ? "available" : "current",
        currentVersion, latestVersion, checkedAt: new Date(now()).toISOString(),
        // Never open an arbitrary URL supplied by a remote response.
        releaseUrl: `${RELEASES_URL}/tag/${encodeURIComponent(tag)}`,
      };
    } catch (error) {
      const message = error instanceof Error && /^(GitHub |暂未|发布信息|未获得|检查更新超时)/u.test(error.message)
        ? error.message : "无法检查更新，请检查网络或系统代理后重试。";
      return { status: "error", currentVersion, checkedAt: new Date(now()).toISOString(), releaseUrl: RELEASES_URL, message };
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }
  return function check(force = false): Promise<ClientUpdateResult> {
    if (pending) return pending;
    if (!force && cached && now() < expiresAt) return Promise.resolve(cached);
    pending = request().then(result => {
      cached = result;
      expiresAt = now() + (result.status === "error" ? 60_000 : 3_600_000);
      return result;
    }).finally(() => { pending = undefined; });
    return pending;
  };
}
