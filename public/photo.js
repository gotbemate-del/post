/* 佐證照片：縮圖 → 左上角燒上店名（白底黑字）→ 上傳
 *
 * 標註和壓縮都在瀏覽器做完才送出：手機原圖動輒 3～5 MB，先縮到最長邊 1280
 * 再壓成 JPEG，上傳量和伺服器的儲存量都會少一個數量級。
 */
const Photos = (() => {
  const MAX_EDGE = 1280;
  const QUALITY = 0.82;
  const MIN_FONT = 13;

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  /** 手機照片常帶 EXIF 旋轉資訊，from-image 讓瀏覽器先轉正再給我們。 */
  async function decode(file) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      return await createImageBitmap(file);
    }
  }

  /** store 名稱太長時先縮字級，縮到下限還放不下就截斷加省略號。 */
  function fitLabel(ctx, label, maxWidth, startSize, fontOf) {
    let size = startSize;
    while (size > MIN_FONT) {
      ctx.font = fontOf(size);
      if (ctx.measureText(label).width <= maxWidth) return { label, size };
      size -= 1;
    }
    ctx.font = fontOf(size);
    let text = label;
    while (text.length > 1 && ctx.measureText(`${text}…`).width > maxWidth) {
      text = text.slice(0, -1);
    }
    return { label: text.length < label.length ? `${text}…` : text, size };
  }

  async function stamp(file, label) {
    const bitmap = await decode(file);
    const scale = Math.min(1, MAX_EDGE / Math.max(bitmap.width, bitmap.height));
    const width = Math.round(bitmap.width * scale);
    const height = Math.round(bitmap.height * scale);

    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();

    const fontOf = (size) =>
      `700 ${size}px "PingFang TC", "Noto Sans TC", "Microsoft JhengHei", system-ui, sans-serif`;
    const margin = Math.round(width * 0.025);
    const startSize = Math.max(MIN_FONT, Math.round(width * 0.045));
    const padding = Math.round(startSize * 0.4);
    const fitted = fitLabel(ctx, label, width - margin * 2 - padding * 2, startSize, fontOf);

    ctx.font = fontOf(fitted.size);
    ctx.textBaseline = 'top';
    const boxW = ctx.measureText(fitted.label).width + padding * 2;
    const boxH = fitted.size + padding * 2;

    // 白底黑字；再描一條淺灰細框，照片本身是白牆時才不會糊成一片
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(margin, margin, boxW, boxH);
    ctx.strokeStyle = 'rgba(0, 0, 0, .35)';
    ctx.lineWidth = Math.max(1, Math.round(width * 0.002));
    ctx.strokeRect(margin + .5, margin + .5, boxW - 1, boxH - 1);
    ctx.fillStyle = '#000000';
    ctx.fillText(fitted.label, margin + padding, margin + padding);

    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => (blob ? resolve(blob) : reject(new Error('圖檔轉換失敗'))),
        'image/jpeg', QUALITY);
    });
  }

  async function upload(file, storeId, label) {
    const blob = await stamp(file, label);
    const res = await fetch(`/api/photos/${encodeURIComponent(storeId)}?name=${encodeURIComponent(label)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/jpeg' },
      body: blob,
    });
    if (!res.ok) {
      throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    }
    return res.json();
  }

  async function remove(photoId) {
    const res = await fetch(`/api/photos/${encodeURIComponent(photoId)}`, { method: 'DELETE' });
    if (!res.ok) {
      throw new Error((await res.json().catch(() => ({}))).error || `HTTP ${res.status}`);
    }
  }

  /** 卡片上的照片區：縮圖 + 上傳鈕。 */
  function html(photos = []) {
    const thumbs = photos.map((p) => `
      <span class="shot">
        <a href="/photos/${encodeURIComponent(p.file)}" target="_blank" rel="noopener">
          <img src="/photos/${encodeURIComponent(p.file)}" alt="${escapeHtml(p.storeName)} 佐證照片" loading="lazy">
        </a>
        <button type="button" class="shot__x" data-action="photo-remove" data-photo="${escapeHtml(p.id)}"
                title="刪除這張照片" aria-label="刪除照片">✕</button>
      </span>`).join('');
    return `
  <div class="shots">
    ${thumbs}
    <button type="button" class="shots__add" data-action="photo">📷 佐證照片${photos.length ? `（${photos.length}）` : ''}</button>
  </div>`;
  }

  return { upload, remove, html };
})();
