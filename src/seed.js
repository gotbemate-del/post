import fs from 'node:fs';
import path from 'node:path';

import * as db from './db.js';

/**
 * 首次啟動時，把 backup/ 底下的 JSON 匯進空的資料庫。
 *
 * 只在「資料庫真的是空的」時候動作 —— 一旦有人開始用，這裡就不再碰任何東西，
 * 所以放著不會有覆蓋現有資料的風險。
 * （Render 的免費方案不能跑一次性任務，只好讓服務自己開機時處理。）
 */

const BACKUP_DIR = path.resolve(import.meta.dirname, '..', 'backup');

function readJson(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(BACKUP_DIR, name), 'utf8'));
  } catch {
    return null;
  }
}

export async function seedIfEmpty() {
  if (!db.enabled()) return false;

  const [status, additions] = await Promise.all([db.loadStatus(), db.loadAdditions()]);
  if (Object.keys(status).length || additions.length) return false;

  const seedStatus = readJson('status.json');
  const seedAdditions = readJson('additions.json');
  if (!seedStatus && !seedAdditions) return false;

  let counts = { status: 0, additions: 0 };
  if (seedStatus && typeof seedStatus === 'object') {
    for (const [id, record] of Object.entries(seedStatus)) {
      await db.saveStatus(id, record);
      counts.status += 1;
    }
  }
  if (Array.isArray(seedAdditions)) {
    for (const record of seedAdditions) {
      await db.saveAddition(record);
      counts.additions += 1;
    }
  }
  console.log(`[seed] 資料庫是空的，已從 backup/ 匯入 `
    + `${counts.status} 筆發送狀態、${counts.additions} 家新增店家`);
  return true;
}
