// ============================================================================
//  EdgeOne Pages 边缘鉴权中间件  ——  真正的服务端访问防护
//  运行在边缘节点，所有请求（含静态 HTML / 图片）都会先经过这里。
//  未持有合法登录凭证的访客，连页面 HTML 都拿不到。
// ============================================================================

// ---- 签名密钥必须由 EdgeOne 控制台「环境变量」AUTH_SECRET 提供；未配置则整站拒绝访问（fail-closed）----
// 代码中不保留任何默认密钥，即使仓库公开也无法伪造凭证。

// 无需登录即可访问的白名单（登录页本身、登录接口、登录页要用到的资源）
const PUBLIC_PATHS = new Set([
  '/login.html',
  '/api/login',
  '/api/onedrive-auth',   // OneDrive OAuth 回调：授权时尚未登录，必须放行
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
  const secret = env && env.AUTH_SECRET;

  // 1) 白名单直接放行
  if (isPublic(pathname)) return context.next();

  // fail-closed：未配置签名密钥时，一律不放行（宁可整站不可用，也不使用可被利用的默认密钥）
  if (!secret) {
    const accept = request.headers.get('Accept') || '';
    if (accept.includes('text/html')) {
      const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
        + '<meta name="viewport" content="width=device-width,initial-scale=1">'
        + '<title>站点未配置</title>'
        + '<body style="margin:0;height:100vh;display:flex;align-items:center;justify-content:center;'
        + 'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;background:#04060F;color:#AEB8CC">'
        + '<div style="text-align:center;max-width:520px;padding:24px">'
        + '<h2 style="color:#5B9CFF;margin:0 0 12px">站点尚未配置访问凭证</h2>'
        + '<p style="line-height:1.7">请在 EdgeOne 控制台的「环境变量」中设置 '
        + '<code style="color:#7AA2FF">AUTH_USER</code> / <code style="color:#7AA2FF">AUTH_PASS</code> / '
        + '<code style="color:#7AA2FF">AUTH_SECRET</code> 后重新部署。</p></div></body></html>';
      return new Response(html, { status: 503, headers: { 'content-type': 'text/html; charset=UTF-8' } });
    }
    return new Response('Service Unavailable: auth not configured', { status: 503 });
  }

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
