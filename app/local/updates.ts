import type { ClientUpdateResult } from "../../src/local/updates.ts";

/** Install once after authenticating; checks never block library navigation. */
export function mountClientUpdates(document: Document, currentVersion: string, request: (force: boolean) => Promise<ClientUpdateResult>) {
  const button = document.getElementById("check-updates") as HTMLButtonElement;
  const status = document.getElementById("update-status")!;
  const banner = document.getElementById("update-banner")!;
  const message = document.getElementById("update-banner-message")!;
  const release = document.getElementById("update-release") as HTMLAnchorElement;
  const bannerLink = document.getElementById("update-banner-release") as HTMLAnchorElement;
  document.getElementById("client-version")!.textContent = currentVersion;
  let checking = false;
  let dismissedVersion = "";
  let latestVersion = "";
  document.getElementById("dismiss-update")!.addEventListener("click", () => {
    dismissedVersion = latestVersion;
    banner.hidden = true;
  });
  async function check(force: boolean) {
    if (checking) return;
    checking = true;
    button.disabled = true;
    button.textContent = "检查中…";
    status.textContent = "正在检查更新…";
    try {
      const result = await request(force);
      release.href = result.releaseUrl;
      release.hidden = false;
      if (result.status === "error") { status.textContent = result.message; return; }
      latestVersion = result.latestVersion;
      status.textContent = result.status === "available"
        ? `发现新版本 ${result.latestVersion}（当前 ${result.currentVersion}）。`
        : `当前 ${result.currentVersion} 已是最新版本（最新稳定版 ${result.latestVersion}）。`;
      if (force) dismissedVersion = "";
      banner.hidden = result.status !== "available" || dismissedVersion === latestVersion;
      message.textContent = `SFL ${result.latestVersion} 已发布，当前版本为 ${result.currentVersion}。`;
      bannerLink.href = result.releaseUrl;
    } catch {
      status.textContent = "无法检查更新，请检查本地服务、网络或系统代理后重试。";
    } finally {
      checking = false;
      button.disabled = false;
      button.textContent = "检查更新";
    }
  }
  button.addEventListener("click", () => { void check(true); });
  return { check };
}
