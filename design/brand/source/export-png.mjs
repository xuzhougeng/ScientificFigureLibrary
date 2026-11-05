#!/usr/bin/env node
// Rasterize the app icons from design/brand/svg to exact-size transparent PNGs.
//
// Usage: node design/brand/source/export-png.mjs
// Needs a Chromium browser. Set SFL_BROWSER if Edge is not at its default Windows path.
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const repo = path.resolve(import.meta.dirname, "../../..");
const browser = process.env.SFL_BROWSER ?? "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe";
const win = "desktop/windows/shell/winres";
// [source SVG, output, canvas size, inset]
const jobs = [
  ["01-app-primary.svg", `${win}/icon.png`, 256, 0],
  ["10-icon-64.svg", `${win}/icon-64.png`, 64, 0],
  ["10-icon-64.svg", `${win}/icon-48.png`, 48, 0],
  ["11-icon-32.svg", `${win}/icon-32.png`, 32, 0],
  ["12-icon-24.svg", `${win}/icon-24.png`, 24, 0],
  ["13-icon-16.svg", `${win}/icon-16.png`, 16, 0],
  // macOS: the icon body is 824 px on a 1024 px transparent canvas.
  ["01-app-primary.svg", "desktop/macos/AppIcon.png", 1024, 100],
];
const payload = jobs.map(([svg, output, size, inset]) => ({
  output,
  size,
  inset,
  src: `data:image/svg+xml;base64,${readFileSync(path.join(repo, "design/brand/svg", svg)).toString("base64")}`,
}));

const work = mkdtempSync(path.join(os.tmpdir(), "sfl-icon-export-"));
try {
  const page = path.join(work, "export.html");
  writeFileSync(page, `<!doctype html><meta charset="utf-8"><pre id="out"></pre><script>
const jobs=${JSON.stringify(payload)};
(async()=>{const r=[];for(const j of jobs){const i=new Image();await new Promise((ok,no)=>{i.onload=ok;i.onerror=no;i.src=j.src});
const c=document.createElement('canvas');c.width=c.height=j.size;const x=c.getContext('2d');x.imageSmoothingQuality='high';
x.drawImage(i,j.inset,j.inset,j.size-2*j.inset,j.size-2*j.inset);r.push({output:j.output,data:c.toDataURL('image/png').split(',')[1]})}
document.getElementById('out').textContent='BEGIN'+JSON.stringify(r)+'END'})();
</script>`);
  const dom = execFileSync(
    browser,
    ["--headless=new", "--disable-gpu", `--user-data-dir=${path.join(work, "profile")}`, "--virtual-time-budget=8000", "--dump-dom", `file:///${page.replaceAll("\\", "/")}`],
    { encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "ignore"] },
  );
  // Anchored on the <pre>: the dumped DOM also contains the script's own BEGIN/END literals.
  const match = dom.match(/<pre id="out">BEGIN(.*?)END<\/pre>/s);
  if (!match) throw new Error("The browser produced no icon data");
  for (const { output, data } of JSON.parse(match[1])) {
    writeFileSync(path.join(repo, output), Buffer.from(data, "base64"));
    console.log(output);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
