import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/** Private local-client operations. These are not model-callable confirmation tools. */
export interface LocalOperations {
  preview(input: unknown): Promise<CallToolResult>;
  confirm(input: unknown): Promise<CallToolResult>;
  library(): Promise<CallToolResult>;
  asset(input: unknown): Promise<CallToolResult>;
}
