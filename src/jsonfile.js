import fs from 'node:fs';
import path from 'node:path';

/**
 * 執行期 JSON 檔的共用讀寫（status.json 與 additions.json 都走這裡）。
 */

/** 讀 JSON；檔案不存在或內容壞掉時回傳 fallback。 */
export function readJson(file, fallback) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : fallback;
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.error(`[jsonfile] 無法讀取 ${file}，改用預設值：`, err.message);
    }
    return fallback;
  }
}

/**
 * 建立延遲寫入器：合併多次快速編輯，避免每敲一個字就寫一次磁碟。
 * 先寫 .tmp 再 rename，避免中途中斷留下半個檔案。
 */
export function makeWriter(file, getData, delay = 300) {
  let timer = null;
  return () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(getData(), null, 1), 'utf8');
        fs.renameSync(tmp, file);
      } catch (err) {
        console.error(`[jsonfile] 寫入 ${file} 失敗：`, err.message);
      }
    }, delay);
  };
}
