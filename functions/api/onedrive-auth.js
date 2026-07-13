// ============================================================================
//  OneDrive OAuth 授权回调（EdgeOne Pages 边缘函数）
//   访问本端点：
//     · 未带 ?code  → 跳转到微软授权页（用户登录同意）
//     · 带 ?code    → 用 code 换 token，存入 KV，返回成功页
//   之后 resources.html 调用 /api/onedrive-list 即可实时读取 OneDrive。
//
//  前置（见《OneDrive 自动目录站配置指南.md》）：
//    1) EdgeOne 控制台创建并绑定 KV 命名空间（变量名 my_kv）
//    2) 配置环境变量 OD_CLIENT_ID / OD_CLIENT_SECRET（OD_TENANT / OD_ROOT 可选）
//    3) 在 Azure 应用里把重定向 URI 配成  https://<你的域名>/api/onedrive-auth
// ============================================================================

const AUTH_BASE = 'https://login.microsoftonline.com';

function cfg(env) {
  return {
    clientId: env && env.OD_CLIENT_ID,
    clientSecret: env && env.OD_CLIENT_SECRET,
    tenant: (env && env.OD_TENANT) || 'common',
    root: (env && env.OD_ROOT) || '/Public',
  };
}

function redirectUri(reqUrl) {
  return new URL('/api/onedrive-auth', reqUrl.origin).toString();
}

async function saveTokens(tokens) {
  const payload = {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expires_at: Date.now() + ((Number(tokens.expires_in) || 3600) * 1000),
  };
  await my_kv.put('onedrive_tokens', JSON.stringify(payload));
}

async function exchangeCode(code, c, redir) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: c.clientId,
    client_secret: c.clientSecret,
    code,
    redirect_uri: redir,
  });
  const resp = await fetch(`${AUTH_BASE}/${c.tenant}/oauth2/v2.0/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!resp.ok) {
    const t = await resp.text();
    throw new Error('token 换取失败: ' + resp.status + ' ' + t.slice(0, 300));
  }
  return resp.json();
}

function htmlResp(title, msg) {
  const html = '<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + title + '</title>'
    + '<body style="margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;'
    + 'font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',sans-serif;background:#04060F;color:#AEB8CC">'
    + '<div style="text-align:center;max-width:560px;padding:32px;background:rgba(255,255,255,.06);'
    + 'border:1px solid rgba(255,255,255,.18);border-radius:18px;backdrop-filter:blur(18px)">'
    + '<h2 style="color:#5B9CFF;margin:0 0 14px">' + title + '</h2>'
    + '<p style="line-height:1.7;font-size:15px">' + msg + '</p></div></body></html>';
  return new Response(html, { headers: { 'content-type': 'text/html; charset=UTF-8' } });
}

export async function onRequest(context) {
  const { request, env } = context;
  const url = new URL(request.url);
  const c = cfg(env);
  const redir = redirectUri(url);

  // KV 未绑定：提前提示，避免 saveTokens 抛裸错
  if (typeof my_kv === 'undefined') {
    return htmlResp('缺少 KV 存储',
      '请在 EdgeOne 控制台创建并绑定一个 KV 命名空间（绑定时的变量名用 <code style="color:#7AA2FF">my_kv</code>），然后重新部署。');
  }

  // 缺配置：提示去配环境变量
  if (!c.clientId || !c.clientSecret) {
    return htmlResp('尚未配置',
      '请在 EdgeOne 控制台「环境变量」设置 <code style="color:#7AA2FF">OD_CLIENT_ID</code> / '
      + '<code style="color:#7AA2FF">OD_CLIENT_SECRET</code>（可选 <code style="color:#7AA2FF">OD_TENANT</code>、'
      + '<code style="color:#7AA2FF">OD_ROOT</code>），然后重新部署。');
  }

  const code = url.searchParams.get('code');
  const error = url.searchParams.get('error');

  try {
    if (error) {
      return htmlResp('授权被拒绝', '微软返回错误：' + error + '。请重试授权。');
    }

    if (!code) {
      // 跳转微软授权页
      const authUrl = new URL(`${AUTH_BASE}/${c.tenant}/oauth2/v2.0/authorize`);
      authUrl.searchParams.set('client_id', c.clientId);
      authUrl.searchParams.set('response_type', 'code');
      authUrl.searchParams.set('redirect_uri', redir);
      authUrl.searchParams.set('scope', 'https://graph.microsoft.com/Files.Read.All offline_access');
      authUrl.searchParams.set('response_mode', 'query');
      return context.redirect(authUrl.toString());
    }

    // 用 code 换 token 并存储
    const tok = await exchangeCode(code, c, redir);
    await saveTokens(tok);
    const rootName = c.root.replace(/^\//, '');
    return htmlResp('授权成功 🎉',
      'OneDrive 已连接。现在访问 <a href="/resources.html" style="color:#7AA2FF">资源站</a> '
      + '即可看到 <b>/' + rootName + '</b> 里的文件，且文件增删会自动同步。<br><br>'
      + '（若资源站提示未授权，请确认 KV 已绑定且本项目已重新部署。）');
  } catch (e) {
    return htmlResp('授权失败', '错误信息：' + e.message
      + '<br><br>常见原因：① Azure 应用的重定向 URI 未配成 <code style="color:#7AA2FF">'
      + redir + '</code>；② client_secret 已过期；③ 组织策略需要管理员同意。');
  }
}
