import process from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.ts";

const VERSION = "0.3.0";

if (process.argv.includes("--help")) {
  console.log(`Scientific Figure Library ${VERSION}

Usage:
  scientific-figure-library

Starts a standard MCP server over stdio. Configure the absolute command path
in any MCP-capable host. Logs and errors are written to stderr.`);
  process.exit(0);
}

if (process.argv.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}

try {
  // Keep startup itself awaited: hosts may send initialize immediately, and
  // Catalog/preview validation must finish before stdio becomes authoritative.
  const server = await createServer();
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(error);
  process.exit(1);
}
