// ============================================================================
//  POST /api/logout  —— 清除登录凭证 Cookie
// ============================================================================
const COOKIE_NAME = 'yf_sess';

export function onRequest() {
  const cookie = [
    `${COOKIE_NAME}=`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Max-Age=0', // 立即失效
  ].join('; ');

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=UTF-8',
      'Set-Cookie': cookie,
    },
  });
}
