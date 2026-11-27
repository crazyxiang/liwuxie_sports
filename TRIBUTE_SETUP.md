# 致敬曼巴 · 数据与后台说明

当前版本：整块可点、支持遥控器焦点、记录 IP / 归属地 / UA，展示基数 10000，后台 `/admin.html` 打开即读。

## 一、数据存在哪

代码里做了一层存储适配，按优先级自动选：

| 优先级 | 触发条件 | 存在哪 | 多端是否统一 |
|---|---|---|---|
| 1 | 绑定了 `TRIBUTE`（KV） | Cloudflare KV | 是 |
| 2 | 配了 `GITHUB_TOKEN` + `GITHUB_REPO` | 仓库里的 `tribute.json` | 是 |
| 3 | 都没配 | 项目根目录 `tribute.json` | 否，只对本机有效 |

> 本地文件**不放 `.cache/`**，那个目录可能被清空。根目录的 `tribute.json` 已加入 `.gitignore`，本地测试数据不会进仓库。

数据结构：

```json
{
  "devices": {
    "<sha256(deviceId) 前 32 位>": {
      "at": "2026-11-27T13:12:51.226Z",
      "rank": 1,
      "ip": "1.2.3.4",
      "loc": "中国 · 湖南 · 长沙",
      "ua": "Mozilla/5.0 ...",
      "ref": "https://你的域名/#/kobe"
    }
  },
  "updatedAt": "2026-11-27T13:12:51.226Z"
}
```

- 计数 = `TRIBUTE_BASE`（默认 10000）+ `devices` 条数。
- 防重复：同一 `deviceId` 的哈希只记一次；换浏览器 / 清缓存算新设备。

## 二、本地开发

```powershell
cd F:\code\qianduan\liwuxie_app
node server/dev-server.mjs          # 或 npm run dev
```

- 首页：<http://127.0.0.1:8787/#/kobe>
- 后台：<http://127.0.0.1:8787/admin.html>（打开即读，没设口令不弹框）
- 数据文件：`F:\code\qianduan\liwuxie_app\tribute.json`

## 三、线上（Trae / 任意 FaaS）统一数据

FaaS 的本地磁盘是临时的，重启即丢，所以线上必须用第 1 或第 2 种存储。

### 用 GitHub 当数据库（推荐，无需信用卡）

1. 建一个仓库（私有即可），初始化 README。
2. 生成 PAT：fine-grained token，只授权该仓库的 **Contents: Read and write**。
3. 在 Trae 项目里加环境变量：

```text
GITHUB_REPO    = 账号/仓库名
GITHUB_TOKEN   = github_pat_xxx
GITHUB_PATH    = tribute.json      # 可省略，默认这个
GITHUB_BRANCH  = main              # 可省略
TRIBUTE_BASE   = 10000             # 可省略
ADMIN_TOKEN    = 你的后台口令       # 建议设置，否则 /admin.html 公开可见 IP
```

4. 重新部署，打卡后仓库里会自动出现 `tribute.json`，电脑 / 电视读的是同一份。

### 用 Cloudflare KV（已有 Worker 时）

```powershell
npx wrangler kv namespace create TRIBUTE
```

把返回的 id 写进 `wrangler.toml` 的 `[[kv_namespaces]]`，再 `npx wrangler deploy`。

## 四、后台

- 地址：`/admin.html`（`/admin/`、`/tribute-admin.html` 都会跳过来）
- 入口：首页顶栏**连按两下「李无邪」**，电视遥控器连按两次 OK 同样有效
- 展示：累计人数（含基数）、真实打卡数、最近 50 条（序号 / 时间 / 地区 / IP / 设备 / 浏览器 / 标记）
- UA 只显示设备与浏览器标签，完整原文挂在 `UA` 角标上
- 口令：设置 `ADMIN_TOKEN` 后页面会自动弹框；可带 `?token=xxx` 直接进
- 刷新：打开即读，之后每 15 秒自动刷新

## 五、清数据

- 本地：把 `tribute.json` 改成 `{"devices":{},"updatedAt":""}`
- GitHub：直接改仓库里那份文件，或删掉让它自动重建
- KV：控制台删 `total` / `d:*` / `recent` 键
