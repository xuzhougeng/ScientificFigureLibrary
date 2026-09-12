"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const yaml = require("yaml");
const { verifyEnvironment } = require("../scripts/verify-ci-environment.cjs");
const root = path.resolve(__dirname, "../..");
const read = (file) => fs.readFileSync(path.join(root, file), "utf8");
const parse = (file) => {
  const doc = yaml.parseDocument(read(file), { uniqueKeys: true });
  assert.deepEqual(doc.errors, [], file);
  return doc.toJS();
};

test("CI runs the same mandatory gate on PR, main push and merge group", () => {
  const ci = parse(".github/workflows/ci.yml");
  assert.deepEqual(Object.keys(ci.on).sort(), ["merge_group", "pull_request", "push"]);
  assert.deepEqual(ci.on.merge_group.types, ["checks_requested"]);
  assert.deepEqual(ci.permissions, { contents: "read" });
  assert.ok(ci.concurrency["cancel-in-progress"].includes("!= 'merge_group'"));
  assert.equal(ci.jobs["ci-required"].name, "SFL / CI required");
  assert.ok(ci.jobs["ci-required"].if.includes("always()"));
  assert.deepEqual(ci.jobs["ci-required"].needs, ["quality", "test-build", "packages"]);
  assert.ok(ci.jobs["ci-required"].steps[0].run.includes('-ne "success"'));
  assert.equal(ci.on.pull_request.paths, undefined);
  assert.equal(ci.jobs["test-build"].strategy["fail-fast"], false);
  assert.equal(ci.jobs["test-build"].strategy.matrix.include.length, 4);
  assert.equal(ci.jobs["dependency-audit"]["continue-on-error"], true);
  assert.ok(!read(".github/workflows/ci.yml").includes("secrets."));
});

test("AI workflow is main-only, allowlisted, manual, disabled unless explicitly enabled", () => {
  const ai = parse(".github/workflows/ai-assist.yml");
  assert.deepEqual(Object.keys(ai.on), ["workflow_dispatch"]);
  assert.deepEqual(ai.permissions, {});
  assert.deepEqual(ai.on.workflow_dispatch.inputs.task.options, ["issue_reply", "pr_review"]);
  for (const job of Object.values(ai.jobs)) {
    assert.ok(job.if.includes("github.ref == 'refs/heads/main'"));
    assert.ok(job.if.includes("github.actor == 'jarxunlai'"));
    assert.ok(job.if.includes("github.triggering_actor == 'jarxunlai'"));
    assert.ok(job.if.includes("vars.AI_ENABLED == 'true'"));
    assert.ok(job["timeout-minutes"] <= 10);
    assert.ok(!JSON.stringify(job).includes("npm ci"));
    assert.ok(!JSON.stringify(job).includes("pull_request.head"));
    assert.ok(!JSON.stringify(job).includes("pull_request_target"));
  }
  assert.equal(ai.jobs.infer.environment, "ai-assist");
  assert.deepEqual(ai.jobs.infer.permissions, { contents: "read", issues: "read", "pull-requests": "read" });
  assert.deepEqual(ai.jobs.publish.permissions, { contents: "read", issues: "write", "pull-requests": "read" });
  assert.ok(!JSON.stringify(ai.jobs.publish).includes("secrets."));
  assert.equal(ai.jobs.publish.environment, undefined);
  assert.equal(ai.jobs.publish.needs, "infer");
  assert.equal(ai.concurrency["cancel-in-progress"], false);
});

test("CI pins LF only for checkout without overriding fixture Git configuration", () => {
  const ci = parse(".github/workflows/ci.yml");
  assert.equal(ci.env.GIT_CONFIG_COUNT, undefined);
  for (const job of Object.values(ci.jobs)) {
    assert.equal(job.env?.GIT_CONFIG_COUNT, undefined);
    for (const step of job.steps) {
      if (step.uses?.startsWith("actions/checkout@")) {
        const env = { ...process.env, ...step.env };
        assert.equal(execFileSync("git", ["config", "--get", "core.autocrlf"], { env, encoding: "utf8" }).trim(), "false");
        assert.equal(execFileSync("git", ["config", "--get", "core.eol"], { env, encoding: "utf8" }).trim(), "lf");
        assert.equal(step.env.GIT_CONFIG_COUNT, "2");
      } else {
        assert.equal(step.env?.GIT_CONFIG_COUNT, undefined);
      }
    }
  }
});

test("matrix fixtures use a canonical isolated temp root, not runner user aliases", () => {
  const ci = parse(".github/workflows/ci.yml");
  const steps = ci.jobs["test-build"].steps;
  const isolate = steps.findIndex((step) => step.name === "Isolate application state");
  const verify = steps.findIndex((step) => step.run === "node .github/scripts/verify-ci-environment.cjs");
  const tests = steps.findIndex((step) => step.name === "Run unit and integration tests");
  assert.ok(isolate < verify && verify < tests);
  assert.ok(steps[isolate].run.includes("realpathSync(process.argv[1])"));
  assert.ok(steps[isolate].run.includes("@('TMPDIR', 'TEMP', 'TMP')"));
});

test("CI environment preflight rejects converted snapshots and noncanonical temp paths", () => {
  const tempDirectory = path.join(root, "virtual-temp");
  const filesystem = {
    realpathSync: (file) => file,
    readFileSync: () => JSON.stringify({ catalog: { bytes: 374 }, previewManifest: { bytes: 131 } }),
    statSync: (file) => ({ size: file.endsWith("preview-manifest.json") ? 131 : 374 }),
  };
  assert.deepEqual(verifyEnvironment({ root, tempDirectory, filesystem }), {
    canonicalTemp: true, snapshotBytes: { "catalog.json": 374, "preview-manifest.json": 131 },
  });
  assert.throws(() => verifyEnvironment({ root, tempDirectory,
    filesystem: { ...filesystem, statSync: () => ({ size: 999 }) } }), /checkout changed/);
  assert.throws(() => verifyEnvironment({ root, tempDirectory,
    filesystem: { ...filesystem, realpathSync: () => path.join(root, "different-long-path") } }), /already be canonical/);
});

test("new workflows pin actions, disable persisted Git credentials and avoid PR checkout", () => {
  for (const file of [".github/workflows/ci.yml", ".github/workflows/ai-assist.yml"]) {
    const workflow = parse(file);
    for (const job of Object.values(workflow.jobs)) {
      for (const step of job.steps) {
        if (step.uses) assert.match(step.uses, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
        if (step.uses?.startsWith("actions/checkout@")) {
          assert.equal(step.with["persist-credentials"], false);
          if (file.includes("ai-assist")) assert.equal(step.with.ref, "${{ github.sha }}");
        }
        if (step.uses?.startsWith("actions/github-script@")) assert.equal(step.with.retries, 0);
      }
    }
  }
});

test("every CI npm command exists; automation tests run without a new dependency", () => {
  const scripts = JSON.parse(read("package.json")).scripts;
  const ci = parse(".github/workflows/ci.yml");
  for (const job of Object.values(ci.jobs)) {
    for (const step of job.steps) {
      for (const match of (step.run || "").matchAll(/npm run ([\w:-]+)/g)) assert.ok(scripts[match[1]], match[1]);
    }
  }
  assert.ok(ci.jobs.quality.steps.some((step) => step.run === "node --test .github/tests/*.test.cjs"));
  assert.equal(parse(".github/dependabot.yml").updates.length, 2);
});

test("Issue Forms parse, have unique ids and only reference existing default labels", () => {
  for (const name of ["bug", "feature", "question"]) {
    const form = parse(`.github/ISSUE_TEMPLATE/${name}.yml`);
    assert.ok(form.name && form.description && form.title);
    assert.ok(form.labels.every((label) => ["bug", "enhancement", "question"].includes(label)));
    const fields = form.body.filter((field) => field.type !== "markdown");
    assert.equal(new Set(fields.map((field) => field.id)).size, fields.length);
    assert.ok(fields.every((field) => field.attributes.label));
  }
  assert.equal(parse(".github/ISSUE_TEMPLATE/config.yml").blank_issues_enabled, false);
  assert.ok(!fs.existsSync(path.join(root, ".github/ISSUE_TEMPLATE/security.yml")));
});
