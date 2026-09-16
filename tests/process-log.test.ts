import assert from "node:assert/strict";
import test from "node:test";
import {
  describeNetworkFailure,
  enableProcessLog,
  formatUserNetworkError,
  processLogEnabled,
  processLogError,
  resetProcessLogForTests,
} from "../src/process-log.ts";

test("network failure hints cover timeout and connection reset", () => {
  const timeout = describeNetworkFailure(new Error("provider source request timed out after 60000ms"));
  assert.match(timeout.hint ?? "", /timed out/iu);
  assert.match(timeout.hint ?? "", /proxy|Settings/u);
  const reset = describeNetworkFailure(new Error("read ECONNRESET"));
  assert.match(reset.hint ?? "", /reset/iu);
  const other = describeNetworkFailure(new Error("signature mismatch"));
  assert.equal(other.hint, undefined);
});

test("user-facing network errors explain timeout and connection reset in Chinese", () => {
  assert.match(
    formatUserNetworkError(new Error("Provider source change plan failed: provider source request timed out after 60000ms")),
    /访问 GitHub 超时/u,
  );
  assert.match(formatUserNetworkError(new Error("read ECONNRESET")), /连接被重置/u);
  assert.match(
    formatUserNetworkError(new Error("Materialization was not completed: archive unavailable. source pack: ENOENT: no such file or directory, open 'D:\\\\SFL\\\\Library\\\\source-packs\\\\figureya\\\\figureya-source-pack.manifest.json'. Provide sourcePackDir containing a validated figureya-source-pack.manifest.json and its archives; do not download the complete FigureYa repository.")),
    /无法下载该模板的固定版本代码包/u,
  );
  assert.match(
    formatUserNetworkError(new Error("Materialization was not completed: archive unavailable. network access is disabled.")),
    /请勾选「从 GitHub 下载该模板的固定版本」/u,
  );
  assert.match(
    formatUserNetworkError(new Error("Open Figure Modules archive unavailable. source pack: ENOENT: no such file or directory, lstat 'D:\\\\SFL\\\\Library\\\\source-packs\\\\open-modules'.")),
    /无法下载该模板的固定版本代码包/u,
  );
});

test("process log is silent until enabled and then writes stderr", () => {
  resetProcessLogForTests();
  assert.equal(processLogEnabled(), false);
  const chunks: string[] = [];
  const original = process.stderr.write.bind(process.stderr);
  process.stderr.write = ((chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  try {
    processLogError("Provider source change plan failed: read ECONNRESET", new Error("read ECONNRESET"));
    assert.deepEqual(chunks, []);
    enableProcessLog();
    processLogError("Provider source change plan failed: read ECONNRESET", new Error("read ECONNRESET"));
    assert.match(chunks.join(""), /\[SFL\] Provider source change plan failed: read ECONNRESET/u);
    assert.match(chunks.join(""), /\[SFL\] Connection to GitHub was reset/u);
  } finally {
    process.stderr.write = original;
    resetProcessLogForTests();
  }
});
