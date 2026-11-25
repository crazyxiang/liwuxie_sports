# 致敬曼巴 · 打卡计数接入说明

按钮已经写到科比页（`#kobe-tribute`），数据不需要自己买数据库。用 Cloudflare Worker + KV 存：

- `total`：总致敬人数；
- `d:<匿名哈希>`：每台设备一条，用来防重复；
- `recent`：最近 50 条，给后台上次记录用。

不收集姓名、手机号、IP；设备只存匿名哈希。同一台设备（同一个 App 安装）只算一次。

## 一、本地先跑通（不需要登录 Cloudflare）

```powershell
cd F:\code\qianduan\liwuxie_app
node server/dev-server.mjs
```

打开 `http://127.0.0.1:8787/#/kobe`，按钮在数据条下面。

本地数据落在（已 gitignore）：

```text
F:\code\qianduan\liwuxie_app\.cache\tribute.json
```

本地后台：`http://127.0.0.1:8787/tribute-admin.html`。本地没设置口令时直接点「进入后台」。

## 二、上线计数（Cloudflare，免费额度够用）

在项目根目录执行：

```powershell
npx wrangler login
npx wrangler kv namespace create TRIBUTE
```

把返回的 `id` 填进 `wrangler.toml`，并取消这两行的注释：

```toml
[[kv_namespaces]]
binding = "TRIBUTE"
id = "你的 KV 命名空间 id"
```

设置后台口令（自己定一个长随机串，不要写进代码或 GitHub）：

```powershell
npx wrangler secret put ADMIN_TOKEN
```

部署：

```powershell
npx wrangler deploy
```

假设部署后域名是 `https://liwuxie-sports.xxx.workers.dev`，接口就是：

```text
https://liwuxie-sports.xxx.workers.dev/api/tribute
```

后台页面：

```text
https://liwuxie-sports.xxx.workers.dev/tribute-admin.html
```

## 三、把接口地址接到页面

改 `app/web/assets/data/kobe.json`：

```json
"tribute": {
  "enabled": true,
  "api": "https://liwuxie-sports.xxx.workers.dev/api/tribute",
  "title": "致敬曼巴",
  "desc": "点亮一盏灯，把想说的话留在斯台普斯。",
  "note": "按一下，点亮属于你的一盏灯"
}
```

把 `version` +1、更新 `updatedAt`，提交并 push 到 `main`。

- 网页和 APK 下一次请求 `/api/kobe` 时会自动拿到新地址，**不用重新装 APK**；
- 如果页面和 Worker 同域部署（例如都在同一个 Worker 静态站），`api` 也可以留空，直接用同源的 `/api/tribute`；
- 地址填错/Worker 没开时，按钮会退化为「本机记录」，联网后下次打开会自动补传，不会把页面弄坏。

## 四、后台能看什么

`/tribute-admin.html` 输入 `ADMIN_TOKEN` 后显示：

- 累计致敬人数；
- 最近打卡时间；
- 每条记录的序号和 8 位设备标记。

也可以直接请求：

```powershell
curl "https://liwuxie-sports.xxx.workers.dev/api/tribute/stats" -H "X-Admin-Token: 你的口令"
```

## 五、接口

```text
GET  /api/tribute?device=<设备ID>       查人数、自己是否已致敬
POST /api/tribute  {"deviceId":"..."}    打卡；已打卡不会重复计数
GET  /api/tribute/stats                  后台统计（需要 X-Admin-Token）
```

## 六、注意

- `wrangler.toml` 里 KV 的 `id` 必须来自你自己的 Cloudflare 账号，不要抄别人的；
- `ADMIN_TOKEN` 只放 `wrangler secret`，不要提交到 GitHub；
- `笔记.txt` 里曾经有 Cloudflare Token，已在 `.gitignore`，不要把 Token 写进源码/文档/JSON；
- KV 是最终一致计数，量很大时并发打卡可能少记 1～2 个；这个场景够用，真要做到严格原子计数再换 Durable Object / D1。
