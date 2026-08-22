import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  applyGlobalWorkspaceBinding,
  inspectWorkspaceDirectory,
  planGlobalWorkspaceBinding,
  WorkspaceRuntime,
} from "../src/workspace-runtime.ts";

test("empty workspace apply creates inbox/drafts/gallery and persists locator", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-workspace-runtime-"));
  const locatorPath = path.join(root, "workspace-locator.json");
  const workspaceDirectory = path.join(root, "draft-db");
  const unbound = new WorkspaceRuntime({ locatorPath });
  const before = await unbound.current();
  assert.equal(before.confirmed, false);
  assert.equal(before.directorySource, "unbound");

  const plan = await planGlobalWorkspaceBinding({ workspaceDirectory, locatorPath });
  assert.equal(plan.willCreateSkeleton, true);
  const applied = await applyGlobalWorkspaceBinding(plan, "workspace-first-bind");
  assert.equal(applied.createdSkeleton, true);
  assert.equal(applied.workspaceDirectory, workspaceDirectory);

  const after = await new WorkspaceRuntime({ locatorPath }).current();
  assert.equal(after.confirmed, true);
  assert.equal(after.directory, workspaceDirectory);
  for (const relative of ["inbox", "drafts", "gallery", "registry", "workspace.yml"]) {
    await fs.stat(path.join(workspaceDirectory, relative));
  }
  assert.equal((await inspectWorkspaceDirectory(workspaceDirectory)).kind, "workspace-v1");
});

test("existing plot-gallery binds without rewriting files", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-workspace-plot-"));
  const locatorPath = path.join(root, "workspace-locator.json");
  const workspaceDirectory = path.join(root, "plot");
  await fs.mkdir(path.join(workspaceDirectory, "config"), { recursive: true });
  await fs.mkdir(path.join(workspaceDirectory, "drafts"), { recursive: true });
  await fs.mkdir(path.join(workspaceDirectory, "gallery"), { recursive: true });
  await fs.writeFile(path.join(workspaceDirectory, "config", "gallery.yml"), "schema_version: personal-r-gallery-config/v1\n");
  const sentinel = path.join(workspaceDirectory, "AGENTS.md");
  await fs.writeFile(sentinel, "keep me\n");

  const plan = await planGlobalWorkspaceBinding({ workspaceDirectory, locatorPath });
  assert.equal(plan.workspaceKind, "plot-gallery");
  assert.equal(plan.willCreateSkeleton, false);
  const applied = await applyGlobalWorkspaceBinding(plan, "workspace-plot-bind");
  assert.equal(applied.createdSkeleton, false);
  assert.equal(await fs.readFile(sentinel, "utf8"), "keep me\n");
  assert.equal((await new WorkspaceRuntime({ locatorPath }).current()).confirmed, true);
});

test("foreign non-empty directories are rejected", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-workspace-foreign-"));
  const locatorPath = path.join(root, "workspace-locator.json");
  const workspaceDirectory = path.join(root, "mcp-middle");
  await fs.mkdir(workspaceDirectory);
  await fs.writeFile(path.join(workspaceDirectory, "package.json"), "{}\n");
  await assert.rejects(
    () => planGlobalWorkspaceBinding({ workspaceDirectory, locatorPath }),
    /not a recognized inbox\/drafts\/gallery/u,
  );
});
