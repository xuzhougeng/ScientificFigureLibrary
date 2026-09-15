import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { ToolOutcomeEnvelope } from "./library-binding-tools.ts";

export function outcome(
  result: ToolOutcomeEnvelope["outcome"],
  code: string,
  summary: string,
  nextAction: ToolOutcomeEnvelope["nextAction"] = "none",
  missingConfirmations?: string[],
): ToolOutcomeEnvelope {
  return {
    schema: "figure-library.tool-outcome.v1",
    outcome: result,
    terminal: true,
    retrySameCall: false,
    code,
    summary,
    nextAction,
    ...(missingConfirmations?.length ? { missingConfirmations } : {}),
  };
}

export function terminal(
  envelope: ToolOutcomeEnvelope,
  details: Record<string, unknown> = {},
  lines: string[] = [],
  meta?: Record<string, unknown>,
): CallToolResult {
  return {
    content: [
      {
        type: "text",
        text: [
          `OUTCOME: ${envelope.outcome}`,
          "TERMINAL: true",
          "RETRY_SAME_CALL: false",
          `CODE: ${envelope.code}`,
          `NEXT_ACTION: ${envelope.nextAction}`,
          ...(envelope.missingConfirmations?.length
            ? [`MISSING_CONFIRMATIONS: ${envelope.missingConfirmations.join(",")}`]
            : []),
          envelope.summary,
          ...lines,
        ].join("\n"),
      },
    ],
    structuredContent: { envelope, ...details },
    ...(meta ? { _meta: meta } : {}),
  };
}
