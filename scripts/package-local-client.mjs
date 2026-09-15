import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { zipSync } from 'fflate';
import { commonPluginFiles, assertPluginReleaseReady } from './plugin-package-lib.mjs';
import { previewDownloadManifests } from './preview-download-manifest.mjs';
import { installRuntime, runtimeLock, sha256 } from './runtime/runtime-lib.mjs';

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dirname, '..');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const target = process.argv[2] === 'macos-native' ? `macos-${process.arch}` : process.argv[2];
const runtimeMode = process.argv.includes('--system-node') ? 'system' : 'bundled';
const variant = runtimeMode === 'system' ? '-no-node' : '';
const output = path.resolve(process.env.SFL_CLIENT_OUTPUT ?? path.join(root, 'release', 'local-client'));
await assertPluginReleaseReady();
await fs.mkdir(output, { recursive: true });
const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'sfl-client-package-'));
async function run(command, args, options = {}) {
  const result = await execFile(command, args, { maxBuffer: 16 * 1024 * 1024, ...options });
  if (result.stdout?.trim()) console.log(result.stdout.trim());
  return result;
}
async function payload(destination) {
  const commit = (await execFile('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  const downloads = await previewDownloadManifests(root, process.env.GITHUB_REPOSITORY ?? 'xuzhougeng/ScientificFigureLibrary', commit);
  const files = new Set([...(await commonPluginFiles()), 'dist/local-app.html', 'package.json', 'docs/LOCAL_CLIENT.md', 'docs/LOCAL_CLIENT_IMPLEMENTATION.md', 'docs/INSTALL_LOCAL.md']);
  for (const relative of files) {
    if (downloads.excluded.has(relative)) continue;
    if (/\.(png|jpe?g|webp|gif)$/i.test(relative) && relative.startsWith('assets/') && !relative.startsWith('assets/brand/')) throw new Error(`Undeclared gallery image in lightweight payload: ${relative}`);
    const to = path.join(destination, relative);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.copyFile(path.join(root, relative), to);
  }
  await fs.writeFile(path.join(destination, 'runtime-mode.json'), JSON.stringify({ mode: runtimeMode, minimumNodeMajor: 22 }) + '\n');
  for (const [relative, bytes] of downloads.manifests) {
    const to = path.join(destination, relative);
    await fs.mkdir(path.dirname(to), { recursive: true });
    await fs.writeFile(to, bytes);
  }
}
async function inventory(directory, relative = '') {
  const output = [];
  for (const entry of (await fs.readdir(path.join(directory, relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const file = path.posix.join(relative, entry.name);
    if (entry.isDirectory()) output.push(...await inventory(directory, file));
    else if (entry.isFile()) { const bytes = await fs.readFile(path.join(directory, file)); output.push({ file, bytes: bytes.length, sha256: sha256(bytes) }); }
    else throw new Error(`Unexpected package entry: ${file}`);
  }
  return output;
}
async function digestFile(file) { await fs.writeFile(`${file}.sha256`, `${sha256(await fs.readFile(file))}  ${path.basename(file)}\n`); }
async function windows() {
  const name = `ScientificFigureLibrary-${pkg.version}-windows-x64${variant}`;
  const directory = path.join(staging, name);
  await payload(directory);
  if (runtimeMode === 'bundled') await installRuntime('win-x64', path.join(directory, 'runtime'));
  for (const host of ['wisp', 'codex', 'claude', 'cursor']) {
    const hostDirectory = `.${host}-plugin`;
    await fs.cp(path.join(root, hostDirectory), path.join(directory, hostDirectory), { recursive: true });
  }
  const wispFile = path.join(directory, '.wisp-plugin/plugin.json');
  const wisp = JSON.parse(await fs.readFile(wispFile, 'utf8'));
  wisp.mcp_servers[0].command = runtimeMode === 'system' ? 'node' : '${WISP_PLUGIN_ROOT}/runtime/node.exe';
  await fs.writeFile(wispFile, JSON.stringify(wisp, null, 2) + '\n');
  const codexFile = path.join(directory, '.codex-plugin/mcp.json');
  const codex = JSON.parse(await fs.readFile(codexFile, 'utf8'));
  codex.mcpServers['figure-library'].command = runtimeMode === 'system' ? 'node' : './runtime/node.exe';
  await fs.writeFile(codexFile, JSON.stringify(codex, null, 2) + '\n');
  const claudeFile = path.join(directory, '.claude-plugin/mcp.json');
  const claude = JSON.parse(await fs.readFile(claudeFile, 'utf8'));
  claude['figure-library'].command = runtimeMode === 'system' ? 'node' : '${CLAUDE_PLUGIN_ROOT}/runtime/node.exe';
  await fs.writeFile(claudeFile, JSON.stringify(claude, null, 2) + '\n');
  const cursorFile = path.join(directory, '.cursor-plugin/mcp.json');
  const cursor = JSON.parse(await fs.readFile(cursorFile, 'utf8'));
  cursor.mcpServers['figure-library'].command = runtimeMode === 'system' ? 'node' : '${PLUGIN_ROOT}/runtime/node.exe';
  await fs.writeFile(cursorFile, JSON.stringify(cursor, null, 2) + '\n');
  await fs.copyFile(cursorFile, path.join(directory, 'mcp.json'));
  await fs.writeFile(path.join(directory, 'Start SFL.cmd'), '@echo off\r\nstart "Scientific Figure Library" /min "%~dp0runtime\\node.exe" "%~dp0dist\\index.js" --local --quiet\r\n');
  await fs.writeFile(path.join(directory, 'MCP.cmd'), '@echo off\r\n"%~dp0runtime\\node.exe" "%~dp0dist\\index.js" %*\r\n');
  await fs.writeFile(path.join(directory, 'READ-ME.txt'), 'Scientific Figure Library\r\n\r\nExtract the entire ZIP, then double-click Start SFL.cmd.\r\nNo Node.js or npm installation is needed.\r\nKeep the extracted folder intact. Quit using the local page.\r\nMCP configuration can be copied from Settings in the app.\r\nSee docs/INSTALL_LOCAL.md for Chinese instructions and preview limitations.\r\n');
  if (runtimeMode === 'system') {
    await fs.copyFile(path.join(root, 'desktop/windows/Launch-SFL.ps1'), path.join(directory, 'Launch-SFL.ps1'));
    await fs.writeFile(path.join(directory, 'Start SFL.cmd'), '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Launch-SFL.ps1"\r\nif errorlevel 1 pause\r\n');
    await fs.writeFile(path.join(directory, 'MCP.cmd'), '@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Launch-SFL.ps1" -Mcp %*\r\n');
    await fs.writeFile(path.join(directory, 'READ-ME.txt'), 'Scientific Figure Library - system Node edition\r\n\r\nRequires installed Node.js 22+. No npm install is needed.\r\nExtract the entire ZIP, then double-click Start SFL.cmd.\r\nSet SFL_NODE_BINARY to an absolute node.exe path if detection fails.\r\nAlternatively download the bundled-Node ZIP.\r\nSee docs/INSTALL_LOCAL.md.\r\n');
  }
  const files = await inventory(directory);
  await fs.writeFile(path.join(directory, 'install-manifest.json'), JSON.stringify({ schema: 'figure-library.local-install.v1', version: pkg.version, target: 'windows-x64', runtimeMode, minimumNodeMajor: 22, nodeVersion: runtimeMode === 'bundled' ? runtimeLock.version : null, files }, null, 2) + '\n');
  const archive = {};
  for (const entry of await inventory(directory)) archive[`${name}/${entry.file}`] = new Uint8Array(await fs.readFile(path.join(directory, entry.file)));
  const file = path.join(output, `${name}.zip`);
  await fs.writeFile(file, zipSync(archive, { level: 6 }));
  await digestFile(file);
  console.log(`WINDOWS_ZIP=${file}`);
}
async function macos(architecture) {
  if (process.platform !== 'darwin') throw new Error('The native macOS App and DMG must be built on macOS.');
  const volume = path.join(staging, 'volume');
  const app = path.join(volume, 'Scientific Figure Library.app');
  const contents = path.join(app, 'Contents');
  const macOS = path.join(contents, 'MacOS');
  const resources = path.join(contents, 'Resources');
  const service = path.join(resources, 'sfl');
  await fs.mkdir(macOS, { recursive: true });
  await payload(service);
  const sources = (await fs.readdir(path.join(root, 'desktop/macos/Sources'))).filter(file => file.endsWith('.swift')).map(file => path.join(root, 'desktop/macos/Sources', file));
  const binaries = [];
  const launchers = [];
  for (const [arch, triple] of [[architecture, architecture === 'arm64' ? 'arm64' : 'x86_64']]) {
    const runtimeDirectory = path.join(service, 'runtime', `darwin-${arch}`);
    const manifest = runtimeMode === 'bundled' ? await installRuntime(`darwin-${arch}`, runtimeDirectory) : undefined;
    const binary = path.join(staging, `sfl-${arch}`);
    await run('xcrun', ['swiftc', '-swift-version', '5', '-O', '-target', `${triple}-apple-macos13.0`, '-o', binary, ...sources]);
    binaries.push(binary);
    const launcher = path.join(staging, `mcp-${arch}`);
    await run('xcrun', ['clang', ...(runtimeMode === 'system' ? ['-DSFL_SYSTEM_NODE=1'] : []), '-arch', triple, '-mmacosx-version-min=13.0', '-O2', path.join(root, 'desktop/macos/Launcher.c'), '-o', launcher]);
    launchers.push(launcher);
    if (manifest) {
      await run('codesign', ['--force', '--sign', '-', '--entitlements', path.join(root, 'desktop/macos/node-entitlements.plist'), path.join(runtimeDirectory, 'node')]);
      await fs.writeFile(path.join(runtimeDirectory, 'runtime.json'), JSON.stringify({ ...manifest, upstreamBinarySha256: manifest.binarySha256, binarySha256: sha256(await fs.readFile(path.join(runtimeDirectory, 'node'))), signing: 'ad-hoc' }, null, 2) + '\n');
    }
  }
  await fs.copyFile(binaries[0], path.join(macOS, 'ScientificFigureLibrary'));
  await fs.copyFile(launchers[0], path.join(macOS, 'sfl-mcp'));
  await fs.chmod(path.join(macOS, 'ScientificFigureLibrary'), 0o755);
  await fs.chmod(path.join(macOS, 'sfl-mcp'), 0o755);
  await run('codesign', ['--force', '--sign', '-', path.join(macOS, 'sfl-mcp')]);
  const icon = path.join(staging, 'icon.png');
  await run('xcrun', ['swift', path.join(root, 'desktop/macos/Icon.swift'), icon]);
  const iconset = path.join(staging, 'AppIcon.iconset');
  await fs.mkdir(iconset);
  for (const size of [16, 32, 128, 256, 512]) for (const scale of [1, 2]) {
    await run('sips', ['-z', String(size * scale), String(size * scale), icon, '--out', path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)]);
  }
  await run('iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'AppIcon.icns')]);
  await fs.writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleName</key><string>Scientific Figure Library</string><key>CFBundleDisplayName</key><string>Scientific Figure Library</string><key>CFBundleExecutable</key><string>ScientificFigureLibrary</string><key>CFBundleIdentifier</key><string>org.scientificfigurelibrary.desktop</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${pkg.version}</string><key>CFBundleVersion</key><string>${pkg.version}</string><key>CFBundleIconFile</key><string>AppIcon</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>\n`);
  await run('codesign', ['--force', '--sign', '-', app]);
  await run('codesign', ['--verify', '--deep', '--strict', app]);
  const smokeRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'sfl-native-smoke-'));
  const env = { ...process.env, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', SFL_NATIVE_SMOKE: '1', SFL_NODE_BINARY: process.execPath, SFL_RUNTIME_MODE: runtimeMode, SFL_SMOKE_ROOT: smokeRoot, SFL_PREVIEW_CACHE_DIR: path.join(smokeRoot, 'preview-cache'), SFL_OPEN_FIGURE_AUTO_REFRESH: '0', FIGURE_LIBRARY_DIR: path.join(smokeRoot, 'library'), XDG_CONFIG_HOME: path.join(smokeRoot, 'config'), XDG_DATA_HOME: path.join(smokeRoot, 'data'), SFL_DIAGNOSTICS_DIR: path.join(smokeRoot, 'diagnostics'), SFL_WORKSPACE_LOCATOR_PATH: path.join(smokeRoot, 'config/workspace.json') };
  delete env.FIGURE_WORKSPACE_DIR;
  if (runtimeMode === 'system') {
    let missingRejected = false;
    try { await execFile(path.join(macOS, 'sfl-mcp'), ['--sfl-node-path'], { env: { ...env, SFL_NODE_BINARY: path.join(smokeRoot, 'missing-node') } }); } catch { missingRejected = true; }
    if (!missingRejected) throw new Error('System Node launcher accepted a missing runtime');
    const oldNode = path.join(smokeRoot, 'old-node');
    await fs.writeFile(oldNode, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    let oldRejected = false;
    try { await execFile(path.join(macOS, 'sfl-mcp'), ['--sfl-node-path'], { env: { ...env, SFL_NODE_BINARY: oldNode } }); } catch { oldRejected = true; }
    if (!oldRejected) throw new Error('System Node launcher accepted an incompatible runtime');
  }
  await run(path.join(macOS, 'ScientificFigureLibrary'), [], { env, timeout: 120_000 });
  const smoke = JSON.parse(await fs.readFile(path.join(smokeRoot, 'native-smoke.json'), 'utf8'));
  if (smoke.status !== 'passed') throw new Error(`Native smoke failed: ${JSON.stringify(smoke)}`);
  await fs.copyFile(path.join(smokeRoot, 'native-smoke.json'), path.join(output, `macos-${architecture}${variant}-smoke.json`));
  await fs.copyFile(path.join(smokeRoot, 'native-window.png'), path.join(output, `macos-${architecture}${variant}-window.png`));
  await fs.copyFile(path.join(smokeRoot, 'integrations-window.png'), path.join(output, `macos-${architecture}${variant}-integrations.png`));
  await fs.rm(smokeRoot, { recursive: true, force: true });
  await fs.writeFile(path.join(volume, 'BUILD-INFO.json'), JSON.stringify({ version: pkg.version, platform: `macos-${architecture}`, minimumOS: '13.0', runtimeMode, minimumNodeMajor: 22, nodeVersion: runtimeMode === 'bundled' ? runtimeLock.version : null, signing: 'ad-hoc', notarized: false, smoke, appFiles: await inventory(app) }, null, 2) + '\n');
  await fs.copyFile(path.join(root, 'docs/INSTALL_LOCAL.md'), path.join(volume, 'INSTALL.md'));
  await fs.symlink('/Applications', path.join(volume, 'Applications'));
  const file = path.join(output, `ScientificFigureLibrary-${pkg.version}-macos-${architecture}${variant}.dmg`);
  await run('hdiutil', ['create', '-volname', 'Scientific Figure Library', '-srcfolder', volume, '-ov', '-format', 'UDZO', file]);
  await run('hdiutil', ['verify', file]);
  await digestFile(file);
  console.log(`MACOS_DMG=${file}`);
}
try {
  if (target === 'windows-x64') await windows();
  else if (target === 'macos-arm64') await macos('arm64');
  else if (target === 'macos-x64') await macos('x64');
  else throw new Error('Usage: node scripts/package-local-client.mjs windows-x64|macos-arm64|macos-x64');
} finally { await fs.rm(staging, { recursive: true, force: true }); }
