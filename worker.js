// LAST STUDIO - Telegram orders, no CAPTCHA.
// Cloudflare secrets: BOT_TOKEN and CHAT_ID
// Cloudflare text variable: ALLOWED_ORIGIN
// Note: browser Origin restrictions do not authenticate clients.
const buckets = new Map(); // Best-effort per-isolate rate limiting (not globally enforced)
const LIMIT = 5;
const WINDOW = 10 * 60 * 1000;
const MAX_BYTES = 12000;

function respond(data, status, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store', ...headers }
  });
}
function trim(value, max) { return typeof value === 'string' ? value.trim().slice(0, max) : ''; }
function valid(value, max) { return typeof value === 'string' && value.trim().length > 0 && value.trim().length <= max; }
async function readSmallJson(request) {
  if (!request.body) throw Error('missing');
  const reader = request.body.getReader();
  let bytes = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BYTES) { await reader.cancel(); throw Error('large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(bytes); let pos = 0;
  for (const chunk of chunks) { body.set(chunk,pos); pos += chunk.length; }
  return JSON.parse(new TextDecoder('utf-8', {fatal:true}).decode(body));
}
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const allowed = (env.ALLOWED_ORIGIN || '').replace(/\/$/, '');
    const cors = origin === allowed && allowed ?
      { 'Access-Control-Allow-Origin': allowed, 'Vary': 'Origin' } : {};
    if (request.method === 'OPTIONS') {
      return origin === allowed && allowed ? new Response(null, {status:204, headers:{...cors,
        'Access-Control-Allow-Methods':'POST, OPTIONS',
        'Access-Control-Allow-Headers':'Content-Type',
        'Access-Control-Max-Age':'600'}}) : new Response(null,{status:403});
    }
    if (request.method !== 'POST') return respond({error:'Method not allowed'},405,cors);
    if (!allowed || origin !== allowed) return respond({error:'المصدر غير مسموح'},403,cors);
    if (!env.BOT_TOKEN || !env.CHAT_ID) return respond({error:'إعداد الخدمة غير مكتمل'},503,cors);
    if (!/^application\/json(?:\s*;|\s*$)/i.test(request.headers.get('Content-Type') || ''))
      return respond({error:'صيغة الطلب غير مدعومة'},415,cors);

    // Best-effort rate limit per Cloudflare Worker isolate. For robust distributed
    // limits, configure Cloudflare's rate-limiting rules / binding separately.
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const now = Date.now();
    if (buckets.size > 2000) {
      for (const [key, val] of buckets) if (now - val.start > WINDOW) buckets.delete(key);
    }
    let b = buckets.get(ip);
    if (!b || now - b.start >= WINDOW) { b = {start:now,count:0}; buckets.set(ip,b); }
    if (++b.count > LIMIT) return respond({error:'طلبات كثيرة. حاول لاحقًا.'},429,{...cors,'Retry-After':'600'});

    let data;
    try { data = await readSmallJson(request); }
    catch (err) { return respond({error:err.message==='large'?'حجم الطلب كبير':'بيانات الطلب غير صحيحة'},400,cors); }
    if (!data || typeof data !== 'object' || Array.isArray(data) || data.website)
      return respond({error:'بيانات الطلب غير صحيحة'},400,cors);
    const packages = {
      'جرافيك':['LAST STUDIO V1'],
      'تصوير Rockstar':['باقة الصور','باقة الفيديو','باقة التريلر']
    };
    const service=trim(data.service,40), pack=trim(data.package,80);
    if (!packages[service]?.includes(pack) ||
        !valid(data.firstName,60) || !valid(data.lastName,60) ||
        !valid(data.phone,35) || !valid(data.discord,80) || !valid(data.details,3000) ||
        (data.email && (typeof data.email!=='string' || data.email.length>160 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(data.email.trim()))) ||
        (['باقة الفيديو','باقة التريلر'].includes(pack) && !valid(data.duration,80)))
      return respond({error:'تأكد من تعبئة الحقول المطلوبة بشكل صحيح'},400,cors);
    const safe = v => v.replace(/[\u0000-\u001f\u007f]/g,' ').trim();
    const lines = [
      '📩 طلب جديد - LAST STUDIO',
      'الخدمة: '+service, 'الباقة: '+pack,
      'الاسم: '+trim(data.firstName,60)+' '+trim(data.lastName,60),
      'البريد: '+(trim(data.email,160)||'غير مذكور'),
      'الهاتف: '+trim(data.dialCode,8)+' '+trim(data.phone,35),
      'Discord: '+trim(data.discord,80),
      'المدة: '+(trim(data.duration,80)||'غير محددة'),
      'التفاصيل: '+trim(data.details,3000)
    ];
    const message = lines.map(safe).join('\n');
    try {
      const response = await fetch('https://api.telegram.org/bot'+env.BOT_TOKEN+'/sendMessage',{
        method:'POST', headers:{'Content-Type':'application/json'},
        body:JSON.stringify({chat_id:env.CHAT_ID, text:message}),
        signal: AbortSignal.timeout(10000)
      });
      const result = await response.json();
      if (!response.ok || !result.ok) return respond({error:'تعذّر تسليم الطلب إلى Telegram'},502,cors);
      return respond({ok:true},200,cors);
    } catch { return respond({error:'تعذّر الاتصال بخدمة الطلبات'},502,cors); }
  }
};
