import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SFL_SERVER_IDENTITY } from "./brand.ts";
import { VERSION } from "./version.ts";
import { createLibraryService, type LibraryService, type LibraryServiceOptions } from "./library-service.ts";
import { mountOperations } from "./mcp-adapter.ts";
import { createMcpUpdateMonitor } from "./mcp-updates.ts";
import { inspectNetworkAccess, testNetworkAccess } from "./network-access.ts";
import { z } from "zod";

export { VERSION };
export { MATERIALIZATION_PROTOCOL_VERSION } from "./library-service.ts";

/** MCP is an external adapter. Local clients call LibraryService directly. */
export async function createServer(options: LibraryServiceOptions & { service?: LibraryService; updateMonitor?: ReturnType<typeof createMcpUpdateMonitor> } = {}) {
  const service = options.service ?? await createLibraryService(options);
  const server = new McpServer({ ...SFL_SERVER_IDENTITY, version: VERSION }, {
    instructions: "Start with figure_library_get_skill for the single SFL Skill and available guidance. Use ordinary search, thumbnail resources/image tools and pagination for host-native browsing; the MCP App is optional. Exact preview confirmation is required before materialization planning.",
  });
  const updates = options.updateMonitor ?? createMcpUpdateMonitor(options.service ? { noticesEnabled: false } : {});
  await updates.load();
  mountOperations(server, service.operations, updates);
  const textResult = (value: unknown) => {
    const notice = updates.notice();
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }, ...(notice ? [{ type: "text" as const, text: notice }] : [])] };
  };
  server.registerTool("figure_library_network_status", {
    description: "Read this process's current user/machine proxy configuration; does not prove forwarding.", inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => textResult(await inspectNetworkAccess()));
  server.registerTool("figure_library_network_test", {
    description: "Run a bounded connectivity test only against the fixed SFL GitHub releases endpoint.", inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async () => textResult(await testNetworkAccess()));
  server.registerTool("figure_library_update_status", {
    description: "Report running/latest stable SFL versions, cache age and release link; refresh manually if requested.",
    inputSchema: { refresh: z.boolean().optional() }, annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ refresh }) => {
    if (refresh) await updates.refresh(true);
    else await updates.load();
    return textResult(updates.status());
  });
  if (!options.service || options.updateMonitor) updates.begin();
  if (!options.service) server.server.onclose = () => { void service.close(); };
  return server;
}
