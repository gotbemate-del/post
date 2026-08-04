import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import * as github from './github.js';
import { makeWriter, readJson } from './jsonfile.js';
import { createSync } from './remotejson.js';
import { DATA_DIR } from './store.js';

/**
 * 發送佐證照片。
 *
 * 圖檔存在 $DATA_DIR/photos/，索引（哪張屬於哪家店）存在 $DATA_DIR/photos.json。
 * 上傳前前端已經縮圖、壓成 JPEG，並把店名燒在左上角，所以這裡只負責存檔。
 *
 * 有設 GITHUB_TOKEN 時，每張照片和索引都會再推一份到 GitHub 的資料分支，
 * 本機那份只當快取——Render 的 free 方案重啟就清空，開機時再從 GitHub 拉回索引，
 * 圖檔則等有人要看的時候才回源抓（見 server.js 的 /photos 路由）。
 *
 * 沒設 GITHUB_TOKEN 就只寫本機，重啟後照片會消失。
 */

const PHOTO_DIR = path.join(DATA_DIR, 'photos');
const INDEX_FILE = path.join(DATA_DIR, 'photos.json');

const EXTENSION = { 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/png': 'png' };
export const ACCEPTED_TYPES = Object.keys(EXTENSION);

const GITHUB_DIR = 'photos';

let items = load();
const writeLocal = makeWriter(INDEX_FILE, () => items);

export const photosSync = createSync('photos/index.json', {
  read: () => items,
  apply: (data) => { if (Array.isArray(data)) items = data; },
  label: () => `照片索引：${items.length} 張`,
  delay: 0,        // 照片本體已經推上去了，索引跟著立刻推，不然重啟會對不起來
});

function load() {
  const raw = readJson(INDEX_FILE, []);
  if (!Array.isArray(raw)) return [];
  if (github.enabled()) return raw;   // 圖檔在 GitHub 上，本機沒有很正常
  // 只用本機儲存時，圖檔和索引可能不同步（磁碟被清掉），把對不到檔案的紀錄丟掉
  const alive = raw.filter((item) => item?.file && fs.existsSync(path.join(PHOTO_DIR, item.file)));
  if (alive.length !== raw.length) {
    console.warn(`[photos] ${raw.length - alive.length} 筆紀錄找不到對應圖檔，已略過`);
  }
  return alive;
}

/** 開機時把 GitHub 上的索引拉回來，蓋掉本機那份（本機只是快取）。 */
export async function restore() {
  if (await photosSync.restore()) {
    writeLocal();
    console.log(`[photos] 已從 GitHub 還原 ${items.length} 張照片的索引`);
  }
}

/** 本機快取沒有這張圖時，回 GitHub 抓一次並寫進快取。 */
export async function ensureLocal(file) {
  const target = path.join(PHOTO_DIR, file);
  if (fs.existsSync(target)) return target;
  if (!github.enabled()) return null;

  const record = items.find((item) => item.file === file);
  if (!record) return null;
  const remote = await github.getFile(`${GITHUB_DIR}/${file}`);
  if (!remote) return null;
  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  fs.writeFileSync(target, remote.content);
  return target;
}

export async function addPhoto({ storeId, storeName, buffer, mime }) {
  const extension = EXTENSION[mime];
  if (!extension) throw new Error('只接受 JPEG / PNG / WebP 圖檔');
  if (!buffer?.length) throw new Error('沒有收到圖檔內容');

  const id = randomUUID();
  const file = `${id}.${extension}`;
  const record = {
    id,
    storeId,
    storeName: String(storeName ?? '').slice(0, 200),
    file,
    bytes: buffer.length,
    createdAt: new Date().toISOString(),
  };

  // 先推 GitHub，成功了才登記；不然索引會指到一張根本不存在的照片
  if (github.enabled()) {
    record.sha = await github.putFile(
      `${GITHUB_DIR}/${file}`, buffer, `新增佐證照片：${record.storeName}`);
  }

  fs.mkdirSync(PHOTO_DIR, { recursive: true });
  fs.writeFileSync(path.join(PHOTO_DIR, file), buffer);
  items.push(record);
  writeLocal();
  await photosSync.flush();
  return record;
}

export async function removePhoto(id) {
  const index = items.findIndex((item) => item.id === id);
  if (index === -1) return false;
  const [record] = items.splice(index, 1);

  try {
    fs.unlinkSync(path.join(PHOTO_DIR, record.file));
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('[photos] 刪除本機圖檔失敗：', err.message);
  }
  if (github.enabled()) {
    try {
      const sha = record.sha ?? (await github.getFile(`${GITHUB_DIR}/${record.file}`))?.sha;
      if (sha) await github.deleteFile(`${GITHUB_DIR}/${record.file}`, sha, `刪除佐證照片：${record.storeName}`);
    } catch (err) {
      console.error('[photos] 從 GitHub 刪除失敗：', err.message);
    }
  }

  writeLocal();
  await photosSync.flush();
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
      path: path.join(PHOTO_DIR, item.file),
      name: `${folder}/${at}${seq > 1 ? `_${seq}` : ''}.jpg`,
      date: new Date(item.createdAt),
    };
  });
}

export function photoDir() {
  return PHOTO_DIR;
}
