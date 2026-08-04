import fs from 'node:fs';
import path from 'node:path';

/**
 * 店家狀態儲存層。
 *
 * data/stores.json 是唯讀的基礎名單（由 scripts/parse_xlsx.py 產生）；
 * 使用者在網站上改的狀態另存成 status.json，兩者在讀取時合併。
 * 這樣重新匯入 Excel 名單時不會蓋掉已經填好的聯繫紀錄。
 *
 * DATA_DIR 預設為專案內的 data/，在 Render 上請掛載 Persistent Disk
 * 並把 DATA_DIR 指到掛載點，否則每次重新部署狀態都會歸零。
 */

const ROOT = path.resolve(import.meta.dirname, '..');
const STORES_FILE = path.join(ROOT, 'data', 'stores.json');
const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const STATUS_FILE = path.join(DATA_DIR, 'status.json');

export const STATUS_OPTIONS = ['未聯繫', '已發送', '已回覆', '已合作', '婉拒', '聯繫不上'];
export const CHANNEL_OPTIONS = ['現場拜訪', '電話', 'LINE', 'Email', 'FB/IG 私訊'];

const catalog = JSON.parse(fs.readFileSync(STORES_FILE, 'utf8'));
const storeIndex = new Map(catalog.stores.map((s) => [s.id, s]));

let status = loadStatus();
let writeTimer = null;

function loadStatus() {
  try {
    const raw = JSON.parse(fs.readFileSync(STATUS_FILE, 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[store] 無法讀取 ${STATUS_FILE}，改用空狀態：`, err.message);
    }
    return {};
  }
}

/** 合併多次快速編輯，避免每敲一個字就寫一次磁碟。 */
function scheduleWrite() {
  if (writeTimer) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
      const tmp = `${STATUS_FILE}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(status, null, 1), 'utf8');
      fs.renameSync(tmp, STATUS_FILE);   // 原子寫入，避免中途中斷留下半個檔案
    } catch (err) {
      console.error('[store] 寫入狀態失敗：', err.message);
    }
  }, 300);
}

/** 原始 Excel 有底色 = 已發送，作為沒有人工紀錄時的預設狀態。 */
function defaultsFor(store) {
  return {
    status: store.sent ? '已發送' : '未聯繫',
    contactedAt: '',
    channel: '',
    owner: '',
    reply: '',
    updatedAt: null,
  };
}

export function getStore(id) {
  const store = storeIndex.get(id);
  if (!store) return null;
  return { ...store, ...defaultsFor(store), ...(status[id] ?? {}) };
}

export function listStores() {
  return catalog.stores.map((s) => ({ ...s, ...defaultsFor(s), ...(status[s.id] ?? {}) }));
}

/** 街道分組加上「即時」的完成度統計（用目前狀態，而非 Excel 原始底色）。 */
export function listStreets(stores = listStores()) {
  const byId = new Map(stores.map((s) => [s.id, s]));
  return catalog.streets.map((street) => {
    const items = street.store_ids.map((id) => byId.get(id)).filter(Boolean);
    return {
      ...street,
      total: items.length,
      sent: items.filter((s) => s.status !== '未聯繫').length,
      done: items.filter((s) => s.status === '已合作').length,
    };
  });
}

export function snapshot() {
  const stores = listStores();
  return {
    summary: {
      ...catalog.summary,
      contacted: stores.filter((s) => s.status !== '未聯繫').length,
      done: stores.filter((s) => s.status === '已合作').length,
    },
    streets: listStreets(stores),
    stores,
    extras: catalog.extras,
    options: { status: STATUS_OPTIONS, channel: CHANNEL_OPTIONS },
  };
}

const EDITABLE = ['status', 'contactedAt', 'channel', 'owner', 'reply'];

export function updateStore(id, patch) {
  if (!storeIndex.has(id)) return null;

  const next = { ...defaultsFor(storeIndex.get(id)), ...(status[id] ?? {}) };
  for (const field of EDITABLE) {
    if (!(field in patch)) continue;
    const value = patch[field];
    if (typeof value !== 'string') {
      throw new Error(`${field} 必須是字串`);
    }
    if (field === 'status' && value && !STATUS_OPTIONS.includes(value)) {
      throw new Error(`聯繫狀態必須是：${STATUS_OPTIONS.join('、')}`);
    }
    if (field === 'channel' && value && !CHANNEL_OPTIONS.includes(value)) {
      throw new Error(`聯繫方式必須是：${CHANNEL_OPTIONS.join('、')}`);
    }
    if (field === 'contactedAt' && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error('聯繫日期格式須為 YYYY-MM-DD');
    }
    next[field] = value.slice(0, 500);
  }
  next.updatedAt = new Date().toISOString();

  status[id] = next;
  scheduleWrite();
  return { ...storeIndex.get(id), ...next };
}

export function statusFilePath() {
  return STATUS_FILE;
}
