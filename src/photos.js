import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { makeWriter, readJson } from './jsonfile.js';
import { DATA_DIR } from './store.js';

/**
 * 發送佐證照片。
 *
 * 圖檔存在 $DATA_DIR/photos/，索引（哪張屬於哪家店）存在 $DATA_DIR/photos.json。
 * 上傳前前端已經縮圖、壓成 JPEG，並把店名燒在左上角，所以這裡只負責存檔。
 *
 * ⚠️ 沒有掛 Persistent Disk 的話，這些圖跟索引都會在服務重啟時消失。
 */

const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const INDEX_FILE = path.join(DATA_DIR, 'photos.json');

const EXTENSION = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };
export const ACCEPTED_TYPES = Object.keys(EXTENSION);

let items = load();
const scheduleWrite = makeWriter(INDEX_FILE, () => items);

function load() {
  const raw = readJson(INDEX_FILE, []);
  if (!Array.isArray(raw)) return [];
  // 圖檔和索引可能不同步（例如磁碟被清掉），開機時先把對不到檔案的紀錄丟掉
  const alive = raw.filter((item) => item?.file && fs.existsSync(path.join(PHOTO_DIR, item.file)));
  if (alive.length !== raw.length) {
    console.warn(`[photos] ${raw.length - alive.length} 筆紀錄找不到對應圖檔，已略過`);
  }
  return alive;
}

export function addPhoto({ storeId, storeName, buffer, mime }) {
  const extension = EXTENSION[mime];
  if (!extension) throw new Error('只接受 JPEG / PNG / WebP 圖檔');
  if (!buffer?.length) throw new Error('沒有收到圖檔內容');

  const id = randomUUID();
  const file = `${id}.${extension}`;
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  fs.writeFileSync(path.join(PHOTO_DIR, file), buffer);

  const record = {
    id,
    storeId,
    storeName: String(storeName ?? '').slice(0, 200),
    file,
    bytes: buffer.length,
    createdAt: new Date().toISOString(),
  };
  items.push(record);
  scheduleWrite();
  return record;
}

export function removePhoto(id) {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return false;
  const [record] = items.splice(index, 1);
  try {
    fs.unlinkSync(path.join(PHOTO_DIR, record.file));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[photos] 刪除圖檔失敗：', err.message);
  }
  scheduleWrite();
  return true;
}

/** { storeId: [照片…] }，只有中繼資料，前端拿來決定卡片要顯示幾張縮圖。 */
export function byStore() {
  const grouped = {};
  for (const item of items) {
    (grouped[item.storeId] ??= []).push(item);
  }
  for (const list of Object.values(grouped)) {
    list.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }
  return grouped;
}

export function snapshot() {
  return { photos: byStore(), total: items.length };
}

export function photoDir() {
  return PHOTO_DIR;
}
