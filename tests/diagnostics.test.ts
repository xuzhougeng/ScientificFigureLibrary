import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { strFromU8, unzipSync } from "fflate";
import {
  DIAGNOSTICS_SCHEMA_VERSION,
  DiagnosticsManager,
  type UiDiagnosticEvent,
} from "../src/diagnostics.ts";

test("diagnostics writes bounded JSONL with safe schema and rotates by session", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-diagnostics-jsonl-"));
  const diagnostics = new DiagnosticsManager({
    directory: root,
    maxFileBytes: 420,
    maxTotalBytes: 8_000,
  });
  await diagnostics.start();
  for (let index = 0; index < 12; index += 1) {
    await diagnostics.record({
      event: "search.completed",
      correlationId: `search-${index}`,
      invocationSource: "agent",
      durationMs: index,
      safeMessage:
        "receipt_supersecret data:image/png;base64,AAAA /home/example/private/library.json /mnt/e/private/project.json Authorization: Bearer abc",
    });
  }
  const files = (await fs.readdir(root)).filter((name) => name.endsWith(".jsonl"));
  assert.ok(files.length > 1);
  assert.ok(files.every((name) => name.startsWith(diagnostics.sessionId)));
  for (const file of files) {
    const lines = (await fs.readFile(path.join(root, file), "utf8")).trim().split("\n");
    for (const line of lines) {
      const event = JSON.parse(line) as Record<string, unknown>;
      assert.equal(event.schemaVersion, DIAGNOSTICS_SCHEMA_VERSION);
      assert.equal(event.sessionId, diagnostics.sessionId);
      assert.doesNotMatch(
        line,
        /receipt_supersecret|data:image|Bearer abc|\/home\/example|\/mnt\/e\/private/u,
      );
    }
  }
});

test("diagnostic bundle filters by correlation and verifies manifest hashes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-diagnostics-bundle-"));
  const diagnostics = new DiagnosticsManager({ directory: root });
  await diagnostics.record({
    level: "warning",
    event: "search.completed",
    correlationId: "keep-this",
    invocationSource: "agent",
    durationMs: 12,
  });
  await diagnostics.record({
    level: "error",
    event: "tool.failed",
    correlationId: "keep-this",
    invocationSource: "agent",
    errorCode: "fixture_error",
    safeMessage: "challenge_secret should never survive",
  });
  await diagnostics.record({
    event: "search.completed",
    correlationId: "exclude-this",
    invocationSource: "agent",
  });
  const result = await diagnostics.exportBundle({
    scope: "correlation_id",
    correlationId: "keep-this",
    detail: "sanitized_bundle",
    includeUserText: false,
    includeAbsolutePaths: false,
  });
  assert.equal(result.summary.events, 2);
  assert.equal(result.summary.errors, 1);
  assert.equal(result.summary.warnings, 1);
  assert.equal(result.localPath, undefined);
  assert.match(result.resourceUri, /^figure-library:\/\/diagnostics\//u);

  const bundle = diagnostics.readBundle(result.bundleId);
  const members = unzipSync(bundle.bytes);
  assert.deepEqual(Object.keys(members).sort(), [
    "environment.json",
    "errors.jsonl",
    "events.jsonl",
    "manifest.json",
    "summary.md",
  ]);
  const events = strFromU8(members["events.jsonl"]!);
  assert.match(events, /keep-this/u);
  assert.doesNotMatch(events, /exclude-this|challenge_secret/u);
  const environment = strFromU8(members["environment.json"]!);
  assert.match(environment, /<DIAGNOSTICS_DIR>/u);
  assert.doesNotMatch(environment, new RegExp(root.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));

  const manifest = JSON.parse(strFromU8(members["manifest.json"]!)) as {
    files: Array<{ name: string; byteLength: number; sha256: string }>;
  };
  for (const file of manifest.files) {
    const bytes = members[file.name];
    assert.ok(bytes);
    assert.equal(bytes.byteLength, file.byteLength);
    const { createHash } = await import("node:crypto");
    assert.equal(createHash("sha256").update(bytes).digest("hex"), file.sha256);
  }
});

test("UI diagnostics rejects unknown events and rate abuse", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-diagnostics-ui-"));
  const diagnostics = new DiagnosticsManager({ directory: root });
  await assert.rejects(
    diagnostics.recordUiEvent({
      event: "arbitrary.user.text" as UiDiagnosticEvent,
      resultSetId: "result-1",
      candidateId: "candidate-1",
    }),
    /unsupported UI diagnostic event/u,
  );
  await assert.rejects(
    diagnostics.recordUiEvent({
      event: "candidate.detail_opened",
      resultSetId: "result-1",
      candidateId: "x".repeat(257),
    }),
    /invalid UI diagnostic result or candidate identifier/u,
  );
  for (let index = 0; index < 120; index += 1) {
    await diagnostics.recordUiEvent({
      event: "candidate.detail_opened",
      resultSetId: "result-1",
      candidateId: "candidate-1",
    });
  }
  await assert.rejects(
    diagnostics.recordUiEvent({
      event: "candidate.detail_opened",
      resultSetId: "result-1",
      candidateId: "candidate-1",
    }),
    /rate limit/u,
  );
});

test("last_operation export ignores the export request itself", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-diagnostics-last-"));
  const diagnostics = new DiagnosticsManager({ directory: root });
  await diagnostics.record({
    event: "search.started",
    correlationId: "previous-search",
    invocationSource: "agent",
  });
  await diagnostics.record({
    event: "search.completed",
    correlationId: "previous-search",
    invocationSource: "agent",
  });
  await diagnostics.record({
    event: "diagnostics.export_requested",
    correlationId: "export-call",
    invocationSource: "agent",
  });
  const result = await diagnostics.exportBundle({
    scope: "last_operation",
    detail: "sanitized_bundle",
    includeUserText: false,
    includeAbsolutePaths: false,
  });
  const members = unzipSync(diagnostics.readBundle(result.bundleId).bytes);
  const events = strFromU8(members["events.jsonl"]!);
  assert.match(events, /previous-search/u);
  assert.doesNotMatch(events, /export-call/u);
});

test("time_range export applies inclusive ISO timestamp bounds", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-diagnostics-range-"));
  let current = new Date("2026-08-11T00:00:00.000Z");
  const diagnostics = new DiagnosticsManager({ directory: root, now: () => current });
  await diagnostics.record({ event: "search.started", correlationId: "before-range" });
  current = new Date("2026-08-11T00:00:10.000Z");
  await diagnostics.record({ event: "search.completed", correlationId: "inside-range" });
  current = new Date("2026-08-11T00:00:20.000Z");
  await diagnostics.record({ event: "search.completed", correlationId: "after-range" });
  const result = await diagnostics.exportBundle({
    scope: "time_range",
    since: "2026-08-11T00:00:05.000Z",
    until: "2026-08-11T00:00:15.000Z",
    detail: "sanitized_bundle",
    includeUserText: false,
    includeAbsolutePaths: false,
  });
  const members = unzipSync(diagnostics.readBundle(result.bundleId).bytes);
  const events = strFromU8(members["events.jsonl"]!);
  assert.match(events, /inside-range/u);
  assert.doesNotMatch(events, /before-range|after-range/u);
});

test("diagnostic sessions isolate bundle access and degrade without breaking event capture", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "figure-library-diagnostics-sessions-"));
  const first = new DiagnosticsManager({ directory: path.join(root, "first") });
  const second = new DiagnosticsManager({ directory: path.join(root, "second") });
  await first.record({ event: "search.completed", correlationId: "first" });
  await second.record({ event: "search.completed", correlationId: "second" });
  const bundle = await first.exportBundle({
    scope: "current_session",
    detail: "sanitized_bundle",
    includeUserText: false,
    includeAbsolutePaths: true,
  });
  assert.ok(bundle.localPath && path.isAbsolute(bundle.localPath));
  assert.throws(() => second.readBundle(bundle.bundleId), /unavailable in this server session/u);
  assert.notEqual(first.sessionId, second.sessionId);

  const blockedPath = path.join(root, "not-a-directory");
  await fs.writeFile(blockedPath, "fixture");
  const degraded = new DiagnosticsManager({ directory: blockedPath });
  await degraded.record({ event: "search.started", correlationId: "still-in-memory" });
  assert.equal(degraded.degraded, true);
  assert.equal(degraded.snapshotEvents().length, 1);
});
