import fs from 'node:fs';
import path from 'node:path';

import { makeWriter, readJson } from './jsonfile.js';

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
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
const STATUS_FILE = path.join(DATA_DIR, 'status.json');

export const STATUS_OPTIONS = ['未發送', '已發送'];
export const CHANNEL_OPTIONS = ['現場拜訪', '電話', 'LINE', 'Email', 'FB/IG 私訊'];

/** 舊版的六段式狀態 → 現在的二元狀態。只有「已合作」算已發送，其餘一律未發送。 */
const LEGACY_STATUS = {
  未聯繫: '未發送',
  已回覆: '未發送',
  已合作: '已發送',
  婉拒: '未發送',
  聯繫不上: '未發送',
};

const catalog = JSON.parse(fs.readFileSync(STORES_FILE, 'utf8'));
const storeIndex = new Map(catalog.stores.map((s) => [s.id, s]));

const status = loadStatus();
const scheduleWrite = makeWriter(STATUS_FILE, () => status);

function loadStatus() {
  const raw = readJson(STATUS_FILE, {});
  // 舊檔案可能還存著六段式狀態，讀進來就順手正規化
  for (const record of Object.values(raw)) {
    const mapped = LEGACY_STATUS[record?.status];
    if (mapped) record.status = mapped;
  }
  return raw;
}

/** 原始 Excel 有底色 = 已發送，作為沒有人工紀錄時的預設狀態。 */
function defaultsFor(store) {
  return {
    status: store.sent ? '已發送' : '未發送',
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

/** 街道分組加上「即時」的發送統計（用目前狀態，而非 Excel 原始底色）。 */
export function listStreets(stores = listStores()) {
  const byId = new Map(stores.map((s) => [s.id, s]));
  return catalog.streets.map((street) => {
    const items = street.store_ids.map((id) => byId.get(id)).filter(Boolean);
    return {
      ...street,
      total: items.length,
      sent: items.filter((s) => s.status === '已發送').length,
    };
  });
}

export function snapshot() {
  const stores = listStores();
  const sent = stores.filter((s) => s.status === '已發送').length;
  return {
    summary: {
      ...catalog.summary,
      sentOriginal: catalog.summary.sent,   // 原始 Excel 底色標記的家數
      sent,                                 // 目前實際的已發送家數
      unsent: stores.length - sent,
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
      throw new Error(`發送狀態必須是：${STATUS_OPTIONS.join('、')}`);
    }
    if (field === 'channel' && value && !CHANNEL_OPTIONS.includes(value)) {
      throw new Error(`發送方式必須是：${CHANNEL_OPTIONS.join('、')}`);
    }
    if (field === 'contactedAt' && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      throw new Error('發送日期格式須為 YYYY-MM-DD');
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

/** 原始名單裡出現過的鄉鎮市／街道，給「新增家數」頁的下拉選單用。 */
export function streetOptions() {
  return {
    towns: [...new Set(catalog.streets.map((s) => s.town))],
    streets: catalog.streets.map(({ town, street }) => ({ town, street })),
  };
}
