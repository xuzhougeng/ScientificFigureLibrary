import assert from "node:assert/strict";
import fs from "node:fs/promises";
import test from "node:test";
import { JSDOM } from "jsdom";
import { mountClientUpdates } from "../app/local/updates.ts";
import type { ClientUpdateResult } from "../src/local/updates.ts";
const available: ClientUpdateResult = {
  status: "available", currentVersion: "0.8.1", latestVersion: "0.9.0",
  checkedAt: "2026-09-22T00:00:00Z", releaseUrl: "https://github.com/xuzhougeng/ScientificFigureLibrary/releases/tag/v0.9.0",
};
async function setup(request: (force: boolean) => Promise<ClientUpdateResult>) {
  const dom = new JSDOM(await fs.readFile(new URL("../app/local-app.html", import.meta.url), "utf8"));
  const updates = mountClientUpdates(dom.window.document, "0.8.1", request);
  return { dom, updates, element: (id: string) => dom.window.document.getElementById(id)! };
}

test("new version banner is dismissible and manual checking restores it", async () => {
  const forces: boolean[] = [];
  const { dom, updates, element } = await setup(async force => { forces.push(force); return available; });
  try {
    await updates.check(false);
    assert.equal(element("client-version").textContent, "0.8.1");
    assert.equal(element("update-banner").hidden, false);
    assert.equal(element("update-banner-release").getAttribute("href"), available.releaseUrl);
    element("dismiss-update").click();
    assert.equal(element("update-banner").hidden, true);
    await updates.check(false);
    assert.equal(element("update-banner").hidden, true);
    await updates.check(true);
    assert.equal(element("update-banner").hidden, false);
    assert.deepEqual(forces, [false, false, true]);
  } finally { dom.window.close(); }
});

test("button disables while checking; failure stays in settings with retry enabled", async () => {
  let resolve!: (value: ClientUpdateResult) => void;
  let calls = 0;
  const { dom, updates, element } = await setup(async force => {
    calls++; assert.equal(force, true);
    return new Promise(done => { resolve = done; });
  });
  try {
    const checking = updates.check(true);
    assert.equal((element("check-updates") as HTMLButtonElement).disabled, true);
    await updates.check(true); assert.equal(calls, 1);
    resolve({ status: "error", currentVersion: "0.8.1", checkedAt: available.checkedAt, releaseUrl: available.releaseUrl, message: "检查更新超时，请重试。" });
    await checking;
    assert.equal((element("check-updates") as HTMLButtonElement).disabled, false);
    assert.match(element("update-status").textContent!, /超时/u);
    assert.equal(element("update-banner").hidden, true);
  } finally { dom.window.close(); }
});

test("current version and local connection failure leave navigation available", async () => {
  let fails = false;
  const { dom, updates, element } = await setup(async () => {
    if (fails) throw new Error("disconnected");
    return { ...available, status: "current", latestVersion: "0.8.1" };
  });
  try {
    await updates.check(true);
    assert.match(element("update-status").textContent!, /最新版本/u);
    assert.equal(element("update-banner").hidden, true);
    fails = true;
    await updates.check(true);
    assert.match(element("update-status").textContent!, /本地服务/u);
    assert.equal((element("check-updates") as HTMLButtonElement).disabled, false);
    assert.equal((element("shutdown") as HTMLButtonElement).disabled, false);
  } finally { dom.window.close(); }
});
