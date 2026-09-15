import { OperationRegistry, resourceTemplate } from "./service/operations.ts";
import { mountOperations } from "./mcp-adapter.ts";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { canonicalJson } from "./canonical-json.ts";
import { PreviewProtocolError } from "./preview-confirmation.ts";
import { outcome, terminal } from "./tool-outcome.ts";
import { SEARCH_MAX_PAGE_DATA_URL_BYTES } from "./transport-image.ts";
import type { TemplateCandidate } from "./types.ts";

export const MAX_CANDIDATE_IMAGES = 12;
export const CANDIDATE_IMAGE_URI_TEMPLATE = "figure-library://candidate-images/{resultSetId}/{candidateId}";
const digest = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

export function scopedCandidateId(resultSetId: string, candidate: TemplateCandidate) {
  return `candidate-${digest(canonicalJson({
    schema: "figure-library.result-candidate.v1", resultSetId,
    providerId: candidate.providerId, exactSelector: candidate.exactSelector,
  })).slice(0, 32)}`;
}

export function candidateImageUri(resultSetId: string, candidateId: string) {
  return `figure-library://candidate-images/${encodeURIComponent(resultSetId)}/${encodeURIComponent(candidateId)}`;
}

export function defineCandidateImages(operations: OperationRegistry, options: {
  load: (resultSetId: string, candidateIds: string[]) => Promise<TemplateCandidate[]>;
  failure: (prefix: string, error: unknown) => CallToolResult;
}) {
  const load = async (resultSetId: string, candidateIds: string[]) => {
    if (new Set(candidateIds).size !== candidateIds.length) {
      throw new PreviewProtocolError("preview_selection_mismatch", "Candidate IDs must be unique within the requested result set.");
    }
    const candidates = await options.load(resultSetId, candidateIds);
    let total = 0;
    return candidates.map((candidate) => {
      const candidateId = scopedCandidateId(resultSetId, candidate);
      const match = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/u.exec(candidate.previewDataUrl ?? "");
      if (!match || !candidate.previewSha256) throw new Error(`preview_unavailable: no readable thumbnail for ${candidateId}`);
      total += candidate.previewDataUrl!.length;
      if (total > SEARCH_MAX_PAGE_DATA_URL_BYTES) throw new Error("preview_unavailable: thumbnail response exceeds its page budget");
      const bytes = Buffer.from(match[2]!, "base64");
      return {
        candidateId, providerId: candidate.providerId, exactSelector: candidate.exactSelector,
        title: candidate.title, uri: candidateImageUri(resultSetId, candidateId),
        sourceSha256: candidate.previewSha256,
        mimeType: match[1]!, byteLength: bytes.byteLength, sha256: digest(bytes), data: match[2]!,
      };
    });
  };
  operations.define("figure_library_get_candidate_images", {
    title: "Read candidate thumbnails for host display",
    description: "Get up to 12 current-result thumbnails as standard MCP images with exact candidate labels. Display a page for user selection; do not iterate the entire result set. Does not confirm exact previews or create materialization receipts.",
    inputSchema: {
      resultSetId: z.string().min(1).max(256),
      candidateIds: z.array(z.string().regex(/^candidate-[a-f0-9]{32}$/u)).min(1).max(MAX_CANDIDATE_IMAGES),
    },
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async ({ resultSetId, candidateIds }) => {
    try {
      const images = await load(resultSetId, candidateIds);
      const metadata = { resultSetId, purpose: "thumbnail", images: images.map(({ data: _data, ...entry }) => entry) };
      const result = terminal(outcome("ok", "candidate_images_ready", "Display these labelled thumbnails for user selection. Exact preview confirmation is still required.", "ask_user"), metadata, [JSON.stringify(metadata)]);
      for (const entry of images) result.content.push(
        { type: "text", text: `CANDIDATE_ID: ${entry.candidateId}\nTITLE: ${entry.title}\nPROVIDER_ID: ${entry.providerId}` },
        { type: "image", data: entry.data, mimeType: entry.mimeType },
      );
      return result;
    } catch (error) { return options.failure("Candidate thumbnail retrieval failed", error); }
  });
  operations.defineResource("SFL candidate thumbnail", resourceTemplate(CANDIDATE_IMAGE_URI_TEMPLATE), {
    description: "Session-bound thumbnail for a search candidate. Read the URI returned by search; this is not an exact-preview confirmation.",
  }, async (uri, variables) => {
    const { resultSetId, candidateId } = variables;
    if (typeof resultSetId !== "string" || typeof candidateId !== "string" || uri.href !== candidateImageUri(resultSetId, candidateId)) {
      throw new Error("Invalid candidate thumbnail URI");
    }
    const [entry] = await load(resultSetId, [candidateId]);
    if (!entry) throw new Error("Candidate thumbnail is unavailable");
    return { contents: [{ uri: entry.uri, mimeType: entry.mimeType, blob: entry.data }] };
  });
}

export function registerCandidateImages(server: McpServer, options: Parameters<typeof defineCandidateImages>[1]) {
  const operations = new OperationRegistry();
  defineCandidateImages(operations, options);
  mountOperations(server, operations);
}
