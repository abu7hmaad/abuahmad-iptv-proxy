// iptv-abuahmad (Deno Deploy) — بروكسي قوائم M3U والبث لمشغل أبو أحمد
// يعمل خارج Cloudflare: يصل لعناوين IP المباشرة ولأي منفذ
// الاستخدام: https://abuahmad-iptv-proxy.deno.dev/?url=<الرابط مُرمَّزاً>

const LOCK = true; // false = يشتغل من أي موقع
const ALLOWED = [
  'https://abu7hmmad.blogspot.com',
  'http://abu7hmmad.blogspot.com',
  'https://www.blogger.com', // معاينة بلوجر
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
};

const reply = (body, status, extra = {}) =>
  new Response(body, { status, headers: { ...CORS, 'Cache-Control': 'no-store', ...extra } });

const okStatus = s => (s >= 200 && s <= 599 ? s : 502);

Deno.serve(async (req) => {
  try {
    const self = new URL(req.url);
    if (!self.searchParams.get('url')) return reply('ok', 200); // فحص الصحة
    return await handle(req);
  } catch (e) {
    return reply('proxy error: ' + (e && e.message), 500, { 'Content-Type': 'text/plain; charset=utf-8' });
  }
});

async function handle(req) {
  if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });

  const self = new URL(req.url);
  const target = self.searchParams.get('url');
  if (!target || !/^https?:\/\//i.test(target)) return reply('missing url', 400);

  if (LOCK) {
    const from = req.headers.get('Origin') || req.headers.get('Referer') || '';
    if (!ALLOWED.some(a => from.startsWith(a))) return reply('forbidden: ' + (from || 'no origin'), 403);
  }

  const up = new Headers({ 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20', 'Accept': '*/*' });
  const range = req.headers.get('Range');
  if (range) up.set('Range', range);

  // وضع الفحص: يرجع تفاصيل رد السيرفر بدل البث (يستخدمه المشغل عند فشل القناة)
  if (self.searchParams.get('debug')) {
    const chain = [];
    let url = target, r;
    try {
      for (let i = 0; i < 6; i++) {
        r = await fetch(url, { headers: up, redirect: 'manual' });
        const loc = r.headers.get('location');
        chain.push({ url, status: r.status, type: r.headers.get('content-type') || '' });
        if (r.status >= 300 && r.status < 400 && loc) { url = new URL(loc, url).href; continue; }
        break;
      }
      let sample = '';
      if (r && r.body) {
        const rd = r.body.getReader();
        const { value } = await rd.read();
        try { rd.cancel(); } catch (e) {}
        if (value && value.length) {
          sample = value[0] === 0x47 ? 'MPEG-TS OK (' + value.length + ' bytes)'
            : new TextDecoder().decode(value.slice(0, 300));
        } else sample = 'empty body';
      }
      return reply(JSON.stringify({ ok: true, chain, sample }), 200, { 'Content-Type': 'application/json; charset=utf-8' });
    } catch (e) {
      return reply(JSON.stringify({ ok: false, chain, error: e.message }), 200, { 'Content-Type': 'application/json; charset=utf-8' });
    }
  }

  let res;
  try {
    res = await fetch(target, { headers: up, redirect: 'follow' });
  } catch (e) {
    return reply('upstream error: ' + e.message, 502);
  }

  const status = okStatus(res.status);
  const finalUrl = res.url || target;
  const ct = res.headers.get('content-type') || '';
  const len = +(res.headers.get('content-length') || 0);
  const path = new URL(finalUrl).pathname;

  // فقط قوائم HLS الصغيرة تُقرأ وتُعاد كتابتها — القوائم الكبيرة (get.php) تُمرَّر مباشرة بدون قراءة
  const isHls = (/\.m3u8$/i.test(path) || /mpegurl/i.test(ct)) && !/get\.php$/i.test(path) && (!len || len < 2e6);

  if (isHls && req.method === 'GET') {
    const text = await res.text();
    if (text.includes('#EXT-X-')) {
      const base = self.origin + self.pathname + '?url=';
      const px = u => base + encodeURIComponent(new URL(u, finalUrl).href);
      const out = text.split(/\r?\n/).map(line => {
        const l = line.trim();
        if (!l) return line;
        if (l.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (m, u) => `URI="${px(u)}"`);
        return px(l);
      }).join('\n');
      return reply(out, status, { 'Content-Type': 'application/vnd.apple.mpegurl' });
    }
    return reply(text, status, { 'Content-Type': ct || 'text/plain; charset=utf-8' });
  }

  // تمرير مباشر: قائمة M3U كبيرة، بث TS، ملف فيديو
  const h = new Headers(CORS);
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const v = res.headers.get(k);
    if (v) h.set(k, v);
  }
  h.set('Cache-Control', 'no-store');
  return new Response(req.method === 'HEAD' ? null : res.body, { status, headers: h });
}
