import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import { runInContext } from 'node:vm';
import { JSDOM } from 'jsdom';

const docs = new URL('../docs/', import.meta.url);
const catalog = JSON.parse(readFileSync(new URL('assets/figure-gallery/catalog.json', docs), 'utf8'));
const scripts = ['assets/pages.js', 'assets/gallery.js'].map(file => readFileSync(new URL(file, docs), 'utf8'));
const tick = () => new Promise(resolve => setImmediate(resolve));
async function page(query = '', failFirst = false) {
  const dom = new JSDOM(readFileSync(new URL('gallery.html', docs), 'utf8'), {
    url: `https://example.com/ScientificFigureLibrary/gallery.html${query}`, runScripts: 'outside-only',
  });
  let calls = 0;
  dom.window.fetch = async () => new Response(JSON.stringify(catalog), { status: failFirst && ++calls === 1 ? 503 : 200 });
  // JSDOM has no native dialog lifecycle; actual Escape/focus behavior is checked in Chrome.
  const dialog = dom.window.document.querySelector('dialog')!;
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new dom.window.Event('close')); };
  scripts.forEach(script => runInContext(script, dom.getInternalVMContext()));
  await tick();
  return dom;
}

test('website catalog preserves source identity, licenses, and verified thumbnails', () => {
  assert.equal(catalog.repository, 'jarxunlai/ScientificFigureLibrary-personal');
  assert.match(catalog.commit, /^[a-f0-9]{40}$/);
  assert.equal(new Set(catalog.figures.map((f: { id: string }) => f.id)).size, catalog.figures.length);
  for (const figure of catalog.figures) {
    assert.ok(figure.title && figure.titleEn && figure.licenses.content && figure.licenses.code);
    const bytes = readFileSync(new URL(figure.thumbnail, docs));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), figure.thumbnailSha256);
    for (const href of [figure.source, figure.code, figure.preview]) {
      assert.ok(href.includes(`${catalog.repository}/`));
      assert.ok(href.includes(`/${catalog.commit}/modules/${figure.id}/`) || href.endsWith(`/modules/${figure.id}`));
    }
  }
  for (const name of ['index.html', 'gallery.html']) {
    const dom = new JSDOM(readFileSync(new URL(name, docs), 'utf8'));
    for (const el of dom.window.document.querySelectorAll('[src], link[href]')) {
      const asset = el.getAttribute('src') || el.getAttribute('href')!;
      if (!asset.startsWith('http')) assert.ok(existsSync(new URL(asset, docs)), asset);
    }
    dom.window.close();
  }
});

test('gallery combines category and bilingual search, preserves filters on language change, and clears empty results', async () => {
  const dom = await page('?lang=zh&category=embedding&q=椭圆');
  const { document: d } = dom.window;
  assert.equal(d.querySelectorAll('.figure-card').length, 1);
  assert.match(d.querySelector('.figure-card h2')!.textContent!, /椭圆/);
  (d.querySelector('[data-lang="en"]') as HTMLButtonElement).click();
  assert.equal(d.documentElement.lang, 'en');
  assert.equal(d.querySelectorAll('.figure-card').length, 1);
  assert.equal(new URL(dom.window.location.href).searchParams.get('q'), '椭圆');
  assert.match((d.querySelector('[data-page-link]') as HTMLAnchorElement).href, /lang=en/);
  const input = d.querySelector('input')!;
  input.value = 'definitely-no-such-figure';
  input.dispatchEvent(new dom.window.Event('input'));
  assert.equal(d.querySelectorAll('.figure-card').length, 0);
  assert.equal((d.querySelector('.gallery-empty') as HTMLElement).hidden, false);
  (d.querySelector('#gallery-reset') as HTMLButtonElement).click();
  assert.equal(d.querySelectorAll('.figure-card').length, catalog.figures.length);
  assert.equal(new URL(dom.window.location.href).searchParams.has('category'), false);
  dom.window.close();
});

test('a figure deep link opens the correct local preview and preserves search when closed', async () => {
  const figure = catalog.figures.find((f: { id: string }) => f.id === 'umap-style-ellipse-labels');
  const dom = await page(`?lang=en&q=UMAP&figure=${figure.id}`);
  const d = dom.window.document;
  assert.equal(d.querySelector('dialog')!.open, true);
  assert.equal(d.querySelector('#figure-title')!.textContent, figure.titleEn);
  assert.equal(d.querySelector('#figure-image')!.getAttribute('src'), figure.thumbnail);
  assert.equal(d.querySelector('#figure-code')!.getAttribute('href'), figure.code);
  (d.querySelector('#figure-close') as HTMLButtonElement).click();
  assert.equal(d.querySelector('dialog')!.open, false);
  assert.equal(new URL(dom.window.location.href).searchParams.get('q'), 'UMAP');
  assert.equal(new URL(dom.window.location.href).searchParams.has('figure'), false);
  dom.window.close();
});

test('failed catalog loads offer a working retry', async () => {
  const dom = await page('', true);
  const d = dom.window.document;
  assert.equal((d.querySelector('.gallery-error') as HTMLElement).hidden, false);
  (d.querySelector('#gallery-retry') as HTMLButtonElement).click();
  await tick();
  assert.equal((d.querySelector('.gallery-error') as HTMLElement).hidden, true);
  assert.equal(d.querySelectorAll('.figure-card').length, catalog.figures.length);
  dom.window.close();
});
