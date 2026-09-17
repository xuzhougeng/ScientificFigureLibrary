import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { unzipSync } from 'fflate';

const artifact = path.resolve(process.argv[2]);
const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'sfl-local-install-')));
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
const windows = String(manifest.target).startsWith('windows');
const linux = String(manifest.target).startsWith('linux');
if (windows && process.platform !== 'win32') throw new Error('Run the Windows package smoke on Windows, using the extracted bundled node.exe if needed.');
if (linux && process.platform !== 'linux') throw new Error('Run the Linux package smoke on Linux, using the extracted bundled node if needed.');
if (!windows && !linux) throw new Error(`Unsupported installer target: ${manifest.target}`);
const expectedArch = String(manifest.target).endsWith('arm64') ? 'arm64' : 'x64';
if ((process.arch === 'arm64') !== (expectedArch === 'arm64')) throw new Error(`Installer architecture ${manifest.target} does not match this runner (${process.arch})`);
if (manifest.files.some(file => /^assets\/(thumbs|personal-modules\/(previews|thumbs))\//.test(file.file))) throw new Error('Gallery images must not be bundled in the lightweight installer');
for (const file of manifest.files) {
  const bytes = await fs.readFile(path.join(packageRoot, file.file));
  if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256) throw new Error(`Installer inventory mismatch: ${file.file}`);
}
const systemNode = manifest.runtimeMode === 'system';
if (systemNode && manifest.files.some(file => file.file.startsWith('runtime/'))) throw new Error('System-Node ZIP must not contain a runtime');
const binary = systemNode ? process.execPath : path.join(packageRoot, windows ? 'runtime/node.exe' : 'runtime/node');
if (!systemNode) await fs.chmod(binary, 0o755);
for (const script of ['start-sfl.sh', 'mcp.sh', 'Launch-SFL.sh']) {
  try { await fs.chmod(path.join(packageRoot, script), 0o755); } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
const env = { ...process.env, PATH: windows ? path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32') : '/usr/bin:/bin', FIGURE_LIBRARY_DIR: path.join(root, 'library'), SFL_WORKSPACE_LOCATOR_PATH: path.join(root, 'config/workspace.json'), SFL_DIAGNOSTICS_DIR: path.join(root, 'diagnostics'), SFL_PREVIEW_CACHE_DIR: path.join(root, 'library', 'indexes', 'preview-cache', 'v1'), APPDATA: path.join(root, 'config'), LOCALAPPDATA: path.join(root, 'data'), XDG_CONFIG_HOME: path.join(root, 'config'), XDG_DATA_HOME: path.join(root, 'data'), XDG_CACHE_HOME: path.join(root, 'cache'), SFL_OPEN_FIGURE_AUTO_REFRESH: '0', SFL_NO_BROWSER: '1' };
delete env.FIGURE_WORKSPACE_DIR;
delete env.NODE_OPTIONS;
delete env.NODE_PATH;
if (systemNode) {
  const { execFileSync } = await import('node:child_process');
  const resolve = (extraEnv = {}) => {
    if (windows) {
      const powershell = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32/WindowsPowerShell/v1.0/powershell.exe');
      return execFileSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(packageRoot, 'Launch-SFL.ps1'), '-ResolveOnly'], { env: { ...env, ...extraEnv }, encoding: 'utf8', stdio: 'pipe' }).trim();
    }
    return execFileSync(path.join(packageRoot, 'Launch-SFL.sh'), ['--resolve-only'], { env: { ...env, ...extraEnv }, encoding: 'utf8', stdio: 'pipe' }).trim();
  };
  const found = resolve({ SFL_NODE_BINARY: binary });
  if (path.resolve(found) !== path.resolve(binary)) throw new Error('System Node resolver selected the wrong executable');
  const detected = resolve({ SFL_NODE_BINARY: '', PATH: path.dirname(binary) + path.delimiter + env.PATH });
  if (path.resolve(detected) !== path.resolve(binary)) throw new Error('Node on PATH was not detected');
  const oldNode = path.join(root, windows ? 'old-node.ps1' : 'old-node');
  await fs.writeFile(oldNode, windows ? "Write-Output 'v20.0.0'\nexit 0\n" : "#!/bin/sh\necho v20.0.0\n", { mode: 0o755 });
  let oldRejected = false;
  try { resolve({ SFL_NODE_BINARY: oldNode }); } catch { oldRejected = true; }
  if (!oldRejected) throw new Error('Unsupported Node version was not rejected');
  let rejected = false;
  try { resolve({ SFL_NODE_BINARY: path.join(root, windows ? 'missing-node.exe' : 'missing-node') }); } catch { rejected = true; }
  if (!rejected) throw new Error('Missing Node was not rejected');
}
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
  const guide = await request('integrations');
  if (guide.schema !== 'figure-library.local-integration-guide.v1' || guide.command !== connection.mcpServers['figure-library'].command) throw new Error('Integration guide uses the wrong runtime');
  await fs.access(guide.skillPath);
  if (guide.hosts.length < 4 || !guide.verificationPrompt.includes('figure_library_get_skill')) throw new Error('Host installation instructions are missing');
  if (path.resolve(connection.mcpServers['figure-library'].command) !== path.resolve(binary)) throw new Error('App is not using its bundled Node runtime');
  const html = await (await fetch(launch.origin)).text();
  if (!html.includes('本地图片') || !html.includes('copy-mcp') || !html.includes('外部图库') || !html.includes('preview-cache')) throw new Error('Standalone page is absent');
  let binding = (await call('figure_library_plan_bind_global', { libraryDirectory: env.FIGURE_LIBRARY_DIR, migrationMode: 'none' })).plan;
  await call('figure_library_apply_bind_global', { planDigest: binding.planDigest, operationId: 'windows-smoke-bind' }, true);
  binding = (await call('figure_library_plan_bind_workspace', { workspaceDirectory: path.join(root, 'workspace') })).plan;
  await call('figure_library_apply_bind_workspace', { planDigest: binding.planDigest, operationId: 'windows-smoke-workspace' }, true);
  for (const providerId of ['org.figureya.module', 'io.github.jarxunlai.personal-figures']) {
    const found = await call('figure_library_search', { query: 'heatmap', providerIds: [providerId], limit: 1 });
    const remote = found.candidates[0];
    if (!remote || remote.previewDelivery !== 'download' || remote.searchPreviewStatus !== 'ready') throw new Error(`On-demand thumbnail failed: ${JSON.stringify(found)}`);
    const preview = await request('preview', { resultSetId: found.resultSetId, providerId, exactSelector: remote.exactSelector });
    if (!preview.content?.some(item => item.type === 'image')) throw new Error(`Downloaded exact preview is missing: ${JSON.stringify(preview)}`);
  }
  const cachedImages = await fs.readdir(env.SFL_PREVIEW_CACHE_DIR);
  if (cachedImages.length !== 3) throw new Error(`Expected only two requested thumbnails and one separate exact preview, got ${cachedImages.length}`);
  const upload = async (filename, bytes) => {
    const response = await fetch(`${launch.origin}/api/upload`, { method: 'POST', headers: { Authorization: `Bearer ${launch.token}`, 'x-sfl-filename': filename }, body: bytes });
    if (!response.ok) throw new Error('Installer fixture upload failed');
    return (await response.json()).sourcePath;
  };
  const imagePath = await upload('reference.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const codePath = await upload('plot.R', Buffer.from("stop('installer smoke must never execute this code')\n"));
  const working = (await call('figure_library_plan_working_revision', {
    mode: 'create', title: 'localinstallfixture reference', description: 'Synthetic local installer fixture', application: 'localinstallfixture test', dataProfile: 'x y', license: 'MIT', language: 'R',
    assetKind: 'plot_template', codeStatus: 'scaffold', executionStatus: 'not_run',
    visualAssets: [{ assetId: 'reference', sourcePath: imagePath, visualRole: 'source_reference' }],
    codeAssets: [{ assetId: 'code', sourcePath: codePath, codeOrigin: 'user_supplied', language: 'R' }], canonicalCodeAssetId: 'code',
    figureCodeLinks: [{ visualAssetId: 'reference', codeAssetIds: ['code'], relationship: 'user_supplied_pair', confirmedBy: 'user', evidence: 'Synthetic local installer test confirmation.' }],
    confirmations: { createOrUpdate: true, figureUnitBoundary: true, multiImageGrouping: true, primaryPreview: true, assetKind: true, canonicalImplementation: true, codeRelationships: true, codeOrigin: true, executionClaim: true, duplicateDecision: 'create_new' },
  })).plan;
  await call('figure_library_apply_working_revision', { planDigest: working.planDigest, operationId: 'windows-smoke-import', expectedAction: working.action, expectedTemplateId: working.templateId, expectedSeriesDigest: working.expectedSeriesDigest }, true);
  const publication = (await call('figure_library_plan_publish_working_revision', { templateId: working.templateId })).plan;
  await call('figure_library_apply_publish_working_revision', { planDigest: publication.planDigest, operationId: 'windows-smoke-publish', expectedTemplateId: working.templateId, expectedSeriesDigest: publication.expectedSeriesDigest }, true);
  const search = await call('figure_library_search', { query: 'localinstallfixture', providerIds: ['org.scientificfigurelibrary.local'], limit: 2 });
  const candidate = search.candidates.find(value => value.previewAvailable);
  if (!candidate) throw new Error('Published fixture returned no readable candidate');
  const images = await call('figure_library_get_candidate_images', { resultSetId: search.resultSetId, candidateIds: [candidate.candidateId] });
  if (images.images[0].candidateId !== candidate.candidateId) throw new Error('Thumbnail identity mismatch');
  const preview = await request('preview', { resultSetId: search.resultSetId, providerId: candidate.providerId, exactSelector: candidate.exactSelector });
  const image = preview.content.find(item => item.type === 'image');
  const imageHash = createHash('sha256').update(Buffer.from(image.data, 'base64')).digest('hex');
  if (imageHash !== preview.structuredContent.transportSha256) throw new Error('Exact image checksum mismatch');
  const confirmed = await request('confirm', { previewChallenge: preview.structuredContent.previewChallenge, displayedImageSha256: imageHash, imageLoaded: true, confirmedBy: 'user' });
  const materialization = (await call('figure_library_plan_materialize', { providerId: candidate.providerId, exactSelector: candidate.exactSelector, previewReceipt: confirmed.structuredContent.previewReceipt, destination: path.join(root, 'project'), allowNetwork: false })).plan;
  const apply = { planDigest: materialization.planDigest, operationId: 'windows-smoke-materialize', expectedProviderId: candidate.providerId, expectedTarget: materialization.target };
  await call('figure_library_apply_materialize', apply, true);
  const replay = await call('figure_library_apply_materialize', apply, true);
  if (replay.envelope.outcome !== 'replayed') throw new Error('Installer materialization replay failed');
  const result = { status: 'passed', target: manifest.target, version: manifest.version, nodeVersion: manifest.nodeVersion, runtimeMode: manifest.runtimeMode, systemNodeRemovedFromChildPath: !systemNode, syntheticUserActions: true, downloadedPreviews: true, cachedImageCount: cachedImages.length, installedFilesVerified: manifest.files.length, binding: true, localWeb: true, import: true, publish: true, search: true, images: true, localConfirmation: true, materialize: true, replay: true };
  await request('shutdown', {});
  const stopped = await Promise.race([exit, new Promise((_, reject) => { setTimeout(() => reject(new Error('Local service did not stop')), 20_000).unref(); })]);
  if (stopped.code !== 0) throw new Error(`Local service exit failed: ${JSON.stringify(stopped)}`);
  const smokeName = windows
    ? `windows${systemNode ? '-no-node' : ''}-install-smoke.json`
    : `${manifest.target}${systemNode ? '-no-node' : ''}-install-smoke.json`;
  await fs.writeFile(path.join(path.dirname(artifact), smokeName), JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify(result));
} finally {
  if (child.exitCode === null) child.kill();
  await exit;
  await fs.rm(root, { recursive: true, force: true });
}
