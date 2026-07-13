// ============================================================================
//  POST /api/login  —— 服务端校验账号密码，签发 HMAC 签名登录凭证
//  账号密码在边缘节点校验，前端拿不到；凭证写入 HttpOnly Cookie，JS 无法窃取。
// ============================================================================

// ---- 默认账号密码 / 密钥；线上请在 EdgeOne 控制台「环境变量」里覆盖 ----
const DEFAULTS = {
  AUTH_USER: 'admin',
  AUTH_PASS: 'yunfan2026',
  AUTH_SECRET: 'change-me-please-a-long-random-string',
};

const COOKIE_NAME = 'yf_sess';
const MAX_AGE = 60 * 60 * 8; // 凭证有效期：8 小时（秒）

// base64url（不依赖 btoa/atob，兼容边缘运行时）
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
function bufToB64url(buf) {
  return __bytesToB64url(new Uint8Array(buf));
}
function strToB64url(str) {
  return __bytesToB64url(new TextEncoder().encode(str));
}

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

async function signToken(user, secret, maxAgeSec) {
  const payload = strToB64url(JSON.stringify({ u: user, exp: Date.now() + maxAgeSec * 1000 }));
  const sig = await hmac(payload, secret);
  return `${payload}.${sig}`;
}

function json(body, status) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'content-type': 'application/json; charset=UTF-8' },
  });
}

async function handleLogin(context) {
  const { request, env } = context;
  const USER = (env && env.AUTH_USER) || DEFAULTS.AUTH_USER;
  const PASS = (env && env.AUTH_PASS) || DEFAULTS.AUTH_PASS;
  const SECRET = (env && env.AUTH_SECRET) || DEFAULTS.AUTH_SECRET;

  let data = {};
  try {
    data = await request.json();
  } catch (_) {
    return json({ ok: false, msg: '请求格式错误' }, 400);
  }

  const user = (data.user || '').trim();
  const pass = data.pass || '';

  if (user !== USER || pass !== PASS) {
    return json({ ok: false, msg: '用户名或密码错误' }, 401);
  }

  const token = await signToken(user, SECRET, MAX_AGE);
  const cookie = [
    `${COOKIE_NAME}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${MAX_AGE}`,
  ].join('; ');

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'Set-Cookie': cookie,
    },
  });
}

// 单一入口：仅接受 POST，其它方法拒绝
export function onRequest(context) {
  if (context.request.method === 'POST') return handleLogin(context);
  return json({ ok: false, msg: 'Method Not Allowed' }, 405);
}
