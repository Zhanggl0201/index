// ============================================================================
//  OneDrive 目录列表接口（EdgeOne Pages 边缘函数）
//   GET /api/onedrive-list[?path=/Public/子目录]
//   返回当前用户 OneDrive 指定文件夹下的文件/文件夹列表（JSON）。
//   自动用 KV 里的 refresh_token 续期 access_token，无需 Cron。
//
//  依赖（见《OneDrive 自动目录站配置指南.md》）：
//    · EdgeOne KV 命名空间（变量名 my_kv），存 onedrive_tokens
//    · 环境变量 OD_CLIENT_ID / OD_CLIENT_SECRET（OD_TENANT / OD_ROOT 可选）
//
//  防护：本接口【不】在 middleware 白名单中，因此未登录用户无法调用，
//  与首页共用同一套边缘登录鉴权。
// ============================================================================

const AUTH_BASE = 'https://login.microsoftonline.com';
const GRAPH_BASE = 'https://graph.microsoft.com';
const KV_KEY = 'onedrive_tokens';

function cfg(env) {
  return {
    clientId: env && env.OD_CLIENT_ID,
    clientSecret: env && env.OD_CLIENT_SECRET,
    tenant: (env && env.OD_TENANT) || 'common',
    root: (env && env.OD_ROOT) || '/Public',
  };
}

function kvAvailable() { return typeof my_kv !== 'undefined'; }

async function loadTokens() {
  const raw = await my_kv.get(KV_KEY);
  return raw ? JSON.parse(raw) : null;
}
async function saveTokens(obj) {
  await my_kv.put(KV_KEY, JSON.stringify(obj));
}

async function refresh(c, refreshToken) {
  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: c.clientId,
    client_secret: c.clientSecret,
    refresh_token: refreshToken,
  });
  const resp = await fetch(`${AUTH_BASE}/${c.tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) throw new Error('TOKEN_EXPIRED');
  return resp.json();
}

// 取得有效 access_token（必要时用 refresh_token 续期并写回 KV）
async function getAccessToken(c) {
  if (!kvAvailable()) throw new Error('KV_NOT_BOUND');
  let t = await loadTokens();
  if (!t || !t.refresh_token) throw new Error('NOT_AUTH');
  const now = Date.now();
  // 距过期 >5 分钟则直接复用缓存的 access_token
  if (t.access_token && t.expires_at && t.expires_at - now > 5 * 60 * 1000) {
    return t.access_token;
  }
  const fresh = await refresh(c, t.refresh_token);
  const next = {
    access_token: fresh.access_token,
    refresh_token: fresh.refresh_token || t.refresh_token,
    expires_at: now + ((Number(fresh.expires_in) || 3600) * 1000),
  };
  await saveTokens(next);
  return next.access_token;
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const c = cfg(env);
  const path = url.searchParams.get('path') || c.root;

  if (!c.clientId || !c.clientSecret) {
    return json({ ok: false, error: 'NOT_CONFIGURED' }, 500);
  }
  if (!kvAvailable()) {
    return json({ ok: false, error: 'KV_NOT_BOUND' }, 500);
  }

  let accessToken;
  try {
    accessToken = await getAccessToken(c);
  } catch (e) {
    if (e.message === 'NOT_AUTH' || e.message === 'TOKEN_EXPIRED') {
      return json({ ok: false, error: 'NOT_AUTH', authUrl: '/api/onedrive-auth' }, 401);
    }
    if (e.message === 'KV_NOT_BOUND') {
      return json({ ok: false, error: 'KV_NOT_BOUND' }, 500);
    }
    return json({ ok: false, error: 'TOKEN_ERROR', detail: e.message }, 500);
  }

  // 构造 Graph 路径：root:/Public/子目录:/children
  const segs = path.split('/').filter(Boolean).map(encodeURIComponent);
  const enc = segs.join('/');
  const graphUrl = `${GRAPH_BASE}/v1.0/me/drive/root${enc ? ':/' + enc + ':' : '/'}/children`
    + '?$select=name,size,file,folder,lastModifiedDateTime,@microsoft.graph.downloadUrl'
    + '&$orderby=folder desc,name asc';

  let resp;
  try {
    resp = await fetch(graphUrl, { headers: { 'Authorization': 'Bearer ' + accessToken } });
  } catch (e) {
    return json({ ok: false, error: 'GRAPH_FETCH_FAILED', detail: e.message }, 502);
  }

  if (!resp.ok) {
    const t = await resp.text();
    return json({ ok: false, error: 'GRAPH_ERROR', status: resp.status, detail: t.slice(0, 300) }, 502);
  }

  const data = await resp.json();
  const items = (data.value || [])
    .filter(it => !it.name.startsWith('.')) // 过滤隐藏文件
    .map(it => ({
      name: it.name,
      size: it.size || 0,
      isFolder: !!it.folder,
      modified: it.lastModifiedDateTime || '',
      downloadUrl: (it['@microsoft.graph.downloadUrl'] || ''),
      path: (path.replace(/\/$/, '') + '/' + it.name).replace(/\/+/g, '/'),
    }));

  return json({ ok: true, path, items });
}
