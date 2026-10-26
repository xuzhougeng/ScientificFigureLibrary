/**
 * MCP tool profiles let a host load only the tools its users need. They only
 * change which tools the MCP adapter registers; the shared service, the local
 * clients and every write contract stay the same.
 */
export const TOOL_PROFILE_ENV = "SFL_TOOL_PROFILE";
export const TOOL_PROFILES = ["use", "author", "full"] as const;
export type ToolProfile = (typeof TOOL_PROFILES)[number];

/** Find, inspect and materialize templates, plus binding, diagnostics and the App's own tools. */
const USE_TOOLS = [
  "figure_library_get_skill",
  "figure_library_source_status",
  "figure_library_open",
  "figure_library_search",
  "figure_library_search_page",
  "figure_library_list_catalog",
  "figure_library_get_candidate_images",
  "figure_library_describe",
  "figure_library_preview",
  "figure_library_preview_exact",
  "figure_library_preview_exact_headless",
  "figure_library_confirm_selection",
  "figure_library_confirm_selection_headless",
  "figure_library_create_plot_task_headless",
  "figure_library_record_ui_event",
  "figure_library_plan_materialize",
  "figure_library_apply_materialize",
  "figure_library_plan_bind_global",
  "figure_library_apply_bind_global",
  "figure_library_plan_bind_workspace",
  "figure_library_apply_bind_workspace",
  "figure_library_plan_recover_write_lock",
  "figure_library_apply_recover_write_lock",
  "figure_library_list_provider_sources",
  "figure_library_export_diagnostics",
  "figure_library_network_status",
  "figure_library_network_test",
  "figure_library_update_status",
] as const;

/** Adds direct intake, review and the Local Published lifecycle. */
const AUTHOR_TOOLS = [
  "figure_library_plan_working_revision",
  "figure_library_apply_working_revision",
  "figure_library_review_open",
  "figure_library_preview_working_revision",
  "figure_library_template_history",
  "figure_library_diff_revisions",
  "figure_library_plan_review_gate_update",
  "figure_library_apply_review_gate_update",
  "figure_library_plan_publish",
  "figure_library_apply_publish",
  "figure_library_plan_publish_working_revision",
  "figure_library_apply_publish_working_revision",
  "figure_library_plan_discard_working_revision",
  "figure_library_apply_discard_working_revision",
  "figure_library_plan_restore_release",
  "figure_library_apply_restore_release",
  "figure_library_plan_adopt_versioning",
  "figure_library_apply_adopt_versioning",
] as const;

export const PROFILE_TOOL_NAMES: Readonly<Record<Exclude<ToolProfile, "full">, ReadonlySet<string>>> = {
  use: new Set(USE_TOOLS),
  author: new Set([...USE_TOOLS, ...AUTHOR_TOOLS]),
};

export function resolveToolProfile(env: NodeJS.ProcessEnv = process.env): ToolProfile {
  const raw = env[TOOL_PROFILE_ENV]?.trim();
  if (!raw) return "full";
  if ((TOOL_PROFILES as readonly string[]).includes(raw)) return raw as ToolProfile;
  throw new Error(`${TOOL_PROFILE_ENV} must be one of ${TOOL_PROFILES.join(", ")}`);
}

/** `full` registers every tool, including tools added after this list was written. */
export function includesTool(profile: ToolProfile, name: string) {
  return profile === "full" || PROFILE_TOOL_NAMES[profile].has(name);
}
