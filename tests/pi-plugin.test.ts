import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
// @ts-expect-error -- host adapters are plain JS modules without declarations.
import figureLibraryPi, { mcpDefinition } from "../.pi-plugin/extension.js";

const root = path.resolve(import.meta.dirname, "..");

test("Pi extension registers the packaged stdio server with pi-mcp-adapter", async () => {
  const definition = mcpDefinition();
  assert.equal(definition.command, process.execPath);
  assert.deepEqual(definition.args, [path.join(root, "dist", "index.js")]);

  const emitted: Array<{ name: string; request: Record<string, unknown> }> = [];
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  let disposed = false;
  const pi = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
    },
    events: {
      emit(name: string, request: Record<string, unknown>) {
        emitted.push({ name, request });
        request.result = { ok: true, registration: { dispose: async () => { disposed = true; } } };
      },
    },
  };

  figureLibraryPi(pi);
  await handlers.get("session_start")?.();
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0]?.name, "pi-mcp-adapter:runtime-register:v1");
  const request = emitted[0]?.request as {
    version?: number;
    name?: string;
    definition?: { command?: string; args?: string[] };
  };
  assert.equal(request.version, 1);
  assert.equal(request.name, "figure-library");
  assert.deepEqual(request.definition, definition);

  await handlers.get("session_start")?.();
  assert.equal(emitted.length, 1);

  await handlers.get("session_shutdown")?.();
  assert.equal(disposed, true);
});

test("Pi extension stays silent when pi-mcp-adapter is not installed", async () => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  const pi = {
    on(event: string, handler: (...args: unknown[]) => unknown) {
      handlers.set(event, handler);
    },
    events: {
      emit() {},
    },
  };
  figureLibraryPi(pi);
  await handlers.get("session_start")?.();
});
