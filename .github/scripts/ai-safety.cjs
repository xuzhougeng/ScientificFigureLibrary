"use strict";

const { createHash } = require("node:crypto");

class SafeError extends Error {
  constructor(code) {
    super(code);
    this.name = "SafeError";
    this.code = code;
  }
}

function requireValue(condition, code) {
  if (!condition) throw new SafeError(code);
}

function safeErrorCode(error) {
  return error instanceof SafeError ? error.code : "UNEXPECTED_FAILURE_DETAILS_WITHHELD";
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exactKeys(value, keys) {
  requireValue(object(value), "INVALID_OUTPUT_OBJECT");
  requireValue(Object.keys(value).every((key) => keys.includes(key)), "UNEXPECTED_OUTPUT_FIELD");
  requireValue(keys.every((key) => Object.hasOwn(value, key)), "MISSING_OUTPUT_FIELD");
}

function boundedText(value, max = 2000) {
  requireValue(typeof value === "string" && value.trim().length > 0 && value.length <= max, "INVALID_TEXT_LENGTH");
  return value.trim();
}

// Deliberately fail closed for recognizable credentials; do not log matches.
// Heuristics cannot guarantee that arbitrary public input contains no secrets.
function assertNoSecrets(text, exactSecret) {
  const value = String(text);
  const signatures = [
    /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/i,
    /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/,
    /\b(?:sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{25,}|AKIA[A-Z0-9]{16})\b/,
    /\bBearer\s+[A-Za-z0-9._~+\/-]{16,}/i,
    /["']?(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)["']?\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{16,}/i,
    /https?:\/\/[^\s/]+:[^\s/]+@/i,
    /[?&](?:api[_-]?key|token|access_token|secret)=[^\s&#]{8,}/i,
  ];
  requireValue(!signatures.some((pattern) => pattern.test(value)), "POSSIBLE_SECRET_CONTENT_BLOCKED");
  if (exactSecret) requireValue(!value.includes(exactSecret), "MODEL_KEY_ECHO_BLOCKED");
}

function sanitizeInput(value) {
  assertNoSecrets(value);
  return String(value)
    .replace(/<!--[\s\S]*?-->/g, (comment) => comment.split("\n")
      .map((line, index) => `${index === 0 ? "" : (line.match(/^[ +\-]/)?.[0] || "")}[HTML comment omitted]`).join("\n"))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, "")
    .replace(/\b[A-Za-z]:\\[^\s<>"']+/g, "[local path omitted]")
    .replace(/\/(?:home|Users)\/[^\s<>"']+/g, "[local path omitted]")
    .replace(/https?:\/\/[^\s<>"']+/g, "[external URL omitted]");
}

function safeMarkdown(value) {
  return String(value)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/g, " ")
    .replace(/https?:\/\/[^\s<>"']+/g, "[URL omitted]")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/@/g, "＠")
    .replace(/[\\`*_{}\[\]()#!|~]/g, "\\$&");
}

function safePath(value) {
  requireValue(typeof value === "string" && value.length > 0 && value.length <= 500, "INVALID_FILE_PATH");
  requireValue(!/[\\\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/.test(value), "INVALID_FILE_PATH");
  requireValue(!value.startsWith("/") && !/^[A-Za-z]:/.test(value), "INVALID_FILE_PATH");
  requireValue(value.split("/").every((part) => part && part !== "." && part !== ".."), "INVALID_FILE_PATH");
  return value;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function parseNumber(value) {
  requireValue(/^[1-9][0-9]{0,8}$/.test(String(value)), "INVALID_ISSUE_OR_PR_NUMBER");
  return Number(value);
}

function newSideText(patch) {
  const lines = new Map();
  let current = null;
  for (const text of patch.split("\n")) {
    const header = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(text);
    if (header) { current = Number(header[1]); continue; }
    if (current === null || text.startsWith("\\") || text.startsWith("-")) continue;
    if (text.startsWith("+") || text.startsWith(" ")) lines.set(current++, text.slice(1));
  }
  return lines;
}

function newSideLines(patch) { return new Set(newSideText(patch).keys()); }

function assertCompletePatch(patch, additions, deletions) {
  requireValue(Number.isSafeInteger(additions) && Number.isSafeInteger(deletions) && additions >= 0 && deletions >= 0,
    "PATCH_STATISTICS_MISSING");
  let oldRemaining = 0;
  let newRemaining = 0;
  let observedAdditions = 0;
  let observedDeletions = 0;
  let hunks = 0;
  for (const line of patch.split("\n")) {
    const header = /^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@/.exec(line);
    if (header) {
      requireValue(oldRemaining === 0 && newRemaining === 0, "PATCH_TRUNCATED");
      oldRemaining = header[1] === undefined ? 1 : Number(header[1]);
      newRemaining = header[2] === undefined ? 1 : Number(header[2]);
      hunks++;
    } else if (line.startsWith("+")) { newRemaining--; observedAdditions++; }
    else if (line.startsWith("-")) { oldRemaining--; observedDeletions++; }
    else if (line.startsWith(" ")) { oldRemaining--; newRemaining--; }
    else if (!line.startsWith("\\") && line !== "") requireValue(false, "PATCH_FORMAT_UNSUPPORTED");
    requireValue(oldRemaining >= 0 && newRemaining >= 0, "PATCH_FORMAT_UNSUPPORTED");
  }
  requireValue(hunks > 0 && oldRemaining === 0 && newRemaining === 0 &&
    observedAdditions === additions && observedDeletions === deletions, "PATCH_TRUNCATED");
}

module.exports = { SafeError, requireValue, safeErrorCode, object, exactKeys, boundedText,
  assertNoSecrets, sanitizeInput, safeMarkdown, safePath, fingerprint, parseNumber, newSideLines, newSideText, assertCompletePatch };
