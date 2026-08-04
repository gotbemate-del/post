import path from 'node:path';

import express from 'express';

import {
  additionsFilePath, createAddition, loadFromDb as loadAdditions, removeAddition,
  snapshot as additionsSnapshot, updateAddition,
} from './additions.js';
import * as auth from './auth.js';
import * as db from './db.js';
import {
  ACCEPTED_TYPES, addPhoto, loadFromDb as loadPhotos, photoFiles,
  readPhoto, removePhoto, snapshot as photosSnapshot,
} from './photos.js';
import { seedIfEmpty } from './seed.js';
import {
  getStore, loadFromDb as loadStatus, snapshot, statusFilePath, updateStore,
} from './store.js';
import { writeZip } from './zip.js';

const ROOT = path.resolve(import.meta.dirname, '..');
const PORT = process.env.PORT || 3000;

const app = express();
app.set('trust proxy', 1);            // Render 在前面擋一層 proxy，要靠它拿到真實 IP
app.use(express.json({ limit: '64kb' }));

/* -------------------------------------------------------------- 密碼保護 */

app.get('/login', (req, res) => {
  if (!auth.enabled()) return res.redirect('/');
  res.type('html').send(auth.loginPage({ next: req.query.next || '/' }));
});

app.post('/login', express.urlencoded({ extended: false, limit: '4kb' }), (req, res) => {
  if (!auth.enabled()) return res.redirect('/');
  const next = typeof req.body.next === 'string' && req.body.next.startsWith('/')
    ? req.body.next : '/';          // 只允許站內轉址，免得被拿來當跳板

  if (auth.locked(req.ip)) {
    return res.status(429).type('html')
      .send(auth.loginPage({ next, message: '嘗試太多次，請 15 分鐘後再試。' }));
  }
  if (!auth.checkPassword(req.body.password)) {
    auth.noteFailure(req.ip);
    return res.status(401).type('html')
      .send(auth.loginPage({ next, message: '密碼不對，再試一次。' }));
  }
  auth.clearFailures(req.ip);
  auth.setCookie(res, req.secure || req.get('x-forwarded-proto') === 'https');
  res.redirect(next);
});

app.post('/logout', (req, res) => {
  auth.clearCookie(res);
  res.redirect('/login');
});

app.use(auth.middleware);
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

// 檔名帶 uuid 不會重複，可以放心讓瀏覽器快取久一點
app.get('/photos/:file', async (req, res) => {
  try {
    const photo = await readPhoto(req.params.file);
    if (!photo) return res.status(404).json({ error: '查無此照片' });
    res.set('Content-Type', photo.mime);
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(photo.content);
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

  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition',
    `attachment; filename="photos-${stamp}.zip"; filename*=UTF-8''${encodeURIComponent(`佐證照片-${stamp}.zip`)}`);
  await writeZip(res, files.map((f) => ({
    ...f,
    read: async () => (await readPhoto(f.file))?.content,
  })));
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
    passwordProtected: auth.enabled(),
    storage: db.enabled()
      ? { kind: 'postgres' }
      : { kind: 'local', warning: '未設定 DATABASE_URL，資料與照片重啟後會消失' },
  });
});

/* ------------------------------------------------------- 開機載入 / 關站收尾 */

// 先把資料庫的內容載進來再開始服務，免得第一個開頁面的人看到空的
try {
  if (await db.init()) {
    await seedIfEmpty();
    const loaded = await Promise.all([loadStatus(), loadAdditions(), loadPhotos()]);
    console.log(`[db] 已載入：發送狀態=${loaded[0] ? '有' : '無'}、`
      + `新增店家=${loaded[1] ? '有' : '無'}、照片索引=${loaded[2] ? '有' : '無'}`);
  }
} catch (err) {
  console.error('[db] 開機載入失敗，改用本機資料：', err.message);
}

const server = app.listen(PORT, () => {
  console.log(`澎湖店家確認表單 → http://localhost:${PORT}`);
  console.log(`狀態檔：${statusFilePath()}`);
});

// Render 重新部署前會送 SIGTERM，把連線收乾淨再走
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, async () => {
    if (closing) return;
    closing = true;
    server.close();
    for (const res of clients) res.end();
    try {
      await db.close();
    } catch (err) {
      console.error('[db] 關閉連線池失敗：', err.message);
    }
    process.exit(0);
  });
}
