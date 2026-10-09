"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("yaml");

const root = path.resolve(__dirname, "../..");
function workflow(name) {
  const doc = yaml.parseDocument(fs.readFileSync(path.join(root, ".github/workflows", name), "utf8"), { uniqueKeys: true });
  assert.deepEqual(doc.errors, []);
  return doc.toJS();
}

test("full release packaging is opt-in after successful quality CI", () => {
  const ci = workflow("ci.yml");
  assert.equal(ci.on.workflow_dispatch.inputs.package_release.type, "boolean");
  assert.equal(ci.on.workflow_dispatch.inputs.package_release.default, false);
  const job = ci.jobs["package-release"];
  assert.equal(job.if, "${{ github.event_name == 'workflow_dispatch' && inputs.package_release }}");
  assert.deepEqual(job.needs, ["ci-required"]);
  assert.equal(job.uses, "./.github/workflows/package-validation.yml");
  assert.deepEqual(job.permissions, { contents: "read" });
  assert.equal(job.secrets, undefined);
});

test("package validation uses the release packagers and exact source commit without publication privileges", () => {
  const validation = workflow("package-validation.yml");
  assert.deepEqual(Object.keys(validation.on), ["workflow_call"]);
  assert.deepEqual(validation.permissions, { contents: "read" });
  assert.equal(validation.jobs["local-clients"].uses, "./.github/workflows/local-clients.yml");
  assert.equal(validation.jobs["local-clients"].with.ref, "${{ github.sha }}");
  assert.deepEqual(validation.jobs.verify.needs, ["plugins", "local-clients"]);
  const text = JSON.stringify(validation);
  for (const forbidden of ["npm publish", "gh release", "gh api", "git push", "git tag", "secrets.", "id-token", "contents: write"]) {
    assert.ok(!text.includes(forbidden), forbidden);
  }
  assert.ok(text.includes("npm run package:plugins"));
  assert.ok(text.includes("npm run package:npm"));
  assert.ok(text.includes("prepareGitHubRelease"));
  assert.ok(text.includes("verified.files"));
  for (const job of Object.values(validation.jobs)) {
    if (job.permissions) assert.deepEqual(job.permissions, { contents: "read" });
    for (const step of job.steps ?? []) {
      if (!step.uses) continue;
      assert.match(step.uses, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
      if (step.uses.startsWith("actions/checkout@")) {
        assert.equal(step.with.ref, "${{ github.sha }}");
        assert.equal(step.with["persist-credentials"], false);
        assert.equal(step.env.GIT_CONFIG_VALUE_0, "false");
        assert.equal(step.env.GIT_CONFIG_VALUE_1, "lf");
      }
    }
  }
  const uploads = validation.jobs.verify.steps.filter(step => step.uses?.startsWith("actions/upload-artifact@"));
  assert.deepEqual(uploads.map(step => step.with.name), ["validated-release-candidate", "release-validation-report"]);
});
