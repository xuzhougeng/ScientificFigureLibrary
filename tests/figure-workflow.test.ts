import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { unzipSync } from "fflate";
import { StyleProfileStore } from "../src/style-profile.ts";
import { ProjectFigures, type ArchiveDetailsValue } from "../src/project-figures.ts";
import { safeRelative } from "../src/workflow-storage.ts";
import { digest } from "../src/workflow-storage.ts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerFigureWorkflowTools } from "../src/figure-workflow-tools.ts";
import { WorkspaceRuntime } from "../src/workspace-runtime.ts";

async function temp(t: TestContext) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-workflow-"));
  t.after(() => fs.rm(root, { recursive: true, force: true })); return root;
}
const details: ArchiveDetailsValue = {
  purpose: "Compare measured values for two example groups", dataDescription: "Synthetic plot data: group and value; no missing values; values in arbitrary units.",
  scriptDescription: "Read plot-data.csv and generate an SVG bar chart, without upstream analysis.",
  environment: `Verified in Node ${process.version}; no external dependencies or fonts required.`, parameters: { width: 200, height: 100 },
  provenanceNotes: "Locally authored synthetic fixture; no original experimental measurements are included.", runCommand: "node scripts/plot.mjs",
  execution: "succeeded", executionNotes: "Executed locally; SVG bars and dimensions checked.", scope: "Plotting source data and code only; no raw experimental data.",
  changes: "Initial local fixture revision", externalDependencies: [], originalScript: "none", panelLabelInArtwork: null,
};
const script = `import fs from 'node:fs';
const rows = fs.readFileSync('data/plot-data.csv', 'utf8').trim().split('\\n').slice(1).map(r => r.split(','));
fs.mkdirSync('outputs', {recursive:true});
fs.writeFileSync('outputs/plot.svg', '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100">' + rows.map((r,i) => '<rect x="'+(i*80+10)+'" y="'+(100-Number(r[1])*10)+'" width="40" height="'+(Number(r[1])*10)+'" fill="#16846a"/>').join('') + '</svg>');
`;
const chineseTranslation = {
  files: [], labels: [], verified: true, notes: "已验证英文代码与当前图标签，科学含义保持不变。",
  readmeSections: { purpose: "比较两组样本的示例数值。", dataDescription: "人工合成作图数据，包含组名与数值，无缺失值，单位为任意单位。", scriptDescription: "读取作图数据后生成柱状图，不执行上游分析。", environment: `已验证 Node ${process.version}，不需要额外依赖。`, provenanceNotes: "本地创建的合成样例，无原始实验数据。", executionNotes: "已在本地执行，检查了 SVG 尺寸与柱形。", scope: "包含作图数据与代码，不包含原始实验材料。", changes: "首次生成本地样例修订。" },
  fileDescriptions: { "data/plot-data.csv": "合成分组数值", "scripts/plot.mjs": "实际绘图脚本", "outputs/plot.svg": "已渲染的柱状图" },
};
async function fixture(t: TestContext) {
  const root = await temp(t); const project = new ProjectFigures(root);
  const plan = await project.plan([{ title: "Example comparison", slug: "example-comparison" }]);
  const state = await project.apply(plan); const figure = state.figures[0]!; const work = path.join(root, figure.directory);
  await fs.mkdir(path.join(work, "data")); await fs.mkdir(path.join(work, "scripts"));
  await fs.writeFile(path.join(work, "data/plot-data.csv"), "group,value\nA,4\nB,7\n");
  await fs.writeFile(path.join(work, "scripts/plot.mjs"), script);
  await promisify(execFile)(process.execPath, ["scripts/plot.mjs"], { cwd: work });
  const artifacts = [
    { path: "data/plot-data.csv", role: "plot_data" as const, description: "Synthetic group values", source: { kind: "local" as const, reference: "Synthetic fixture created for this project" } },
    { path: "scripts/plot.mjs", role: "plot_script" as const, description: "Actual plotting script", source: { kind: "generated" as const, reference: "Authored locally for this example" } },
    { path: "outputs/plot.svg", role: "output" as const, description: "Rendered bar chart", source: { kind: "generated" as const, reference: "scripts/plot.mjs and data/plot-data.csv" } },
  ];
  const renderEvidence = { verifiedAt: new Date().toISOString(), files: Object.fromEntries(await Promise.all(artifacts.map(async (a) => [a.path, digest(await fs.readFile(path.join(work, a.path)))]))) };
  return { root, project, figure, work, artifacts, renderDetails: { ...details, renderEvidence } };
}

test("style settings survive a new store; current overrides and faithful template take priority", async (t) => {
  const root = await temp(t); const store = new StyleProfileStore(root);
  await store.save({ expectedRevision: 0, name: "Lab", settings: { fontFamily: "Arial", colors: { A: "#0000ff", B: "#ff8800" }, size: { width: 85, unit: "mm" }, export: { formats: ["pdf", "png"], rasterDpi: 600 } } });
  const fresh = new StyleProfileStore(root);
  const resolved = await fresh.resolve({ fontFamily: "serif" }, { colors: { B: "#aa0000" } });
  assert.equal(resolved.effective.fontFamily, "Arial"); assert.deepEqual(resolved.effective.colors, { A: "#0000ff", B: "#aa0000" });
  assert.equal((await fresh.read()).settings.colors!.B, "#ff8800");
  assert.equal((await fresh.resolve({ fontFamily: "serif" }, {}, true)).effective.fontFamily, "serif");
  await assert.rejects(fresh.save({ expectedRevision: 0, name: "stale", settings: {} }), /changed/);
  await assert.rejects(fresh.save({ expectedRevision: 1, name: "invalid", settings: { size: { width: -1, unit: "mm" } } }));
  await fresh.reset(1); assert.equal((await new StyleProfileStore(root).read()).enabled, false);
  assert.equal((await fresh.read()).revision, 2);
});

test("plan eight panels, exchange B/C atomically, find aliases and reject duplicate names and stale writes", async (t) => {
  const root = await temp(t); const p = new ProjectFigures(root);
  const state = await p.apply(await p.plan("ABCDEFGH".split("").map((panel) => ({ title: `Panel ${panel}`, label: { figure: 1, panel } }))));
  assert.equal(state.figures.length, 8); assert.ok(state.figures.every((f) => f.revision === 0));
  const b = state.figures[1]!; const c = state.figures[2]!;
  await fs.writeFile(path.join(root, b.directory, "marker.txt"), "B-data");
  await fs.writeFile(path.join(root, c.directory, "marker.txt"), "C-data");
  const swap = await p.plan([{ id: b.id, title: b.title, slug: c.slug, label: c.label }, { id: c.id, title: c.title, slug: b.slug, label: b.label }]);
  await p.apply(swap);
  assert.equal(await fs.readFile(path.join(root, c.directory, "marker.txt"), "utf8"), "B-data");
  assert.equal(await fs.readFile(path.join(root, b.directory, "marker.txt"), "utf8"), "C-data");
  assert.equal((await new ProjectFigures(root).list(b.id)).figures[0]!.label!.panel, "C");
  assert.equal((await p.list("Figure 1B")).ambiguous, true);
  await assert.rejects(p.apply(swap), /Stale/);
  await assert.rejects(p.plan([{ title: "Panel A", slug: state.figures[0]!.slug }]), /conflict/);
  for (const bad of ["../escape", "CON", "a\\b", "x:stream", "trailing.", "/absolute"]) assert.throws(() => safeRelative(bad));
});

test("archive ZIP is self contained and reproduces the same figure after unpacking", async (t) => {
  const { root, project, figure, artifacts, renderDetails } = await fixture(t);
  const result = await project.archive(figure.id, 0, artifacts, renderDetails);
  assert.equal(result.complete, true);
  const translation = { files: [], labels: [], verified: true, notes: "Generated code is English; no artwork labels need translation.", readmeSections: {
    purpose: details.purpose, dataDescription: details.dataDescription, scriptDescription: details.scriptDescription, environment: details.environment,
    provenanceNotes: details.provenanceNotes, executionNotes: details.executionNotes, scope: details.scope, changes: details.changes,
  } };
  const plan = await project.planExport(figure.id, "en", translation);
  const exported = await project.applyExport(plan, translation);
  const unpack = path.join(root, "unpacked"); await fs.mkdir(unpack);
  const files = unzipSync(await fs.readFile(exported.path));
  for (const [name, bytes] of Object.entries(files)) { await fs.mkdir(path.dirname(path.join(unpack, name)), { recursive: true }); await fs.writeFile(path.join(unpack, name), bytes); }
  const before = await fs.readFile(path.join(unpack, "outputs/plot.svg"));
  await fs.unlink(path.join(unpack, "outputs/plot.svg"));
  await promisify(execFile)(process.execPath, ["scripts/plot.mjs"], { cwd: unpack });
  assert.deepEqual(await fs.readFile(path.join(unpack, "outputs/plot.svg")), before);
  assert.match(Buffer.from(files["README.md"]!).toString(), /Identity and purpose/);
  assert.equal(JSON.parse(Buffer.from(files["manifest.json"]!).toString()).exportLocale, "en");
  await assert.rejects(project.applyExport(plan, translation), /EEXIST/);
  const zh = await project.applyExport(await project.planExport(figure.id, "zh-CN", chineseTranslation), chineseTranslation);
  assert.notEqual(zh.path, exported.path);
  assert.match(Buffer.from(unzipSync(await fs.readFile(zh.path))["README.md"]!).toString(), /图的身份与目的/);
});

test("incomplete renders, unknown sources, tampering and stale language preparation cannot export", async (t) => {
  const { project, figure, artifacts, work, renderDetails } = await fixture(t);
  const failed = await project.archive(figure.id, 0, artifacts, { ...details, execution: "failed" });
  assert.equal(failed.complete, false);
  const translation = chineseTranslation;
  await assert.rejects(project.planExport(figure.id, "zh-CN", translation), /incomplete/);
  const good = await project.archive(figure.id, 1, artifacts, renderDetails);
  await fs.writeFile(path.join(good.archiveDirectory, "data/plot-data.csv"), "tampered");
  assert.equal((await project.check(figure.id)).complete, false);
  await assert.rejects(project.planExport(figure.id, "zh-CN", translation), /Changed file/);
  await project.archive(figure.id, 2, artifacts, renderDetails);
  const plan = await project.planExport(figure.id, "zh-CN", translation);
  await fs.writeFile(path.join(work, "data/plot-data.csv"), "group,value\nA,1\nB,2\n");
  await assert.rejects(project.archive(figure.id, 3, artifacts, renderDetails), /changed since verified render/);
  await project.archive(figure.id, 3, artifacts, { ...renderDetails, execution: "not_run" });
  await assert.rejects(project.applyExport(plan, translation), /incomplete|changed/);
});

test("renaming a rendered panel preserves its ID and revisions but requires rerendering artwork letters", async (t) => {
  const { project, figure, artifacts, renderDetails } = await fixture(t);
  await project.apply(await project.plan([{ id: figure.id, title: figure.title, label: { figure: 1, panel: "B" } }]));
  await project.archive(figure.id, 0, artifacts, { ...renderDetails, panelLabelInArtwork: "B" });
  await project.apply(await project.plan([{ id: figure.id, title: "Updated comparison", label: { figure: 2, panel: "C" } }]));
  const found = (await project.list(figure.id)).figures[0]!;
  assert.equal(found.id, figure.id); assert.equal(found.history.length, 1);
  assert.equal(found.artworkLabelPending, true);
  assert.ok((await project.check(figure.id)).errors.some((e) => e.includes("panel label")));
});

test("all twelve workflow MCP tools expose terminal outcomes and complete an isolated workflow", async (t) => {
  const { root, figure, artifacts, renderDetails } = await fixture(t);
  const server = new McpServer({ name: "workflow-test", version: "1.0.0" });
  const runtime = new WorkspaceRuntime({ env: { FIGURE_WORKSPACE_DIR: root }, locatorPath: path.join(root, "workspace-locator.json") });
  registerFigureWorkflowTools(server, runtime, new StyleProfileStore(path.join(root, "user-settings")));
  const client = new Client({ name: "workflow-client", version: "1.0.0" });
  const [a, b] = InMemoryTransport.createLinkedPair(); await server.connect(b); await client.connect(a);
  t.after(async () => { await client.close(); await server.close(); });
  const called = new Set<string>();
  async function call(suffix: string, args: Record<string, unknown> = {}) {
    const name = `figure_library_${suffix}`; called.add(name);
    const result = await client.callTool({ name, arguments: args });
    assert.notEqual(result.isError, true, JSON.stringify(result));
    const data = result.structuredContent as Record<string, unknown>;
    assert.equal((data.envelope as Record<string, unknown>).terminal, true);
    return data;
  }
  await call("get_style_profile");
  await call("save_style_profile", { expectedRevision: 0, name: "Lab", settings: { fontFamily: "Arial" } });
  await call("resolve_style"); await call("reset_style_profile", { expectedRevision: 1 });
  await call("list_project_figures");
  const change = await call("plan_project_figures", { changes: [{ title: "Another plot", slug: "another-plot" }] });
  await call("apply_project_figures", { planDigest: change.digest });
  await call("archive_project_figure", { figureId: figure.id, expectedRevision: 0, artifacts, details: renderDetails });
  await call("check_project_figure", { figureId: figure.id });
  await call("prepare_submission", { figureId: figure.id, locale: "zh-CN", translation: chineseTranslation });
  const plan = await call("plan_submission_export", { figureId: figure.id, locale: "zh-CN" });
  await call("apply_submission_export", { planDigest: plan.digest });
  assert.deepEqual([...called].sort(), (await client.listTools()).tools.map((v) => v.name).sort());
});

test("rename failure restores both data and index, while concurrent creates cannot share a path", async (t) => {
  const root = await temp(t); const project = new ProjectFigures(root);
  const first = await project.apply(await project.plan([{ title: "Original", slug: "original" }]));
  const figure = first.figures[0]!;
  await fs.writeFile(path.join(root, figure.directory, "data.txt"), "unchanged");
  const plan = await project.plan([{ id: figure.id, title: "Renamed", slug: "renamed" }]);
  await fs.mkdir(path.join(root, "figures/renamed"));
  await assert.rejects(project.apply(plan), /Destination appeared/);
  assert.equal((await project.list(figure.id)).figures[0]!.slug, "original");
  assert.equal(await fs.readFile(path.join(root, figure.directory, "data.txt"), "utf8"), "unchanged");
  const a = await project.plan([{ title: "Concurrent", slug: "concurrent" }]);
  const b = await project.plan([{ title: "Concurrent", slug: "concurrent" }]);
  const results = await Promise.allSettled([project.apply(a), new ProjectFigures(root).apply(b)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal((await project.list()).figures.length, 2);
});

test("missing README, unknown provenance and external local-only dependencies remain incomplete", async (t) => {
  const { project, figure, artifacts, renderDetails } = await fixture(t);
  const badSource = artifacts.map((a) => ({ ...a, source: { kind: "unknown" as const, reference: "Unknown origin" } }));
  let archived = await project.archive(figure.id, 0, badSource, renderDetails);
  assert.ok(archived.errors.some((e) => e.includes("Unknown source")));
  archived = await project.archive(figure.id, 1, artifacts, { ...renderDetails, externalDependencies: [{ reference: "project-data/raw.bin", description: "Shared experiment", availability: "local_only" }] });
  assert.equal(archived.selfContained, false); assert.equal(archived.complete, false);
  archived = await project.archive(figure.id, 2, artifacts, renderDetails);
  await fs.unlink(path.join(archived.archiveDirectory, "README.md"));
  assert.ok((await project.check(figure.id)).errors.some((e) => e.includes("README.md")));
});

test("working metadata write failure never publishes a new archive revision", async (t) => {
  const { project, figure, artifacts, renderDetails, work } = await fixture(t);
  const before = await fs.readFile(path.join(work, "README.md"), "utf8");
  await fs.mkdir(path.join(work, "environment.txt"));
  await assert.rejects(project.archive(figure.id, 0, artifacts, renderDetails));
  assert.equal((await project.list(figure.id)).figures[0]!.revision, 0);
  assert.equal(await fs.readFile(path.join(work, "README.md"), "utf8"), before);
});
