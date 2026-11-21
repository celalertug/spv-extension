// Runs in the page (MAIN world). Facebook loads a listing's data through XHR/fetch when you open
// it from the feed (ajax/route-definition, api/graphql). Responses that carry vehicle fields are
// handed to the content script, which pulls the listing out of them.
(() => {
  if (window.__spvHook) return;
  window.__spvHook = true;
  const MARK = 'vehicle_make_display_name';
  const post = (text) => {
    if (typeof text === 'string' && text.includes(MARK)) window.postMessage({ __spvExt: 'response', text }, location.origin);
  };

  const send = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function (...args) {
    this.addEventListener('load', function () {
      try {
        if (this.responseType === '' || this.responseType === 'text') post(this.responseText);
      } catch {}
    });
    return send.apply(this, args);
  };

  const origFetch = window.fetch;
  window.fetch = function (...args) {
    const p = origFetch.apply(this, args);
    p.then((res) => {
      try {
        if (/facebook\.com\/(api\/graphql|ajax\/)/.test(res.url)) res.clone().text().then(post, () => {});
      } catch {}
    }, () => {});
    return p;
  };
})();
