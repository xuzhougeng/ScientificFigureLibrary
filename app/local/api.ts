import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function records(value: unknown) { return Array.isArray(value) ? value.map(record) : []; }
export function details(result: unknown) { return record(record(result).structuredContent); }
export function requireResult(result: CallToolResult) {
  const envelope = record(details(result).envelope);
  if (result.isError || ["failed", "blocked", "conflict", "not_found", "needs_user_input"].includes(String(envelope.outcome))) {
    const text = result.content.filter((item) => item.type === "text").map((item) => item.text).join("\n");
    throw new Error(String(envelope.summary ?? text ?? "操作失败"));
  }
  return result;
}
export async function api<T = CallToolResult>(endpoint: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/${endpoint}`, {
    method: body === undefined ? "GET" : "POST",
    credentials: "same-origin",
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(String(record(value).error ?? `连接失败 (${response.status})`));
  return value as T;
}
export async function call(name: string, args: Record<string, unknown> = {}, approve = false) {
  return requireResult(await api("call", {
    name, arguments: args,
    ...(approve ? { approval: { planDigest: args.planDigest, confirmedBy: "user" } } : {}),
  }));
}
export async function upload(file: File) {
  const response = await fetch("/api/upload", { method: "POST", body: file, headers: { "x-sfl-filename": encodeURIComponent(file.name) } });
  const value = record(await response.json());
  if (!response.ok) throw new Error(String(value.error));
  return String(value.sourcePath);
}
export function imageData(result: CallToolResult) {
  const image = result.content.find((item) => item.type === "image");
  if (!image) throw new Error("服务没有返回可显示的图片");
  return { ...image, url: `data:${image.mimeType};base64,${image.data}` };
}
export async function imageHash(data: string) {
  const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash)).map((value) => value.toString(16).padStart(2, "0")).join("");
}
