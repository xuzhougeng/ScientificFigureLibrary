import fs from 'node:fs/promises';
import path from 'node:path';

export async function previewDownloadManifests(root, repository, commit) {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository) || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Preview downloads require a GitHub repository and exact commit');
  const figureYa = JSON.parse(await fs.readFile(path.join(root, 'assets/figureya-preview.manifest.json'), 'utf8'));
  const modules = JSON.parse(await fs.readFile(path.join(root, 'assets/personal-modules/module-preview.manifest.json'), 'utf8'));
  const sets = [
    { prefix: 'assets', providerId: figureYa.providerId, files: figureYa.previews.map(({ file, bytes, sha256, mediaType }) => ({ path: file, bytes, sha256, mediaType })) },
    { prefix: 'assets/personal-modules', providerId: modules.providerId, files: modules.entries.map(({ path, bytes, sha256, mediaType }) => ({ path, bytes, sha256, mediaType })) },
  ];
  const excluded = new Set();
  const manifests = new Map();
  for (const set of sets) {
    for (const file of set.files) excluded.add(`${set.prefix}/${file.path}`);
    manifests.set(`${set.prefix}/preview-downloads.json`, Buffer.from(JSON.stringify({ schema: 'figure-library.preview-downloads.v1', repository, commit, ...set }, null, 2) + '\n'));
  }
  return { excluded, manifests };
}
