#!/usr/bin/env node
// Offline, repeatable Markdown link checker for the user guide and READMEs.
// Validates repository-relative links (files and heading anchors) using
// GitHub-style slug rules. External http(s) links are collected but never
// fetched, so the check works without network access.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const DEFAULT_FILES = [
  "README.md",
  "README.zh-CN.md",
  "docs/USER_GUIDE.md",
  "docs/USER_GUIDE.zh-CN.md",
  "docs/QUICKSTART.md",
  ...fs
    .readdirSync(path.join(repoRoot, "docs", "generated"), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".md"))
    .map((e) => `docs/generated/${e.name}`)
    .sort(),
];

const files = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_FILES;

// GitHub slugger: lowercase; drop characters that are not letters, numbers,
// spaces, or hyphens (Unicode-aware, so CJK survives); spaces become hyphens.
function slug(heading) {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function headingSlugs(markdown) {
  const slugs = new Map();
  const counts = new Map();
  for (const line of markdown.split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (!match) continue;
    const text = match[2]
      .replace(/`([^`]*)`/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*/g, "");
    let s = slug(text);
    const n = counts.get(s) ?? 0;
    counts.set(s, n + 1);
    if (n > 0) s = `${s}-${n}`;
    slugs.set(s, true);
  }
  return slugs;
}

const anchorCache = new Map();
function anchorsFor(mdPath) {
  const key = path.resolve(mdPath).toLowerCase();
  if (!anchorCache.has(key)) {
    const markdown = fs.readFileSync(mdPath, "utf8");
    anchorCache.set(key, headingSlugs(markdown));
  }
  return anchorCache.get(key);
}

let links = 0;
let external = 0;
const failures = [];

for (const relFile of files) {
  const absFile = path.join(repoRoot, relFile);
  if (!fs.existsSync(absFile)) {
    failures.push(`${relFile}: file listed for checking does not exist`);
    continue;
  }
  const markdown = fs.readFileSync(absFile, "utf8");
  const linkPattern = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const match of markdown.matchAll(linkPattern)) {
    const raw = match[1];
    links += 1;
    if (/^https?:\/\//i.test(raw) || /^(mailto|data):/i.test(raw)) {
      external += 1;
      continue;
    }
    let anchor;
    let absTarget;
    if (raw.startsWith("#")) {
      anchor = decodeURIComponent(raw.slice(1));
      absTarget = absFile;
    } else {
      const [targetRaw, anchorRaw] = raw.split("#", 2);
      const target = decodeURIComponent(targetRaw ?? "");
      anchor = anchorRaw ? decodeURIComponent(anchorRaw) : null;
      absTarget = path.resolve(path.dirname(absFile), target);
      if (!fs.existsSync(absTarget)) {
        failures.push(`${relFile}: broken link target "${raw}"`);
        continue;
      }
    }
    if (anchor && fs.statSync(absTarget).isFile() && absTarget.endsWith(".md")) {
      if (!anchorsFor(absTarget).has(anchor)) {
        failures.push(`${relFile}: missing anchor "#${anchor}" in ${path.relative(repoRoot, absTarget)}`);
      }
    }
  }
}

console.log(`checked files: ${files.length}`);
console.log(`local+external links: ${links} (external, not fetched: ${external})`);
if (failures.length) {
  console.error(`failures: ${failures.length}`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log("all links and anchors OK");
