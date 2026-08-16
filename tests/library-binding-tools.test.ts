import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  registerLibraryBindingTools,
  type CurrentLibraryContext,
} from "../src/library-binding-tools.ts";
import {
  LibraryRuntime,
  defaultLibraryLocatorPath,
  readLibraryRootMarker,
} from "../src/library-runtime.ts";
import { VersionedTemplateLibrary } from "../src/versioned-library.ts";

function record(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function text(value: unknown) {
  const content = record(value).content;
  assert.ok(Array.isArray(content));
  return content
    .map((item) => {
      const block = record(item);
      return block.type === "text" && typeof block.text === "string" ? block.text : "";
    })
    .filter(Boolean)
    .join("\n");
}

test("text-only hosts can bind the global Library using cached planDigest", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-binding-tools-"));
  const priorConfig = process.env.XDG_CONFIG_HOME;
  const priorOverride = process.env.FIGURE_LIBRARY_DIR;
  process.env.XDG_CONFIG_HOME = path.join(root, "config");
  delete process.env.FIGURE_LIBRARY_DIR;
  const libraryDirectory = path.join(root, "portable-library");
  const runtime = new LibraryRuntime();
  const contexts = new Map<string, CurrentLibraryContext>();
  const currentLibraries = async () => {
    const snapshot = await runtime.current();
    const existing = contexts.get(snapshot.contextKey);
    if (existing) return existing;
    const context = {
      snapshot,
      versionedLibrary: new VersionedTemplateLibrary(snapshot),
    };
    contexts.set(snapshot.contextKey, context);
    return context;
  };
  const server = new McpServer({ name: "Binding tools test", version: "0.5.0" });
  registerLibraryBindingTools({ server, runtime, currentLibraries });
  const client = new Client({ name: "binding-tools-test", version: "0.5.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  try {
    const missing = await client.callTool({
      name: "figure_library_apply_bind_global",
      arguments: {
        planDigest: "f".repeat(64),
        operationId: "missing-binding-plan",
      },
    });
    const missingEnvelope = record(record(missing.structuredContent).envelope);
    assert.equal(missingEnvelope.outcome, "blocked");
    assert.equal(missingEnvelope.code, "plan_not_available");
    assert.equal(missingEnvelope.retrySameCall, false);

    const planned = await client.callTool({
      name: "figure_library_plan_bind_global",
      arguments: { libraryDirectory, migrationMode: "none" },
    });
    const structured = record(planned.structuredContent);
    const envelope = record(structured.envelope);
    const plan = record(structured.plan);
    const planDigest = String(plan.planDigest);
    assert.equal(envelope.outcome, "needs_user_confirmation");
    assert.match(text(planned), new RegExp(`PLAN_DIGEST: ${planDigest}`, "u"));
    assert.match(text(planned), new RegExp(`LIBRARY_DIRECTORY: ${libraryDirectory}`, "u"));
    assert.match(
      text(planned),
      new RegExp(`LOCATOR_PATH: ${String(plan.locatorPath).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}`, "u"),
    );
    assert.match(text(planned), /MIGRATION_MODE: none/u);

    const applyArguments = {
      planDigest,
      operationId: "bind-text-only-library",
    };
    const applied = await client.callTool({
      name: "figure_library_apply_bind_global",
      arguments: applyArguments,
    });
    assert.equal(record(record(applied.structuredContent).envelope).outcome, "applied");
    const marker = await readLibraryRootMarker(libraryDirectory);
    assert.equal(marker?.value.libraryId, plan.libraryId);
    assert.equal(
      defaultLibraryLocatorPath(),
      path.join(root, "config", "scientific-figure-library", "locator.json"),
    );

    const replayed = await client.callTool({
      name: "figure_library_apply_bind_global",
      arguments: applyArguments,
    });
    assert.equal(record(record(replayed.structuredContent).envelope).outcome, "replayed");
  } finally {
    await client.close();
    await server.close();
    if (priorConfig === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = priorConfig;
    if (priorOverride === undefined) delete process.env.FIGURE_LIBRARY_DIR;
    else process.env.FIGURE_LIBRARY_DIR = priorOverride;
    await fs.rm(root, { recursive: true, force: true });
  }
});
