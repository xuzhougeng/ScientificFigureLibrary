import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const skillsRoot = path.join(packageRoot, "skills");
const mcpEntry = path.join(packageRoot, "dist", "index.js");

export const name = "figure-library";
export const inject = ["skills"];

export function mcpClientConfig() {
  return {
    serverName: "figure-library",
    transport: "stdio",
    command: process.execPath,
    args: [mcpEntry],
    failOnStartupError: false,
  };
}

export function createSkillProvider() {
  const skills = loadSkills();
  return {
    name: "figure-library",
    list: async () => skills.map(candidateOf),
    get: async (candidate) => {
      const name = candidate?.name ?? candidate?.locator?.name;
      const skill = skills.find((entry) => entry.name === name);
      return skill ? definitionOf(skill) : undefined;
    },
  };
}

export function apply(ctx) {
  const disposers = [];
  const skills = ctx?.skills ?? ctx?.get?.("skills");
  if (skills && typeof skills.registerProvider === "function") {
    disposers.push(skills.registerProvider(() => createSkillProvider()));
  } else if (skills && typeof skills.register === "function") {
    for (const skill of loadSkills()) {
      disposers.push(skills.register(definitionOf(skill)));
    }
  }
  if (typeof ctx?.plugin === "function") {
    try {
      const dispose = ctx.plugin("@deepseek-ai/dsh-mcp-client", mcpClientConfig());
      if (typeof dispose === "function") disposers.push(dispose);
    } catch (error) {
      ctx.logger?.warn?.(`figure-library: could not mount @deepseek-ai/dsh-mcp-client: ${error}`);
    }
  } else {
    ctx?.logger?.warn?.(
      "figure-library: ctx.plugin is unavailable; add an @deepseek-ai/dsh-mcp-client row that launches this package's dist/index.js",
    );
  }
  return () => {
    for (const dispose of disposers.reverse()) {
      try {
        dispose();
      } catch {
        // Unload must not throw.
      }
    }
  };
}

function loadSkills() {
  if (!fs.existsSync(skillsRoot)) return [];
  return fs.readdirSync(skillsRoot, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory()) return [];
    const skillFile = path.join(skillsRoot, entry.name, "SKILL.md");
    if (!fs.existsSync(skillFile)) return [];
    const source = fs.readFileSync(skillFile, "utf8");
    const matched = source.match(/^---\r?\n([\s\S]*?)\r?\n---/u);
    const frontmatter = matched ? YAML.parse(matched[1]) : {};
    const skillName = typeof frontmatter?.name === "string" ? frontmatter.name : entry.name;
    const description = typeof frontmatter?.description === "string" ? frontmatter.description : "";
    return [{
      name: skillName,
      description,
      content: stripFrontmatter(source),
      path: skillFile,
      directory: path.join(skillsRoot, entry.name),
    }];
  });
}

function candidateOf(skill) {
  return {
    name: skill.name,
    description: skill.description,
    invocation: { modelInvocable: true, userInvocable: true },
    source: "bundled",
    provider: "figure-library",
    rank: 600,
    locator: { name: skill.name },
    path: skill.path,
    resourceBase: { kind: "directory", path: skill.directory },
  };
}

function definitionOf(skill) {
  return {
    name: skill.name,
    description: skill.description,
    content: skill.content,
    invocation: { modelInvocable: true, userInvocable: true },
    source: "bundled",
    provider: "figure-library",
    path: skill.path,
    resourceBase: { kind: "directory", path: skill.directory },
  };
}

function stripFrontmatter(source) {
  const matched = source.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/u);
  const body = matched ? source.slice(matched[0].length) : source;
  return body.replace(/^\r?\n/u, "");
}
