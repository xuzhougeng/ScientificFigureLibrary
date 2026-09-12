import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceScript = path.join(repoRoot, "scripts", "check-doc-links.mjs");
const tick = String.fromCharCode(96);
const fence = tick.repeat(3);

function fixture(t: TestContext, files: Record<string, string>) {
  const parent = path.resolve(os.tmpdir());
  const root = fs.mkdtempSync(path.join(parent, "sfl-doc-links-"));
  t.after(() => {
    const target = path.resolve(root);
    assert.ok(target.startsWith(parent + path.sep), "cleanup must stay under the test temp root");
    fs.rmSync(target, { recursive: true, force: true });
  });
  fs.mkdirSync(path.join(root, "scripts"));
  fs.copyFileSync(sourceScript, path.join(root, "scripts", "check-doc-links.mjs"));
  for (const [name, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, name)), { recursive: true });
    fs.writeFileSync(path.join(root, name), body);
  }
  return root;
}

function run(root: string, args: string[] = []) {
  const result = spawnSync(process.execPath, [path.join(root, "scripts", "check-doc-links.mjs"), ...args], {
    cwd: root, encoding: "utf8", timeout: 10_000,
  });
  assert.ifError(result.error);
  return { status: result.status, output: result.stdout + result.stderr };
}

test("default guide link check works without a generated catalog directory", (t) => {
  const root = fixture(t, {
    "README.md": "[Guide](docs/USER_GUIDE.md#guide)\n",
    "README.zh-CN.md": "[手册](docs/USER_GUIDE.zh-CN.md#手册)\n",
    "docs/USER_GUIDE.md": "# Guide\n[Quickstart](QUICKSTART.md#start)\n",
    "docs/USER_GUIDE.zh-CN.md": "# 手册\n[English](USER_GUIDE.md#guide)\n",
    "docs/QUICKSTART.md": "# Start\n",
  });
  assert.equal(fs.existsSync(path.join(root, "docs", "generated")), false);
  const result = run(root);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /checked files: 5/);
});

test("explicit files work without the default guide tree; Unicode and encoded paths resolve", (t) => {
  const root = fixture(t, {
    "entry.md": "[说明](docs/input%20notes.md#中文标题)\n",
    "docs/input notes.md": "# 中文标题\n",
  });
  const result = run(root, ["entry.md"]);
  assert.equal(result.status, 0, result.output);
});

test("missing local targets fail with a useful diagnostic", (t) => {
  const root = fixture(t, { "entry.md": "[Missing](absent.md)\n" });
  const result = run(root, ["entry.md"]);
  assert.equal(result.status, 1);
  assert.match(result.output, /broken link target "absent.md"/);
});

test("missing heading anchors fail", (t) => {
  const root = fixture(t, { "entry.md": "# Present\n[Missing](#absent)\n" });
  const result = run(root, ["entry.md"]);
  assert.equal(result.status, 1);
  assert.match(result.output, /missing anchor "#absent"/);
});

test("duplicate and naturally suffixed headings receive collision-free anchors", (t) => {
  const root = fixture(t, {
    "entry.md": "# Same\n# Same\n# Same-1\n# Same\n[a](#same)\n[b](#same-1)\n[c](#same-1-1)\n[d](#same-2)\n",
  });
  const result = run(root, ["entry.md"]);
  assert.equal(result.status, 0, result.output);
});

test("fenced, inline-code, and commented example links are not treated as real links", (t) => {
  const root = fixture(t, {
    "entry.md": [
      fence + "md", "# Title", "[example](absent.md)", fence,
      "~~~text", "[example](also-absent.md)", "~~~",
      "<!-- [example](comment-only.md) -->",
      tick + "[example](inline-only.md)" + tick,
      "# Title", "[real](#title)",
    ].join("\n"),
  });
  const result = run(root, ["entry.md"]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /local\+external links: 1/);
});

test("a fenced heading cannot satisfy a real heading link", (t) => {
  const root = fixture(t, {
    "entry.md": [fence, "# Fake", fence, "[bad](#fake)"].join("\n"),
  });
  const result = run(root, ["entry.md"]);
  assert.equal(result.status, 1);
  assert.match(result.output, /missing anchor "#fake"/);
});

test("external URLs are counted but never required to be online", (t) => {
  const root = fixture(t, {
    "entry.md": "[external](https://example.invalid/not-contacted)\n[mail](mailto:test@example.invalid)\n",
  });
  const result = run(root, ["entry.md"]);
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /external, not fetched: 2/);
});

test("malformed URL encoding is a diagnostic rather than an uncaught exception", (t) => {
  const root = fixture(t, { "entry.md": "[bad](#%ZZ)\n" });
  const result = run(root, ["entry.md"]);
  assert.equal(result.status, 1);
  assert.match(result.output, /invalid URL encoding/);
  assert.doesNotMatch(result.output, /URIError/);
});

test("a missing explicitly selected file fails", (t) => {
  const root = fixture(t, {});
  const result = run(root, ["absent.md"]);
  assert.equal(result.status, 1);
  assert.match(result.output, /file listed for checking does not exist/);
});

test("real guides and README links pass the offline checker", () => {
  const result = run(repoRoot);
  assert.equal(result.status, 0, result.output);
});

test("both README entries point to the correct online guide in source and package contexts", () => {
  for (const [readme, guide] of [["README.md", "USER_GUIDE.md"], ["README.zh-CN.md", "USER_GUIDE.zh-CN.md"]] as const) {
    const body = fs.readFileSync(path.join(repoRoot, readme), "utf8");
    assert.ok(body.includes("(https://github.com/xuzhougeng/ScientificFigureLibrary/blob/main/docs/" + guide + ")"));
    assert.equal(body.includes("](docs/" + guide + ")"), false);
    assert.ok(fs.existsSync(path.join(repoRoot, "docs", guide)), "online destination exists in the candidate tree");
  }
});

test("bilingual guides preserve the same synthetic CSV and actual module contract", () => {
  const bodies = ["USER_GUIDE.md", "USER_GUIDE.zh-CN.md"].map((name) => fs.readFileSync(path.join(repoRoot, "docs", name), "utf8").replace(/\r\n/g, "\n"));
  const csv = bodies.map((body) => body.split(fence + "csv\n")[1]?.split("\n" + fence)[0]);
  const firstCsv = csv[0];
  assert.ok(firstCsv);
  assert.equal(firstCsv, csv[1]);
  const [header, ...rows] = firstCsv.split("\n");
  assert.equal(header, "Sample_ID,Group,celltype,n");
  const groups = new Map<string, string>();
  const pairs = new Set<string>();
  for (const row of rows) {
    const columns = row.split(",");
    assert.equal(columns.length, 4);
    const [sample, group, celltype, rawCount] = columns as [string, string, string, string];
    assert.ok(["Control", "Treatment"].includes(group));
    assert.ok(["B-cells", "T-cells"].includes(celltype));
    assert.ok(Number.isInteger(Number(rawCount)) && Number(rawCount) >= 0);
    assert.ok(!groups.has(sample) || groups.get(sample) === group);
    groups.set(sample, group);
    const key = sample + ":" + celltype;
    assert.ok(!pairs.has(key));
    pairs.add(key);
  }
  for (const body of bodies) {
    assert.ok(body.includes("b349606d7219b58a80a224e409dfd51928d1329b/modules/sc-celltype-grouped-stacked-bar/data_schema.yml"));
    assert.ok(body.includes("SFL_OUTPUT_DIR"));
    assert.ok(body.includes("render.png"));
    assert.ok(body.includes("SFL_OPEN_FIGURE_AUTO_REFRESH=0"));
    assert.ok(body.includes("ScientificFigureLibrary-personal#current-modules"));
    assert.equal(body.includes("generated/open-figure"), false);
    assert.equal(body.includes("npm run docs:index"), false);
  }
});

test("selected documentation command does not add a catalog-generation path", () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));
  assert.equal(pkg.scripts["docs:check-links"], "node scripts/check-doc-links.mjs");
  assert.equal(pkg.scripts["docs:index"], undefined);
  assert.equal(fs.existsSync(path.join(repoRoot, "scripts", "build-user-guide-index.mjs")), false);
});
