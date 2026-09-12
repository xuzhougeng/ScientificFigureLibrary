"use strict";

const fs = require("node:fs/promises");
const path = require("node:path");
const policy = require("../ai-policy.json");
const { requestModel } = require("./ai-client.cjs");
const { upsertComment, findBotComment } = require("./upsert-comment.cjs");
const { requireValue, safeErrorCode, exactKeys, boundedText, assertNoSecrets,
  sanitizeInput, safeMarkdown, safePath, fingerprint, parseNumber, newSideLines, newSideText, assertCompletePatch } = require("./ai-safety.cjs");

function taskInput(context) {
  const task = context.payload.inputs?.task;
  requireValue(["issue_reply", "pr_review"].includes(task), "INVALID_TASK");
  return { task, number: parseNumber(context.payload.inputs?.number) };
}

async function authorize({ github, context, env }) {
  requireValue(env.AI_ENABLED === "true", "AI_DISABLED");
  requireValue(context.eventName === "workflow_dispatch", "UNTRUSTED_EVENT");
  requireValue(`${context.repo.owner}/${context.repo.repo}` === policy.repository, "UNTRUSTED_REPOSITORY");
  requireValue(context.ref === `refs/heads/${policy.defaultBranch}`, "UNTRUSTED_WORKFLOW_REF");
  const actors = new Set([context.actor, env.GITHUB_TRIGGERING_ACTOR]);
  for (const actor of actors) {
    requireValue(policy.allowedActors.includes(actor), "ACTOR_NOT_AUTHORIZED");
    const { data } = await github.rest.repos.getCollaboratorPermissionLevel({ ...context.repo, username: actor });
    requireValue(["admin", "maintain", "write"].includes(data.permission), "ACTOR_HAS_NO_WRITE_PERMISSION");
  }
  const { data: repo } = await github.rest.repos.get(context.repo);
  requireValue(repo.full_name === policy.repository && repo.private === false && repo.default_branch === policy.defaultBranch,
    "REPOSITORY_POLICY_MISMATCH");
  return taskInput(context);
}

function checkIssue(issue) {
  requireValue(issue.state === "open" && !issue.locked, "ISSUE_OR_PR_NOT_OPEN");
  const labels = (issue.labels || []).map((label) => typeof label === "string" ? label : label.name);
  requireValue(!labels.some((label) => /(?:^|[: /-])security(?:$|[: /-])/i.test(label)), "SECURITY_REPORT_EXCLUDED");
  requireValue(!/\b(?:security|vulnerability|exploit|CVE-\d{4})\b|漏洞|安全报告/i.test(issue.title || ""), "SECURITY_REPORT_EXCLUDED");
  const title = issue.title || "";
  const body = issue.body || "";
  requireValue(title.length <= 500 && body.length <= 30000, "ISSUE_TEXT_TOO_LARGE");
  assertNoSecrets(`${title}\n${body}`);
  return { title, body, labels: labels.sort() };
}

function reviewableFile(filename) {
  safePath(filename);
  if (/(?:^|\/)(?:\.env(?:\..*)?|\.npmrc|\.netrc|id_rsa|id_ed25519|credentials|hosts\.yml)$/i.test(filename)) return false;
  if (/\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|zip|tgz|png|jpe?g|webp|gif|pdf|svg)$/i.test(filename)) return false;
  if (/^(?:assets|dist|release|node_modules)\//.test(filename)) return false;
  if (filename === "package-lock.json" || /^docs\/assets\/figure-gallery\//.test(filename)) return false;
  return /\.(?:[cm]?js|tsx?|md|json|ya?ml|css|html|toml|txt)$/i.test(filename) || /(?:^|\/)CODEOWNERS$/.test(filename);
}

async function collectInput({ github, context, task, number }) {
  const { data: issue } = await github.rest.issues.get({ ...context.repo, issue_number: number });
  const checked = checkIssue(issue);
  requireValue(task === "pr_review" ? Boolean(issue.pull_request) : !issue.pull_request, "TASK_OBJECT_KIND_MISMATCH");
  const content = { title: sanitizeInput(checked.title), body: sanitizeInput(checked.body), files: [], excludedFiles: 0 };
  let baseSha = null;
  let headSha = null;
  if (task === "pr_review") {
    const { data: pr } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
    requireValue(pr.state === "open" && !pr.merged && pr.base?.repo?.full_name === policy.repository &&
      pr.base?.ref === policy.defaultBranch, "PR_BASE_OR_STATE_MISMATCH");
    baseSha = pr.base.sha;
    headSha = pr.head.sha;
    requireValue(/^[a-f0-9]{40}$/.test(baseSha) && /^[a-f0-9]{40}$/.test(headSha), "INVALID_PR_SHA");
    requireValue(Number.isSafeInteger(pr.changed_files) && pr.changed_files > 0 && pr.changed_files <= 200, "PR_TOO_LARGE");
    const files = await github.paginate(github.rest.pulls.listFiles, { ...context.repo, pull_number: number, per_page: 100 });
    requireValue(files.length === pr.changed_files, "PR_FILE_LIST_INCOMPLETE");
    for (const file of files) {
      if (!reviewableFile(file.filename) || file.status === "removed") { content.excludedFiles++; continue; }
      requireValue(typeof file.patch === "string" && file.patch.length > 0, "TEXT_PATCH_MISSING_SPLIT_PR_OR_REVIEW_MANUALLY");
      requireValue(file.patch.length <= policy.maxInputCharacters, "PATCH_TOO_LARGE");
      assertCompletePatch(file.patch, file.additions, file.deletions);
      const patch = sanitizeInput(file.patch);
      const originalLines = newSideText(file.patch);
      const sanitizedLines = newSideText(patch);
      const redactedLines = [...originalLines].filter(([line, text]) => sanitizedLines.get(line) !== text).map(([line]) => line);
      content.files.push({ filename: file.filename, patch, status: file.status, redactedLines });
    }
    requireValue(content.files.length > 0 && content.files.length <= policy.maxFiles, "REVIEWABLE_FILE_COUNT_OUT_OF_RANGE");
    // Detect synchronize/base updates while the paginated file list was fetched.
    const { data: latest } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
    requireValue(latest.head.sha === headSha && latest.base.sha === baseSha, "PR_CHANGED_DURING_READ");
  }
  const sourceKey = fingerprint({ ...checked, baseSha, headSha, policy });
  const input = { schema: "sfl.ai-input.v1", repository: policy.repository, task, number,
    sourceKey, headSha, baseSha, content };
  requireValue(JSON.stringify(input).length <= policy.maxInputCharacters, "MODEL_INPUT_TOO_LARGE");
  return input;
}

function validateOutput(output, input) {
  assertNoSecrets(JSON.stringify(output));
  const strings = (values) => {
    requireValue(Array.isArray(values) && values.length <= 8, "INVALID_LIST_LENGTH");
    return values.map((value) => boundedText(value, 1200));
  };
  if (input.task === "issue_reply") {
    exactKeys(output, ["summary", "missing_information", "next_steps"]);
    return { summary: boundedText(output.summary), missing_information: strings(output.missing_information), next_steps: strings(output.next_steps) };
  }
  exactKeys(output, ["summary", "findings"]);
  requireValue(Array.isArray(output.findings) && output.findings.length <= policy.maxFindings, "INVALID_FINDING_COUNT");
  const findings = output.findings.map((finding) => {
    exactKeys(finding, ["severity", "file", "line", "problem", "evidence", "impact", "suggestion", "confidence"]);
    requireValue(["blocker", "high", "medium", "low", "informational"].includes(finding.severity), "INVALID_SEVERITY");
    requireValue(Number.isFinite(finding.confidence) && finding.confidence >= 0 && finding.confidence <= 1, "INVALID_CONFIDENCE");
    const file = input.content.files.find((candidate) => candidate.filename === safePath(finding.file));
    requireValue(file && Number.isSafeInteger(finding.line) && newSideLines(file.patch).has(finding.line), "FINDING_OUTSIDE_DIFF");
    requireValue(!(file.redactedLines || []).includes(finding.line), "FINDING_ON_REDACTED_LINE");
    const evidence = boundedText(finding.evidence, 1000);
    requireValue(evidence.length >= 3 && !/[\r\n]/.test(evidence) && newSideText(file.patch).get(finding.line).includes(evidence), "FINDING_WITHOUT_LITERAL_EVIDENCE");
    requireValue(!/\[(?:HTML comment|local path|external URL) omitted\]/.test(evidence), "REDACTION_IS_NOT_CODE_EVIDENCE");
    return { severity: finding.severity, file: file.filename, line: finding.line,
      problem: boundedText(finding.problem, 1200), evidence,
      impact: boundedText(finding.impact, 1200), suggestion: boundedText(finding.suggestion, 1200), confidence: finding.confidence };
  }).filter((finding) => finding.confidence >= policy.minimumConfidence);
  return { summary: boundedText(output.summary), findings };
}

function renderComment(output, input) {
  const lines = input.task === "issue_reply" ? [
    "<!-- issue-triage:v1 -->", "", "## 反馈整理与下一步", "",
    "感谢反馈。以下为基于当前公开信息的辅助建议；尚未复现、未确定根因，也不承诺修复时间。", "",
    safeMarkdown(output.summary), "", "### 建议补充的信息",
    ...(output.missing_information.length ? output.missing_information.map((text) => `- ${safeMarkdown(text)}`) : ["- 暂无额外信息请求；由维护者继续判断。"]),
    "", "### 下一步", ...output.next_steps.map((text) => `- ${safeMarkdown(text)}`),
    "", "请勿提供 API Key、token、私有数据或原始 Library/诊断包。此回复不是最终处理结论。",
  ] : [
    "<!-- pr-review:v1 -->", "", "## AI 辅助审查（仅建议）", "",
    `审查提交：\`${input.headSha}\`；基线：\`${input.baseSha}\`。`,
    `范围：${input.content.files.length} 个文本文件；排除 ${input.content.excludedFiles} 个生成、敏感、二进制或删除文件。`,
    "未执行代码或测试；脱敏改写的行不作为代码证据；不是全仓安全审计，不构成人工批准。", "", safeMarkdown(output.summary), "",
    ...(output.findings.length ? output.findings.flatMap((finding, index) => [
      `### ${index + 1}. ${finding.severity} — ${safeMarkdown(finding.file)}:${finding.line}`,
      `- 问题：${safeMarkdown(finding.problem)}`,
      `- 证据：${safeMarkdown(finding.evidence)}`,
      `- 影响：${safeMarkdown(finding.impact)}`,
      `- 建议：${safeMarkdown(finding.suggestion)}`,
      `- 置信度：${finding.confidence.toFixed(2)}`, "",
    ]) : ["本次返回中没有通过证据与置信度校验的 finding；这不代表没有缺陷或可以合并。"]),
    "", "请由人工 reviewer 核验建议，并以确定性 CI 与仓库保护规则决定是否合并。",
  ];
  const body = [...lines, "", `<!-- sfl-ai-source:v1 ${input.sourceKey} -->`].join("\n");
  requireValue(body.length <= 50000, "COMMENT_TOO_LARGE");
  return body;
}

async function prepare({ github, context, env = process.env }) {
  const { task, number } = await authorize({ github, context, env });
  const input = await collectInput({ github, context, task, number });
  const marker = task === "issue_reply" ? "<!-- issue-triage:v1 -->" : "<!-- pr-review:v1 -->";
  const existing = await findBotComment({ github, repo: context.repo, number, marker });
  if (existing?.body?.includes(`<!-- sfl-ai-source:v1 ${input.sourceKey} -->`)) {
    return { number, task, files: input.content.files.length, skip: true };
  }
  requireValue(Boolean(env.RUNNER_TEMP), "RUNNER_TEMP_MISSING");
  await fs.writeFile(path.join(env.RUNNER_TEMP, "sfl-ai-input.json"), JSON.stringify(input), { encoding: "utf8", mode: 0o600 });
  return { number, task, files: input.content.files.length, skip: false };
}

async function generateResult(input, env, dependencies = {}) {
  requireValue(input.schema === "sfl.ai-input.v1" && input.repository === policy.repository, "INVALID_INPUT_ENVELOPE");
  requireValue(["issue_reply", "pr_review"].includes(input.task), "INVALID_TASK");
  const output = validateOutput(await requestModel(input, policy, env, dependencies), input);
  renderComment(output, input);
  return { schema: "sfl.ai-result.v1", repository: policy.repository, task: input.task, number: input.number,
    sourceKey: input.sourceKey, runId: String(env.GITHUB_RUN_ID), runAttempt: String(env.GITHUB_RUN_ATTEMPT),
    model: policy.model, output };
}

function verifyResultEnvelope(result, input, env) {
  exactKeys(result, ["schema", "repository", "task", "number", "sourceKey", "runId", "runAttempt", "model", "output"]);
  requireValue(result.schema === "sfl.ai-result.v1" && result.repository === policy.repository && result.model === policy.model,
    "RESULT_POLICY_MISMATCH");
  requireValue(result.task === input.task && result.number === input.number && result.sourceKey === input.sourceKey, "STALE_OR_WRONG_RESULT");
  requireValue(result.runId === String(env.GITHUB_RUN_ID) && result.runAttempt === String(env.GITHUB_RUN_ATTEMPT), "RESULT_RUN_MISMATCH");
  return validateOutput(result.output, input);
}

async function publish({ github, context, env = process.env, log = () => {} }) {
  const { task, number } = await authorize({ github, context, env });
  const input = await collectInput({ github, context, task, number });
  requireValue(Boolean(env.RUNNER_TEMP), "RUNNER_TEMP_MISSING");
  const file = path.join(env.RUNNER_TEMP, "sfl-ai-result", "result.json");
  const stat = await fs.lstat(file);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= policy.maxResponseBytes, "INVALID_RESULT_ARTIFACT");
  const result = JSON.parse(await fs.readFile(file, "utf8"));
  const output = verifyResultEnvelope(result, input, env);
  return upsertComment({ github, repo: context.repo, number,
    marker: task === "issue_reply" ? "<!-- issue-triage:v1 -->" : "<!-- pr-review:v1 -->",
    body: renderComment(output, input), log,
    assertFresh: async () => {
      // Recheck permissions and source immediately before the GitHub write.
      await authorize({ github, context, env });
      const latest = await collectInput({ github, context, task, number });
      requireValue(latest.sourceKey === input.sourceKey, "SOURCE_CHANGED_BEFORE_COMMENT");
    },
  });
}

async function main() {
  requireValue(process.argv[2] === "generate" && Boolean(process.env.RUNNER_TEMP), "INVALID_CLI_INVOCATION");
  const file = path.join(process.env.RUNNER_TEMP, "sfl-ai-input.json");
  const stat = await fs.lstat(file);
  requireValue(stat.isFile() && !stat.isSymbolicLink() && stat.size <= policy.maxInputCharacters * 4, "INVALID_INPUT_FILE");
  const input = JSON.parse(await fs.readFile(file, "utf8"));
  const result = await generateResult(input, process.env);
  const directory = path.join(process.env.RUNNER_TEMP, "sfl-ai-result");
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(path.join(directory, "result.json"), JSON.stringify(result), { encoding: "utf8", mode: 0o600 });
  console.log(JSON.stringify({ operation: "model_completed", task: result.task, number: result.number, model: result.model }));
}

if (require.main === module) main().catch((error) => { console.error(safeErrorCode(error)); process.exitCode = 1; });

module.exports = { taskInput, authorize, checkIssue, reviewableFile, collectInput, validateOutput,
  renderComment, prepare, generateResult, verifyResultEnvelope, publish };
