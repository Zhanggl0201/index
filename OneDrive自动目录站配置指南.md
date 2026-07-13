# OneDrive 自动目录站（EdgeOne 版）配置指南

把 OneDrive 变成一个「自动更新、风格和你主站统一、共用登录鉴权」的资源站——**全部跑在你现有的 EdgeOne Pages 项目里**，不碰 Cloudflare、不买服务器。

> 之前那份 FODI 指南要你注册 Cloudflare、建 KV、装 wrangler、配 Cron，太重。
> 这套方案只多一步「注册一个 Azure 应用 + 跑一次授权链接」，其余全在 EdgeOne 一个平台完成，而且前端是你主站的玻璃风格。

---

## 这个方案做了什么

| 组件 | 作用 |
|---|---|
| `functions/api/onedrive-auth.js` | OneDrive OAuth 授权回调。访问它自动跳转微软登录 → 同意后把 token 存进 EdgeOne KV |
| `functions/api/onedrive-list.js` | 登录后实时读 OneDrive 指定文件夹，返回文件/文件夹列表（JSON） |
| `resources.html` | 你主站同款玻璃风格的资源页，JS 调上面的接口动态渲染，支持进子文件夹 |
| `middleware.js` | 全局拦截。**`onedrive-list` 故意不在白名单**——没登录连目录都拉不到；只有 `onedrive-auth` 放行（授权时还没登录） |

**自动更新**：`onedrive-list` 每次访问都实时向 OneDrive 拉最新目录，你在 OneDrive 里增删文件，刷新资源站立刻反映，无需改代码、无需重新部署。

**共用登录**：和首页同一个边缘登录门，没登录进不去资源站。

---

## 你需要准备的东西

1. 一个 **Azure 应用（client_id + client_secret）** —— 用于向微软申请访问你 OneDrive 的权限（约 5 分钟注册一次）
2. 你的 **EdgeOne 部署域名**（部署后才有，用于填 Azure 的重定向 URI）
3. OneDrive 里一个用来放资源的文件夹（默认 `/Public`，可自行改名）

---

## 部署步骤

### ① 注册 Azure 应用（一次性）

1. 打开 **https://entra.microsoft.com** → 左侧「应用注册」→「新注册」
2. 名称随便，比如 `YunfanRes`
3. **受支持的账户类型**：
   - 个人 OneDrive → 选「任何组织目录中的账户和个人 Microsoft 账户」
   - 学校/公司 E5 版 → 选对应组织范围即可（默认项通常就行）
4. **重定向 URI**：平台选 **Web**，填：
   ```
   https://<你的 EdgeOne 域名>/api/onedrive-auth
   ```
   > 例：若你的站是 `https://blog.example.com`，就填 `https://blog.example.com/api/onedrive-auth`
   > 这个域名要等 ④ 部署完才有，所以可以先部署、回头再补这步也行。
5. 点「注册」，记下顶部的 **应用程序(客户端) ID**（即 `OD_CLIENT_ID`）
6. 左侧「证书和密码」→「客户端密码」→「新建客户端密码」→ 说明随便、过期选「24 个月」→ 添加 → **立刻复制那个「值」**（即 `OD_CLIENT_SECRET`，只显示一次）
7. 左侧「API 权限」→「添加权限」→ Microsoft Graph → 委托的权限 → 勾选：
   - `Files.Read.All`
   - `offline_access`（用于拿到长期有效的 refresh_token）
   - 点「添加权限」
   - 若是**组织/学校账号**，顶部可能出现「为 xxx 授予管理员同意」按钮 → 让管理员点一次（或你自己有权限时点「代表组织授予同意」）。个人账号登录授权时会自行同意，无需这步。

### ② 在 EdgeOne 创建并绑定 KV 存储

1. EdgeOne 控制台 → 「存储」→「KV」→ 开通账户 →「创建命名空间」，名字随便（如 `onedrive`）
2. 进入你的 **Pages 项目** → 设置 → 找到 KV 绑定 → 把刚才的命名空间绑定进来，**绑定时的「变量名」填 `my_kv`**（代码里就靠这个名字访问 KV）

### ③ 配置环境变量

项目 → 设置 → 环境变量，加：

| 变量名 | 必填 | 说明 |
|---|---|---|
| `OD_CLIENT_ID` | ✅ | ① 第 5 步拿到的客户端 ID |
| `OD_CLIENT_SECRET` | ✅ | ① 第 6 步拿到的客户端密码「值」 |
| `OD_TENANT` | 选填 | 默认 `common`；若授权总提示租户问题，改成你的租户 ID |
| `OD_ROOT` | 选填 | OneDrive 里要展示的根文件夹，**默认 `/Public`**（注意开头有斜杠） |

> 密钥只存在控制台环境变量 + KV 里，**不进代码、不进公开仓库**，比写死安全得多。

### ④ 部署

把改动推到 GitHub（EdgeOne 会自动重新构建）：
```bash
cd "C:\Users\青冥\WorkBuddy\2026-07-13-01-57-05\blog-homepage"
git push
```
部署完成后记下你的域名，回去把 **① 第 4 步的重定向 URI** 补填进 Azure 应用（如果刚才先部署的话）。

### ⑤ 跑一次授权

浏览器打开：
```
https://<你的域名>/api/onedrive-auth
```
会自动跳到微软登录页 → 用你的 OneDrive 账号登录并「接受」→ 跳回后显示「授权成功 🎉」。
此时 refresh_token 已经存进 KV，之后**再也不需要手动授权**（除非你改密码或撤销应用）。

> 如果 Azure 重定向 URI 没配对，会报错——按页面提示把正确的 `https://<域名>/api/onedrive-auth` 加到 Azure 应用即可。

### ⑥ 看资源站

访问 `https://<你的域名>/resources.html`（首页「资源站」框也会跳到这里）。
往 OneDrive 的 `/Public` 文件夹丢文件，刷新页面就能看到，**全自动同步**。

---

## 防护说明

- 没登录访问 `/resources.html` 或 `/api/onedrive-list` → 被 `middleware.js` 拦到登录页。
- 直接拿 OneDrive 文件直链（Graph 返回的 `downloadUrl`）下载不需要登录，但**直链本身不会出现在任何未授权页面里**，外人拿不到。
- 整个网站只暴露你主动放进 `/Public` 的内容，OneDrive 其它文件不外泄。

---

## 常见报错自查

| 资源站提示 | 含义 | 处理 |
|---|---|---|
| 尚未连接 OneDrive / 去授权 | 还没跑 ⑤ 授权 | 打开 `/api/onedrive-auth` 授权一次 |
| 尚未配置 / `NOT_CONFIGURED` | 没配 `OD_CLIENT_ID` / `OD_CLIENT_SECRET` | 回 ③ 配环境变量并重部署 |
| 缺少 KV 存储 / `KV_NOT_BOUND` | 没绑定 KV 或变量名不是 `my_kv` | 回 ② 绑定，变量名务必 `my_kv` |
| `GRAPH_ERROR` 权限类 | 应用没有 `Files.Read.All` 权限或管理员未同意 | 回 ① 第 7 步补权限/授予同意 |
| 授权失败：redirect_uri 不匹配 | Azure 里的重定向 URI 写错 | 改成 `https://<域名>/api/onedrive-auth` |

---

## 和 FODI 方案比，为什么这个更简单

| | FODI | 本方案（EdgeOne 自建） |
|---|---|---|
| 云服务商 | Cloudflare + 微软 +（可选）EdgeOne 前端 | **只有 EdgeOne + 微软** |
| 需要注册 | Cloudflare 账号 + Azure 应用 | 只需 Azure 应用 |
| 额外组件 | Workers + KV + wrangler + Cron 续期 | EdgeOne 自带 KV，无 Cron |
| 前端风格 | FODI 自带 UI（要改代码才像你站） | **直接用你主站玻璃风格** |
| 登录鉴权 | 要额外做 | **复用你现有的边缘登录门** |
| 适合 | 想完全独立托管 | 想和现网站融为一体 ✅ |
