import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { outcome, terminal } from "./tool-outcome.ts";
import { VERSION } from "./version.ts";

export const GUIDANCE_ROOT = path.resolve(import.meta.dirname, "../skills/figure-library");
export const GUIDANCE_URI = "figure-library://guidance/figure-library/";

/** Load only bundled guidance, once per server. Caller-supplied paths never reach fs. */
export async function loadGuidance(root = GUIDANCE_ROOT) {
  const documents = new Map<string, { document: string; uri: string; mimeType: string; sha256: string; text: string }>();
  const read = async (document: string) => {
    const absolute = path.join(root, ...document.split("/"));
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 512 * 1024) {
      throw new Error(`Invalid bundled guidance: ${document}`);
    }
    const text = await fs.readFile(absolute, "utf8");
    documents.set(document, {
      document, uri: GUIDANCE_URI + document,
      mimeType: document.endsWith(".md") ? "text/markdown" : "text/plain",
      sha256: createHash("sha256").update(text).digest("hex"), text,
    });
  };
  const walk = async (relative: string) => {
    for (const entry of (await fs.readdir(path.join(root, relative), { withFileTypes: true })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
      const document = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await walk(document);
      else if (entry.isFile() && (/\.(?:md|py)$/u.test(entry.name) || entry.name === "LICENSE")) await read(document);
    }
  };
  await read("SKILL.md");
  await walk("references");
  return documents;
}

export async function registerGuidanceTools(server: McpServer, capabilities: Record<string, unknown>) {
  const documents = await loadGuidance();
  const inventory = [...documents.values()].map(({ text: _text, ...entry }) => entry);
  const guidanceRevision = createHash("sha256").update(JSON.stringify(inventory)).digest("hex");
  for (const entry of documents.values()) {
    server.registerResource(`SFL guidance: ${entry.document}`, entry.uri, {
      title: entry.document,
      description: "Bundled SFL guidance or helper source. Reading does not execute or install it.",
      mimeType: entry.mimeType,
    }, async () => ({ contents: [{ uri: entry.uri, mimeType: entry.mimeType, text: entry.text }] }));
  }
  server.registerTool("figure_library_get_skill", {
    title: "Read the core SFL Skill or one bundled reference",
    description: "Start here for SFL guidance and host capabilities. Returns the same bundled SKILL.md without requiring Library setup. Use only listed document IDs for on-demand references; does not install a Skill or execute helper code.",
    inputSchema: { document: z.string().min(1).max(300).optional().default("SKILL.md") },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ document }) => {
    const entry = documents.get(document);
    if (!entry) return terminal(outcome("not_found", "guidance_not_found", "Use a document ID from figure_library_get_skill's inventory."));
    const metadata = { serverVersion: VERSION, guidanceRevision, ...entry, documents: inventory, capabilities };
    return terminal(outcome("ok", "guidance_ready", "Read the requested guidance; load additional references only when relevant."), metadata, [
      `GUIDANCE_METADATA: ${JSON.stringify({ ...metadata, text: undefined })}`, entry.text,
    ]);
  });
}
