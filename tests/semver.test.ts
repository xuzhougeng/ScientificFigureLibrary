import assert from "node:assert/strict";
import test from "node:test";
import { isStrictSemVer, STRICT_SEMVER } from "../src/semver.ts";

test("strict SemVer accepts prerelease and build metadata as immutable release identity", () => {
  for (const version of [
    "0.0.0",
    "1.0.0+build.9",
    "1.0.0-rc.1+build",
    "2.17.4-alpha.1-x.0+sha.abcdef",
  ]) {
    assert.equal(isStrictSemVer(version), true, version);
    assert.equal(STRICT_SEMVER.test(version), true, version);
  }
});

test("strict SemVer rejects leading-zero and empty prerelease/build identifiers", () => {
  for (const version of [
    "01.0.0",
    "1.0.0-01",
    "1.0.0-alpha..1",
    "1.0.0-",
    "1.0.0+",
    "1.0.0+build..9",
  ]) {
    assert.equal(isStrictSemVer(version), false, version);
    assert.equal(STRICT_SEMVER.test(version), false, version);
  }
});
