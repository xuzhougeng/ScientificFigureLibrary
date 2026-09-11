import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

// Read public metadata and thumbnails only. Never execute module code or alter the app's signed feed.
const exec = promisify(execFile);
const repository = 'jarxunlai/ScientificFigureLibrary-personal';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const output = path.join(root, 'docs/assets/figure-gallery');
const ref = process.argv[2] || 'main';
if (!/^(main|[a-f0-9]{40})$/.test(ref)) throw new Error('Use main or a full commit SHA.');
async function github(endpoint, raw = false) {
  const args = ['api', endpoint];
  const { stdout } = await exec('gh', args, { encoding: 'buffer', maxBuffer: 8 * 1024 * 1024 });
  if (!raw) return stdout;
  const file = JSON.parse(stdout);
  if (file.encoding !== "base64" || typeof file.content !== "string") throw new Error(`Missing file content: ${endpoint}`);
  return Buffer.from(file.content, "base64");
}
const tree = JSON.parse(await github(`repos/${repository}/git/trees/${ref}?recursive=1`));
if (tree.truncated) throw new Error('Repository tree is truncated.');
const commit = tree.sha;
const paths = tree.tree.map(entry => entry.path).filter(p => /^modules\/[a-z0-9-]+\/module\.yml$/.test(p)).sort();
if (!paths.length) throw new Error('No figure modules found.');
function category(m) {
  const id = m.moduleId;
  if (/^(ggtree-|nature-2022-|nature-evoflux-|open-radial-)/.test(id)) return 'genomics';
  if (/^(umap-|nature-metabolome-)/.test(id)) return 'embedding';
  if (/sankey|mantel|upset/.test(id)) return 'relationships';
  if (/heatmap|matrix|clustergvis/.test(id)) return 'heatmap';
  if (/go-|kegg-|gsea|enrichment|volcano/.test(id)) return 'enrichment';
  if (/celltype|stacked|barplot|lollipop|spatial-niche/.test(id)) return 'composition';
  return 'expression';
}
const results = new Array(paths.length);
let cursor = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (cursor < paths.length) {
    const index = cursor++;
    const modulePath = paths[index];
    const base = path.posix.dirname(modulePath);
    const m = YAML.parse((await github(`repos/${repository}/contents/${modulePath}?ref=${commit}`, true)).toString());
    if (base !== `modules/${m.moduleId}`) throw new Error(`Invalid module identity: ${base}`);
    for (const asset of [m.thumbnail, m.preview]) {
      if (!/^[a-zA-Z0-9._-]+$/.test(asset.path)) throw new Error(`Unsafe asset path: ${asset.path}`);
    }
    const thumb = await github(`repos/${repository}/contents/${base}/${m.thumbnail.path}?ref=${commit}`, true);
    if (thumb.length !== m.thumbnail.bytes || createHash('sha256').update(thumb).digest('hex') !== m.thumbnail.sha256) {
      throw new Error(`Thumbnail integrity mismatch: ${m.moduleId}`);
    }
    results[index] = { thumb, data: {
      id: m.moduleId, title: m.title, titleEn: m.titleEn || m.title,
      description: m.description, application: m.application, dataProfile: m.dataProfile,
      category: category(m), family: m.plotFamily, language: m.language,
      tags: m.tags || [], packages: m.packages || [], licenses: m.licenses,
      thumbnail: `assets/figure-gallery/${m.moduleId}.jpg`, thumbnailSha256: m.thumbnail.sha256,
      preview: `https://raw.githubusercontent.com/${repository}/${commit}/${base}/${m.preview.path}`,
      source: `https://github.com/${repository}/tree/${commit}/${base}`,
      code: `https://github.com/${repository}/blob/${commit}/${base}/${m.canonicalCode}`,
    }};
  }
}));
// Publish the new snapshot only after every input has passed validation.
await fs.mkdir(output, { recursive: true });
for (const { thumb, data } of results) await fs.writeFile(path.join(output, `${data.id}.jpg`), thumb);
const snapshot = { schema: 'sfl.website-gallery.v1', repository, providerId: 'io.github.jarxunlai.personal-figures', displayName: 'Open Figure Modules', commit, figures: results.map(r => r.data) };
await fs.writeFile(path.join(output, 'catalog.json'), JSON.stringify(snapshot, null, 2) + '\n');
console.log(`Updated gallery: ${results.length} modules from ${repository}@${commit}`);
console.log(JSON.stringify(Object.fromEntries([...new Set(snapshot.figures.map(m=>m.category))].map(c=>[c,snapshot.figures.filter(m=>m.category===c).length]))));
