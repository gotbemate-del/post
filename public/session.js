/* 登入狀態過期時，把使用者送回登入頁。
 *
 * 有開密碼保護時，cookie 過期後 API 會回 401。沒有這段的話畫面只會一直跳
 * 「儲存失敗」，看不出來是要重新登入。
 */
(() => {
  const nativeFetch = window.fetch.bind(window);
  let redirecting = false;

  window.fetch = async (...args) => {
    const res = await nativeFetch(...args);
    if (res.status === 401 && !redirecting) {
      redirecting = true;
      location.href = `/login?next=${encodeURIComponent(location.pathname)}`;
    }
    return res;
  };
})();
