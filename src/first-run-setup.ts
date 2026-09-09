import type { ToolNextAction } from "./library-binding-tools.ts";
import type { LibraryRuntimeSnapshot } from "./library-runtime.ts";
import type { WorkspaceRuntimeSnapshot } from "./workspace-runtime.ts";

export const SETUP_MISSING_LIBRARY = "globalLibraryDirectory" as const;
export const SETUP_MISSING_WORKSPACE = "localWorkspaceDirectory" as const;

export type FirstRunMissingConfirmation =
  | typeof SETUP_MISSING_LIBRARY
  | typeof SETUP_MISSING_WORKSPACE;

export interface FirstRunSetupStatus {
  required: boolean;
  libraryBound: boolean;
  workspaceBound: boolean;
  librarySource: LibraryRuntimeSnapshot["directorySource"];
  workspaceSource: WorkspaceRuntimeSnapshot["directorySource"];
  writesEnabled: boolean;
  missingConfirmations: FirstRunMissingConfirmation[];
  code: "setup_required" | "library_ready";
  nextAction: Extract<ToolNextAction, "none" | "ask_user" | "rebind_library" | "rebind_workspace">;
  summary: string;
}

export function libraryIsBoundForWrites(
  library: Pick<LibraryRuntimeSnapshot, "directorySource" | "writesEnabled">,
) {
  return library.writesEnabled && library.directorySource !== "legacy-default";
}

export function firstRunSetupStatus(input: {
  library: Pick<LibraryRuntimeSnapshot, "directorySource" | "writesEnabled">;
  workspace: Pick<WorkspaceRuntimeSnapshot, "confirmed" | "directorySource">;
}): FirstRunSetupStatus {
  const libraryBound = libraryIsBoundForWrites(input.library);
  const workspaceBound = input.workspace.confirmed === true;
  const missingConfirmations: FirstRunMissingConfirmation[] = [];
  if (!libraryBound) missingConfirmations.push(SETUP_MISSING_LIBRARY);
  if (!workspaceBound) missingConfirmations.push(SETUP_MISSING_WORKSPACE);
  const required = missingConfirmations.length > 0;
  let nextAction: FirstRunSetupStatus["nextAction"] = "none";
  if (!libraryBound && !workspaceBound) nextAction = "ask_user";
  else if (!libraryBound) nextAction = "rebind_library";
  else if (!workspaceBound) nextAction = "rebind_workspace";
  return {
    required,
    libraryBound,
    workspaceBound,
    librarySource: input.library.directorySource,
    workspaceSource: input.workspace.directorySource,
    writesEnabled: input.library.writesEnabled,
    missingConfirmations,
    code: required ? "setup_required" : "library_ready",
    nextAction,
    summary: required
      ? "This install has not finished first-run setup. Ask for the missing absolute directories, then Plan/Apply bind. Do not infer the current project folder."
      : "Global Library and Local workspace are bound for this machine.",
  };
}

export function firstRunSetupPayload(status: FirstRunSetupStatus) {
  return {
    required: status.required,
    libraryBound: status.libraryBound,
    workspaceBound: status.workspaceBound,
    librarySource: status.librarySource,
    workspaceSource: status.workspaceSource,
    writesEnabled: status.writesEnabled,
    missingConfirmations: status.missingConfirmations,
  };
}

export function firstRunSetupLines(status: FirstRunSetupStatus) {
  return [
    `SETUP_REQUIRED: ${status.required}`,
    `LIBRARY_BOUND: ${status.libraryBound}`,
    `WORKSPACE_BOUND: ${status.workspaceBound}`,
    `MISSING_CONFIRMATIONS: ${status.missingConfirmations.join(",") || "none"}`,
  ];
}