import path from 'node:path';

import express from 'express';

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

app.get('/healthz', (req, res) => {
  res.json({ ok: true, clients: clients.size, statusFile: statusFilePath() });
});

app.listen(PORT, () => {
  console.log(`澎湖店家確認表單 → http://localhost:${PORT}`);
  console.log(`狀態檔：${statusFilePath()}`);
});
