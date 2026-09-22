import assert from "node:assert/strict";
import test from "node:test";
import { createClientUpdateChecker, isNewerStableVersion, RELEASES_URL } from "../src/local/updates.ts";
const release = (tag = "v0.10.0", extra = {}) => Response.json({ tag_name: tag, draft: false, prerelease: false, ...extra });

test("stable precedence compares numeric components, prereleases and build metadata", () => {
  for (const [latest, current, expected] of [
    ["0.10.0", "0.9.9", true], ["1.0.0", "0.99.99", true], ["0.8.2", "0.8.1", true],
    ["0.8.1", "0.8.1", false], ["0.8.1", "0.9.0", false], ["0.8.1", "0.8.1-rc.2", true],
    ["0.8.1", "0.9.0-rc.1", false], ["0.8.1+new", "0.8.1+old", false],
    ["9007199254740993.0.0", "9007199254740992.0.0", true],
  ] as const) assert.equal(isNewerStableVersion(latest, current), expected, `${latest} vs ${current}`);
  for (const invalid of ["v0.8.1", "0.08.1", "0.8", "latest", "0.8.1-rc.1", "0.8.1\n"]) assert.throws(() => isNewerStableVersion(invalid, "0.8.1"));
  assert.throws(() => isNewerStableVersion("0.8.1", "bad"));
});

test("official endpoint and safe release links; equal or newer installations need no update", async () => {
  const check = createClientUpdateChecker({ currentVersion: "0.9.0", fetch: async (url, init) => {
    assert.equal(url, "https://api.github.com/repos/xuzhougeng/ScientificFigureLibrary/releases/latest");
    assert.equal(init?.redirect, "error");
    assert.ok(init?.signal);
    assert.equal(new Headers(init?.headers).get("Authorization"), null);
    return release("v0.10.0", { html_url: "https://example.com/untrusted" });
  } });
  const result = await check();
  assert.equal(result.status, "available");
  assert.equal(result.releaseUrl, `${RELEASES_URL}/tag/v0.10.0`);
  for (const currentVersion of ["0.10.0", "0.11.0"]) assert.equal((await createClientUpdateChecker({ currentVersion, fetch: async () => release() })()).status, "current");
});

test("cache, forced refresh, expiry and concurrent request deduplication", async () => {
  let calls = 0, now = 0;
  let resolve!: (value: Response) => void;
  const check = createClientUpdateChecker({ now: () => now, fetch: async () => {
    if (++calls === 1) return new Promise<Response>(done => { resolve = done; });
    return release();
  } });
  const first = check(), second = check(true);
  assert.equal(calls, 1);
  resolve(release());
  assert.equal(await first, await second);
  await check(); assert.equal(calls, 1);
  await check(true); assert.equal(calls, 2);
  now += 3_600_000;
  await check(); assert.equal(calls, 3);
});

test("HTTP, offline and malformed-release failures are cached briefly and can be retried", async () => {
  for (const fetch of [
    ...[403, 429, 404, 503].map(status => async () => new Response("", { status })),
    async () => new Response("not json"), async () => Response.json(null),
    async () => release("v0.10.0", { draft: true }), async () => release("v0.10.0", { prerelease: true }),
    async () => release("v0.10.0-rc.1"), async () => release("invalid"), async () => release("v0.10.0\n"),
    async () => { throw new Error("offline"); },
  ]) {
    let calls = 0, now = 0;
    const check = createClientUpdateChecker({ now: () => now, fetch: async () => { calls++; return fetch(); } });
    const result = await check();
    assert.equal(result.status, "error");
    assert.ok(result.status === "error" && result.message);
    await check(); assert.equal(calls, 1);
    now += 60_000;
    await check(); assert.equal(calls, 2);
  }
  let offline = true;
  const retry = createClientUpdateChecker({ fetch: async () => { if (offline) throw new Error("offline"); return release(); } });
  assert.equal((await retry()).status, "error");
  offline = false;
  assert.equal((await retry(true)).status, "available");
});

test("timeout bounds network wait and body parsing, aborts the request, and permits retry", async () => {
  for (const stallBody of [false, true]) {
    let signal: AbortSignal | null | undefined;
    let calls = 0;
    const check = createClientUpdateChecker({ timeoutMs: 10, fetch: async (_url, init) => {
      signal = init?.signal;
      if (++calls > 1) return release();
      if (stallBody) return new Response(new ReadableStream({ start() {} }));
      return new Promise<Response>(() => {});
    } });
    const result = await check();
    assert.equal(result.status, "error");
    assert.match(result.status === "error" ? result.message : "", /超时/u);
    assert.equal(signal?.aborted, true);
    assert.equal((await check(true)).status, "available");
  }
});
