// ============================================================================
//  EdgeOne Pages 边缘鉴权中间件  ——  真正的服务端访问防护
//  运行在边缘节点，所有请求（含静态 HTML / 图片）都会先经过这里。
//  未持有合法登录凭证的访客，连页面 HTML 都拿不到。
// ============================================================================

// ---- 可通过 EdgeOne 控制台「环境变量」覆盖（强烈建议线上覆盖 AUTH_SECRET）----
const DEFAULTS = {
  AUTH_SECRET: 'change-me-please-a-long-random-string', // 签名密钥：务必在控制台改成一长串随机字符
};

// 无需登录即可访问的白名单（登录页本身、登录接口、登录页要用到的资源）
const PUBLIC_PATHS = new Set([
  '/login.html',
  '/api/login',
  '/favicon.ico',
]);
// 登录页依赖的静态资源前缀（logo 等），放行以便登录页能正常显示
const PUBLIC_PREFIXES = ['/assets/images/logo'];

const COOKIE_NAME = 'yf_sess';

// ---------- base64url 工具（不依赖 btoa/atob，兼容边缘运行时）----------
const __B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function __bytesToB64url(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : 0;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : 0;
    out += __B64[b0 >> 2]
        +  __B64[((b0 & 3) << 4) | (b1 >> 4)]
        +  (i + 1 < bytes.length ? __B64[((b1 & 15) << 2) | (b2 >> 6)] : '=')
        +  (i + 2 < bytes.length ? __B64[b2 & 63] : '=');
  }
  return out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function __b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const clean = s.replace(/=+$/, '');
  const bytes = new Uint8Array(Math.floor(clean.length * 3 / 4));
  let p = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = __B64.indexOf(clean[i]);
    const c1 = __B64.indexOf(clean[i + 1]);
    const c2 = clean[i + 2] !== undefined ? __B64.indexOf(clean[i + 2]) : -1;
    const c3 = clean[i + 3] !== undefined ? __B64.indexOf(clean[i + 3]) : -1;
    bytes[p++] = (c0 << 2) | (c1 >> 4);
    if (c2 >= 0) bytes[p++] = ((c1 & 15) << 4) | (c2 >> 2);
    if (c3 >= 0) bytes[p++] = ((c2 & 3) << 6) | c3;
  }
  return bytes;
}
function bufToB64url(buf) {
  return __bytesToB64url(new Uint8Array(buf));
}

// ---------- HMAC-SHA256 验签 ----------
async function hmac(data, secret) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return bufToB64url(sig);
}

function b64urlToStr(b64) {
  return new TextDecoder().decode(__b64urlToBytes(b64));
}

// token 结构：  <payloadB64url>.<sigB64url>
// payload = { u: 用户名, exp: 过期时间(ms) }
async function verifyToken(token, secret) {
  if (!token || token.indexOf('.') < 0) return false;
  const [payloadB64, sig] = token.split('.');
  if (!payloadB64 || !sig) return false;
  const expected = await hmac(payloadB64, secret);
  // 长度先比，再逐字符比，避免明显的短路
  if (expected.length !== sig.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ sig.charCodeAt(i);
  if (diff !== 0) return false;
  try {
    const payload = JSON.parse(b64urlToStr(payloadB64));
    if (!payload.exp || Date.now() > payload.exp) return false; // 已过期
    return true;
  } catch (_) {
    return false;
  }
}

function getCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

function isPublic(pathname) {
  if (PUBLIC_PATHS.has(pathname)) return true;
  return PUBLIC_PREFIXES.some((p) => pathname.startsWith(p));
}

export async function middleware(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const pathname = url.pathname;
  const secret = (env && env.AUTH_SECRET) || DEFAULTS.AUTH_SECRET;

  // 1) 白名单直接放行
  if (isPublic(pathname)) return context.next();

  // 2) 校验登录凭证
  const token = getCookie(request, COOKIE_NAME);
  const ok = await verifyToken(token, secret);
  if (ok) return context.next(); // 已登录 —— 透传到真实页面 / 资源

  // 3) 未登录：页面请求重定向到登录页；其它资源（图片/接口）直接 401
  const accept = request.headers.get('Accept') || '';
  if (accept.includes('text/html')) {
    const to = new URL('/login.html', url.origin);
    to.searchParams.set('redirect', pathname + url.search);
    return context.redirect(to.toString());
  }
  return new Response('Unauthorized', { status: 401 });
}

// 注：EdgeOne Pages 中间件默认即拦截「所有请求」（含静态 HTML / 图片），
// 无需额外 matcher 配置。白名单逻辑已在上面 isPublic() 中实现。
