import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export interface PickedDirectory {
  directory?: string;
  cancelled?: boolean;
  error?: string;
}

async function existingDirectory(value: string): Promise<PickedDirectory> {
  const directory = value.trim().replace(/\/+$/u, "");
  if (!directory || !path.isAbsolute(directory)) return { cancelled: true };
  const stat = await fs.lstat(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error("Please choose a regular directory");
  return { directory };
}

export async function pickLocalDirectory(): Promise<PickedDirectory> {
  try {
    if (process.platform === "win32") {
      const script = [
        "Add-Type -AssemblyName System.Windows.Forms",
        "$d = New-Object System.Windows.Forms.FolderBrowserDialog",
        "$d.Description = 'Choose the project folder'",
        "$d.ShowNewFolderButton = $true",
        "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write($d.SelectedPath) }",
      ].join("; ");
      const { stdout } = await execute("powershell.exe", ["-NoProfile", "-STA", "-Command", script], {
        timeout: 180_000,
        windowsHide: false,
      });
      return stdout.trim() ? existingDirectory(stdout) : { cancelled: true };
    }
    if (process.platform === "darwin") {
      try {
        const { stdout } = await execute("osascript", [
          "-e",
          'POSIX path of (choose folder with prompt "选择保存模板的目录")',
        ], { timeout: 180_000 });
        return existingDirectory(stdout);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/[-+]1743|User canceled|用户已取消/iu.test(message)) return { cancelled: true };
        throw error;
      }
    }
    const tools: Array<[string, string[]]> = [
      ["zenity", ["--file-selection", "--directory", "--title=选择保存模板的目录"]],
      ["kdialog", ["--getexistingdirectory", os.homedir(), "选择保存模板的目录"]],
    ];
    for (const [command, args] of tools) {
      try {
        const { stdout } = await execute(command, args, { timeout: 180_000 });
        return stdout.trim() ? existingDirectory(stdout) : { cancelled: true };
      } catch (error) {
        const err = error as NodeJS.ErrnoException & { status?: number };
        if (err.code === "ENOENT") continue;
        if (err.status === 1) return { cancelled: true };
        throw error;
      }
    }
    return { error: "当前环境无法打开目录选择框，请手动填写绝对路径。" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (/canceled|cancelled|用户已取消/iu.test(message)) return { cancelled: true };
    return { error: message };
  }
}
