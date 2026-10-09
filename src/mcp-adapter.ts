import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppResource, registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import { OperationRegistry } from "./service/operations.ts";
import type { createMcpUpdateMonitor } from "./mcp-updates.ts";

/** The external MCP boundary adapts the same operations the local app calls directly. */
export function mountOperations(server: McpServer, service: OperationRegistry, updates?: ReturnType<typeof createMcpUpdateMonitor>) {
  const execute = async (name: string, input: unknown) => {
    const result = await service.execute(name, input);
    if (result.isError) return result;
    const notice = updates?.notice();
    return notice ? { ...result, content: [...result.content, { type: "text" as const, text: notice }] } : result;
  };
  for (const operation of service.operations.values()) {
    const { name, execute: _execute, ...configuration } = operation;
    const ui = configuration._meta?.ui;
    if (ui && typeof ui === "object" && "resourceUri" in ui && typeof ui.resourceUri === "string") {
      registerAppTool(server, name, { ...configuration, _meta: { ...configuration._meta, ui: { ...ui, resourceUri: ui.resourceUri } } }, async (input: unknown) => execute(name, input));
    } else {
      server.registerTool(name, configuration, async (input: unknown) => execute(name, input));
    }
  }
  for (const resource of service.resources.values()) {
    const { name, uri, read: _read, ...configuration } = resource;
    if (typeof uri !== "string") {
      server.registerResource(name, new ResourceTemplate(uri.uriTemplate, { list: undefined }), configuration,
        (requested) => service.readResource(requested.href));
    } else if (uri.startsWith("ui://")) {
      registerAppResource(server, name, uri, configuration, (requested) => service.readResource(requested.href));
    } else {
      server.registerResource(name, uri, configuration, (requested) => service.readResource(requested.href));
    }
  }
}
