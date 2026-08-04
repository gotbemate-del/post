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
    const thumbs = photos.map((p, index) => `
      <span class="shot">
        <button type="button" class="shot__open" data-action="photo-open"
                data-store="${escapeHtml(p.storeId)}" data-index="${index}"
                aria-label="預覽 ${escapeHtml(p.storeName)} 的佐證照片">
          <img src="/photos/${encodeURIComponent(p.file)}" alt="${escapeHtml(p.storeName)} 佐證照片" loading="lazy">
        </button>
        <button type="button" class="shot__x" data-action="photo-remove" data-photo="${escapeHtml(p.id)}"
                title="刪除這張照片" aria-label="刪除照片">✕</button>
      </span>`).join('');
    return `
  <div class="shots">
    ${thumbs}
    <button type="button" class="shots__add" data-action="photo">📷 佐證照片${photos.length ? `（${photos.length}）` : ''}</button>
  </div>`;
  }

  /* ------------------------------------------------------------- 預覽燈箱 */

  let viewer = null;
  let list = [];
  let cursor = 0;

  function buildViewer() {
    const node = document.createElement('div');
    node.className = 'lightbox';
    node.hidden = true;
    node.innerHTML = `
      <button type="button" class="lightbox__close" data-lb="close" aria-label="關閉預覽">✕</button>
      <button type="button" class="lightbox__nav lightbox__nav--prev" data-lb="prev" aria-label="上一張">‹</button>
      <figure class="lightbox__figure">
        <img class="lightbox__img" alt="">
        <figcaption class="lightbox__caption"></figcaption>
      </figure>
      <button type="button" class="lightbox__nav lightbox__nav--next" data-lb="next" aria-label="下一張">›</button>`;
    document.body.appendChild(node);

    node.addEventListener('click', (event) => {
      const action = event.target.closest('[data-lb]')?.dataset.lb;
      if (action === 'prev') step(-1);
      else if (action === 'next') step(1);
      // 點圖片以外的地方（背景）也關掉
      else if (action === 'close' || !event.target.closest('.lightbox__figure')) close();
    });
    document.addEventListener('keydown', (event) => {
      if (node.hidden) return;
      if (event.key === 'Escape') close();
      else if (event.key === 'ArrowLeft') step(-1);
      else if (event.key === 'ArrowRight') step(1);
    });
    return node;
  }

  function show() {
    const photo = list[cursor];
    if (!photo) return close();
    viewer.querySelector('.lightbox__img').src = `/photos/${encodeURIComponent(photo.file)}`;
    const at = new Date(photo.createdAt).toLocaleString('zh-TW', {
      timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    viewer.querySelector('.lightbox__caption').textContent =
      `${photo.storeName}　${at}　${cursor + 1}/${list.length}`;
    const solo = list.length < 2;
    for (const nav of viewer.querySelectorAll('.lightbox__nav')) nav.hidden = solo;
  }

  function step(delta) {
    if (!list.length) return;
    cursor = (cursor + delta + list.length) % list.length;
    show();
  }

  function close() {
    if (!viewer) return;
    viewer.hidden = true;
    viewer.querySelector('.lightbox__img').src = '';
    document.body.classList.remove('is-locked');
  }

  /** 開啟預覽；photos 是同一家店的照片，index 是點到的那張。 */
  function open(photos, index = 0) {
    if (!photos?.length) return;
    viewer ??= buildViewer();
    list = photos;
    cursor = Math.min(Math.max(index, 0), photos.length - 1);
    viewer.hidden = false;
    document.body.classList.add('is-locked');
    show();
  }

  return { upload, remove, html, open };
})();
