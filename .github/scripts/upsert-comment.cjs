"use strict";

const { SafeError, requireValue } = require("./ai-safety.cjs");

async function findBotComment({ github, repo, number, marker }) {
  requireValue(/^<!-- (?:issue-triage|pr-summary|pr-review|ci-status):v1 -->$/.test(marker), "INVALID_COMMENT_MARKER");
  const { data: bot } = await github.rest.users.getByUsername({ username: "github-actions[bot]" });
  requireValue(bot.type === "Bot" && Number.isSafeInteger(bot.id), "INVALID_BOT_IDENTITY");
  const comments = await github.paginate(github.rest.issues.listComments, { ...repo, issue_number: number, per_page: 100 });
  return comments.filter((comment) => comment.user?.id === bot.id && comment.user?.type === "Bot" &&
    comment.body?.startsWith(`${marker}\n`)).sort((a, b) => a.id - b.id)[0];
}

async function upsertComment({ github, repo, number, marker, body, assertFresh, log = () => {} }) {
  requireValue(body.startsWith(`${marker}\n`) && body.length <= 50000, "INVALID_COMMENT_BODY");
  const current = await findBotComment({ github, repo, number, marker });
  await assertFresh();
  if (current?.body === body) {
    log({ operation: "unchanged", commentId: current.id, number });
    return { operation: "unchanged", id: current.id };
  }
  if (current) {
    // A later manual rerun safely retries an idempotent PATCH after API failures.
    const { data } = await github.rest.issues.updateComment({ ...repo, comment_id: current.id, body });
    log({ operation: "updated", commentId: data.id, number });
    return { operation: "updated", id: data.id };
  }
  try {
    const { data } = await github.rest.issues.createComment({ ...repo, issue_number: number, body });
    log({ operation: "created", commentId: data.id, number });
    return { operation: "created", id: data.id };
  } catch (error) {
    // Do not blindly repeat POST: a timeout may have happened after creation.
    const recovered = await findBotComment({ github, repo, number, marker });
    if (recovered?.body === body) {
      log({ operation: "recovered", commentId: recovered.id, number });
      return { operation: "recovered", id: recovered.id };
    }
    throw new SafeError(error.status === 403 ? "COMMENT_WRITE_FORBIDDEN" :
      error.status === 429 ? "COMMENT_RATE_LIMITED_RERUN_LATER" : "COMMENT_CREATE_UNCERTAIN_DO_NOT_BLINDLY_RETRY");
  }
}

module.exports = { findBotComment, upsertComment };
