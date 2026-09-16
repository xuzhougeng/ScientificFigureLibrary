import { spawn } from "node:child_process";
import { startLocalHttp } from "./http.ts";
import { createServer } from "../server.ts";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { enableProcessLog } from "../process-log.ts";
import { VERSION } from "../version.ts";

export function browserLaunchSpec(url: string, platform = process.platform): {
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
} {
  if (!url.startsWith("http://127.0.0.1:")) throw new Error("Refusing to open a non-local address");
  if (platform === "win32") {
    // explorer.exe drops #fragments, so #connect= never reaches the browser.
    return {
      command: process.env.ComSpec && process.env.ComSpec.length > 0 ? process.env.ComSpec : "cmd.exe",
      args: ["/c", "start", '""', `"${url}"`],
      windowsVerbatimArguments: true,
    };
  }
  if (platform === "darwin") return { command: "/usr/bin/open", args: [url] };
  return { command: "xdg-open", args: [url] };
}

export async function openBrowser(url: string) {
  const spec = browserLaunchSpec(url);
  await new Promise<void>((resolve, reject) => {
    const child = spawn(spec.command, spec.args, {
      stdio: "ignore",
      detached: true,
      windowsHide: true,
      windowsVerbatimArguments: spec.windowsVerbatimArguments === true,
    });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

function writeFallbackUrl(url: string) {
  process.stdout.write(`If the browser did not open, paste this address into a modern browser:\n${url}\nKeep this window open while using the app.\nGallery source and network errors will appear in this window.\n`);
}

export async function launchLocalClient(args: string[]) {
  const stdio = args.includes("--stdio");
  if (!stdio) enableProcessLog();
  const local = await startLocalHttp({ allowShutdown: !stdio });
  process.once("SIGINT", () => { void local.close(); });
  process.once("SIGTERM", () => { void local.close(); });
  const open = process.env.SFL_NO_BROWSER === "1" ? async (_url: string) => {} : openBrowser;
  if (stdio) {
    const server = await createServer({ service: local.service });
    await server.connect(new StdioServerTransport());
  } else {
    const url = local.openUrl();
    // Private launch pipe used by the native client. Never emitted on MCP stdio.
    if (!args.includes("--quiet")) process.stdout.write(`${JSON.stringify({ schema: "figure-library.local-launch.v1", version: VERSION, origin: local.origin, token: local.token, url })}\n`);
    else writeFallbackUrl(url);
    if (!args.includes("--no-open")) {
      try { await open(url); }
      catch (error) {
        process.stderr.write(`Could not open the browser automatically. ${error instanceof Error ? error.message : String(error)}\n`);
        if (!args.includes("--quiet")) writeFallbackUrl(url);
      }
    }
  }
  return local;
}
