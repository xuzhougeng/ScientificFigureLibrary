"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("yaml");

const root = path.resolve(__dirname, "../..");

function workflow(name) {
  const doc = yaml.parseDocument(fs.readFileSync(path.join(root, ".github/workflows", name), "utf8"), {
    uniqueKeys: true,
  });
  assert.deepEqual(doc.errors, []);
  return doc.toJS();
}

function pinAction(uses) {
  assert.match(uses, /^[\w-]+\/[\w-]+@[a-f0-9]{40}(?:\s+#.+)?$/);
}

test("GitHub Release publishes the v0.8.0 asset set only from a stable tag", () => {
  const release = workflow("release.yml");
  assert.deepEqual(Object.keys(release.on).sort(), ["push", "workflow_dispatch"]);
  assert.deepEqual(release.on.push.tags, ["v[0-9]+.[0-9]+.[0-9]+"]);
  assert.equal(release.on.push.branches, undefined);
  assert.equal(release.on.workflow_dispatch.inputs.tag.required, true);
  assert.equal(release.concurrency["cancel-in-progress"], false);
  assert.deepEqual(release.permissions, { contents: "read", actions: "read", checks: "read" });
  assert.deepEqual(release.jobs.validate.outputs.tag, "${{ steps.check.outputs.tag }}");
  assert.deepEqual(release.jobs.validate.outputs.sha, "${{ steps.check.outputs.sha }}");
  assert.deepEqual(release.jobs.plugins.needs, ["validate"]);
  assert.deepEqual(release.jobs["local-clients"].needs, ["validate"]);
  assert.equal(release.jobs["local-clients"].uses, "./.github/workflows/local-clients.yml");
  assert.equal(release.jobs["local-clients"].with.ref, "${{ needs.validate.outputs.sha }}");
  assert.deepEqual(release.jobs.publish.needs, ["validate", "plugins", "local-clients"]);
  assert.deepEqual(release.jobs.publish.permissions, {
    contents: "write",
    actions: "read",
    "id-token": "write",
  });
  assert.equal(release.jobs.publish.env.GH_TOKEN, "${{ github.token }}");

  const plugins = JSON.stringify(release.jobs.plugins);
  const publish = JSON.stringify(release.jobs.publish);
  assert.ok(plugins.includes("npm run package:plugins"));
  assert.ok(plugins.includes("npm run package:npm"));
  assert.ok(plugins.includes("scientific-figure-library-wisp-update.json"));
  assert.ok(publish.includes("github-release.mjs prepare"));
  assert.ok(publish.includes("github-release-create.json"));
  assert.ok(publish.includes("github-release-update.json"));
  assert.ok(publish.includes("gh api --method POST"));
  assert.ok(publish.includes("gh api --method PATCH"));
  assert.ok(publish.includes("--clobber"));
  assert.ok(publish.includes("npm publish"));
  assert.ok(publish.includes("secrets.NPM_TOKEN"));
  assert.ok(publish.includes("--provenance"));
  assert.ok(!publish.includes("gh release create"));
  assert.ok(!publish.includes("--notes-file"));
  assert.ok(JSON.stringify(release.jobs.validate).includes("SFL / CI required"));

  for (const job of Object.values(release.jobs)) {
    if (job.uses) {
      assert.match(job.uses, /^\.\/\.github\/workflows\/[A-Za-z0-9._-]+\.yml$/);
      assert.deepEqual(job.permissions, { contents: "read" });
      continue;
    }
    for (const step of job.steps) {
      if (!step.uses) continue;
      pinAction(step.uses);
      if (step.uses.startsWith("actions/checkout@")) {
        assert.equal(step.with["persist-credentials"], false);
      }
    }
  }
});

test("local-client packaging can be called by the GitHub Release workflow", () => {
  const local = workflow("local-clients.yml");
  assert.equal(local.on.workflow_call.inputs.ref.required, false);
  assert.equal(local.on.workflow_call.inputs.ref.type, "string");
  assert.ok(local.on.push.branches.includes("main"));
  assert.deepEqual(local.permissions, { contents: "read" });
  for (const job of Object.values(local.jobs)) {
    const checkout = job.steps.find((step) => step.uses?.startsWith("actions/checkout@"));
    assert.equal(checkout.with.ref, "${{ inputs.ref || github.sha }}");
    assert.equal(checkout.with["persist-credentials"], false);
  }
});

test("quality CI still does not upload GitHub Release assets", () => {
  const ci = workflow("ci.yml");
  const text = JSON.stringify(ci);
  assert.ok(!text.includes("package:plugins"));
  assert.ok(!text.includes("gh release"));
  assert.deepEqual(ci.permissions, { contents: "read" });
});
