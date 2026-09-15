import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import { integrationGuide, localConnection } from "./integrations.ts";
import { VERSION } from "../version.ts";
import { createLibraryService, type LibraryService } from "../library-service.ts";

const BODY_LIMIT = 1024 * 1024;
const UPLOAD_LIMIT = 32 * 1024 * 1024;
const UPLOAD_TOTAL_LIMIT = 256 * 1024 * 1024;
const LOCAL_TOOLS = new Set([
  "figure_library_get_skill", "figure_library_source_status", "figure_library_search", "figure_library_search_page",
  "figure_library_get_candidate_images", "figure_library_describe", "figure_library_review_open",
  "figure_library_preview_working_revision", "figure_library_template_history", "figure_library_diff_revisions",
  "figure_library_plan_bind_global", "figure_library_apply_bind_global",
  "figure_library_plan_bind_workspace", "figure_library_apply_bind_workspace",
  "figure_library_plan_working_revision", "figure_library_apply_working_revision",
  "figure_library_plan_review_gate_update", "figure_library_apply_review_gate_update",
  "figure_library_plan_publish_working_revision", "figure_library_apply_publish_working_revision",
  "figure_library_plan_discard_working_revision", "figure_library_apply_discard_working_revision",
  "figure_library_plan_restore_release", "figure_library_apply_restore_release",
  "figure_library_plan_materialize", "figure_library_apply_materialize",
  "figure_library_list_provider_sources", "figure_library_plan_provider_source_change", "figure_library_apply_provider_source_change",
]);
const CallInput = z.object({
  name: z.string(), arguments: z.record(z.string(), z.unknown()).optional().default({}),
  approval: z.object({ planDigest: z.string().regex(/^[a-f0-9]{64}$/u), confirmedBy: z.literal("user") }).optional(),
}).strict();

function matches(secret: string, value: string | undefined) {
  if (!value) return false;
  const expected = Buffer.from(secret);
  const actual = Buffer.from(value);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

async function readBody(request: IncomingMessage, limit: number) {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const raw of request) {
    const chunk = Buffer.from(raw);
    size += chunk.length;
    if (size > limit) throw new Error("Request body exceeds the allowed size");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(value));
}

export async function startLocalHttp(options: {
  service?: LibraryService;
  htmlPath?: string;
  port?: number;
  allowShutdown?: boolean;
} = {}) {
  const service = options.service ?? await createLibraryService();
  const token = randomBytes(32).toString("base64url");
  const cookieName = `sfl_${randomBytes(8).toString("hex")}`;
  const tickets = new Map<string, number>();
  const uploads = await fs.mkdtemp(path.join(os.tmpdir(), "sfl-local-intake-"));
  let uploadBytes = 0;
  let origin = "";
  let closing = false;
  const htmlPath = options.htmlPath ?? path.resolve(import.meta.dirname, "local-app.html");
  const http = createServer((request, response) => { void handle(request, response); });
  const authorized = (request: IncomingMessage) => {
    const bearer = request.headers.authorization?.startsWith("Bearer ") ? request.headers.authorization.slice(7) : undefined;
    const cookie = request.headers.cookie?.split(";").map((item) => item.trim()).find((item) => item.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
    return matches(token, bearer) || matches(token, cookie);
  };
  const close = async () => {
    if (closing) return;
    closing = true;
    await new Promise<void>((resolve, reject) => {
      http.close((error) => error ? reject(error) : resolve());
      http.closeIdleConnections();
    });
    await service.close();
    await fs.rm(uploads, { recursive: true, force: true });
  };
  async function handle(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      if (closing) return json(response, 503, { error: "Client is shutting down" });
      if (request.headers.host !== new URL(origin).host ||
          (request.headers.origin && request.headers.origin !== origin) ||
          request.headers["sec-fetch-site"] === "cross-site") {
        return json(response, 403, { error: "This local client accepts only its own origin" });
      }
      const url = new URL(request.url ?? "/", origin);
      if (url.pathname === "/" && request.method === "GET") {
        const html = await fs.readFile(htmlPath);
        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(html);
        return;
      }
      if (url.pathname === "/api/connect" && request.method === "POST") {
        const { ticket } = z.object({ ticket: z.string().max(100) }).strict().parse(JSON.parse((await readBody(request, BODY_LIMIT)).toString()));
        const expires = tickets.get(ticket);
        tickets.delete(ticket);
        if (!expires || expires < Date.now()) return json(response, 401, { error: "Open the client again to obtain a new connection" });
        response.setHeader("Set-Cookie", `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/`);
        return json(response, 200, { version: VERSION });
      }
      if (!authorized(request)) return json(response, 401, { error: "Local client authentication required" });
      if (request.method === "GET" && url.pathname === "/api/state") {
        return json(response, 200, { version: VERSION, canShutdown: options.allowShutdown !== false });
      }
      if (request.method === "GET" && url.pathname === "/api/connection") {
        return json(response, 200, localConnection({ node: process.execPath, server: path.resolve(import.meta.dirname, "index.js") }));
      }
      if (request.method === "GET" && url.pathname === "/api/integrations") return json(response, 200, integrationGuide({ server: path.resolve(import.meta.dirname, "index.js") }));
      if (request.method === "GET" && url.pathname === "/api/library") return json(response, 200, await service.local.library());
      if (request.method === "GET" && url.pathname === "/api/preview-cache") return json(response, 200, await service.local.previewCache());
      if (request.method !== "POST") return json(response, 404, { error: "Unknown local client endpoint" });
      if (url.pathname === "/api/upload") {
        const filename = z.string().min(1).max(200).parse(request.headers["x-sfl-filename"]);
        if (!/^[^/\\\x00-\x1f]+\.(?:png|jpe?g|webp|r|py|txt|md|csv|tsv|json)$/iu.test(filename)) throw new Error("Unsupported upload filename");
        const bytes = await readBody(request, UPLOAD_LIMIT);
        if (uploadBytes + bytes.length > UPLOAD_TOTAL_LIMIT) throw new Error("Local intake limit reached; finish or restart this client session");
        const file = path.join(uploads, `${randomBytes(12).toString("hex")}${path.extname(filename).toLowerCase()}`);
        await fs.writeFile(file, bytes, { flag: "wx", mode: 0o600 });
        uploadBytes += bytes.length;
        return json(response, 200, { sourcePath: file, filename, bytes: bytes.length });
      }
      const input: unknown = JSON.parse((await readBody(request, BODY_LIMIT)).toString());
      if (url.pathname === "/api/call") {
        const call = CallInput.parse(input);
        if (!LOCAL_TOOLS.has(call.name)) return json(response, 403, { error: "This operation is not available through the local interface" });
        if (call.name.startsWith("figure_library_apply_") && (!call.approval || call.approval.planDigest !== call.arguments.planDigest)) {
          return json(response, 403, { error: "Approve the exact plan before applying it" });
        }
        return json(response, 200, await service.execute(call.name, call.arguments));
      }
      if (url.pathname === "/api/preview") return json(response, 200, await service.local.preview(input));
      if (url.pathname === "/api/confirm") return json(response, 200, await service.local.confirm(input));
      if (url.pathname === "/api/asset") return json(response, 200, await service.local.asset(input));
      if (url.pathname === "/api/preview-cache") return json(response, 200, await service.local.cachePreviews(input));
      if (url.pathname === "/api/resource") {
        const { uri } = z.object({ uri: z.string().max(2_000) }).strict().parse(input);
        if (!uri.startsWith("figure-library://candidate-images/") && !uri.startsWith("figure-library://guidance/")) throw new Error("Unsupported resource");
        return json(response, 200, await service.readResource(uri));
      }
      if (url.pathname === "/api/shutdown" && options.allowShutdown !== false) {
        json(response, 200, { closed: true });
        void close();
        return;
      }
      return json(response, 404, { error: "Unknown local client endpoint" });
    } catch (error) {
      if (!response.headersSent) json(response, 400, { error: error instanceof Error ? error.message : String(error) });
      else response.end();
    }
  }
  try {
    await new Promise<void>((resolve, reject) => {
      http.once("error", reject);
      http.listen(options.port ?? 0, "127.0.0.1", () => { http.off("error", reject); resolve(); });
    });
  } catch (error) {
    await service.close();
    await fs.rm(uploads, { recursive: true, force: true });
    throw error;
  }
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("Local server did not bind a TCP port");
  origin = `http://127.0.0.1:${address.port}`;
  return {
    origin, token, service, close,
    openUrl: () => {
      const ticket = randomBytes(24).toString("base64url");
      tickets.set(ticket, Date.now() + 5 * 60_000);
      while (tickets.size > 16) tickets.delete(tickets.keys().next().value!);
      return `${origin}/#connect=${ticket}`;
    },
  };
}
