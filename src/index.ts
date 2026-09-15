import process from "node:process";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.ts";
import { VERSION } from "./version.ts";
import { launchLocalClient } from "./local/launch.ts";

if (process.argv.includes("--help")) {
  console.log(`Scientific Figure Library ${VERSION}

Usage:
  scientific-figure-library
  scientific-figure-library --local [--no-open]
  scientific-figure-library --local --stdio

Starts a standard MCP server over stdio. Configure the absolute command path
in any MCP-capable host. Logs and errors are written to stderr.`);
  process.exit(0);
}

if (process.argv.includes("--version")) {
  console.log(VERSION);
  process.exit(0);
}

try {
  if (process.argv.includes("--local")) {
    await launchLocalClient(process.argv.slice(2));
  } else {
  // Keep startup itself awaited: hosts may send initialize immediately, and
  // Catalog/preview validation must finish before stdio becomes authoritative.
  const server = await createServer();
  await server.connect(new StdioServerTransport());
  }
} catch (error) {
  console.error(error);
  process.exit(1);
}
