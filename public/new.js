/* 新增家數 — 原始名單以外新加的店家，依街道分區
 *
 * 資料流：GET /api/additions 取得整包快照 → 新增／修改／刪除打 /api/additions
 * → 伺服器透過 SSE (/api/events) 用 additions:update 事件廣播整包新的快照。
 */

const state = {
  groups: [],
  summary: { total: 0, sent: 0, unsent: 0, streets: 0 },
  options: { towns: [], streets: [], status: [] },
  collapsed: new Set(),
};

const el = (id) => document.getElementById(id);
const dom = {
  main: el('main'), placeholder: el('placeholder'), toast: el('toast'), conn: el('conn'),
  form: el('addForm'), addBtn: el('addBtn'), addStatus: el('addStatus'),
  townList: el('townList'), streetList: el('streetList'),
};

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

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const escapeAttr = escapeHtml;

function telHref(phone) {
  const digits = (phone || '').replace(/[^\d+]/g, '');
  return digits.length >= 6 ? `tel:${digits}` : '';
}

/** 打勾時間顯示成台灣時間。 */
function sentAtLabel(record) {
  if (!record.sentAt) return '';
  const at = new Date(record.sentAt);
  if (Number.isNaN(at.getTime())) return '';
  return `🕒 ${at.toLocaleString('zh-TW', {
    timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  })}`;
}

async function api(url, options) {
  const res = await fetch(url, options);
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return res.status === 204 ? null : res.json();
}

/* ------------------------------------------------------------------ 渲染 */

function renderSummary() {
  const { total, sent, posted, unsent, streets } = state.summary;
  el('statTotal').textContent = total;
  el('statSent').textContent = sent;
  el('statPosted').textContent = posted;
  el('statUnsent').textContent = unsent;
  el('statStreets').textContent = streets;
}

function card(record) {
  const tel = telHref(record.phone);
  const statusOptions = state.options.status
    .map((v) => `<option value="${escapeAttr(v)}"${v === record.status ? ' selected' : ''}>${escapeHtml(v)}</option>`)
    .join('');

  // 地址／電話都空的時候整塊不要輸出，否則會留下一段空白
  const sentAt = sentAtLabel(record);
  const meta = [
    record.address ? `<span>📍 ${escapeHtml(record.address)}</span>` : '',
    record.phone ? `<span>📞 ${tel ? `<a href="${escapeAttr(tel)}">${escapeHtml(record.phone)}</a>` : escapeHtml(record.phone)}</span>` : '',
    sentAt ? `<span class="store__sentat">${escapeHtml(sentAt)}</span>` : '',
  ].join('');
  const actions = [
    record.address ? `<a class="linkbtn" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(record.address)}" target="_blank" rel="noopener">地圖</a>` : '',
    tel ? `<a class="linkbtn" href="${escapeAttr(tel)}">撥號</a>` : '',
  ].join('');

  return `
<article class="store" data-id="${escapeAttr(record.id)}" data-status="${escapeAttr(record.status)}">
  <div class="store__head">
    <h3 class="store__name">${escapeHtml(record.name)}</h3>
    <span class="tag tag--status" data-v="${escapeAttr(record.status)}">${escapeHtml(record.status)}</span>
    <button type="button" class="iconbtn" data-action="remove" title="刪除這筆" aria-label="刪除 ${escapeAttr(record.name)}">✕</button>
  </div>
  ${meta ? `<div class="store__meta">${meta}</div>` : ''}
  ${actions ? `<div class="store__actions">${actions}</div>` : ''}
  <div class="store__form">
    <div class="store__form-row">
      <label>發送狀態<select data-field="status">${statusOptions}</select></label>
    </div>
  </div>
</article>`;
}

function render() {
  if (!state.groups.length) {
    dom.main.innerHTML = '';
    dom.placeholder.textContent = '還沒有新增任何店家。用上面的表單加第一家。';
    dom.placeholder.hidden = false;
    dom.main.appendChild(dom.placeholder);
    renderSummary();
    return;
  }

  dom.placeholder.hidden = true;
  dom.main.innerHTML = state.groups.map((group) => {
    const open = !state.collapsed.has(group.key);
    const pct = group.total ? Math.round((group.handled / group.total) * 100) : 0;
    return `
<section class="street" data-key="${escapeAttr(group.key)}" data-open="${open}">
  <button type="button" class="street__head" aria-expanded="${open}">
    <span class="street__caret">▼</span>
    <span>
      <span class="street__name">${escapeHtml(group.street)}</span><span class="street__town">${escapeHtml(group.town || '未填鄉鎮市')}</span>
      <span class="street__cats">新增 ${group.total} 家</span>
    </span>
    <span class="street__meta">
      <span class="street__ratio">${group.handled}/${group.total}</span>
      <span class="street__ring"><span style="width:${pct}%"></span></span>
    </span>
  </button>
  <div class="street__body">${group.items.map(card).join('')}</div>
</section>`;
  }).join('');
  renderSummary();
}

function fillOptions() {
  dom.addStatus.innerHTML = state.options.status
    .map((v) => `<option value="${escapeAttr(v)}">${escapeHtml(v)}</option>`).join('');
  dom.townList.innerHTML = state.options.towns
    .map((v) => `<option value="${escapeAttr(v)}"></option>`).join('');
  // 同名街道會跨鄉鎮市重複出現，這裡只要去重後的街道名
  const streets = [...new Set(state.options.streets.map((s) => s.street))]
    .sort((a, b) => a.localeCompare(b, 'zh-Hant'));
  dom.streetList.innerHTML = streets.map((v) => `<option value="${escapeAttr(v)}"></option>`).join('');
}

function ingest(data) {
  state.groups = data.groups ?? [];
  state.summary = data.summary ?? state.summary;
  state.options = data.options ?? state.options;
}

/* ------------------------------------------------------------------ 事件 */

dom.form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const body = Object.fromEntries(new FormData(dom.form));
  if (!body.name.trim()) { toast('店家名稱是必填的', 'error'); return; }

  dom.addBtn.disabled = true;
  try {
    const record = await api('/api/additions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    // 街道／鄉鎮市留著不清，方便連續加同一條街上的店家
    for (const field of ['name', 'address', 'phone']) dom.form.elements[field].value = '';
    dom.form.elements.name.focus();
    toast(`已新增「${record.name}」`);
    await reload();
  } catch (err) {
    toast(`新增失敗：${err.message}`, 'error');
  } finally {
    dom.addBtn.disabled = false;
  }
});

dom.main.addEventListener('click', async (event) => {
  const head = event.target.closest('.street__head');
  if (head) {
    const section = head.closest('.street');
    const open = section.dataset.open === 'true';
    section.dataset.open = String(!open);
    head.setAttribute('aria-expanded', String(!open));
    if (open) state.collapsed.add(section.dataset.key); else state.collapsed.delete(section.dataset.key);
    return;
  }

  const remove = event.target.closest('[data-action="remove"]');
  if (!remove) return;
  const article = remove.closest('.store');
  const name = article.querySelector('.store__name').textContent;
  if (!confirm(`確定要刪除「${name}」？這筆新增紀錄會直接消失。`)) return;
  try {
    await api(`/api/additions/${encodeURIComponent(article.dataset.id)}`, { method: 'DELETE' });
    toast(`已刪除「${name}」`);
    await reload();
  } catch (err) {
    toast(`刪除失敗：${err.message}`, 'error');
  }
});

dom.main.addEventListener('change', async (event) => {
  const input = event.target.closest('[data-field]');
  if (!input) return;
  const article = input.closest('.store');
  try {
    await api(`/api/additions/${encodeURIComponent(article.dataset.id)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [input.dataset.field]: input.value }),
    });
    await reload();
  } catch (err) {
    toast(`儲存失敗：${err.message}`, 'error');
  }
});

/* ------------------------------------------------------------------ 啟動 */

async function reload() {
  ingest(await api('/api/additions'));
  render();
}

function connect() {
  const source = new EventSource('/api/events');
  source.onopen = () => setConn('live', '即時連線');
  source.onerror = () => setConn('offline', '連線中斷，重試中');
  source.addEventListener('additions:update', (event) => {
    ingest(JSON.parse(event.data));
    render();
  });
}

async function init() {
  try {
    ingest(await api('/api/additions'));
  } catch (err) {
    dom.placeholder.textContent = `載入失敗：${err.message}`;
    setConn('offline', '離線');
    return;
  }
  fillOptions();
  render();
  connect();
}

init();
