import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { zipSync } from "fflate";
import { PNG } from "pngjs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { canonicalJson } from "../src/canonical-json.ts";
import {
  PROVIDER_SOURCE_MANIFEST_SCHEMA,
  SecureProviderSourceFetcher,
  ed25519PublicKeyIdentity,
  type RawHttpsResponse,
} from "../src/provider-source-fetch.ts";
import { registerProviderSourceTools } from "../src/provider-source-tools.ts";
import { ProviderSourceManager, type ProviderSourcePaths } from "../src/provider-sources.ts";

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

function rawResponse(body: Uint8Array, contentType: string): RawHttpsResponse {
  return {
    statusCode: 200,
    headers: { "content-type": contentType, "content-length": String(body.byteLength) },
    body,
  };
}

async function harness() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-provider-source-tools-"));
  const configRoot = path.join(root, "config");
  const paths: ProviderSourcePaths = {
    configRoot,
    registryFile: path.join(configRoot, "provider-sources.json"),
    dataRoot: path.join(root, "data"),
  };
  const routes = new Map<string, RawHttpsResponse>();
  let requestCount = 0;
  const fetcher = new SecureProviderSourceFetcher({
    lookup: async () => [{ address: "8.8.8.8", family: 4 }],
    request: async (url) => {
      requestCount += 1;
      const found = routes.get(url.href);
      if (!found) throw new Error(`unexpected provider source URL: ${url.href}`);
      return found;
    },
    timeoutMs: 500,
  });
  const manager = new ProviderSourceManager({ paths, fetcher });
  const server = new McpServer({ name: "provider-source-tools-test", version: "0.6.0" });
  registerProviderSourceTools({ server, manager });
  const client = new Client({ name: "provider-source-tools-client", version: "0.6.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    root,
    routes,
    manager,
    client,
    server,
    requests: () => requestCount,
    publish(options: { sequence: number; baseUrl?: string; privateKey?: ReturnType<typeof generateKeyPairSync>["privateKey"]; publicKey?: string }) {
      const pair = options.privateKey && options.publicKey
        ? { privateKey: options.privateKey, publicKey: options.publicKey }
        : (() => {
            const generated = generateKeyPairSync("ed25519");
            const raw = Buffer.from(generated.publicKey.export({ format: "der", type: "spki" })).subarray(-32);
            return { privateKey: generated.privateKey, publicKey: raw.toString("base64") };
          })();
      const keyId = ed25519PublicKeyIdentity(pair.publicKey).keyId;
      const base = options.baseUrl ?? "https://tools.example/source";
      const manifestUrl = `${base}/source-manifest.json`;
      const signatureUrl = `${base}/source-manifest.sig.json`;
      const catalogUrl = `${base}/catalog.json`;
      const previewsUrl = `${base}/previews.zip`;
      const png = new PNG({ width: 2, height: 1 });
      png.data.set([255, 0, 0, 255, 0, 0, 255, 255]);
      const previewBytes = new Uint8Array(PNG.sync.write(png));
      const previewPath = "thumbs/tools-volcano/1.0.0.png";
      const previewsBytes = new Uint8Array(zipSync({ [previewPath]: previewBytes }, { level: 0 }));
      const catalogBytes = Buffer.from(canonicalJson({
        schema: "figure-library.public-provider-catalog.v1",
        provider: {
          providerId: "io.example.tools.personal",
          displayName: "Tools personal provider",
          catalogRepository: "example/tools-catalog",
          archiveRepository: "example/tools-archives",
        },
        generatedAt: "2026-08-21T00:00:00.000Z",
        entries: [{
          schema: "figure-library.public-template-entry.v1",
          providerId: "io.example.tools.personal",
          templateId: "tools-volcano",
          releaseVersion: "1.0.0",
          contentDigest: createHash("sha256").update(`tools:${options.sequence}`).digest("hex"),
          title: "Tools volcano",
          description: "A signed personal Provider tool fixture.",
          search: {
            application: "Provider source tool validation",
            dataProfile: "Synthetic fixture",
            plotFamily: "volcano",
            language: "R",
            tags: ["tools", "volcano"],
            packages: ["base"],
            codeFiles: ["payload/code/render.R"],
            inputFiles: ["payload/data/input.csv"],
          },
          archive: {
            repository: "example/tools-archives",
            commit: "1".repeat(40),
            path: "archives/tools-volcano/1.0.0/tools-volcano-1.0.0.zip",
            bytes: 1234,
            sha256: createHash("sha256").update(`archive:${options.sequence}`).digest("hex"),
          },
          preview: {
            path: previewPath,
            bytes: previewBytes.byteLength,
            sha256: createHash("sha256").update(previewBytes).digest("hex"),
            mediaType: "image/png",
            width: png.width,
            height: png.height,
            canonicalRgbaSha256: createHash("sha256").update(png.data).digest("hex"),
          },
          status: {
            upstreamStatus: "published",
            publisherVerified: true,
            curationStatus: "unreviewed",
            renderValidation: "publisher_attested",
            localReviewStatus: "not_reviewed",
            plotExecutionByRecipient: "not_run",
          },
          licenses: {
            code: "MIT",
            content: "CC-BY-4.0",
            documentation: "CC-BY-4.0",
          },
        }],
      }));
      const manifestBytes = Buffer.from(canonicalJson({
        schema: PROVIDER_SOURCE_MANIFEST_SCHEMA,
        providerId: "io.example.tools.personal",
        sequence: options.sequence,
        generatedAt: "2026-08-21T00:00:00.000Z",
        catalog: {
          url: catalogUrl,
          bytes: catalogBytes.byteLength,
          sha256: createHash("sha256").update(catalogBytes).digest("hex"),
          mediaType: "application/json",
        },
        previews: {
          url: previewsUrl,
          bytes: previewsBytes.byteLength,
          sha256: createHash("sha256").update(previewsBytes).digest("hex"),
          mediaType: "application/zip",
        },
        authorizedNextKeys: [],
        tombstones: [],
      }));
      const signature = sign(null, manifestBytes, pair.privateKey);
      const signatureBytes = Buffer.from(canonicalJson({
        schema: "figure-library.provider-source-signature.v1",
        algorithm: "Ed25519",
        keyId,
        manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
        signatureBase64: signature.toString("base64"),
      }));
      routes.set(manifestUrl, rawResponse(manifestBytes, "application/json"));
      routes.set(
        signatureUrl,
        rawResponse(signatureBytes, "application/json"),
      );
      routes.set(catalogUrl, rawResponse(catalogBytes, "application/json"));
      routes.set(previewsUrl, rawResponse(previewsBytes, "application/zip"));
      return { ...pair, keyId, manifestUrl, signatureUrl };
    },
    async close() {
      await client.close();
      await server.close();
      await fs.rm(root, { recursive: true, force: true });
    },
  };
}

test("provider source MCP tools expose offline list plus confirmed Add Apply and replay", async () => {
  const state = await harness();
  const feed = state.publish({ sequence: 1 });
  try {
    const tools = await state.client.listTools();
    const planTool = tools.tools.find((tool) => tool.name === "figure_library_plan_provider_source_change");
    assert.ok(planTool);
    const inputSchemaText = JSON.stringify(planTool.inputSchema);
    assert.doesNotMatch(inputSchemaText, /sourceId|signatureUrl|"publicKey"/u);
    assert.match(inputSchemaText, /expectedProviderId/u);
    assert.match(inputSchemaText, /publicKeyBase64/u);

    const before = state.requests();
    const empty = await state.client.callTool({ name: "figure_library_list_provider_sources", arguments: {} });
    assert.equal(record(record(empty.structuredContent).envelope).outcome, "ok");
    assert.equal(record(empty.structuredContent).result instanceof Object, true);
    assert.equal(state.requests(), before);
    assert.match(text(empty), /SOURCE_COUNT: 0/u);

    const missingFields = await state.client.callTool({
      name: "figure_library_plan_provider_source_change",
      arguments: { action: "add" },
    });
    assert.equal(record(record(missingFields.structuredContent).envelope).outcome, "needs_user_input");

    const planned = await state.client.callTool({
      name: "figure_library_plan_provider_source_change",
      arguments: {
        action: "add",
        expectedProviderId: "io.example.tools.personal",
        manifestUrl: feed.manifestUrl,
        publicKeyBase64: feed.publicKey,
      },
    });
    const plan = record(record(planned.structuredContent).plan);
    assert.equal(record(record(planned.structuredContent).envelope).outcome, "needs_user_confirmation");
    assert.equal(plan.includeInDefaultSearch, false);
    assert.match(text(planned), /PLAN_WRITES: none/u);
    assert.match(text(planned), new RegExp(`SIGNING_KEY_ID: ${feed.keyId}`, "u"));
    assert.match(text(planned), /TARGET_SNAPSHOT_PATH:/u);
    assert.match(text(planned), /TEMPLATES_ADDED: tools-volcano@1.0.0/u);
    assert.match(text(planned), /ACCESS_URL_4:/u);

    const applyArguments = {
      planDigest: String(plan.planDigest),
      operationId: "tools-add-personal",
      expectedAction: "add",
      expectedProviderId: "io.example.tools.personal",
    };
    const applied = await state.client.callTool({
      name: "figure_library_apply_provider_source_change",
      arguments: applyArguments,
    });
    assert.equal(record(record(applied.structuredContent).envelope).outcome, "applied");
    assert.match(text(applied), /IDEMPOTENT_REPLAY: false/u);

    const replayed = await state.client.callTool({
      name: "figure_library_apply_provider_source_change",
      arguments: applyArguments,
    });
    assert.equal(record(record(replayed.structuredContent).envelope).outcome, "replayed");

    const alreadyCurrent = await state.client.callTool({
      name: "figure_library_plan_provider_source_change",
      arguments: { action: "update", providerId: "io.example.tools.personal" },
    });
    assert.equal(record(record(alreadyCurrent.structuredContent).envelope).outcome, "ok");
    assert.equal(record(record(alreadyCurrent.structuredContent).result).status, "already_current");
    assert.match(text(alreadyCurrent), /APPLY_REQUIRED: false/u);

    const callsBeforeList = state.requests();
    const listed = await state.client.callTool({ name: "figure_library_list_provider_sources", arguments: {} });
    assert.equal(state.requests(), callsBeforeList);
    assert.doesNotMatch(JSON.stringify(listed.structuredContent), new RegExp(feed.publicKey, "u"));
    assert.match(text(listed), /SOURCE_1_DEFAULT_SEARCH: false/u);
  } finally {
    await state.close();
  }
});

test("provider source MCP Apply reports missing and stale cached plans as terminal blockers/conflicts", async () => {
  const state = await harness();
  const feed = state.publish({ sequence: 1 });
  try {
    const missing = await state.client.callTool({
      name: "figure_library_apply_provider_source_change",
      arguments: {
        planDigest: "f".repeat(64),
        operationId: "missing-provider-plan",
        expectedAction: "update",
        expectedProviderId: "io.example.not-present",
      },
    });
    const missingEnvelope = record(record(missing.structuredContent).envelope);
    assert.equal(missingEnvelope.outcome, "blocked");
    assert.equal(missingEnvelope.code, "plan_not_available");
    assert.equal(missingEnvelope.retrySameCall, false);

    const addPlanResult = await state.client.callTool({
      name: "figure_library_plan_provider_source_change",
      arguments: {
        action: "add",
        expectedProviderId: "io.example.tools.personal",
        manifestUrl: feed.manifestUrl,
        publicKeyBase64: feed.publicKey,
      },
    });
    const addPlan = record(record(addPlanResult.structuredContent).plan);
    await state.client.callTool({
      name: "figure_library_apply_provider_source_change",
      arguments: {
        planDigest: String(addPlan.planDigest),
        operationId: "add-stale-tools",
        expectedAction: "add",
        expectedProviderId: "io.example.tools.personal",
      },
    });

    const disable = await state.client.callTool({
      name: "figure_library_plan_provider_source_change",
      arguments: { action: "configure", providerId: "io.example.tools.personal", enabled: false },
    });
    const enableDefault = await state.client.callTool({
      name: "figure_library_plan_provider_source_change",
      arguments: { action: "configure", providerId: "io.example.tools.personal", includeInDefaultSearch: true },
    });
    const enablePlan = record(record(enableDefault.structuredContent).plan);
    await state.client.callTool({
      name: "figure_library_apply_provider_source_change",
      arguments: {
        planDigest: String(enablePlan.planDigest),
        operationId: "enable-default-tools",
        expectedAction: "configure",
        expectedProviderId: "io.example.tools.personal",
      },
    });
    const disablePlan = record(record(disable.structuredContent).plan);
    const stale = await state.client.callTool({
      name: "figure_library_apply_provider_source_change",
      arguments: {
        planDigest: String(disablePlan.planDigest),
        operationId: "disable-stale-tools",
        expectedAction: "configure",
        expectedProviderId: "io.example.tools.personal",
      },
    });
    assert.equal(record(record(stale.structuredContent).envelope).outcome, "conflict");

    const remove = await state.client.callTool({
      name: "figure_library_plan_provider_source_change",
      arguments: { action: "remove", providerId: "io.example.tools.personal" },
    });
    assert.match(text(remove), /keeps immutable snapshots and already materialized projects/u);
  } finally {
    await state.close();
  }
});
