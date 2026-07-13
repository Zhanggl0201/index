# 用 OneDrive 搭建资源站（FODI · E5 版）部署指南

> 目标：把你 OneDrive 里某个文件夹变成一个公开的资源浏览站——别人打开网址就能看到文件列表，
> 支持在线预览（图片 / 视频 / PDF / Office）、下载、搜索，且**完全看不出背后是 OneDrive**、也拿不到你的账号。
> 你只管往网盘丢文件，网站永远最新。
>
> 方案：**FODI**（Fast OneDrive Index）。后端跑在 **Cloudflare Workers**（免费、无服务器），
> 前端可选挂到 **EdgeOne Pages** 加速（国内访问更快，接你现有生态）。

---

## 架构一图流

```
你往 OneDrive/Public 丢文件
        │
        ▼
[Cloudflare Workers]  ← FODI 后端，用你自建的 Azure 应用调 Microsoft Graph API 读文件
        │
        ▼
访客浏览器  ──►  files.你的域名.com  （文件列表 / 预览 / 下载）
```

> **为什么你必须自建 Azure 应用**：FODI 的「一键部署」只支持**个人版** OneDrive。
> 你是**学校/公司 E5（组织）版**，走国际版 Microsoft Graph API，
> 官方明确要求「自行创建应用」。下面第一步就是干这个，不难，跟着截图字段填即可。

---

## 第一步 · 注册 Azure 应用（拿 clientId + clientSecret）

1. 浏览器打开 **Azure 门户** → 应用注册页面：
   https://portal.azure.com/#view/Microsoft_AAD_RegisteredApps/ApplicationsListBlade
   （用你的 **E5 账号**登录）

2. 点 **「新注册 / New registration」**：
   - **名称**：随便填，如 `fodi-resource`
   - **受支持的账户类型**：选
     **「任何组织目录中的账户和个人 Microsoft 账户」**
     （Accounts in any organizational directory and personal Microsoft accounts）
   - **重定向 URI**：平台选 **Web**，值填：
     ```
     http://localhost/onedrive-login
     ```
     ⚠️ 必须**一字不差**是这个（要和后面 wrangler.jsonc 里的 `redirectUri` 完全一致）
   - 点 **注册**

3. 注册完进入应用概览页，**复制并记下**：
   - **应用程序(客户端) ID** → 这就是 `clientId`

4. 左侧 **「证书和密码 / Certificates & secrets」** → **「新客户端密码 / New client secret」**：
   - 说明随意，有效期选最长（24 个月）
   - 创建后**立刻复制「值 / Value」那一列**（不是「密码 ID」！值只显示这一次，刷新就没了）
   - 这就是 `clientSecret`

5. 左侧 **「API 权限 / API permissions」** → **添加权限** → **Microsoft Graph** → **委托的权限 / Delegated**，
   勾选这三个后点添加：
   - `offline_access`
   - `User.Read`
   - `Files.ReadWrite.All`（只读也行，用 `Files.Read.All`，但读写更省事）

   > 组织版一般**不需要**管理员同意这几个委托权限；若列表里出现「需要管理员同意」的黄色提示，
   > 让管理员点一下「授予管理员同意」即可。

到此你手里有两样东西：**clientId**、**clientSecret**。收好。

---

## 第二步 · 准备 Cloudflare（建 KV + 装工具）

1. 注册/登录 **Cloudflare**：https://dash.cloudflare.com/
2. 建一个 KV 命名空间（存 token 和缓存）：
   左侧 **Storage & Databases → KV → Create namespace**，名字随意（如 `fodi-cache`），
   建好后**复制它的 ID**（后面填进配置）。
   直达：https://dash.cloudflare.com/?to=/:account/workers/kv/namespaces
3. 本机装 Wrangler CLI（Cloudflare 的部署工具）并登录：
   ```bash
   npm install -g wrangler
   wrangler login
   ```
   浏览器会弹出授权，点同意即可。

---

## 第三步 · 拿 FODI 代码 + 改配置

```bash
git clone https://github.com/vcheckzen/FODI.git
cd FODI
```

用编辑器打开根目录的 **`wrangler.jsonc`**，改这几处（其余保持默认）：

```jsonc
{
  "name": "fodi",                      // Worker 名字，随意
  "main": "back-end-cf/index.ts",
  "compatibility_date": "2025-04-10",

  "kv_namespaces": [
    {
      "binding": "FODI_CACHE",
      "id": "把第二步复制的 KV 命名空间 ID 填这里"   // ★
    }
  ],

  "vars": {
    "OAUTH": {
      "clientId":     "填你第一步的 clientId",        // ★
      "clientSecret": "填你第一步的 clientSecret",    // ★
      "redirectUri":  "http://localhost/onedrive-login",   // 保持不变，和 Azure 一致
      "loginHost":    "https://login.microsoftonline.com",
      "oauthUrl":     "https://login.microsoftonline.com/common/oauth2/v2.0/",
      "apiHost":      "https://graph.microsoft.com",
      "apiUrl":       "https://graph.microsoft.com/v1.0/me/drive/root",
      "scope":        "offline_access User.Read Files.ReadWrite.All"
      // ↑ 你是 E5 国际版，上面这几个 host/url 全部保持默认，不用动
      //   （只有「世纪互联版」才需要改成 onmschina 的端点）
    },

    "PROTECTED": {
      "EXPOSE_PATH": "/Public",   // ★ 只公开这个目录！先在 OneDrive 建个 Public 文件夹放要分享的文件
      "REQUIRE_AUTH": false,      // 想给整站加访问密码就改 true（见下方「给资源站加密码」）
      "AUTH_PATHS": [],
      "PASSWD_FILENAME": ".password",
      "PROXY_KEYWORD": ""
    }
    // CACHE_TTLMAP / RESP_HEADERS 保持默认
  },

  "triggers": {
    "crons": ["0 0 1 * *"]   // 自动续 token（内置，不用管）
  }
}
```

> **★ 三个必填**：KV 的 `id`、`clientId`、`clientSecret`。
> **EXPOSE_PATH 强烈建议设成 `/Public`**（别用 `/`），这样只暴露你专门放资源的那个文件夹，
> 整个网盘的其它文件不会被人看到。记得去 OneDrive 网页版**新建一个 `Public` 文件夹**。

⚠️ **安全提醒**：`clientSecret` 明文写在 wrangler.jsonc 里。
- 如果你要把改好的代码推到 GitHub，**务必用私有仓库**；
- 或更稳妥地用密钥方式（不写进文件）：
  ```bash
  # 把 OAUTH 里的 clientSecret 留空，改用 secret 注入
  npx wrangler secret put OAUTH   # 按提示粘贴整个 OAUTH JSON（进阶，可跳过）
  ```

---

## 第四步 · 部署到 Cloudflare Workers

```bash
npm install
npm run deploy
```

部署成功后会给你一个地址，形如：
```
https://fodi.你的用户名.workers.dev
```

---

## 第五步 · 完成 OneDrive 授权（拿 refresh_token）

这一步把「你的 Azure 应用」和「你的 OneDrive」正式绑定，token 会存进 KV。

1. 浏览器访问：
   ```
   https://fodi.你的用户名.workers.dev/deployfodi
   ```
2. 页面会引导你跳转到微软登录 → 用 **E5 账号**登录并**同意授权**。
3. 授权后浏览器会跳到 `http://localhost/onedrive-login?code=xxxxx`
   （这个页面**打不开是正常的**，浏览器会显示无法访问）。
   **把地址栏里完整的 URL 复制**，粘回 `deployfodi` 页面的输入框，提交。
4. 提示成功后，token 就写进 KV 了。以后 FODI 会靠内置 Cron 每月自动续期，**不用再管**。

现在访问 `https://fodi.你的用户名.workers.dev`，应该能看到你 OneDrive `/Public` 里的文件列表了 🎉

---

## 第六步 · 绑定自己的短域名（可选但推荐）

`workers.dev` 域名又长、国内访问也一般。在 Cloudflare 控制台：
**Workers & Pages → 你的 fodi Worker → Settings → Domains & Routes → Add → Custom Domain**，
填 `files.你的域名.com`（域名需先托管在 Cloudflare）。

---

## 第七步（可选）· 前端挂到 EdgeOne 加速

FODI 官方支持 EdgeOne Pages 部署前端（后端仍在 CF Workers，前端静态资源由 EdgeOne 国内 CDN 分发，访问更快）。
一键部署入口（README 里那颗 EdgeOne 按钮）：
```
https://edgeone.ai/pages/new?repository-url=https://github.com/vcheckzen/FODI/tree/master/front-end
```
部署时把前端配置里的**后端接口地址**指向你第六步的 Worker 域名即可。
> 简单起见，你也可以**跳过这步**，直接用 Worker 自带的前端（第五步那个地址就已经是完整站点了）。

---

## 第八步 · 把主站首页「资源站」框链上去

你主站 `index.html` 里第 4 个框「资源站」现在是占位链接 `href="#resources"`。
资源站上线拿到域名后，告诉我地址，我帮你把它改成真实链接（比如 `https://files.你的域名.com`，
并让它在新标签页打开）。或者你自己改：把 `href="#resources"` 换成资源站网址即可。

---

## 附：给资源站加访问密码

如果不想让资源站完全公开：
1. wrangler.jsonc 里 `PROTECTED.REQUIRE_AUTH` 改成 `true`；
2. 在 OneDrive 的 `/Public` 目录（或某个子目录）放一个名为 `.password` 的文本文件，
   内容是密码的 **sha256 十六进制**值（用 `echo -n '你的密码' | sha256sum` 生成）；
3. 重新 `npm run deploy`。
访客进站就需要输密码了。

---

## 常见问题

| 现象 | 原因 / 解决 |
|---|---|
| 授权时报 `AADSTS......` / 需要管理员同意 | 组织策略限制。让 IT 管理员在 Azure「API 权限」页点「授予管理员同意」 |
| 列表空 / 404 | `EXPOSE_PATH` 写的目录在 OneDrive 里不存在，或大小写不符。确认 `/Public` 真实存在 |
| 部署报 KV 错误 | `wrangler.jsonc` 里 KV `id` 没填或填错 |
| clientSecret 失效 | 密码到期了。去 Azure 重新生成客户端密码，更新配置再 `npm run deploy` |
| 文件下载慢 | 设置 `PROXY_KEYWORD` 让 Worker 代理下载，或走第七步 EdgeOne 加速 |

---

## 一句话总结

**建 Azure 应用拿 clientId+clientSecret → 建 CF KV → 改 wrangler.jsonc 填三项 → `npm run deploy` → 访问 `/deployfodi` 授权 → 完事。**
文件放 OneDrive `/Public`，网站自动同步。
