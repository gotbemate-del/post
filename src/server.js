import path from 'node:path';

import express from 'express';

import {
  additionsFilePath, createAddition, removeAddition,
  snapshot as additionsSnapshot, updateAddition,
} from './additions.js';
import {
  ACCEPTED_TYPES, addPhoto, photoDir, removePhoto,
  snapshot as photosSnapshot,
} from './photos.js';
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

// 圖檔本身直接靜態送出；快取一天，檔名帶 uuid 不會重複所以不必怕舊圖
app.use('/photos', express.static(photoDir(), { maxAge: '1d', fallthrough: true }));

function broadcastPhotos() {
  broadcast('photos:update', photosSnapshot());
}

app.get('/api/photos', (req, res) => {
  res.json(photosSnapshot());
});

app.post('/api/photos/:storeId',
  express.raw({ type: ACCEPTED_TYPES, limit: '6mb' }),
  (req, res) => {
    try {
      if (!Buffer.isBuffer(req.body)) {
        return res.status(415).json({ error: '請以 image/jpeg、image/png 或 image/webp 上傳' });
      }
      const record = addPhoto({
        storeId: req.params.storeId,
        storeName: req.query.name,
        buffer: req.body,
        mime: req.get('content-type')?.split(';')[0].trim(),
      });
      broadcastPhotos();
      res.status(201).json(record);
    } catch (err) {
      res.status(400).json({ error: err.message });
    }
  });

app.delete('/api/photos/:id', (req, res) => {
  if (!removePhoto(req.params.id)) return res.status(404).json({ error: '查無此照片' });
  broadcastPhotos();
  res.status(204).end();
});

app.get('/healthz', (req, res) => {
  res.json({
    ok: true,
    clients: clients.size,
    statusFile: statusFilePath(),
    additionsFile: additionsFilePath(),
  });
});

app.listen(PORT, () => {
  console.log(`澎湖店家確認表單 → http://localhost:${PORT}`);
  console.log(`狀態檔：${statusFilePath()}`);
});
