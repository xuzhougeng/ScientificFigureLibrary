"use strict";

const { requireValue, exactKeys, boundedText, safeMarkdown } = require("./ai-safety.cjs");

const SKIP_REASONS = ["no_added_value", "already_answered", "visual_context_required",
  "maintainer_decision_required", "insufficient_context", "discussion_too_large"];

// A conservative text-only boundary, not an assessment of the artwork.
function needsVisualContext(title, body) {
  const visualSubject = /\b(?:logo|icon|branding|visual design|appearance)\b|图标|视觉|配色|外观|品牌设计/i.test(title);
  const hasImage = /!\[[^\]]*\]\s*(?:\(|\[)|<img\b/i.test(body);
  return visualSubject && hasImage;
}

function skipDecision(reason) {
  requireValue(SKIP_REASONS.includes(reason), "INVALID_SKIP_REASON");
  return { decision: "skip", reason, message: "", evidence: [] };
}

function issueSources(input) {
  return new Map([
    ["title", input.content.title], ["body", input.content.body],
    ...(input.content.discussion || []).map((comment) => [`comment:${comment.id}`, comment.body]),
  ]);
}

function validateIssueDecision(output, input) {
  exactKeys(output, ["decision", "reason", "message", "evidence"]);
  if (output.decision === "skip") {
    requireValue(output.message === "" && Array.isArray(output.evidence) && output.evidence.length === 0, "SKIP_HAS_PUBLIC_CONTENT");
    return skipDecision(output.reason);
  }
  requireValue(output.decision === "reply", "INVALID_REPLY_DECISION");
  requireValue(!input.skipReason, "ISSUE_REPLY_INELIGIBLE");
  requireValue(["specific_answer", "blocking_question"].includes(output.reason), "INVALID_REPLY_REASON");
  const message = boundedText(output.message, 600);
  requireValue(!/^\s{0,3}#{1,6}\s/m.test(message), "ISSUE_REPLY_HAS_HEADINGS");
  requireValue((message.match(/[?？]/g) || []).length <= 2, "TOO_MANY_ISSUE_QUESTIONS");
  requireValue(Array.isArray(output.evidence) && output.evidence.length >= 1 && output.evidence.length <= 3, "ISSUE_EVIDENCE_REQUIRED");
  const sources = issueSources(input);
  const evidence = output.evidence.map((entry) => {
    exactKeys(entry, ["source", "quote"]);
    const quote = boundedText(entry.quote, 300);
    requireValue(quote.length >= 3 && typeof entry.source === "string" && sources.has(entry.source) &&
      sources.get(entry.source).includes(quote), "ISSUE_EVIDENCE_NOT_IN_SOURCE");
    requireValue(!/\[(?:HTML comment|local path|external URL) omitted\]/.test(quote), "REDACTION_IS_NOT_EVIDENCE");
    return { source: entry.source, quote };
  });
  const normalized = (text) => text.replace(/\s+/g, "").toLowerCase();
  requireValue(![...sources.values()].some((text) => normalized(text).includes(normalized(message))), "ISSUE_REPLY_REPEATS_SOURCE");
  // Literal evidence establishes provenance, not semantic correctness. Novelty
  // and whether a question is already answered still require model judgment.
  return { decision: "reply", reason: output.reason, message, evidence };
}

function renderIssueReply(output) {
  if (output.decision === "skip") return null;
  const prose = output.message.split(/\n\s*\n/).map(safeMarkdown).join("\n\n");
  return ["<!-- issue-triage:v1 -->", "", prose, "", "*AI 辅助回复*"];
}

module.exports = { SKIP_REASONS, needsVisualContext, skipDecision, validateIssueDecision, renderIssueReply };
