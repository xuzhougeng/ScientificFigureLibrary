import path from "node:path";
import { fileURLToPath } from "node:url";

const MCP_RUNTIME_REGISTER_EVENT = "pi-mcp-adapter:runtime-register:v1";
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mcpEntry = path.join(packageRoot, "dist", "index.js");

export function mcpDefinition() {
  return {
    command: process.execPath,
    args: [mcpEntry],
  };
}

/** Registers the packaged stdio server with pi-mcp-adapter when that extension is installed. */
export default function figureLibraryPi(pi) {
  let registration;
  const register = () => {
    if (registration || !pi?.events || typeof pi.events.emit !== "function") return;
    const request = {
      version: 1,
      name: "figure-library",
      definition: mcpDefinition(),
    };
    pi.events.emit(MCP_RUNTIME_REGISTER_EVENT, request);
    if (!request.result) return;
    if (!request.result.ok) {
      throw request.result.error ?? new Error("figure-library MCP registration failed");
    }
    registration = request.result.registration;
  };
  pi.on("session_start", register);
  pi.on("session_shutdown", async () => {
    const current = registration;
    registration = undefined;
    await current?.dispose?.();
  });
}
