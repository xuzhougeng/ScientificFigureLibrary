import { spawn } from "node:child_process";
import { watch } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as esbuild from "esbuild";

const root = fileURLToPath(new URL("../", import.meta.url));
const noOpen = process.argv.includes("--no-open") || process.env.SFL_NO_BROWSER === "1";
const watchers = [];
const pending = new Set();
let local;
let buildProcess;
let timer;
let busy = false;
let stopping = false;
let generation = 0;

function run(script, args = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(root, script), ...args], {
      cwd: root, stdio: "inherit", windowsHide: true,
    });
    buildProcess = child;
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (buildProcess === child) buildProcess = undefined;
      if (code === 0) resolve();
      else reject(new Error(`${script} exited with ${signal ?? code}`));
    });
  });
}

async function rebuildBackend() {
  await run("scripts/esbuild-server.mjs");
  await esbuild.build({
    absWorkingDir: root,
    stdin: {
      contents: 'export { startLocalHttp } from "./src/local/http.ts"; export { openBrowser } from "./src/local/launch.ts";',
      resolveDir: root, sourcefile: "dev-entry.ts", loader: "ts",
    },
    bundle: true, platform: "node", format: "esm", target: "node22",
    outfile: path.join(root, "dist/dev-runtime.mjs"),
    banner: { js: 'import { createRequire as __nodeCreateRequire } from "node:module"; const require = __nodeCreateRequire(import.meta.url);' },
  });
  if (stopping) return;
  const runtime = await import(`${pathToFileURL(path.join(root, "dist/dev-runtime.mjs")).href}?generation=${++generation}`);
  await local?.close();
  local = undefined;
  if (stopping) return;
  local = await runtime.startLocalHttp();
  const url = local.openUrl();
  console.log(`\n[dev] Local client: ${url}`);
  console.log("[dev] Backend restarted. Use this new link; previous plans and sessions have expired.");
  if (!noOpen && !stopping) {
    try { await runtime.openBrowser(url); }
    catch (error) { console.error(`[dev] Open the link above in your browser: ${error.message}`); }
  }
}

async function drain() {
  if (busy || stopping || pending.size === 0) return;
  busy = true;
  const changes = new Set(pending);
  pending.clear();
  try {
    console.log(`\n[dev] Building ${[...changes].join(" + ")}…`);
    await run("node_modules/typescript/bin/tsc", ["--noEmit"]);
    if (stopping) return;
    // Shared app modules can also affect the optional MCP view.
    if (changes.has("frontend") || changes.has("backend")) {
      await run("node_modules/vite/bin/vite.js", ["build", "--emptyOutDir", "false"]);
      await run("node_modules/vite/bin/vite.js", ["build", "--config", "vite.local.config.ts"]);
    }
    if (stopping) return;
    if (changes.has("backend") || !local) await rebuildBackend();
    else console.log("[dev] Frontend updated. Refresh the browser to view changes (no HMR).");
    console.log("[dev] Watching app/, src/, skills/, assets/ and build configuration. Ctrl+C to stop.");
  } catch (error) {
    if (!stopping) console.error(`[dev] ${error.message}\n[dev] Fix the error and save to retry.`);
  } finally {
    busy = false;
    if (pending.size && !stopping) void drain();
  }
}

function schedule(kind) {
  if (stopping) return;
  pending.add(kind);
  clearTimeout(timer);
  timer = setTimeout(() => void drain(), 200);
}

async function stop() {
  if (stopping) return;
  stopping = true;
  clearTimeout(timer);
  for (const watcher of watchers) watcher.close();
  buildProcess?.kill();
  // Let an in-progress start/build settle before closing its service.
  while (busy) await new Promise((resolve) => setTimeout(resolve, 50));
  await local?.close();
  console.log("\n[dev] Stopped.");
}

process.once("SIGINT", () => void stop());
process.once("SIGTERM", () => void stop());
for (const [directory, kind] of [["app", "frontend"], ["src", "backend"], ["skills", "backend"], ["assets", "backend"]]) {
  watchers.push(watch(path.join(root, directory), { recursive: true }, () => schedule(kind)));
}
for (const file of ["package.json", "tsconfig.json", "vite.config.ts", "vite.local.config.ts", "scripts/esbuild-server.mjs"]) {
  watchers.push(watch(path.join(root, file), () => schedule("backend")));
}
console.log("[dev] Uses your configured local library. Set FIGURE_LIBRARY_DIR and FIGURE_WORKSPACE_DIR for a separate development library.");
pending.add("backend");
await drain();
