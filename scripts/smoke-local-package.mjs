import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';

if (process.platform !== 'win32') throw new Error('Run this package smoke on Windows, using the extracted bundled node.exe if needed.');
const artifact = path.resolve(process.argv[2]);
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'sfl-windows-install-'));
const zip = unzipSync(new Uint8Array(await fs.readFile(artifact)));
let packageRoot;
for (const [relative, bytes] of Object.entries(zip)) {
  if (!relative || relative.startsWith('/') || relative.includes('\\') || relative.split('/').some(part => part === '..')) throw new Error('Invalid installer path');
  if (relative.endsWith('/')) continue;
  const target = path.join(root, relative);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
  packageRoot ??= path.join(root, relative.split('/')[0]);
}
const manifest = JSON.parse(await fs.readFile(path.join(packageRoot, 'install-manifest.json'), 'utf8'));
for (const file of manifest.files) {
  const bytes = await fs.readFile(path.join(packageRoot, file.file));
  if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Installer inventory mismatch: ${file.file}`);
}
const binary = path.join(packageRoot, 'runtime/node.exe');
const env = { ...process.env, PATH: path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32'), FIGURE_LIBRARY_DIR: path.join(root, 'library'), SFL_WORKSPACE_LOCATOR_PATH: path.join(root, 'config/workspace.json'), SFL_DIAGNOSTICS_DIR: path.join(root, 'diagnostics'), APPDATA: path.join(root, 'config'), LOCALAPPDATA: path.join(root, 'data'), SFL_OPEN_FIGURE_AUTO_REFRESH: '0', SFL_NO_BROWSER: '1' };
delete env.FIGURE_WORKSPACE_DIR;
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
const child = spawn(binary, [path.join(packageRoot, 'dist/index.js'), '--local', '--no-open'], { cwd: root, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '';
child.stderr.on('data', bytes => { log = (log + bytes).slice(-8000); });
let launch;
const exit = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
try {
  launch = await new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('Bundled local startup timed out: ' + log)), 30_000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stdout.on('data', bytes => { buffer += bytes; const index = buffer.indexOf('\n'); if (index >= 0) { clearTimeout(timer); try { resolve(JSON.parse(buffer.slice(0, index))); } catch (error) { reject(error); } } });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Bundled runtime exited early (${code}): ${log}`)); });
  });
  const request = async (route, body) => {
    const response = await fetch(`${launch.origin}/api/${route}`, { method: body === undefined ? 'GET' : 'POST', headers: { Authorization: `Bearer ${launch.token}`, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    if (!response.ok) throw new Error(JSON.stringify(result));
    return result;
  };
  const call = async (name, args = {}, approve = false) => {
    const result = await request('call', { name, arguments: args, ...(approve ? { approval: { planDigest: args.planDigest, confirmedBy: 'user' } } : {}) });
    const data = result.structuredContent;
    if (!data || ['failed','blocked','conflict','not_found','needs_user_input'].includes(data.envelope?.outcome)) throw new Error(JSON.stringify(result));
    return data;
  };
  const connection = await request('connection');
  if (path.resolve(connection.mcpServers['figure-library'].command) !== path.resolve(binary)) throw new Error('App is not using its bundled Node runtime');
  const html = await (await fetch(launch.origin)).text();
  if (!html.includes('本地图片') || !html.includes('copy-mcp')) throw new Error('Standalone page is absent');
  let binding = (await call('figure_library_plan_bind_global', { libraryDirectory: env.FIGURE_LIBRARY_DIR, migrationMode: 'none' })).plan;
  await call('figure_library_apply_bind_global', { planDigest: binding.planDigest, operationId: 'windows-smoke-bind' }, true);
  binding = (await call('figure_library_plan_bind_workspace', { workspaceDirectory: path.join(root, 'workspace') })).plan;
  await call('figure_library_apply_bind_workspace', { planDigest: binding.planDigest, operationId: 'windows-smoke-workspace' }, true);
  const search = await call('figure_library_search', { query: 'volcano differential expression', limit: 2 });
  const candidate = search.candidates.find(value => value.previewAvailable);
  if (!candidate) throw new Error('Bundled catalog returned no readable candidates');
  const images = await call('figure_library_get_candidate_images', { resultSetId: search.resultSetId, candidateIds: [candidate.candidateId] });
  if (images.images[0].candidateId !== candidate.candidateId) throw new Error('Thumbnail identity mismatch');
  const result = { status: 'passed', target: 'windows-x64', version: manifest.version, nodeVersion: manifest.nodeVersion, systemNodeRemovedFromChildPath: true, installedFilesVerified: manifest.files.length, binding: true, localWeb: true, search: true, images: true };
  await request('shutdown', {});
  const stopped = await Promise.race([exit, new Promise((_, reject) => { setTimeout(() => reject(new Error('Local service did not stop')), 20_000).unref(); })]);
  if (stopped.code !== 0) throw new Error(`Local service exit failed: ${JSON.stringify(stopped)}`);
  await fs.writeFile(path.join(path.dirname(artifact), 'windows-install-smoke.json'), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  if (child.exitCode === null) child.kill();
  await exit;
  await fs.rm(root, { recursive: true, force: true });
}
