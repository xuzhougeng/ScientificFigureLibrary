(() => {
  const grid = document.querySelector('.figure-grid');
  const search = document.getElementById('figure-search');
  const filters = document.querySelector('.gallery-filters');
  const count = document.querySelector('.gallery-count');
  const empty = document.querySelector('.gallery-empty');
  const error = document.querySelector('.gallery-error');
  const dialog = document.querySelector('.figure-dialog');
  const categories = ['all', 'embedding', 'heatmap', 'enrichment', 'composition', 'genomics', 'relationships', 'expression'];
  let figures = [];
  let selected = null;
  let opener = null;
  let loaded = false;
  let activeCategory = 'all';
  const text = key => I18N[lang()][`gallery.${key}`];
  const title = figure => lang() === 'en' ? figure.titleEn : figure.title;
  function updateUrl() {
    const url = new URL(location.href);
    for (const [key, value] of [['q', search.value.trim()], ['category', activeCategory === 'all' ? '' : activeCategory], ['figure', selected?.id || '']]) {
      if (value) url.searchParams.set(key, value);
      else url.searchParams.delete(key);
    }
    history.replaceState(null, '', url);
  }
  function readUrl() {
    const params = new URLSearchParams(location.search);
    search.value = (params.get('q') || '').slice(0, 200);
    activeCategory = categories.includes(params.get('category')) ? params.get('category') : 'all';
  }
  function create(tag, className, content) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (content != null) element.textContent = content;
    return element;
  }
  function renderFilters() {
    filters.replaceChildren();
    for (const category of categories) {
      const total = category === 'all' ? figures.length : figures.filter(f => f.category === category).length;
      if (!total) continue;
      const button = create('button', 'gallery-filter', `${text(category)} ${total}`);
      button.type = 'button';
      button.dataset.category = category;
      button.setAttribute('aria-pressed', String(category === activeCategory));
      button.addEventListener('click', () => {
        activeCategory = category;
        updateUrl();
        render();
        filters.querySelector(`[data-category="${category}"]`)?.focus({ preventScroll: true });
      });
      filters.append(button);
    }
  }
  function render() {
    if (!loaded) { count.textContent = error.hidden ? text('loading') : ''; return; }
    renderFilters();
    const words = search.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
    const visible = figures.filter(figure => {
      const haystack = [figure.id, figure.title, figure.titleEn, figure.description, figure.family, text(figure.category), ...figure.tags, ...figure.packages].join(' ').toLocaleLowerCase();
      return (activeCategory === 'all' || figure.category === activeCategory) && words.every(word => haystack.includes(word));
    });
    grid.replaceChildren();
    for (const figure of visible) {
      const article = create('article', 'figure-card');
      const button = create('button', 'figure-card-button');
      button.type = 'button';
      button.dataset.figure = figure.id;
      button.setAttribute('aria-label', `${text('view')}: ${title(figure)}`);
      const visual = create('div', 'figure-card-visual');
      const img = create('img');
      img.src = figure.thumbnail;
      img.alt = '';
      img.loading = 'lazy';
      img.decoding = 'async';
      img.width = 600;
      img.height = 400;
      visual.append(img);
      const body = create('div', 'figure-card-body');
      body.append(create('p', 'figure-card-category', `${text(figure.category)} · ${figure.language}`), create('h2', '', title(figure)));
      const packages = create('p', 'figure-card-packages', figure.packages.slice(0, 3).join(' / '));
      body.append(packages);
      button.append(visual, body);
      button.addEventListener('click', () => openFigure(figure, button));
      article.append(button);
      grid.append(article);
    }
    count.textContent = text('count').replace('{shown}', visible.length).replace('{total}', figures.length);
    empty.hidden = visible.length > 0;
    grid.setAttribute('aria-busy', 'false');
    if (selected) renderDetails(selected);
  }
  function renderDetails(figure) {
    document.getElementById('figure-title').textContent = title(figure);
    document.getElementById('figure-family').textContent = `${text(figure.category)} · ${figure.language}`;
    document.getElementById('figure-description').textContent = figure.description;
    document.getElementById('figure-data').textContent = figure.dataProfile;
    document.getElementById('figure-packages').textContent = figure.packages.join(' · ');
    document.getElementById('figure-license').textContent = `${text('codeLicense')}: ${figure.licenses.code} · ${text('contentLicense')}: ${figure.licenses.content} · ${text('docsLicense')}: ${figure.licenses.documentation}`;
    document.getElementById('figure-image').alt = title(figure);
    document.getElementById('figure-image-status').textContent = text('previewNote');
    document.getElementById('figure-module').href = figure.source;
    document.getElementById('figure-code').href = figure.code;
    document.getElementById('figure-original').href = figure.preview;
  }
  function openFigure(figure, button) {
    selected = figure;
    opener = button || null;
    renderDetails(figure);
    const img = document.getElementById('figure-image');
    img.src = figure.thumbnail;
    if (!dialog.open) dialog.showModal();
    document.body.classList.add('dialog-open');
    updateUrl();
  }
  document.getElementById('figure-close').addEventListener('click', () => dialog.close());
  dialog.addEventListener('click', event => {
    const box = dialog.getBoundingClientRect();
    if (event.target === dialog && (event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom)) dialog.close();
  });
  dialog.addEventListener('close', () => {
    selected = null;
    document.body.classList.remove('dialog-open');
    updateUrl();
    if (opener?.isConnected) opener.focus({ preventScroll: true });
    else search.focus({ preventScroll: true });
  });
  search.addEventListener('input', () => { updateUrl(); render(); });
  document.getElementById('gallery-reset').addEventListener('click', () => {
    search.value = '';
    activeCategory = 'all';
    updateUrl();
    render();
    search.focus();
  });
  document.addEventListener('sfl:languagechange', render);
  window.addEventListener('popstate', () => {
    readUrl();
    render();
    const id = new URLSearchParams(location.search).get('figure');
    const figure = figures.find(f => f.id === id);
    if (figure) openFigure(figure);
    else if (dialog.open) dialog.close();
  });
  async function load() {
    loaded = false;
    error.hidden = true;
    empty.hidden = true;
    grid.setAttribute('aria-busy', 'true');
    count.textContent = text('loading');
    try {
      const response = await fetch('assets/figure-gallery/catalog.json');
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const catalog = await response.json();
      if (catalog.schema !== 'sfl.website-gallery.v1' || !Array.isArray(catalog.figures) || !catalog.figures.length) throw new Error('Invalid gallery catalog');
      figures = catalog.figures;
      const commit = document.getElementById('gallery-commit');
      commit.textContent = catalog.commit.slice(0, 7);
      commit.href = `https://github.com/${catalog.repository}/tree/${catalog.commit}`;
      loaded = true;
      readUrl();
      render();
      const selectedId = new URLSearchParams(location.search).get('figure');
      const figure = figures.find(f => f.id === selectedId);
      if (figure) openFigure(figure);
    } catch {
      grid.setAttribute('aria-busy', 'false');
      count.textContent = '';
      error.hidden = false;
    }
  }
  document.getElementById('gallery-retry').addEventListener('click', load);
  load();
})();
