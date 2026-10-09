"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const yaml = require("yaml");
const { diagnose } = require("../scripts/npm-diagnostics.cjs");
const root = path.resolve(__dirname, "../..");
const success = value => ({ exitCode: 0, stdout: JSON.stringify(value), stderr: "" });
const metadata = success({ name: "scientific-figure-library", maintainers: ["hoptoper <private@example.invalid>"], "dist-tags": { latest: "0.8.1" } });

function runner(identity, access) {
  const calls = [];
  return { calls, run: async (args, authenticated) => {
    calls.push({ args, authenticated });
    if (args[0] === "--version") return { exitCode: 0, stdout: "10.9.9\n", stderr: "" };
    if (args[0] === "view") return metadata;
    if (args[0] === "whoami") return identity;
    if (args[0] === "access") return access;
    throw new Error("unexpected command");
  } };
}

test("rejected credential stops privileged probes and exposes only an error category", async () => {
  const secret = "npm_synthetic_secret_never_log";
  const mocked = runner({ exitCode: 1, stdout: JSON.stringify({ error: { code: "E401", summary: `invalid token ${secret}` } }), stderr: `expired ${secret}` });
  const report = await diagnose({ run: mocked.run, tokenPresent: true, secret });
  assert.equal(report.authentication.errorCode, "E401");
  assert.equal(report.authentication.status, "authentication_rejected");
  assert.equal(report.authentication.mentionsTokenExpiryOrRevocation, true);
  assert.equal(report.publishAttempted, false);
  assert.deepEqual(mocked.calls.map(call => call.args[0]), ["--version", "view", "whoami"]);
  assert.equal(mocked.calls[1].authenticated, false);
  assert.ok(!JSON.stringify(report).includes(secret));
  assert.ok(!JSON.stringify(report).includes("private@example.invalid"));
});

test("valid identity emits only the requested package permission and does not assert publish authorization", async () => {
  const mocked = runner(success("hoptoper"), success({ "scientific-figure-library": "read-write", "unrelated-private-package": "read-write" }));
  const report = await diagnose({ run: mocked.run, tokenPresent: true });
  assert.equal(report.authentication.username, "hoptoper");
  assert.equal(report.authentication.listedMaintainer, true);
  assert.equal(report.packageAccess.permission, "read-write");
  assert.ok(report.publicationAuthorization.startsWith("not_proven"));
  assert.ok(!JSON.stringify(report).includes("unrelated-private-package"));
  assert.equal(mocked.calls.every(call => ["--version", "view", "whoami", "access"].includes(call.args[0])), true);
});

test("missing credentials never trigger authenticated requests", async () => {
  const mocked = runner();
  const report = await diagnose({ run: mocked.run, tokenPresent: false });
  assert.equal(report.authentication.status, "token_missing");
  assert.equal(mocked.calls.some(call => call.authenticated), false);
});

test("diagnostic workflow stays on the authorized branch, read-only and separate from secret-free quality CI", () => {
  const read = name => yaml.parse(fs.readFileSync(path.join(root, ".github/workflows", name), "utf8"));
  const ci = read("ci.yml");
  assert.ok(!JSON.stringify(ci).includes("secrets."));
  const flow = read("npm-diagnostics.yml");
  assert.deepEqual(Object.keys(flow.on).sort(), ["push", "workflow_dispatch"]);
  assert.deepEqual(flow.on.push.branches, ["codex/npm-publish-diagnostics"]);
  assert.ok(flow.jobs.diagnose.if.includes("github.repository == 'xuzhougeng/ScientificFigureLibrary'"));
  assert.ok(flow.jobs.diagnose.if.includes("github.ref == 'refs/heads/codex/npm-publish-diagnostics'"));
  assert.deepEqual(flow.permissions, { contents: "read" });
  const authenticated = flow.jobs.diagnose.steps.filter(step => step.env?.NODE_AUTH_TOKEN);
  assert.equal(authenticated.length, 1);
  assert.equal(authenticated[0].env.NODE_AUTH_TOKEN, "${{ secrets.NPM_TOKEN }}");
  const text = JSON.stringify(flow);
  for (const command of ["npm publish", "npm login", "npm install", "npm ci", "gh release", "git push", "id-token"]) assert.ok(!text.includes(command));
  for (const step of flow.jobs.diagnose.steps) if (step.uses) assert.match(step.uses, /^[\w-]+\/[\w-]+@[a-f0-9]{40}$/);
  const upload = flow.jobs.diagnose.steps.find(step => step.uses?.startsWith("actions/upload-artifact@"));
  assert.equal(upload.with.path, "${{ runner.temp }}/sfl-npm-auth/report.json");
  assert.equal(upload.if, "${{ always() }}");
});
