"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("yaml");
const policy = require("../ai-policy.json");
const root = path.resolve(__dirname, "../..");
function workflow(name) {
  const doc = yaml.parseDocument(fs.readFileSync(path.join(root, ".github/workflows", name), "utf8"), { uniqueKeys: true });
  assert.deepEqual(doc.errors, []);
  return doc.toJS();
}

test("only allowlisted manual main dispatches can reach either bot job", () => {
  const ai = workflow("ai-assist.yml");
  assert.deepEqual(Object.keys(ai.on), ["workflow_dispatch"]);
  assert.deepEqual(Object.keys(ai.on.workflow_dispatch.inputs).sort(), ["number", "task"]);
  assert.deepEqual(ai.on.workflow_dispatch.inputs.task.options, ["issue_reply", "pr_review"]);
  assert.deepEqual(ai.permissions, {});
  for (const job of Object.values(ai.jobs)) {
    assert.ok(job.if.includes(`github.repository == '${policy.repository}'`));
    assert.ok(job.if.includes(`github.ref == 'refs/heads/${policy.defaultBranch}'`));
    assert.ok(job.if.includes("vars.AI_ENABLED == 'true'"));
    for (const actorField of ["github.actor", "github.triggering_actor"]) {
      const expression = new RegExp("contains\\(fromJSON\\('([^']+)'\\), " + actorField.replaceAll(".", "\\.") + "\\)");
      assert.deepEqual(JSON.parse(job.if.match(expression)[1]), policy.allowedActors);
    }
    assert.ok(job["timeout-minutes"] <= 10);
  }
  assert.equal(ai.concurrency["cancel-in-progress"], false);
  assert.ok(ai.concurrency.group.includes("inputs.number"));
});

test("model key is isolated from comment write permission; checkout stays on dispatch SHA", () => {
  const ai = workflow("ai-assist.yml");
  assert.equal(ai.jobs.infer.environment, "ai-assist");
  assert.deepEqual(ai.jobs.infer.permissions, { contents: "read", issues: "read", "pull-requests": "read" });
  assert.equal(ai.jobs.publish.environment, undefined);
  assert.deepEqual(ai.jobs.publish.permissions, { contents: "read", issues: "write", "pull-requests": "read" });
  assert.equal(ai.jobs.publish.needs, "infer");
  assert.ok(!JSON.stringify(ai.jobs.publish).includes("secrets."));
  assert.ok(!JSON.stringify(ai.env).includes("secrets."));
  for (const key of ["AI_ENABLED", "AI_BASE_URL", "AI_MODEL", "AI_API_STYLE"]) {
    assert.equal(ai.env[key], "${{ vars." + key + " }}");
  }
  let keySteps = 0;
  for (const job of Object.values(ai.jobs)) {
    for (const step of job.steps) {
      const text = JSON.stringify(step);
      assert.ok(!/npm (?:ci|install)|pull_request\.head|pull_request_target/.test(text));
      assert.ok(!/\$\{\{\s*(?:inputs\.|github\.event\.)/.test(step.run || step.with?.script || ""));
      if (text.includes("secrets.")) {
        keySteps++;
        assert.equal(step.run, "node .github/scripts/ai-assist.cjs generate");
        assert.equal(step.env.AI_API_KEY, "${{ secrets.AI_API_KEY }}");
      }
      if (step.uses) assert.match(step.uses, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
      if (step.uses?.startsWith("actions/checkout@")) {
        assert.equal(step.with.ref, "${{ github.sha }}");
        assert.equal(step.with["persist-credentials"], false);
      }
      if (step.with?.script) {
        assert.equal(step.with.retries, 0);
        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
        assert.doesNotThrow(() => new AsyncFunction("github", "context", "core", "require", step.with.script));
      }
    }
  }
  assert.equal(keySteps, 1);
  const upload = ai.jobs.infer.steps.find((step) => step.uses?.startsWith("actions/upload-artifact@"));
  const download = ai.jobs.publish.steps.find((step) => step.uses?.startsWith("actions/download-artifact@"));
  assert.equal(upload.with.name, download.with.name);
  assert.ok(upload.with.name.includes("github.run_id") && upload.with.name.includes("github.run_attempt"));
  assert.equal(upload.with["retention-days"], 1);
});

test("base CI validates bot behavior offline and does not require the live model", () => {
  const ci = workflow("ci.yml");
  assert.ok(ci.jobs["test-build"].steps.some((step) => step.run === "node --test .github/tests/*.test.cjs"));
  assert.ok(!JSON.stringify(ci).includes("secrets."));
  assert.deepEqual(ci.jobs["ci-required"].needs, ["test-build"]);
});
