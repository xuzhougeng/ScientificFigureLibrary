import assert from "node:assert/strict";
import test from "node:test";
import {
  describeNetworkFailure,
  enableProcessLog,
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
