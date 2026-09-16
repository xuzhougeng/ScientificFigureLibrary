import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { PreviewCacheSnapshot } from "../preview-downloads.ts";

/** Private local-client operations. These are not model-callable confirmation tools. */
export interface LocalOperations {
  preview(input: unknown): Promise<CallToolResult>;
  confirm(input: unknown): Promise<CallToolResult>;
  library(): Promise<CallToolResult>;
  asset(input: unknown): Promise<CallToolResult>;
  previewCache(): Promise<PreviewCacheSnapshot>;
  cachePreviews(input: unknown): Promise<PreviewCacheSnapshot>;
  gallery(input: unknown): Promise<CallToolResult>;
}
