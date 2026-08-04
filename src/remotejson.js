import * as github from './github.js';

/**
 * 把一份 JSON 同步到 GitHub 的資料分支。
 *
 * 為什麼要防抖：勾一輪 326 家店就是 326 次寫入，每次都推一個 commit 的話
 * 又慢又把歷史洗爆。所以本機照舊即時寫（掉了也只掉那一瞬間），
 * GitHub 這邊等安靜幾秒後才推一次，把連續操作併成一個 commit。
 *
 * 關站前要記得 flush()，不然最後幾秒的異動只會留在本機。
 */
export function createSync(remotePath, { read, apply, label, delay = 5000 }) {
  let sha = null;
  let timer = null;
  let running = false;
  let queued = false;

  async function put() {
    const body = Buffer.from(JSON.stringify(read(), null, 1), 'utf8');
    try {
      sha = await github.putFile(remotePath, body, label(), sha);
    } catch (err) {
      // 兩台裝置同時改會撞 sha，重抓最新的再寫一次
      if (err.status !== 409 && err.status !== 422) throw err;
      sha = (await github.getFile(remotePath))?.sha ?? null;
      sha = await github.putFile(remotePath, body, label(), sha);
    }
  }

  async function run() {
    if (running) { queued = true; return; }
    running = true;
    try {
      await put();
    } catch (err) {
      console.error(`[sync] ${remotePath} 推送失敗：`, err.message);
    } finally {
      running = false;
      if (queued) { queued = false; await run(); }
    }
  }

  return {
    /** 開機時把 GitHub 上那份拉回來蓋掉本機的。回傳有沒有拉到。 */
    async restore() {
      if (!github.enabled()) return false;
      try {
        const file = await github.getFile(remotePath);
        if (!file) return false;
        apply(JSON.parse(file.content.toString('utf8')));
        sha = file.sha;
        return true;
      } catch (err) {
        console.error(`[sync] ${remotePath} 還原失敗，改用本機那份：`, err.message);
        return false;
      }
    },

    schedule() {
      if (!github.enabled() || timer) return;
      timer = setTimeout(() => { timer = null; run(); }, delay);
    },

    async flush() {
      if (!github.enabled()) return;
      if (timer) { clearTimeout(timer); timer = null; }
      await run();
    },
  };
}
