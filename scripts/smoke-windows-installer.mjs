// Installs the Windows setup silently into a temporary directory, checks the
// installed inventory and `SFL.exe --smoke`, reinstalls over a stale file,
// then uninstalls and checks that the program directory and uninstall entry
// are gone. Per-user setup still registers HKCU uninstall data and a Start
// menu shortcut while it runs; both are removed by the uninstall step.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const APP_ID = '{7D5AAE52-BF12-4BD2-9042-586BC36DE9F1}_is1';
const uninstallKey = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${APP_ID}`;
const setup = path.resolve(process.argv[2] ?? '');
if (process.platform !== 'win32') throw new Error('Run the Windows installer smoke on Windows');
if (!setup.endsWith('-setup.exe')) throw new Error('Usage: node scripts/smoke-windows-installer.mjs <ScientificFigureLibrary-x.y.z-windows-x64-setup.exe>');

const registered = () => {
  try { execFileSync('reg.exe', ['query', uninstallKey], { stdio: 'ignore' }); return true; } catch { return false; }
};
if (registered()) throw new Error('Scientific Figure Library is already installed for this user; uninstall it before running the installer smoke');

const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sfl-installer-smoke-')));
const app = path.join(root, 'app');
const install = (log) => execFileSync(setup, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', `/DIR=${app}`, `/LOG=${path.join(root, log)}`], { stdio: 'inherit', timeout: 300_000 });
const exists = async (file) => fs.access(file).then(() => true, () => false);
try {
  install('install.log');
  const manifest = JSON.parse(await fs.readFile(path.join(app, 'install-manifest.json'), 'utf8'));
  if (manifest.target !== 'windows-x64' || manifest.runtimeMode !== 'bundled') throw new Error(`Unexpected installed package: ${manifest.target} ${manifest.runtimeMode}`);
  for (const file of manifest.files) {
    const bytes = await fs.readFile(path.join(app, file.file));
    if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Installed inventory mismatch: ${file.file}`);
  }
  if (!registered()) throw new Error('Setup did not register an uninstall entry');

  const env = { ...process.env, PATH: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), FIGURE_LIBRARY_DIR: path.join(root, 'library'), SFL_WORKSPACE_LOCATOR_PATH: path.join(root, 'config/workspace.json'), SFL_DIAGNOSTICS_DIR: path.join(root, 'diagnostics'), SFL_PREVIEW_CACHE_DIR: path.join(root, 'library', 'indexes', 'preview-cache', 'v1'), APPDATA: path.join(root, 'config'), LOCALAPPDATA: path.join(root, 'data'), SFL_OPEN_FIGURE_AUTO_REFRESH: '0', SFL_NO_BROWSER: '1' };
  delete env.FIGURE_WORKSPACE_DIR;
  delete env.NODE_OPTIONS;
  delete env.NODE_PATH;
  execFileSync(path.join(app, 'SFL.exe'), ['--smoke'], { cwd: root, env, stdio: ['ignore', 'inherit', 'inherit'], timeout: 120_000 });

  const stale = path.join(app, 'dist', 'stale-from-previous-version.js');
  await fs.writeFile(stale, '');
  install('reinstall.log');
  if (await exists(stale)) throw new Error('Reinstall kept a file from the previous version');

  execFileSync(path.join(app, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { stdio: 'inherit', timeout: 300_000 });
  // The uninstaller finishes from a temporary copy; wait for it to clean up.
  const deadline = Date.now() + 60_000;
  while ((await exists(app) || registered()) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 500));
  if (await exists(app)) throw new Error('Uninstall left the program directory behind');
  if (registered()) throw new Error('Uninstall left the uninstall entry behind');
  const result = { status: 'passed', setup: path.basename(setup), version: manifest.version, installedFilesVerified: manifest.files.length, desktopShell: true, reinstallRemovesStaleFiles: true, uninstall: true };
  await fs.writeFile(path.join(path.dirname(setup), 'windows-installer-smoke.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  if (registered() && await exists(path.join(app, 'unins000.exe'))) {
    try { execFileSync(path.join(app, 'unins000.exe'), ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART'], { stdio: 'ignore', timeout: 300_000 }); } catch {}
  }
  await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
