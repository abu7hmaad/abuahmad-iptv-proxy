// abuahmad-iptv-proxy — بروكسي بث IPTV على Render (Node.js بدون مكتبات)
// يصل لأي منفذ وأي IP (عكس Cloudflare) — الاستخدام: https://اسم-الخدمة.onrender.com/?url=<الرابط مُرمَّزاً>

const http = require('http');
const https = require('https');

const PORT = process.env.PORT || 3000;
const LOCK = true; // false = يشتغل من أي موقع
const ALLOWED = [
  'https://abu7hmmad.blogspot.com',
  'http://abu7hmmad.blogspot.com',
  'https://www.blogger.com',
];
const UA = 'VLC/3.0.20 LibVLC/3.0.20';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Expose-Headers': '*',
  'Cache-Control': 'no-store',
};

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  if (res.headersSent) return res.end();
  res.writeHead(status, { ...CORS, 'Content-Type': type });
  res.end(body);
}

// طلب واحد بدون تتبع التحويلات
function request(url, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request(u, { method: 'GET', headers, timeout: 20000, rejectUnauthorized: false }, resolve);
    r.on('timeout', () => r.destroy(new Error('timeout')));
    r.on('error', reject);
    r.end();
  });
}

// يتتبع التحويلات ويرجع الرد النهائي + سلسلة التحويلات
async function follow(url, headers) {
  const chain = [];
  for (let i = 0; i < 8; i++) {
    const resp = await request(url, headers);
    chain.push({ url, status: resp.statusCode, type: resp.headers['content-type'] || '' });
    const loc = resp.headers.location;
    if (resp.statusCode >= 300 && resp.statusCode < 400 && loc) {
      resp.resume();
      url = new URL(loc, url).href;
      continue;
    }
    return { resp, finalUrl: url, chain };
  }
  throw new Error('too many redirects');
}

function readBody(resp, limit = 3e6) {
  return new Promise((resolve, reject) => {
    const parts = []; let size = 0;
    resp.on('data', c => { size += c.length; if (size > limit) { resp.destroy(); reject(new Error('too large')); } else parts.push(c); });
    resp.on('end', () => resolve(Buffer.concat(parts)));
    resp.on('error', reject);
  });
}

http.createServer(async (req, res) => {
  try {
    if (req.method === 'OPTIONS') { res.writeHead(204, CORS); return res.end(); }

    const self = new URL(req.url, 'http://x');
    const target = self.searchParams.get('url');
    if (!target) return send(res, 200, 'ok'); // فحص الصحة + UptimeRobot
    if (!/^https?:\/\//i.test(target)) return send(res, 400, 'bad url');

    if (LOCK) {
      const from = req.headers.origin || req.headers.referer || '';
      if (!ALLOWED.some(a => from.startsWith(a))) return send(res, 403, 'forbidden: ' + (from || 'no origin'));
    }

    const headers = { 'User-Agent': UA, 'Accept': '*/*' };
    if (req.headers.range) headers.Range = req.headers.range;

    // وضع الفحص
    if (self.searchParams.get('debug')) {
      try {
        const { resp, chain } = await follow(target, headers);
        const first = await new Promise(r => { resp.once('data', c => { resp.destroy(); r(c); }); resp.once('end', () => r(null)); resp.once('error', () => r(null)); });
        const sample = !first ? 'empty body' : first[0] === 0x47 ? 'MPEG-TS OK (' + first.length + ' bytes)' : first.slice(0, 300).toString('utf8');
        return send(res, 200, JSON.stringify({ ok: true, chain, sample }), 'application/json; charset=utf-8');
      } catch (e) {
        return send(res, 200, JSON.stringify({ ok: false, chain: [], error: e.message }), 'application/json; charset=utf-8');
      }
    }

    let out;
    try { out = await follow(target, headers); }
    catch (e) { return send(res, 502, 'upstream error: ' + e.message); }
    const { resp, finalUrl } = out;

    const ct = resp.headers['content-type'] || '';
    const path = new URL(finalUrl).pathname;
    const isHls = (/\.m3u8$/i.test(path) || /mpegurl/i.test(ct)) && !/get\.php$/i.test(path);

    if (isHls && req.method === 'GET') {
      const text = (await readBody(resp)).toString('utf8');
      if (text.includes('#EXT-X-')) {
        const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
        const base = proto + '://' + req.headers.host + '/?url=';
        const px = u => base + encodeURIComponent(new URL(u, finalUrl).href);
        const body = text.split(/\r?\n/).map(line => {
          const l = line.trim();
          if (!l) return line;
          if (l.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (m, u) => `URI="${px(u)}"`);
          return px(l);
        }).join('\n');
        return send(res, resp.statusCode, body, 'application/vnd.apple.mpegurl');
      }
      return send(res, resp.statusCode, text, ct || 'text/plain; charset=utf-8');
    }

    // تمرير مباشر: TS مباشر، فيديو، قوائم كبيرة
    const h = { ...CORS };
    for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
      if (resp.headers[k]) h[k] = resp.headers[k];
    }
    res.writeHead(resp.statusCode, h);
    if (req.method === 'HEAD') { resp.destroy(); return res.end(); }
    resp.pipe(res);
    req.on('close', () => resp.destroy()); // الزائر أغلق القناة → نقطع الاتصال بالسيرفر فوراً
  } catch (e) {
    send(res, 500, 'proxy error: ' + e.message);
  }
}).listen(PORT, () => console.log('iptv proxy on ' + PORT));
