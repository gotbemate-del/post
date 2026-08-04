import crypto from 'node:crypto';

/**
 * 單一密碼的登入保護。
 *
 * 密碼放在環境變數 APP_PASSWORD，沒設就完全不擋（本機開發、或還沒決定要不要鎖時）。
 * 登入成功後發一張帶到期時間的簽章票，存在 HttpOnly cookie 裡；
 * 簽章金鑰就是密碼本身，所以改密碼等於讓所有人重新登入。
 */

const PASSWORD = process.env.APP_PASSWORD || '';
const COOKIE = 'penghu_auth';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;   // 30 天

// 登入頁自己要放行，健康檢查要讓 Render 打得到
const OPEN_PATHS = new Set(['/login', '/logout', '/healthz']);

export const enabled = () => Boolean(PASSWORD);

function sign(value) {
  return crypto.createHmac('sha256', PASSWORD).update(value).digest('base64url');
}

/** 長度不同時 timingSafeEqual 會直接丟例外，先擋掉。 */
function sameSecret(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export const checkPassword = (input) => sameSecret(input ?? '', PASSWORD);

function issue() {
  const expires = Date.now() + MAX_AGE_MS;
  return `${expires}.${sign(String(expires))}`;
}

function valid(token) {
  const [expires, mac] = String(token ?? '').split('.');
  if (!expires || !mac || Number(expires) < Date.now()) return false;
  return sameSecret(mac, sign(expires));
}

function readCookie(req, name) {
  const raw = req.headers.cookie;
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return null;
}

/* ------------------------------------------------------- 粗暴的嘗試次數限制 */

const attempts = new Map();          // ip → { count, until }
const MAX_TRIES = 8;
const LOCK_MS = 15 * 60 * 1000;

export function locked(ip) {
  const record = attempts.get(ip);
  if (!record) return false;
  if (record.until && record.until > Date.now()) return true;
  if (record.until) attempts.delete(ip);       // 鎖定過期，重新計算
  return false;
}

export function noteFailure(ip) {
  const record = attempts.get(ip) ?? { count: 0, until: 0 };
  record.count += 1;
  if (record.count >= MAX_TRIES) record.until = Date.now() + LOCK_MS;
  attempts.set(ip, record);
}

export const clearFailures = (ip) => attempts.delete(ip);

/* ------------------------------------------------------------------ 中介層 */

export function setCookie(res, secure) {
  res.setHeader('Set-Cookie',
    `${COOKIE}=${issue()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${MAX_AGE_MS / 1000}`
    + (secure ? '; Secure' : ''));
}

export function clearCookie(res) {
  res.setHeader('Set-Cookie', `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`);
}

export function middleware(req, res, next) {
  if (!enabled() || OPEN_PATHS.has(req.path)) return next();
  if (valid(readCookie(req, COOKIE))) return next();

  // API 要回 401 讓前端知道要重新登入，一般頁面直接導去登入頁
  if (req.path.startsWith('/api/')) return res.status(401).json({ error: '請先登入' });
  const back = encodeURIComponent(req.originalUrl || '/');
  res.redirect(`/login?next=${back}`);
}

/* --------------------------------------------------------------- 登入頁面 */

const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function loginPage({ next = '/', message = '' } = {}) {
  return `<!DOCTYPE html>
<html lang="zh-Hant">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1f3864">
<title>登入 — 澎湖店家確認表單</title>
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🔒</text></svg>">
<style>
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 24px;
    font-family: "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif;
    background: linear-gradient(160deg, #1f3864, #2f4f8f);
    color: #1c2333;
  }
  .box {
    width: 100%; max-width: 340px; background: #fff; border-radius: 14px;
    padding: 26px 22px; box-shadow: 0 18px 40px rgba(10, 18, 36, .28);
  }
  h1 { margin: 0 0 4px; font-size: 1.1rem; color: #1f3864; }
  p.sub { margin: 0 0 18px; font-size: .78rem; color: #6b7688; }
  label { display: block; font-size: .72rem; font-weight: 600; color: #6b7688; margin-bottom: 5px; }
  input {
    width: 100%; font: inherit; font-size: 1rem; padding: 10px 12px;
    border: 1px solid #dfe4ec; border-radius: 9px; background: #fff;
  }
  input:focus { outline: 2px solid rgba(31, 56, 100, .35); outline-offset: 1px; border-color: #1f3864; }
  button {
    width: 100%; margin-top: 14px; font: inherit; font-size: .92rem; font-weight: 600;
    padding: 11px; border: 0; border-radius: 9px; cursor: pointer;
    background: #1f3864; color: #fff;
  }
  button:hover { background: #2f4f8f; }
  .err {
    margin: 0 0 14px; padding: 9px 11px; border-radius: 8px;
    background: #fbe6e6; color: #92302f; font-size: .78rem;
  }
</style>
</head>
<body>
  <form class="box" method="post" action="/login">
    <h1>澎湖店家確認表單</h1>
    <p class="sub">請輸入密碼</p>
    ${message ? `<p class="err">${escape(message)}</p>` : ''}
    <input type="hidden" name="next" value="${escape(next)}">
    <label for="password">密碼</label>
    <input id="password" name="password" type="password" autocomplete="current-password"
           autofocus required>
    <button type="submit">登入</button>
  </form>
</body>
</html>`;
}
