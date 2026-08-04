/**
 * 一次性匯入：把 JSON 備份寫進 Postgres。
 *
 * 從 GitHub 的 app-data 分支搬過來時用的，之後要從備份還原也可以再跑一次。
 * 同一筆 id 會覆蓋，重複執行不會產生重複資料。
 *
 * 用法（在有 DATABASE_URL 的環境）：
 *     node scripts/import_state.js backup/status.json backup/additions.json
 */
import fs from 'node:fs';

import * as db from '../src/db.js';

function readJson(file) {
  if (!file || !fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

async function main() {
  if (!db.enabled()) {
    console.error('沒有設定 DATABASE_URL，無事可做');
    process.exit(1);
  }
  await db.init();

  const status = readJson(process.argv[2]);
  const additions = readJson(process.argv[3]);

  if (status && typeof status === 'object') {
    for (const [id, record] of Object.entries(status)) {
      await db.saveStatus(id, record);
    }
    console.log(`已匯入 ${Object.keys(status).length} 筆發送狀態`);
  }

  if (Array.isArray(additions)) {
    for (const record of additions) {
      await db.saveAddition(record);
    }
    console.log(`已匯入 ${additions.length} 家新增店家`);
  }

  const [s, a, p] = await Promise.all([db.loadStatus(), db.loadAdditions(), db.loadPhotoIndex()]);
  console.log(`目前資料庫：發送狀態 ${Object.keys(s).length} 筆、新增店家 ${a.length} 家、照片 ${p.length} 張`);
  await db.close();
}

main().catch((err) => {
  console.error('匯入失敗：', err.message);
  process.exit(1);
});
