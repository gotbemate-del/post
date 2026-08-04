import pg from 'pg';

/**
 * Postgres 儲存層。
 *
 * 設了 DATABASE_URL 就走資料庫，沒設就退回本機檔案（本機開發用）。
 *
 * 為什麼用獨立 schema：這個資料庫是跟另一個專案共用的（Render 免費方案每個帳號
 * 只能有一個），把表放進 penghu schema 才不會跟人家的表撞名。
 *
 * 三種資料各一張表，內容直接存 jsonb —— 欄位本來就會變（之後可能加欄位），
 * 用 jsonb 就不必每次改結構都寫 migration。照片的二進位另外用 bytea 存。
 */

const SCHEMA = process.env.PG_SCHEMA || 'penghu';
const URL = process.env.DATABASE_URL || '';

export const enabled = () => Boolean(URL);

let pool = null;

function getPool() {
  if (!pool) {
    pool = new pg.Pool({
      connectionString: URL,
      max: 4,
      idleTimeoutMillis: 30_000,
      // Render 內部連線不需要 TLS；外部連線才要，用 sslmode 參數控制
      ssl: URL.includes('sslmode=require') ? { rejectUnauthorized: false } : false,
    });
    pool.on('error', (err) => console.error('[db] 連線池錯誤：', err.message));
  }
  return pool;
}

export function query(text, params) {
  return getPool().query(text, params);
}

export async function init() {
  if (!enabled()) {
    console.log('[db] 未設定 DATABASE_URL，資料只存在本機檔案，重啟後會消失');
    return false;
  }
  await query(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA}`);
  await query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.status (
      store_id   text PRIMARY KEY,
      data       jsonb NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    )`);
  await query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.additions (
      id         text PRIMARY KEY,
      data       jsonb NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await query(`
    CREATE TABLE IF NOT EXISTS ${SCHEMA}.photos (
      id         text PRIMARY KEY,
      store_id   text NOT NULL,
      store_name text NOT NULL DEFAULT '',
      mime       text NOT NULL DEFAULT 'image/jpeg',
      content    bytea NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    )`);
  await query(`CREATE INDEX IF NOT EXISTS photos_store_idx ON ${SCHEMA}.photos (store_id)`);
  console.log(`[db] 已連上 Postgres，schema=${SCHEMA}`);
  return true;
}

/* -------------------------------------------------------------- 發送狀態 */

export async function loadStatus() {
  const { rows } = await query(`SELECT store_id, data FROM ${SCHEMA}.status`);
  return Object.fromEntries(rows.map((r) => [r.store_id, r.data]));
}

export function saveStatus(storeId, record) {
  return query(
    `INSERT INTO ${SCHEMA}.status (store_id, data, updated_at) VALUES ($1, $2, now())
     ON CONFLICT (store_id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()`,
    [storeId, record]);
}

/* -------------------------------------------------------------- 新增店家 */

export async function loadAdditions() {
  const { rows } = await query(
    `SELECT data FROM ${SCHEMA}.additions ORDER BY created_at, id`);
  return rows.map((r) => r.data);
}

export function saveAddition(record) {
  return query(
    `INSERT INTO ${SCHEMA}.additions (id, data, created_at) VALUES ($1, $2, $3)
     ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data`,
    [record.id, record, record.createdAt ?? new Date().toISOString()]);
}

export function deleteAddition(id) {
  return query(`DELETE FROM ${SCHEMA}.additions WHERE id = $1`, [id]);
}

/* ---------------------------------------------------------------- 照片 */

/** 只取中繼資料，不要把圖檔內容一起撈出來。 */
export async function loadPhotoIndex() {
  const { rows } = await query(
    `SELECT id, store_id, store_name, mime, octet_length(content) AS bytes, created_at
     FROM ${SCHEMA}.photos ORDER BY created_at, id`);
  return rows.map((r) => ({
    id: r.id,
    storeId: r.store_id,
    storeName: r.store_name,
    file: `${r.id}.${r.mime === 'image/png' ? 'png' : r.mime === 'image/webp' ? 'webp' : 'jpg'}`,
    bytes: Number(r.bytes),
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

export function savePhoto({ id, storeId, storeName, mime, buffer, createdAt }) {
  return query(
    `INSERT INTO ${SCHEMA}.photos (id, store_id, store_name, mime, content, created_at)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [id, storeId, storeName, mime, buffer, createdAt]);
}

export async function loadPhoto(id) {
  const { rows } = await query(
    `SELECT content, mime FROM ${SCHEMA}.photos WHERE id = $1`, [id]);
  return rows[0] ? { content: rows[0].content, mime: rows[0].mime } : null;
}

export function deletePhoto(id) {
  return query(`DELETE FROM ${SCHEMA}.photos WHERE id = $1`, [id]);
}

export async function close() {
  if (pool) await pool.end();
  pool = null;
}
