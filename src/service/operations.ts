import { z } from "zod";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";

/** Business commands are ordinary validated functions. There is no protocol client or transport. */
export interface OperationMetadata {
  title?: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean; [key: string]: unknown };
  _meta?: Record<string, unknown>;
}
export interface OperationDefinition extends OperationMetadata {
  name: string;
  inputSchema: z.ZodRawShape | z.ZodType;
  execute(input: unknown): Promise<CallToolResult>;
}
export interface ResourceMetadata { title?: string; description?: string; mimeType?: string; _meta?: Record<string, unknown> }
export interface ResourceDefinition extends ResourceMetadata {
  name: string;
  uri: string | { uriTemplate: string };
  read(uri: URL, variables: Record<string, string>): Promise<ReadResourceResult>;
}
export const resourceTemplate = (uriTemplate: string) => ({ uriTemplate });
type OperationInput = z.ZodRawShape | z.ZodType;
type ParsedInput<Schema extends OperationInput> = Schema extends z.ZodType
  ? z.output<Schema>
  : Schema extends z.ZodRawShape ? z.output<z.ZodObject<Schema>> : never;

export class OperationRegistry {
  readonly operations = new Map<string, OperationDefinition>();
  readonly resources = new Map<string, ResourceDefinition>();
  private closed = false;
  private pending = new Set<Promise<unknown>>();

  define<Shape extends OperationInput = {}>(
    name: string,
    configuration: OperationMetadata & { inputSchema?: Shape },
    execute: (input: ParsedInput<Shape>) => Promise<CallToolResult> | CallToolResult,
  ) {
    if (this.operations.has(name)) throw new Error(`Duplicate business operation: ${name}`);
    const inputSchema = configuration.inputSchema ?? {} as Shape;
    const schema = inputSchema instanceof z.ZodType ? inputSchema : z.object(inputSchema);
    this.operations.set(name, {
      ...configuration, name, inputSchema,
      execute: async (input) => execute(await schema.parseAsync(input ?? {}) as ParsedInput<Shape>),
    });
  }

  defineResource(name: string, uri: ResourceDefinition["uri"], configuration: ResourceMetadata,
    read: (uri: URL, variables: Record<string, string>) => Promise<ReadResourceResult> | ReadResourceResult) {
    if (this.resources.has(name)) throw new Error(`Duplicate business resource: ${name}`);
    this.resources.set(name, { name, uri, ...configuration, read: async (uri, variables) => read(uri, variables) });
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.closed) throw new Error("Library service session is closed");
    const request = operation();
    this.pending.add(request);
    try { return await request; } finally { this.pending.delete(request); }
  }

  execute(name: string, input: unknown = {}) {
    return this.run(async () => {
      const operation = this.operations.get(name);
      if (!operation) throw new Error(`Unknown library operation: ${name}`);
      return operation.execute(input);
    });
  }

  readResource(rawUri: string) {
    return this.run(async () => {
      const uri = new URL(rawUri);
      for (const resource of this.resources.values()) {
        if (typeof resource.uri === "string") {
          if (resource.uri === uri.href) return resource.read(uri, {});
          continue;
        }
        const names: string[] = [];
        const expression = resource.uri.uriTemplate.split(/(\{[^}]+\})/u).map((part) => {
          if (part.startsWith("{")) { names.push(part.slice(1, -1)); return "([^/?#]+)"; }
          return part.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
        }).join("");
        const match = new RegExp(`^${expression}$`, "u").exec(uri.href);
        if (match) return resource.read(uri, Object.fromEntries(names.map((name, index) => [name, decodeURIComponent(match[index + 1]!)])));
      }
      throw new Error("Library resource not found in this service session");
    });
  }

  async close() {
    this.closed = true;
    await Promise.allSettled([...this.pending]);
  }
}
