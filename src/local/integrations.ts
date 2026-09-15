import path from "node:path";

export function localConnection(options: { node: string; server: string }) {
  return { mcpServers: { "figure-library": { command: options.node, args: [options.server] } } };
}

/** Instructions only: the local client never edits another application's configuration. */
export function integrationGuide(options: { node?: string; server?: string; platform?: NodeJS.Platform; nodeVersion?: string } = {}) {
  const platform = options.platform ?? process.platform;
  const paths = platform === "win32" ? path.win32 : path.posix;
  const node = options.node ?? process.execPath;
  const server = options.server ?? path.resolve(import.meta.dirname, "index.js");
  const skillDirectory = paths.resolve(paths.dirname(server), "../skills/figure-library");
  const skillPath = paths.join(skillDirectory, "SKILL.md");
  const quote = (value: string) => platform === "win32" ? `'${value.replaceAll("'", "''")}'` : `'${value.replaceAll("'", `'"'"'`)}'`;
  const launch = `${quote(node)} ${quote(server)}`;
  const connection = localConnection({ node, server });
  const snippets = [
    { id: "json", title: "通用 MCP JSON", format: "JSON", description: "将 figure-library 合并到已有的 mcpServers 中，保留其他服务。", content: JSON.stringify(connection, null, 2) },
    { id: "codex-command", title: "Codex CLI 添加命令", format: platform === "win32" ? "PowerShell" : "Terminal", description: "在已安装 Codex CLI 的本机终端运行一次。", content: `codex mcp add figure-library -- ${launch}` },
    { id: "codex-config", title: "Codex 配置片段", format: "TOML", description: "合并到 Codex 使用的 config.toml；已有同名配置时更新该项。", content: `[mcp_servers.figure-library]\ncommand = ${JSON.stringify(node)}\nargs = [${JSON.stringify(server)}]\n` },
    { id: "claude-command", title: "Claude Code 添加命令", format: platform === "win32" ? "PowerShell" : "Terminal", description: "在已安装 Claude Code 的本机终端运行一次，添加到用户配置。", content: `claude mcp add --transport stdio --scope user figure-library -- ${launch}` },
  ];
  return {
    schema: "figure-library.local-integration-guide.v1", platform, nodeVersion: options.nodeVersion ?? process.versions.node,
    command: node, args: [server], skillDirectory, skillPath, snippets,
    hosts: [
      { id: "codex", title: "Codex CLI / Desktop", steps: ["已安装 CLI 时运行下面的添加命令；也可以将 TOML 片段合并到该客户端使用的 ~/.codex/config.toml。", "在桌面客户端的 MCP 设置中检查 figure-library，并重启或重新加载连接。CLI 可运行 codex mcp list 检查配置。"], snippetIds: ["codex-command", "codex-config"], documentationUrl: "https://developers.openai.com/codex/mcp/" },
      { id: "claude-code", title: "Claude Code", steps: ["在本机终端执行下面的添加命令。", "重启 Claude Code，在 /mcp 中检查 figure-library。"], snippetIds: ["claude-command"], documentationUrl: "https://code.claude.com/docs/en/mcp" },
      { id: "claude-desktop", title: "Claude Desktop", steps: ["打开桌面应用的 Settings → Developer → Edit Config。", "把下面的 figure-library 配置合并到 claude_desktop_config.json 的 mcpServers，再完全退出并重新打开 Claude Desktop。"], snippetIds: ["json"], documentationUrl: "https://modelcontextprotocol.io/docs/develop/connect-local-servers" },
      { id: "other", title: "zcode / WorkBuddy / 其他客户端", steps: ["在客户端中找到 MCP 服务配置入口，选择本机 stdio 类型。", "若支持 mcpServers JSON，合并下面的配置；若使用表单，分别填写命令和参数，不要将它们拼成一个命令字段。", "保存后重新连接。各客户端版本的配置入口和图片显示能力可能不同，可对照其帮助文档。"], snippetIds: ["json"] },
    ],
    skillInstructions: "MCP 连接后，可让宿主调用 figure_library_get_skill 读取核心指导，无需额外复制文件。若宿主支持本地 Skill 安装，将下方整个 figure-library 文件夹导入其 Skill 目录，保留 references 等相对路径；不能只复制 SKILL.md。",
    verificationPrompt: "请调用 figure_library_get_skill 读取使用指导，然后调用 figure_library_source_status 检查图库绑定。若已完成绑定，搜索 heatmap 并通过 figure_library_get_candidate_images 展示候选图片，等待我选择。",
    notes: ["先将 App 安装或解压到固定位置，再复制配置。移动安装目录、切换运行时后需要更新外部配置。", "外部工具启动自己的本机 MCP 服务进程，SFL 窗口可以关闭。各会话独立，选图和确认应在同一外部会话中完成。", "支持 MCP App 的宿主可打开简化图片界面；其他宿主通过标准图片工具使用图库。图片首次读取需要下载。", "以上是本机接入配置；若宿主运行在 WSL、容器或远程机器，需要使用该环境可访问的程序与路径。"],
  };
}
