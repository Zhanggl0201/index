# OneDrive 自动目录站（EdgeOne 版）· 详细配置手册

> 目标：把你 OneDrive 里的文件，自动列成「和你主站同款玻璃风格、共用同一套登录鉴权」的资源站。
> 往 OneDrive 丢文件 / 删文件 → 刷新资源站立刻同步，不用改代码、不用重新部署。
> 全程只在 **EdgeOne + 微软** 两家平台完成，不碰 Cloudflare、不买服务器、不配 Cron。

---

## 0. 你现在的代码里已经有什么（确认用）

| 文件 | 作用 |
|---|---|
| `functions/api/onedrive-auth.js` | 授权入口：访问它 → 跳微软登录 → 同意后把 token 存进 EdgeOne KV |
| `functions/api/onedrive-list.js` | 列表接口：实时读 OneDrive 目录返回 JSON，自动续期 token |
| `resources.html` | 资源页：JS 调上面接口动态渲染卡片墙，风格和主站一致 |
| `middleware.js` | 全局拦截；`onedrive-list` **故意不在白名单**（没登录拉不到目录），只放行 `onedrive-auth` |

**代码里用到的「名字」（配置时务必一致）：**

| 名字 | 含义 | 默认值 |
|---|---|---|
| KV 绑定变量名 | 代码里固定用 `my_kv` 访问 KV | 必须叫 `my_kv` |
| `OD_CLIENT_ID` | Azure 应用的客户端 ID | 无（必填） |
| `OD_CLIENT_SECRET` | Azure 应用的客户端密码 | 无（必填） |
| `OD_TENANT` | Azure 租户 ID | `common` |
| `OD_ROOT` | OneDrive 里展示的根文件夹 | `/Public` |
| KV 内部键 | token 存在 KV 的键名 | `onedrive_tokens`（代码自动管） |

> 微软 API 地址是 `https://graph.microsoft.com/v1.0/me/drive/root:/路径:/children`，scope = `Files.Read.All offline_access`。这些代码已写好，你不用管。

---

## 1. 准备工作（一次性）

你需要三样东西，下面逐步拿到：

1. **Azure 应用** 的 `client_id` + `client_secret`（向微软申请访问你 OneDrive 的凭证）
2. **EdgeOne 部署域名**（部署后才有，回头填进 Azure 的重定向 URI）
3. OneDrive 里一个放资源的文件夹（默认 `/Public`，建议就用这个，先在 OneDrive 建好）

---

## 2. 第一步：注册 Azure 应用

> 你的是 **学校/公司 E5 版**，账号走国际版 Microsoft Graph，按下面「E5 专属」提示来。

1. 浏览器打开 **https://entra.microsoft.com**（微软 Entra 管理中心，旧名 Azure AD）。
   - 用你的 **OneDrive 同一账号** 登录。
2. 左侧菜单 → **「应用注册」(App registrations)** → 右上角 **「新注册」(New registration)**。
3. **名称(Name)**：随便填，例如 `YunfanRes`。
4. **受支持的账户类型(Supported account types)**：
   - 个人 OneDrive → 选「任何组织目录中的账户和个人 Microsoft 账户」。
   - **E5 / 组织账号（你的情况）→ 选「仅限此组织目录中的账户 (仅 <你的组织> - 单一租户)」**。（也可选默认第一项，但单租户最稳。）
5. **重定向 URI(Redirect URI)**：
   - 平台选 **Web**。
   - 填：`https://<你的 EdgeOne 域名>/api/onedrive-auth`
   - 例：站点是 `https://blog.example.com` → 填 `https://blog.example.com/api/onedrive-auth`
   - ⚠️ **这个域名要等部署完才有。** 两种做法：
     - A. 先把代码部署上去（见第 5 步），拿到域名，再回来补这步；
     - B. 先随便填一个占位（如 `https://example.com/api/onedrive-auth`），部署后改成真实域名。
   - **这个 URI 必须和实际访问的域名一字不差（含 https、不含结尾斜杠）**，否则授权时会报 `redirect_uri 不匹配`。
6. 点 **「注册」(Register)**。
7. 注册成功后，页面顶部有一行 **「应用程序(客户端) ID / Application (client) ID」** → **复制这串 GUID**，这就是 `OD_CLIENT_ID`（后面用）。

### 2.1 新建客户端密码（client_secret）

1. 在刚注册的应用页，左侧 **「证书和密码」(Certificates & secrets)** → **「客户端密码」(Client secrets)** 选项卡 → **「新建客户端密码」(New client secret)**。
2. 说明(Description) 随便；**过期(Expires)** 选 **「24 个月」(24 months)**（最长，省得频繁换）。
3. 点 **「添加」(Add)**。
4. 列表中会出现一条，**「值」(Value)** 列那串字符 → **立刻复制**（只显示这一次！关掉就没了）。这就是 `OD_CLIENT_SECRET`。

### 2.2 配置 API 权限（关键）

1. 左侧 **「API 权限」(API permissions)** → **「添加权限」(Add a permission)**。
2. 选 **Microsoft Graph** → **委托的权限 (Delegated permissions)**。
3. 在搜索框勾选这两项，再点底部「添加权限」：
   - **`Files.Read.All`**（读取你 OneDrive 文件 —— 自动列目录必需）
   - **`offline_access`**（拿到长期有效的 refresh_token —— 授权一次后不再弹窗必需）
4. **E5 / 组织账号专属**：添加完权限后，页面顶部常出现黄色条 **「代表 <组织> 授予管理员同意 / Grant admin consent for <组织>」** 按钮 → **点它**（需要你是该应用的管理员/有相应权限；若没有，找你们 IT 管理员点一次）。
   - 个人账号无需这步，授权登录时会自行同意。
   - 不授予管理员同意的话，普通成员账号授权时会出现 **「需要管理员批准 / Need admin approval」** 错误（见排查表）。
5. 确认权限列表里 `Files.Read.All` 和 `offline_access` 都出现，且 E5 账号那一栏显示 **「已授予」(Granted)** 绿勾。

> 到此，你手上有：`OD_CLIENT_ID`、`OD_CLIENT_SECRET`，权限已配好。

---

## 3. 第二步：EdgeOne 创建并绑定 KV

1. EdgeOne 控制台 → 左侧 **「存储」(Storage)** → **「KV」**。
2. **开通** KV 账户（首次会提示，按引导开通，免费 1GB 额度足够）。
3. **「创建命名空间」(Create namespace)**，名字随便（如 `onedrive`）。
4. 进入你的 **Pages 项目** → **「设置」(Settings)** → 找到 **KV 绑定 / KV bindings**（在「函数」或「绑定」相关区域）。
5. 把刚建的命名空间绑定进来，**绑定时的「变量名 / Variable name」必须填 `my_kv`**（代码里写死是这个名字，写错函数就读不到 KV）。
6. 保存。

---

## 4. 第三步：配置环境变量

1. 进入 Pages 项目 → **「设置」(Settings)** → **「环境变量」(Environment variables)**。
2. 添加以下变量（**变量名必须完全一致，区分大小写**）：

| 变量名 | 必填 | 值 |
|---|---|---|
| `OD_CLIENT_ID` | ✅ | 第 2 步第 7 条复制的客户端 ID |
| `OD_CLIENT_SECRET` | ✅ | 第 2.1 步复制的客户端密码「值」 |
| `OD_TENANT` | 选填 | 默认 `common`。若 E5 授权总报租户错误，改成你的租户 ID（Entra 中心 → 概览 → 租户 ID） |
| `OD_ROOT` | 选填 | 默认 `/Public`。要展示别的文件夹就改，注意**开头要有斜杠** |

3. 保存。

> 密钥只存在于控制台环境变量 + KV 里，**不进代码、不进 GitHub 公开仓库**，比写死安全。

---

## 5. 第四步：部署

把本地改动推到 GitHub（EdgeOne 监听仓库，会自动重新构建部署）：

```bash
cd "C:\Users\青冥\WorkBuddy\2026-07-13-01-57-05\blog-homepage"
git add -A
git commit -m "更新资源站"
git push
```

部署完成后，记下你的 **EdgeOne 域名**（如 `https://blog.example.com`）。
若第 2 步的重定向 URI 用的是占位域名，**现在回到 Azure 应用把它改成真实域名** `https://<你的域名>/api/onedrive-auth` 并保存。

---

## 6. 第五步：跑一次授权（拿 token）

1. 浏览器（用你的 OneDrive 账号登录态）打开：
   ```
   https://<你的域名>/api/onedrive-auth
   ```
2. 会自动跳到微软登录页 → 用 **OneDrive 同一账号** 登录 → 出现权限请求页点 **「接受 / Accept」**。
3. 跳回后显示 **「授权成功 🎉」**。此时 refresh_token 已存进 KV。
4. 之后**再也不需要手动授权**（除非你改 OneDrive 密码、或撤销了该应用）。

> 若 Azure 重定向 URI 没配对，页面会报错，按提示把正确的 `https://<域名>/api/onedrive-auth` 加进 Azure 应用即可。

---

## 7. 第六步：查看资源站

访问 `https://<你的域名>/resources.html`（首页「资源站」框也会跳到这里）。
往 OneDrive 的 `/Public` 文件夹丢文件 → 刷新页面即出现，**全自动同步**；进子文件夹、面包屑返回都支持；点文件在新标签走微软直链下载。

---

## 8. 防护说明

- 没登录访问 `/resources.html` 或 `/api/onedrive-list` → 被 `middleware.js` 拦到登录页。
- 直接拿 Graph 返回的 `downloadUrl` 下载不需要登录，但**直链不会出现在任何未授权页面里**，外人拿不到。
- 只暴露你放进 `/Public` 的内容，OneDrive 其余文件不外泄。

---

## 9. 常见报错自查表

| 现象 / 页面提示 | 原因 | 处理 |
|---|---|---|
| 资源站显示「尚未连接 OneDrive / 去授权」 | 还没跑第 6 步授权 | 打开 `/api/onedrive-auth` 授权一次 |
| 授权页显示「尚未配置」 | 没配 `OD_CLIENT_ID` / `OD_CLIENT_SECRET` | 回第 4 步配环境变量并重部署 |
| 资源站显示「缺少 KV 存储」 | 没绑定 KV 或变量名不是 `my_kv` | 回第 3 步绑定，变量名务必 `my_kv` |
| 授权失败：提示 `redirect_uri 不匹配` | Azure 重定向 URI 写错或少 https | 改成 `https://<域名>/api/onedrive-auth`（一字不差） |
| 授权页出现「需要管理员批准 / Need admin approval」 | E5 组织账号未授予管理员同意 | 回第 2.2 步点「代表组织授予管理员同意」（或找 IT 管理员） |
| 资源站报 `GRAPH_ERROR` 权限类 | 应用缺 `Files.Read.All` 或管理员未同意 | 回第 2.2 步补权限 / 授予同意 |
| 列表为空但文件夹有文件 | 文件夹不是 `/Public` 或 `OD_ROOT` 写错 | 核对 `OD_ROOT`，确认文件确实在对应文件夹根层 |
| 授权后访问仍提示未授权 | KV 没绑 / 项目没重部署生效 | 确认 KV 绑定 + 重新部署一次 |

---

## 10. 不想用 OneDrive 了 / 换账号怎么办

- **换账号**：用新账号打开 `/api/onedrive-auth` 重新授权一次，新 token 覆盖旧 token。
- **撤销授权**：Azure 应用注册页 → 「证书和密码」删掉密码，或在 OneDrive/微软账户里撤销该应用；资源站随即回到「尚未连接」状态。
- **彻底下线资源站**：把 `resources.html` 入口从首页去掉，或删除 `functions/api/onedrive-*` 两个文件后重新部署。

---

## 11. 和 FODI 方案对比（为什么选这个）

| | FODI | 本方案（EdgeOne 自建） |
|---|---|---|
| 云服务商 | Cloudflare + 微软 +（可选）EdgeOne | **只有 EdgeOne + 微软** |
| 需注册 | Cloudflare 账号 + Azure 应用 | 只需 Azure 应用 |
| 额外组件 | Workers + KV + wrangler + Cron 续期 | EdgeOne 自带 KV，无 Cron |
| 前端风格 | FODI 自带 UI（要改代码才像你站） | **直接用你主站玻璃风格** |
| 登录鉴权 | 要额外做 | **复用你现有的边缘登录门** |
| 适合 | 想完全独立托管 | 想和现网站融为一体 ✅ |
