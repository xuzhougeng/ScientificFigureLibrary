import assert from "node:assert/strict";
import test from "node:test";
import { firstRunSetupStatus } from "../src/first-run-setup.ts";

test("a brand-new install requires both Library and workspace directories", () => {
  const status = firstRunSetupStatus({
    library: { directorySource: "legacy-default", writesEnabled: false },
    workspace: { confirmed: false, directorySource: "unbound" },
  });
  assert.equal(status.required, true);
  assert.equal(status.code, "setup_required");
  assert.equal(status.nextAction, "ask_user");
  assert.deepEqual(status.missingConfirmations, [
    "globalLibraryDirectory",
    "localWorkspaceDirectory",
  ]);
});

test("an explicit Library bind still requires the Local workspace", () => {
  const status = firstRunSetupStatus({
    library: { directorySource: "locator", writesEnabled: true },
    workspace: { confirmed: false, directorySource: "unbound" },
  });
  assert.equal(status.required, true);
  assert.equal(status.nextAction, "rebind_workspace");
  assert.deepEqual(status.missingConfirmations, ["localWorkspaceDirectory"]);
});

test("a confirmed workspace still requires an explicit writable Library", () => {
  const status = firstRunSetupStatus({
    library: { directorySource: "legacy-default", writesEnabled: false },
    workspace: { confirmed: true, directorySource: "locator" },
  });
  assert.equal(status.required, true);
  assert.equal(status.nextAction, "rebind_library");
  assert.deepEqual(status.missingConfirmations, ["globalLibraryDirectory"]);
});

test("locator or env-bound Library plus confirmed workspace is ready", () => {
  for (const directorySource of ["locator", "FIGURE_LIBRARY_DIR", "argument"] as const) {
    const status = firstRunSetupStatus({
      library: { directorySource, writesEnabled: true },
      workspace: { confirmed: true, directorySource: "locator" },
    });
    assert.equal(status.required, false, directorySource);
    assert.equal(status.code, "library_ready", directorySource);
    assert.equal(status.nextAction, "none", directorySource);
    assert.deepEqual(status.missingConfirmations, []);
  }
});