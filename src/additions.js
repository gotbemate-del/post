import { randomUUID } from 'node:crypto';
import path from 'node:path';

import { makeWriter, readJson } from './jsonfile.js';
import { createSync } from './remotejson.js';
import { DATA_DIR, STATUS_OPTIONS, isHandled, stampSentAt, streetOptions } from './store.js';

/**
 * 「新增家數」——原始名單以外、在外面跑的時候現場加進來的店家。
 *
 * 和 data/stores.json 完全分開存（$DATA_DIR/additions.json），因為原始名單是
 * 由 Excel 產生的唯讀資料，重新匯入時不能被這裡的新增蓋掉。
 * 一樣依「鄉鎮市 · 街道」分區，街道可以直接打新的，不限於原始名單的 92 條。
 */

const FILE = path.join(DATA_DIR, 'additions.json');
const NO_STREET = '未分類';

const LIMITS = { name: 200, address: 500, phone: 60, town: 40, street: 60 };

let items = load();
const writeLocal = makeWriter(FILE, () => items);

function load() {
  const raw = readJson(FILE, []);
  return Array.isArray(raw) ? raw : [];
}

export const additionsSync = createSync('state/additions.json', {
  read: () => items,
  apply: (data) => { if (Array.isArray(data)) items = data; },
  label: () => `新增店家：${items.length} 家`,
});

function scheduleWrite() {
  writeLocal();
  additionsSync.schedule();
}

function text(value, field) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error(`${field} 必須是字串`);
  return value.trim().slice(0, LIMITS[field] ?? 500);
}

/** 把送進來的欄位套到 record 上，順便做驗證。patch 沒帶到的欄位不動。 */
function applyFields(record, patch) {
  const before = record.status;
  for (const field of ['name', 'address', 'phone', 'town', 'street']) {
    const value = text(patch[field], field);
    if (value !== undefined) record[field] = value;
  }
  if (patch.status !== undefined) {
    const value = text(patch.status, 'status');
    if (!STATUS_OPTIONS.includes(value)) {
      throw new Error(`發送狀態必須是：${STATUS_OPTIONS.join('、')}`);
    }
    record.status = value;
  }
  if (!record.name) throw new Error('店家名稱是必填的');
  if (!record.street) record.street = NO_STREET;
  stampSentAt(record, before);
  record.updatedAt = new Date().toISOString();
  return record;
}

export function createAddition(patch = {}) {
  const record = applyFields({
    id: `新增-${randomUUID().slice(0, 8)}`,
    name: '', address: '', phone: '', town: '', street: '',
    status: '未發送',
    sentAt: null,
    createdAt: new Date().toISOString(),
    updatedAt: null,
  }, patch);
  items.push(record);
  scheduleWrite();
  return record;
}

export function updateAddition(id, patch = {}) {
  const record = items.find((r) => r.id === id);
  if (!record) return null;
  // 驗證失敗時不能留下改到一半的紀錄，先在副本上套用
  const next = applyFields({ ...record }, patch);
  Object.assign(record, next);
  scheduleWrite();
  return record;
}

export function removeAddition(id) {
  const index = items.findIndex((r) => r.id === id);
  if (index === -1) return false;
  items.splice(index, 1);
  scheduleWrite();
  return true;
}

/** 依「鄉鎮市 · 街道」分區，排序比照主名單：先鄉鎮市、再街道、組內照新增時間。 */
export function groupByStreet() {
  const groups = new Map();
  for (const record of items) {
    const key = `${record.town}|${record.street}`;
    if (!groups.has(key)) {
      groups.set(key, { key, town: record.town, street: record.street, items: [] });
    }
    groups.get(key).items.push(record);
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      items: group.items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)),
      total: group.items.length,
      sent: group.items.filter((r) => r.status === '已發送').length,
      posted: group.items.filter((r) => r.status === '已張貼').length,
      handled: group.items.filter((r) => isHandled(r.status)).length,
    }))
    .sort((a, b) => a.town.localeCompare(b.town, 'zh-Hant') || a.street.localeCompare(b.street, 'zh-Hant'));
}

export function snapshot() {
  const groups = groupByStreet();
  const sent = items.filter((r) => r.status === '已發送').length;
  const posted = items.filter((r) => r.status === '已張貼').length;
  return {
    groups,
    summary: {
      total: items.length,
      sent,
      posted,
      handled: sent + posted,
      unsent: items.length - sent - posted,
      streets: groups.length,
    },
    options: { ...streetOptions(), status: STATUS_OPTIONS },
  };
}

export function additionsFilePath() {
  return FILE;
}
