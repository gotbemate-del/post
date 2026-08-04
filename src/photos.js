import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import * as db from './db.js';
import { makeWriter, readJson } from './jsonfile.js';
import { DATA_DIR } from './store.js';

/**
 * 發送佐證照片。
 *
 * 上傳前前端已經縮圖、壓成 JPEG，並把店名燒在左上角，所以這裡只負責存。
 *
 * 有設 DATABASE_URL 時圖檔直接進 Postgres 的 bytea，記憶體裡只留中繼資料；
 * 沒設就退回本機檔案（$DATA_DIR/photos/），重啟後會消失。
 */

const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const INDEX_FILE = path.join(DATA_DIR, 'photos.json');

const EXTENSION = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };
export const ACCEPTED_TYPES = Object.keys(EXTENSION);

let items = load();
const writeLocal = makeWriter(INDEX_FILE, () => items);

function load() {
  const raw = readJson(INDEX_FILE, []);
  if (!Array.isArray(raw)) return [];
  if (db.enabled()) return raw;
  // 只用本機儲存時，圖檔和索引可能不同步（磁碟被清掉），把對不到檔案的紀錄丟掉
  const alive = raw.filter((item) => item?.file && fs.existsSync(path.join(PHOTO_DIR, item.file)));
  if (alive.length !== raw.length) {
    console.warn(`[photos] ${raw.length - alive.length} 筆紀錄找不到對應圖檔，已略過`);
  }
  return alive;
}

/** 開機時把資料庫裡的照片索引載進記憶體（不含圖檔內容）。 */
export async function loadFromDb() {
  if (!db.enabled()) return false;
  items = await db.loadPhotoIndex();
  return true;
}

const idOf = (file) => String(file).replace(/\.(jpg|png|webp)$/i, '');

export async function addPhoto({ storeId, storeName, buffer, mime }) {
  const extension = EXTENSION[mime];
  if (!extension) throw new Error('只接受 JPEG / PNG / WebP 圖檔');
  if (!buffer?.length) throw new Error('沒有收到圖檔內容');

  const id = randomUUID();
  const record = {
    id,
    storeId,
    storeName: String(storeName ?? '').slice(0, 200),
    file: `${id}.${extension}`,
    bytes: buffer.length,
    createdAt: new Date().toISOString(),
  };

  // 先寫進儲存體、成功了才登記，不然索引會指到一張不存在的照片
  if (db.enabled()) {
    await db.savePhoto({ ...record, mime, buffer, createdAt: record.createdAt });
  } else {
    fs.mkdirSync(PHOTO_DIR, { recursive: true });
    fs.writeFileSync(path.join(PHOTO_DIR, record.file), buffer);
  }

  items.push(record);
  if (!db.enabled()) writeLocal();
  return record;
}

export async function removePhoto(id) {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return false;
  const [record] = items.splice(index, 1);

  if (db.enabled()) {
    await db.deletePhoto(id);
  } else {
    try {
      fs.unlinkSync(path.join(PHOTO_DIR, record.file));
    } catch (err) {
      if (err.code !== 'ENOENT') console.error('[photos] 刪除圖檔失敗：', err.message);
    }
    writeLocal();
  }
  return true;
}

/** 取單張圖的內容，給 /photos 路由送出去用。 */
export async function readPhoto(file) {
  if (db.enabled()) {
    const row = await db.loadPhoto(idOf(file));
    return row ? { content: row.content, mime: row.mime } : null;
  }
  const target = path.join(PHOTO_DIR, path.basename(file));
  if (!items.some((item) => item.file === path.basename(file)) || !fs.existsSync(target)) return null;
  return { content: fs.readFileSync(target), mime: 'image/jpeg' };
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

/** 檔名裡不能出現的字元，換成底線。 */
function safeName(value) {
  return String(value ?? '').replace(/[\\/:*?"<>|]/g, '_').trim() || '未命名';
}

/** 打包下載用的清單：壓縮檔裡按店家分資料夾，檔名帶拍攝時間。 */
export function photoFiles() {
  const perStore = new Map();
  return items.map((item) => {
    const folder = safeName(item.storeName || item.storeId);
    const seq = (perStore.get(folder) ?? 0) + 1;
    perStore.set(folder, seq);
    const at = item.createdAt.slice(0, 19).replace(/[:T]/g, '-');
    return {
      file: item.file,
      name: `${folder}/${at}${seq > 1 ? `_${seq}` : ''}.jpg`,
      date: new Date(item.createdAt),
    };
  });
}

export function photoDir() {
  return PHOTO_DIR;
}
