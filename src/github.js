/**
 * GitHub Contents API 的極薄封裝，用來把佐證照片存進 repo。
 *
 * 需要的環境變數：
 *   GITHUB_TOKEN         有 contents:write 權限的 token（沒設就整個功能關閉，改用本機磁碟）
 *   GITHUB_REPO          owner/repo，預設 gotbemate-del/post
 *   GITHUB_PHOTO_BRANCH  照片要存的分支，預設 photos
 *
 * ⚠️ 一定要用「跟 Render 部署分支不同」的分支。Render 的 auto-deploy 綁在部署分支上，
 *    照片推到那條分支的話，每上傳一張就會重新部署一次，服務會在外面跑的時候斷線。
 */

const API = process.env.GITHUB_API_BASE || 'https://api.github.com';
const TOKEN = process.env.GITHUB_TOKEN || '';
const REPO = process.env.GITHUB_REPO || 'gotbemate-del/post';
const BRANCH = process.env.GITHUB_PHOTO_BRANCH || 'photos';

export const config = { repo: REPO, branch: BRANCH };
export const enabled = () => Boolean(TOKEN);

async function call(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'penghu-store-confirmation',
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...options.headers,
    },
  });
  if (res.status === 404) return { status: 404, body: null };
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const detail = body?.message || `HTTP ${res.status}`;
    const err = new Error(`GitHub: ${detail}`);
    err.status = res.status;
    throw err;
  }
  return { status: res.status, body };
}

/** 照片分支不存在就從預設分支開一條出來。 */
export async function ensureBranch() {
  const existing = await call(`/repos/${REPO}/git/ref/heads/${encodeURIComponent(BRANCH)}`);
  if (existing.status !== 404) return false;

  const repo = await call(`/repos/${REPO}`);
  const base = await call(
    `/repos/${REPO}/git/ref/heads/${encodeURIComponent(repo.body.default_branch)}`);
  await call(`/repos/${REPO}/git/refs`, {
    method: 'POST',
    body: JSON.stringify({ ref: `refs/heads/${BRANCH}`, sha: base.body.object.sha }),
  });
  console.log(`[github] 已建立照片分支 ${BRANCH}`);
  return true;
}

/** 回傳 { content: Buffer, sha } 或 null。 */
export async function getFile(path) {
  const res = await call(
    `/repos/${REPO}/contents/${encodePath(path)}?ref=${encodeURIComponent(BRANCH)}`);
  if (res.status === 404 || !res.body?.content) return null;
  return { content: Buffer.from(res.body.content, 'base64'), sha: res.body.sha };
}

export async function putFile(path, buffer, message, sha) {
  const res = await call(`/repos/${REPO}/contents/${encodePath(path)}`, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: buffer.toString('base64'),
      branch: BRANCH,
      ...(sha ? { sha } : {}),
    }),
  });
  return res.body?.content?.sha;
}

export async function deleteFile(path, sha, message) {
  await call(`/repos/${REPO}/contents/${encodePath(path)}`, {
    method: 'DELETE',
    body: JSON.stringify({ message, sha, branch: BRANCH }),
  });
}

/** contents API 的路徑不能整段 encode，斜線要留著。 */
function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}
