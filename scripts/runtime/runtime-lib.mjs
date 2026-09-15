import { createHash } from 'node:crypto';
import { execFile as execFileCallback } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { unzipSync } from 'fflate';

const execFile = promisify(execFileCallback);
const root = path.resolve(import.meta.dirname, '../..');
export const runtimeLock = JSON.parse(await fs.readFile(path.join(import.meta.dirname, 'node-runtime.json'), 'utf8'));
export const sha256 = value => createHash('sha256').update(value).digest('hex');

export async function installRuntime(target, destination) {
  const entry = runtimeLock.archives[target];
  if (!entry) throw new Error(`Unsupported runtime target: ${target}`);
  const cache = path.resolve(process.env.SFL_RUNTIME_CACHE ?? path.join(root, '.runtime-cache'));
  await fs.mkdir(cache, { recursive: true });
  const archivePath = path.join(cache, entry.file);
  let bytes;
  try { bytes = await fs.readFile(archivePath); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!bytes) {
    const response = await fetch(entry.url, { signal: AbortSignal.timeout(180_000) });
    if (!response.ok) throw new Error(`Node runtime download failed: ${response.status} ${entry.url}`);
    bytes = Buffer.from(await response.arrayBuffer());
    if (sha256(bytes) !== entry.sha256) throw new Error(`Runtime download checksum mismatch: ${entry.file}`);
    await fs.writeFile(archivePath, bytes, { flag: 'wx' });
  }
  if (sha256(bytes) !== entry.sha256) throw new Error(`Cached runtime checksum mismatch: ${entry.file}`);
  await fs.mkdir(destination, { recursive: true });
  let binary;
  let license;
  const base = entry.file.replace(/\.(zip|tar\.gz)$/, '');
  if (target.startsWith('win-')) {
    const files = unzipSync(bytes, { filter: file => file.name === `${base}/node.exe` || file.name === `${base}/LICENSE` });
    binary = files[`${base}/node.exe`];
    license = files[`${base}/LICENSE`];
  } else {
    const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'sfl-node-extract-'));
    try {
      await execFile('tar', ['-xzf', archivePath, '-C', staging, `${base}/bin/node`, `${base}/LICENSE`]);
      binary = await fs.readFile(path.join(staging, base, 'bin/node'));
      license = await fs.readFile(path.join(staging, base, 'LICENSE'));
    } finally { await fs.rm(staging, { recursive: true, force: true }); }
  }
  if (!binary?.length || !license?.length) throw new Error(`Runtime binary or license missing: ${entry.file}`);
  const binaryName = target.startsWith('win-') ? 'node.exe' : 'node';
  await fs.writeFile(path.join(destination, binaryName), binary, { mode: 0o755 });
  await fs.writeFile(path.join(destination, 'LICENSE'), license);
  const manifest = { schema: 'figure-library.bundled-runtime.v1', version: runtimeLock.version, target, source: entry.url, archiveSha256: entry.sha256, binary: binaryName, binarySha256: sha256(binary) };
  await fs.writeFile(path.join(destination, 'runtime.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  return manifest;
}
