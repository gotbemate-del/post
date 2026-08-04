import path from 'node:path';

import express from 'express';

import {
  additionsFilePath, createAddition, removeAddition,
  snapshot as additionsSnapshot, updateAddition,
} from './additions.js';
import * as githubStore from './github.js';
import {
  ACCEPTED_TYPES, addPhoto, ensureLocal, photoDir, photoFiles, removePhoto,
  restore as restorePhotos, snapshot as photosSnapshot,
} from './photos.js';
import { writeZip } from './zip.js';
import { getStore, snapshot, statusFilePath, updateStore } from './store.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.json({ limit: '64kb' }));
app.use(express.static(path.join(ROOT, 'public'), { extensions: ['html'] }));

/* ---------------------------------------------------------------- SSE 即時推播 */

const clients = new Set();

function broadcast(event, payload) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const res of clients) res.write(frame);
}

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',   // 關掉反向代理的緩衝，否則事件會卡住
  });
  res.write('retry: 3000\n\n');
  clients.add(res);

  // Render 的 proxy 會切斷閒置連線，定期送註解行維持 keep-alive
  const ping = setInterval(() => res.write(': ping\n\n'), 25_000);
  req.on('close', () => {
    clearInterval(ping);
    clients.delete(res);
    res.end();
  });
});

/* -------------------------------------------------------------------- REST API */

app.get('/api/data', (req, res) => {
  res.json(snapshot());
});

app.get('/api/stores/:id', (req, res) => {
  const store = getStore(req.params.id);
  if (!store) return res.status(404).json({ error: '查無此店家' });
  res.json(store);
});

app.patch('/api/stores/:id', (req, res) => {
  try {
    const store = updateStore(req.params.id, req.body ?? {});
    if (!store) return res.status(404).json({ error: '查無此店家' });
    const { streets, summary } = snapshot();
    broadcast('store:update', { store, streets, summary });
    res.json(store);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

/* ------------------------------------------------------- 新增家數（額外名單） */

/** 新增名單筆數不多，改動就整包廣播，前端不必自己合併。 */
function broadcastAdditions() {
  broadcast('additions:update', additionsSnapshot());
}

app.get('/api/additions', (req, res) => {
  res.json(additionsSnapshot());
});

app.post('/api/additions', (req, res) => {
  try {
    const record = createAddition(req.body ?? {});
    broadcastAdditions();
    res.status(201).json(record);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.patch('/api/additions/:id', (req, res) => {
  try {
    const record = updateAddition(req.params.id, req.body ?? {});
    if (!record) return res.status(404).json({ error: '查無此新增店家' });
    broadcastAdditions();
    res.json(record);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.delete('/api/additions/:id', (req, res) => {
  if (!removeAddition(req.params.id)) return res.status(404).json({ error: '查無此新增店家' });
  broadcastAdditions();
  res.status(204).end();
});

/* ------------------------------------------------------------ 佐證照片 */

// 圖檔本身直接靜態送出；快取一天，檔名帶 uuid 不會重複所以不必怕舊圖。
// 快取沒命中（例如重啟後本機被清空）就回 GitHub 抓一次再送。
app.use('/photos', express.static(photoDir(), { maxAge: '1d', fallthrough: true }));

app.get('/photos/:file', async (req, res) => {
  try {
    const local = await ensureLocal(req.params.file);
    if (!local) return res.status(404).json({ error: '查無此照片' });
    res.sendFile(local, { maxAge: '1d' });
  } catch (err) {
    res.status(502).json({ error: `取得照片失敗：${err.message}` });
  }
});

function broadcastPhotos() {
  broadcast('photos:update', photosSnapshot());
}

app.get('/api/photos', (req, res) => {
  res.json(photosSnapshot());
});

app.post('/api/photos/:storeId',
  express.raw({ type: ACCEPTED_TYPES, limit: '6mb' }),
  async (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) {
        return res.status(415).json({ error: '請以 image/jpeg、image/png 或 image/webp 上傳' });
      }
      const record = await addPhoto({
        storeId: req.params.storeId,
        storeName: req.query.name,
        buffer: req.body,
        mime: req.get('content-type')?.split(';')[0].trim(),
      });
      broadcastPhotos();
      res.status(201).json(record);
    } catch (err) {
      res.status(err.status && err.status >= 500 ? 502 : 400).json({ error: err.message });
    }
  });

app.get('/api/photos/download.zip', async (req, res) => {
  const files = photoFiles();
  if (!files.length) return res.status(404).json({ error: '目前沒有任何佐證照片' });

  // 重啟後本機快取是空的，打包前先確定每張都在本機
  try {
    for (const file of files) await ensureLocal(path.basename(file.path));
  } catch (err) {
    return res.status(502).json({ error: `取得照片失敗：${err.message}` });
  }

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition',
    `attachment; filename="photos-${stamp}.zip"; filename*=UTF-8''${encodeURIComponent(`佐證照片-${stamp}.zip`)}`);
  writeZip(res, files);
});

app.delete('/api/photos/:id', async (req, res) => {
  try {
    if (!await removePhoto(req.params.id)) return res.status(404).json({ error: '查無此照片' });
    broadcastPhotos();
    res.status(204).end();
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    clients: clients.size,
    statusFile: statusFilePath(),
    additionsFile: additionsFilePath(),
    photoStorage: githubStore.enabled()
      ? { kind: 'github', ...githubStore.config }
      : { kind: 'local', warning: '未設定 GITHUB_TOKEN，照片重啟後會消失' },
  });
});

// 先把 GitHub 上的照片索引拉回來再開始服務，免得第一個開頁面的人看到空的
await restorePhotos();

app.listen(PORT, () => {
  console.log(`澎湖店家確認表單 → http://localhost:${PORT}`);
  console.log(`狀態檔：${statusFilePath()}`);
});
