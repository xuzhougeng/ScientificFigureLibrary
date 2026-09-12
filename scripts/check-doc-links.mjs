#!/usr/bin/env node
// Offline Markdown link/heading check for README, user guides, and QUICKSTART.
// No catalog generation, module downloads, or external HTTP requests.
// This intentionally supports inline Markdown links and ATX headings, not
// every Markdown/HTML extension; passing is not a browser or host smoke test.

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
];
const files = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_FILES;

// Ignore example links/headings inside fenced code and HTML comments.
function prose(markdown) {
  let fence;
  return markdown.replace(/<!--[\s\S]*?-->/g, "").split(/\r?\n/).map((line) => {
    const match = /^ {0,3}(\x60{3,}|~{3,})(.*)$/.exec(line);
    if (fence) {
      if (match && match[1][0] === fence.char && match[1].length >= fence.length && !match[2].trim()) {
        fence = undefined;
      }
      return "";
    }
    if (match) {
      fence = { char: match[1][0], length: match[1].length };
      return "";
    }
    return line;
  }).join("\n");
}

function slug(heading) {
  return heading.trim().toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

function headingSlugs(markdown) {
  const used = new Set();
  for (const line of prose(markdown).split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
    if (!match) continue;
    const text = match[2]
      .replace(/\s+#+\s*$/, "")
      .replace(/\x60([^\x60]*)\x60/g, "$1")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*/g, "");
    const base = slug(text);
    let candidate = base;
    let suffix = 0;
    while (used.has(candidate)) candidate = base + "-" + (++suffix);
    used.add(candidate);
  }
  return used;
}

const anchorCache = new Map();
function anchorsFor(mdPath) {
  const key = path.resolve(mdPath);
  if (!anchorCache.has(key)) anchorCache.set(key, headingSlugs(fs.readFileSync(mdPath, "utf8")));
  return anchorCache.get(key);
}

let links = 0;
let external = 0;
const failures = [];
for (const relFile of files) {
  const absFile = path.resolve(repoRoot, relFile);
  if (!fs.existsSync(absFile) || !fs.statSync(absFile).isFile()) {
    failures.push(relFile + ": file listed for checking does not exist");
    continue;
  }
  const markdown = prose(fs.readFileSync(absFile, "utf8"))
    .replace(/(\x60+)[^\x60\n]*?\1/g, "");
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
    try {
      if (raw.startsWith("#")) {
        anchor = decodeURIComponent(raw.slice(1));
        absTarget = absFile;
      } else {
        const [targetRaw, anchorRaw] = raw.split("#", 2);
        const target = decodeURIComponent(targetRaw ?? "");
        anchor = anchorRaw ? decodeURIComponent(anchorRaw) : null;
        absTarget = path.resolve(path.dirname(absFile), target);
      }
    } catch {
      failures.push(relFile + ': invalid URL encoding in "' + raw + '"');
      continue;
    }
    if (!fs.existsSync(absTarget)) {
      failures.push(relFile + ': broken link target "' + raw + '"');
      continue;
    }
    if (anchor && fs.statSync(absTarget).isFile() && /\.md$/i.test(absTarget)) {
      if (!anchorsFor(absTarget).has(anchor)) {
        failures.push(relFile + ': missing anchor "#' + anchor + '" in ' + path.relative(repoRoot, absTarget));
      }
    }
  }
}

console.log("checked files: " + files.length);
console.log("local+external links: " + links + " (external, not fetched: " + external + ")");
if (failures.length) {
  console.error("failures: " + failures.length);
  for (const failure of failures) console.error("  - " + failure);
  process.exit(1);
}
console.log("all supported local links and anchors OK");
