import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SFL_SERVER_IDENTITY } from "./brand.ts";
import { VERSION } from "./version.ts";
import { createLibraryService, type LibraryService, type LibraryServiceOptions } from "./library-service.ts";
import { mountOperations } from "./mcp-adapter.ts";
import { createMcpUpdateMonitor } from "./mcp-updates.ts";
import { inspectNetworkAccess, testNetworkAccess } from "./network-access.ts";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { outcome, terminal } from "./tool-outcome.ts";

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
  const diagnosticResult = async (failureCode: string, operation: () => Promise<CallToolResult>): Promise<CallToolResult> => {
    let result: CallToolResult;
    try { result = await operation(); }
    catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      result = terminal(outcome("failed", failureCode, message, "ask_user"), { message });
    }
    const envelope = result.structuredContent?.envelope as { outcome?: string } | undefined;
    if (envelope?.outcome === "failed") return { ...result, isError: true };
    const notice = updates.notice();
    return notice ? { ...result, content: [...result.content, { type: "text", text: notice }] } : result;
  };
  server.registerTool("figure_library_network_status", {
    description: "Read this process's current user/machine proxy configuration; does not prove forwarding.", inputSchema: {},
    annotations: { readOnlyHint: true },
  }, async () => diagnosticResult("network_status_failed", async () => {
    const status = await inspectNetworkAccess();
    const invalid = Boolean(status.configurationError) || (status.useSystemProxy && !status.configured);
    return terminal(outcome(invalid ? "failed" : "ok", invalid ? "network_configuration_invalid" : "network_status",
      invalid ? "Inspect and correct the enabled proxy configuration before another request." : "Network configuration read; reachability and forwarding are not established.",
      invalid ? "ask_user" : "none"), { ...status }, [JSON.stringify(status)]);
  }));
  server.registerTool("figure_library_network_test", {
    description: "Run a bounded connectivity test only against the fixed SFL GitHub releases endpoint.", inputSchema: {},
    annotations: { readOnlyHint: true, openWorldHint: true },
  }, async () => diagnosticResult("network_test_failed", async () => {
    const status = await testNetworkAccess();
    const passed = status.forwardingTested === true;
    return terminal(outcome(passed ? "ok" : "failed", passed ? "network_test_passed" : "network_test_failed",
      status.message, passed ? "none" : "ask_user"), { ...status }, [JSON.stringify(status)]);
  }));
  server.registerTool("figure_library_update_status", {
    description: "Report running/latest stable SFL versions, cache age and release link; refresh manually if requested.",
    inputSchema: { refresh: z.boolean().optional() }, annotations: { readOnlyHint: true, openWorldHint: true },
  }, async ({ refresh }) => diagnosticResult("update_status_failed", async () => {
    if (refresh) await updates.refresh(true);
    else await updates.load();
    const status = updates.status();
    const failed = status.checkStatus === "error";
    return terminal(outcome(failed ? "failed" : "ok", failed ? "update_check_failed" : "update_status",
      failed ? "The latest stable version could not be checked; do not assume this installation is current." : "Update status read; check freshness before using the latest-version field.",
      failed ? "ask_user" : "none"), { ...status }, [JSON.stringify(status)]);
  }));
  if (!options.service || options.updateMonitor) updates.begin();
  if (!options.service) server.server.onclose = () => { void service.close(); };
  return server;
}
