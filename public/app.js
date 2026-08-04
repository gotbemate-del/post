/* 澎湖店家確認表單 — 前端邏輯
 *
 * 資料流：GET /api/data 取得完整快照 → 使用者編輯 → PATCH /api/stores/:id
 * → 伺服器透過 SSE (/api/events) 廣播給所有開著頁面的裝置。
 */

const state = {
  stores: [],
  streets: [],
  extras: [],
  additions: [],          // 不在原始名單上、在網站上新增的店家
  options: { status: [], channel: [] },
  byId: new Map(),
  collapsed: new Set(),   // 收合中的街道 key；預設全部收合，當成街道索引使用
  allCollapsed: true,
  filtering: false,
};

const el = (id) => document.getElementById(id);
const dom = {
  main: el('main'), placeholder: el('placeholder'), filters: el('filters'),
  stats: el('stats'), progressWrap: el('progressWrap'), progressFill: el('progressFill'),
  progressText: el('progressText'), conn: el('conn'), toast: el('toast'),
  q: el('q'), fTown: el('fTown'), fCategory: el('fCategory'), fStatus: el('fStatus'),
  fStreet: el('fStreet'), fPending: el('fPending'), fSentOriginal: el('fSentOriginal'),
  resultCount: el('resultCount'), toggleAll: el('toggleAll'),
  extrasSection: el('extrasSection'), extrasGrid: el('extrasGrid'),
  toggleAdd: el('toggleAdd'), addbox: el('addbox'), addForm: el('addForm'),
  addBtn: el('addBtn'), addStatus: el('addStatus'),
  townList: el('townList'), streetList: el('streetList'),
};

const ADDED_CATEGORY = '新增';

/* ------------------------------------------------------------------ 工具 */

let toastTimer;
function toast(message, tone = 'ok') {
  dom.toast.textContent = message;
  dom.toast.dataset.tone = tone;
  dom.toast.dataset.show = 'true';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { dom.toast.dataset.show = 'false'; }, 2400);
}

function setConn(stateName, label) {
  dom.conn.dataset.state = stateName;
  dom.conn.querySelector('.conn__label').textContent = label;
}

function debounce(fn, wait) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

function normalizeUrl(raw) {
  if (!raw) return '';
  const value = raw.trim();
  if (!value || value.includes(' ')) return '';
  if (/^https?:\/\//i.test(value)) return value;
  if (/^[\w.-]+\.[a-z]{2,}(\/|$)/i.test(value)) return `https://${value}`;
  return '';
}

function telHref(phone) {
  const digits = (phone || '').replace(/[^\d+]/g, '');
  return digits.length >= 6 ? `tel:${digits}` : '';
}

/** 已發送與已張貼都算「已處理」，進度條與街道比例用這個判斷。 */
const isHandled = (status) => status !== '未發送';

function fillSelect(select, values, placeholder) {
  select.innerHTML = `<option value="">${placeholder}</option>` +
    values.map((v) => `<option value="${escapeAttr(v)}">${escapeHtml(v)}</option>`).join('');
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escapeAttr = escapeHtml;

/* ------------------------------------------------------------------ 篩選 */

function activeFilters() {
  return {
    q: dom.q.value.trim().toLowerCase(),
    town: dom.fTown.value,
    category: dom.fCategory.value,
    status: dom.fStatus.value,
    street: dom.fStreet.value,
    pending: dom.fPending.checked,
    sentOriginal: dom.fSentOriginal.checked,
  };
}

function isFiltering(f) {
  return Boolean(f.q || f.town || f.category || f.status || f.street || f.pending || f.sentOriginal);
}

function matches(store, f) {
  if (f.town && store.town !== f.town) return false;
  if (f.category && store.category !== f.category) return false;
  if (f.status && store.status !== f.status) return false;
  if (f.street && store.street !== f.street) return false;
  if (f.pending && store.status !== '未發送') return false;
  if (f.sentOriginal && !store.sent) return false;
  if (f.q) {
    const hay = [store.name, store.address, store.phone, store.owner, store.reply, store.street]
      .filter(Boolean).join(' ').toLowerCase();
    if (!hay.includes(f.q)) return false;
  }
  return true;
}

/** 原始名單 + 新增店家，依街道 key 併成同一份分區資料。 */
function sectionsWithAdditions() {
  const added = new Map();
  for (const record of state.additions) {
    const key = `${record.town}|${record.street}`;
    if (!added.has(key)) added.set(key, []);
    added.get(key).push(record);
  }

  const sections = state.streets.map((street) => ({
    ...street,
    items: [
      ...street.store_ids.map((id) => state.byId.get(id)).filter(Boolean),
      ...(added.get(street.key) ?? []),
    ],
  }));

  // 新增到原始名單沒有的街道，另外補成新的分區排在後面
  const known = new Set(state.streets.map((s) => s.key));
  for (const [key, items] of added) {
    if (known.has(key)) continue;
    const [town, street] = key.split('|');
    sections.push({ key, town, street, items });
  }
  return sections;
}

/* ------------------------------------------------------------------ 渲染 */

function renderSummary() {
  // 進度以「原始名單 + 新增店家」為母數，新增的店家一樣要跑
  const all = [...state.stores, ...state.additions];
  const sent = all.filter((s) => s.status === '已發送').length;
  const posted = all.filter((s) => s.status === '已張貼').length;
  const handled = sent + posted;

  el('statTotal').textContent = state.stores.length;
  el('statAdded').textContent = state.additions.length;
  el('statSent').textContent = sent;
  el('statPosted').textContent = posted;
  el('statUnsent').textContent = all.length - handled;
  // 新增到原始名單沒有的街道時，分區數會比原本的 92 條多
  el('statStreets').textContent = sectionsWithAdditions().length;

  const pct = all.length ? Math.round((handled / all.length) * 100) : 0;
  dom.progressFill.style.width = `${pct}%`;
  dom.progressText.textContent = `${handled}/${all.length} 已處理（${pct}%）`;
  dom.stats.hidden = false;
  dom.progressWrap.hidden = false;
}

function storeCard(store) {
  const url = normalizeUrl(store.link);
  const tel = telHref(store.phone);
  const dup = store.duplicate_of?.length
    ? `<span class="tag tag--dup">名單重複 ×${store.duplicate_of.length + 1}</span>` : '';

  const statusOptions = state.options.status
    .map((v) => `<option value="${escapeAttr(v)}"${v === store.status ? ' selected' : ''}>${escapeHtml(v)}</option>`)
    .join('');

  const added = store.isAddition === true;

  return `
<article class="store" data-id="${escapeAttr(store.id)}" data-sent="${Boolean(store.sent)}" data-status="${escapeAttr(store.status)}"${added ? ' data-addition="true"' : ''}>
  <div class="store__head">
    <h3 class="store__name">${escapeHtml(store.name)}</h3>
    <span class="tag${added ? ' tag--new' : ''}">${escapeHtml(store.category)}</span>
    <span class="tag tag--status" data-v="${escapeAttr(store.status)}">${escapeHtml(store.status)}</span>
    ${dup}
    ${added ? '<button type="button" class="iconbtn" data-action="remove" title="刪除這筆新增">✕</button>' : ''}
  </div>
  <div class="store__meta">
    <span>📍 ${escapeHtml(store.address || '（未填地址）')}</span>
    ${store.phone ? `<span>📞 ${tel ? `<a href="${escapeAttr(tel)}">${escapeHtml(store.phone)}</a>` : escapeHtml(store.phone)}</span>` : ''}
    ${store.hours ? `<span>🕘 ${escapeHtml(store.hours)}</span>` : ''}
    ${store.note ? `<span>📝 ${escapeHtml(store.note)}</span>` : ''}
  </div>
  <div class="store__actions">
    ${url ? `<a class="linkbtn" href="${escapeAttr(url)}" target="_blank" rel="noopener">官網／粉專</a>` : ''}
    ${store.address ? `<a class="linkbtn" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(store.address)}" target="_blank" rel="noopener">地圖</a>` : ''}
    ${tel ? `<a class="linkbtn" href="${escapeAttr(tel)}">撥號</a>` : ''}
  </div>
  <div class="store__form">
    <div class="store__form-row">
      <label>發送狀態<select data-field="status">${statusOptions}</select></label>
    </div>
    <span class="store__saved" data-role="saved"></span>
  </div>
</article>`;
}

function render() {
  const f = activeFilters();
  const sections = sectionsWithAdditions();

  // 有篩選條件時自動展開命中的街道，清掉條件後回到收合的索引狀態
  const filtering = isFiltering(f);
  if (filtering !== state.filtering) {
    state.filtering = filtering;
    state.allCollapsed = !filtering;
    state.collapsed = filtering ? new Set() : new Set(sections.map((s) => s.key));
    dom.toggleAll.textContent = filtering ? '全部收合' : '全部展開';
  }

  const visible = new Set(
    [...state.stores, ...state.additions].filter((s) => matches(s, f)).map((s) => s.id));
  dom.resultCount.textContent = `符合 ${visible.size} 家`;

  const html = sections.map((street) => {
    const items = street.items.filter((s) => visible.has(s.id));
    if (!items.length) return '';
    const handled = items.filter((s) => isHandled(s.status)).length;
    const pct = Math.round((handled / items.length) * 100);
    const open = !state.collapsed.has(street.key);
    const cats = [...new Set(items.map((s) => s.category))].join('、');
    return `
<section class="street" data-key="${escapeAttr(street.key)}" data-open="${open}">
  <button type="button" class="street__head" aria-expanded="${open}">
    <span class="street__caret">▼</span>
    <span>
      <span class="street__name">${escapeHtml(street.street)}</span><span class="street__town">${escapeHtml(street.town)}</span>
      <span class="street__cats">${escapeHtml(cats)}</span>
    </span>
    <span class="street__meta">
      <span class="street__ratio">${handled}/${items.length}</span>
      <span class="street__ring"><span style="width:${pct}%"></span></span>
    </span>
  </button>
  <div class="street__body">${items.map(storeCard).join('')}</div>
</section>`;
  }).join('');

  dom.placeholder.hidden = Boolean(html);
  if (!html) dom.placeholder.textContent = '沒有符合條件的店家。';
  dom.main.innerHTML = html || '';
  if (!html) dom.main.appendChild(dom.placeholder);
  renderSummary();
}

/** 只更新一張卡片，避免使用者正在打字時整頁重繪。 */
function patchCard(store) {
  const card = dom.main.querySelector(`.store[data-id="${CSS.escape(store.id)}"]`);
  // 被篩選掉的店家沒有卡片可更新；不要整頁重繪，以免使用者捲動位置與輸入被打斷
  if (!card) { renderSummary(); return; }

  card.dataset.status = store.status;
  card.dataset.sent = String(store.sent);
  const tag = card.querySelector('.tag--status');
  tag.dataset.v = store.status;
  tag.textContent = store.status;

  for (const field of ['status', 'contactedAt', 'channel', 'owner', 'reply']) {
    const input = card.querySelector(`[data-field="${field}"]`);
    if (input && input !== document.activeElement && input.value !== (store[field] ?? '')) {
      input.value = store[field] ?? '';
    }
  }

  const section = card.closest('.street');
  if (section) {
    const cards = [...section.querySelectorAll('.store')];
    const handled = cards.filter((c) => isHandled(c.dataset.status)).length;
    section.querySelector('.street__ratio').textContent = `${handled}/${cards.length}`;
    section.querySelector('.street__ring > span').style.width =
      `${Math.round((handled / cards.length) * 100)}%`;
  }
  renderSummary();
}

function renderExtras() {
  if (!state.extras.length) return;
  dom.extrasGrid.innerHTML = state.extras
    .map((e) => `<div class="extra">${escapeHtml(e.text)}<small>${escapeHtml(e.batch)}</small></div>`)
    .join('');
  dom.extrasSection.hidden = false;
}

/* ------------------------------------------------------------------ 儲存 */

const pending = new Map();

async function save(id, patch, savedEl) {
  const merged = { ...(pending.get(id) ?? {}), ...patch };
  pending.set(id, merged);
  try {
    const res = await fetch(`/api/stores/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(merged),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const store = await res.json();
    pending.delete(id);
    applyStore(store);   // patchCard 會跳過使用者正在輸入的欄位
    if (savedEl) {
      savedEl.textContent = `已儲存 ${new Date().toLocaleTimeString('zh-TW', { hour12: false })}`;
      setTimeout(() => { savedEl.textContent = ''; }, 2500);
    }
  } catch (err) {
    pending.delete(id);
    toast(`儲存失敗：${err.message}`, 'error');
  }
}

const saveDebounced = debounce((id, patch, savedEl) => save(id, patch, savedEl), 500);

function applyStore(store) {
  const current = state.byId.get(store.id);
  if (!current) return;
  Object.assign(current, store);
  patchCard(current);
}

/* ------------------------------------------------------------------ 事件 */

dom.main.addEventListener('click', async (event) => {
  const head = event.target.closest('.street__head');
  if (head) {
    const section = head.closest('.street');
    const key = section.dataset.key;
    const open = section.dataset.open === 'true';
    section.dataset.open = String(!open);
    head.setAttribute('aria-expanded', String(!open));
    if (open) state.collapsed.add(key); else state.collapsed.delete(key);
    return;
  }

  const remove = event.target.closest('[data-action="remove"]');
  if (!remove) return;
  const card = remove.closest('.store');
  const name = card.querySelector('.store__name').textContent;
  if (!confirm(`確定要刪除新增的「${name}」？這筆紀錄會直接消失。`)) return;
  try {
    const res = await fetch(`/api/additions/${encodeURIComponent(card.dataset.id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    toast(`已刪除「${name}」`);
    await reloadAdditions();
    render();
  } catch (err) {
    toast(`刪除失敗：${err.message}`, 'error');
  }
});

dom.main.addEventListener('change', async (event) => {
  const input = event.target.closest('[data-field]');
  if (!input) return;
  const card = input.closest('.store');
  const savedEl = card.querySelector('[data-role="saved"]');

  // 新增的店家走另一組 API，改完重抓一次就好（筆數少，不必逐筆合併）
  if (card.dataset.addition === 'true') {
    try {
      const res = await fetch(`/api/additions/${encodeURIComponent(card.dataset.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ [input.dataset.field]: input.value }),
      });
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
      await reloadAdditions();
      render();
    } catch (err) {
      toast(`儲存失敗：${err.message}`, 'error');
    }
    return;
  }

  save(card.dataset.id, { [input.dataset.field]: input.value }, savedEl);
});

dom.main.addEventListener('input', (event) => {
  const input = event.target.closest('[data-field="owner"], [data-field="reply"]');
  if (!input) return;
  const card = input.closest('.store');
  const savedEl = card.querySelector('[data-role="saved"]');
  savedEl.textContent = '輸入中…';
  saveDebounced(card.dataset.id, { [input.dataset.field]: input.value }, savedEl);
});

const rerender = debounce(render, 180);
dom.q.addEventListener('input', rerender);
for (const control of [dom.fTown, dom.fCategory, dom.fStatus, dom.fStreet, dom.fPending, dom.fSentOriginal]) {
  control.addEventListener('change', render);
}

dom.toggleAll.addEventListener('click', () => {
  state.allCollapsed = !state.allCollapsed;
  state.collapsed = state.allCollapsed
    ? new Set(sectionsWithAdditions().map((s) => s.key)) : new Set();
  dom.toggleAll.textContent = state.allCollapsed ? '全部展開' : '全部收合';
  render();
});

/* -------------------------------------------------------------- 新增店家 */

dom.toggleAdd.addEventListener('click', () => {
  const open = dom.addbox.hidden;
  dom.addbox.hidden = !open;
  dom.toggleAdd.setAttribute('aria-expanded', String(open));
  dom.toggleAdd.textContent = open ? '✕ 收起新增' : '➕ 新增店家';
  if (open) dom.addForm.elements.name.focus();
});

dom.addForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(dom.addForm));
  if (!body.name.trim()) { toast('店家名稱是必填的', 'error'); return; }

  dom.addBtn.disabled = true;
  try {
    const res = await fetch('/api/additions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    const record = await res.json();
    // 街道／鄉鎮市留著不清，方便連續加同一條街上的店家
    for (const field of ['name', 'address', 'phone']) dom.addForm.elements[field].value = '';
    dom.addForm.elements.name.focus();
    await reloadAdditions();
    state.collapsed.delete(`${record.town}|${record.street}`);   // 展開剛加進去的那一區
    render();
    toast(`已新增「${record.name}」`);
  } catch (err) {
    toast(`新增失敗：${err.message}`, 'error');
  } finally {
    dom.addBtn.disabled = false;
  }
});

/* ------------------------------------------------------------------ 啟動 */

function ingest(data) {
  state.stores = data.stores;
  state.streets = data.streets;
  state.extras = data.extras ?? [];
  state.options = data.options ?? state.options;
  state.byId = new Map(state.stores.map((s) => [s.id, s]));
}

/** 新增的店家補上主名單卡片需要的欄位，之後就能和原始店家走同一套渲染／篩選。 */
function ingestAdditions(data) {
  state.additions = (data.groups ?? []).flatMap((group) => group.items)
    .map((record) => ({ ...record, isAddition: true, category: ADDED_CATEGORY, sent: false }));
}

async function reloadAdditions() {
  const res = await fetch('/api/additions');
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  ingestAdditions(await res.json());
}

function buildFilterOptions() {
  const uniq = (values) => [...new Set(values.filter(Boolean))];
  fillSelect(dom.fTown, uniq(state.stores.map((s) => s.town)), '全部');
  fillSelect(dom.fCategory, [...uniq(state.stores.map((s) => s.category)), ADDED_CATEGORY], '全部');
  fillSelect(dom.fStatus, state.options.status, '全部');
  fillSelect(dom.fStreet, uniq(state.streets.map((s) => s.street)).sort((a, b) => a.localeCompare(b, 'zh-Hant')), '全部');

  dom.addStatus.innerHTML = state.options.status
    .map((v) => `<option value="${escapeAttr(v)}">${escapeHtml(v)}</option>`).join('');
  dom.townList.innerHTML = uniq(state.stores.map((s) => s.town))
    .map((v) => `<option value="${escapeAttr(v)}"></option>`).join('');
  dom.streetList.innerHTML = uniq(state.streets.map((s) => s.street))
    .sort((a, b) => a.localeCompare(b, 'zh-Hant'))
    .map((v) => `<option value="${escapeAttr(v)}"></option>`).join('');
}

function connect() {
  const source = new EventSource('/api/events');
  source.onopen = () => setConn('live', '即時連線');
  source.onerror = () => setConn('offline', '連線中斷，重試中');
  source.addEventListener('store:update', (event) => {
    const { store } = JSON.parse(event.data);
    // 自己送出的更新已在本地套用過，這裡只補上其他裝置的異動
    if (!pending.has(store.id)) applyStore(store);
  });
  source.addEventListener('additions:update', (event) => {
    ingestAdditions(JSON.parse(event.data));
    render();
  });
}

async function init() {
  try {
    const [data, additions] = await Promise.all([
      fetch('/api/data').then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
      fetch('/api/additions').then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); }),
    ]);
    ingest(data);
    ingestAdditions(additions);
  } catch (err) {
    dom.placeholder.textContent = `載入失敗：${err.message}`;
    setConn('offline', '離線');
    return;
  }
  buildFilterOptions();
  state.collapsed = new Set(sectionsWithAdditions().map((s) => s.key));
  dom.filters.hidden = false;
  render();
  renderExtras();
  connect();
}

init();
