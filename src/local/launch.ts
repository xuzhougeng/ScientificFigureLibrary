import { spawn } from "node:child_process";
import { startLocalHttp } from "./http.ts";
import { createServer } from "../server.ts";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION } from "../version.ts";

export async function openBrowser(url: string) {
  const command = process.platform === "win32" ? "explorer.exe" : process.platform === "darwin" ? "/usr/bin/open" : "xdg-open";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(command, [url], { stdio: "ignore", detached: true, windowsHide: true });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

export async function launchLocalClient(args: string[]) {
  const stdio = args.includes("--stdio");
  const local = await startLocalHttp({ allowShutdown: !stdio });
  process.once("SIGINT", () => { void local.close(); });
  process.once("SIGTERM", () => { void local.close(); });
  const open = process.env.SFL_NO_BROWSER === "1" ? async (_url: string) => {} : openBrowser;
  if (stdio) {
    const server = await createServer({ service: local.service });
    await server.connect(new StdioServerTransport());
  } else {
    // Private launch pipe used by the native client. Never emitted on MCP stdio.
    if (!args.includes("--quiet")) process.stdout.write(`${JSON.stringify({ schema: "figure-library.local-launch.v1", version: VERSION, origin: local.origin, token: local.token, url: local.openUrl() })}\n`);
    if (!args.includes("--no-open")) await open(local.openUrl());
  }
  return local;
}
