import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SFL_SERVER_IDENTITY } from "./brand.ts";
import { VERSION } from "./version.ts";
import { createLibraryService, type LibraryService, type LibraryServiceOptions } from "./library-service.ts";
import { mountOperations } from "./mcp-adapter.ts";

export { VERSION };
export { MATERIALIZATION_PROTOCOL_VERSION } from "./library-service.ts";

/** MCP is an external adapter. Local clients call LibraryService directly. */
export async function createServer(options: LibraryServiceOptions & { service?: LibraryService } = {}) {
  const service = options.service ?? await createLibraryService(options);
  const server = new McpServer({ ...SFL_SERVER_IDENTITY, version: VERSION }, {
    instructions: "Start with figure_library_get_skill for the single SFL Skill and available guidance. Use ordinary search, thumbnail resources/image tools and pagination for host-native browsing; the MCP App is optional. Exact preview confirmation is required before materialization planning.",
  });
  mountOperations(server, service.operations);
  if (!options.service) server.server.onclose = () => { void service.close(); };
  return server;
}
