# 科比页数据说明（kobe.json）

科比页的视频片单、hero 轮播、BGM、曼巴精神组图都从这份 JSON 渲染。
App / 网页不会直接跨域拉 GitHub，而是请求 `/api/kobe`，由本机服务或站点服务代理并缓存：

- 优先读 30 分钟内的远端缓存，直接返回，不拖慢首屏；
- 远端拿不到时回落到 APK / 站点内置的这份 JSON；
- 页面加载先用缓存/内置数据，后台再更新，网络慢也不会白屏。

## 更新流程

1. 修改本文件 `app/web/assets/data/kobe.json`，建议把 `version` +1，并更新 `updatedAt`；
2. 提交并推送到 `crazyxiang/liwuxie_sports` 的 `main` 分支；
3. jsDelivr 有大约 12 小时缓存，想立刻生效可以访问一次：
   `https://purge.jsdelivr.net/gh/crazyxiang/liwuxie_sports@main/app/web/assets/data/kobe.json`
4. App 端在科比页点右上角「刷新」会强制走远端；不点也会在下次进入/启动时自动更新。
5. 纯数据更新不需要重新打包 APK；只有改页面结构/样式才需要重装。

## 字段

```json
{
  "version": 2,
  "updatedAt": "2026-11-25T00:00:00.000Z",
  "hero": {
    "interval": 5000,
    "slides": [
      {
        "type": "image",
        "src": "assets/kobe/hero.jpg",
        "title": "Kobe Bryant",
        "sub": "1978.08.23 — 2020.01.26 · 8 & 24",
        "line": "「你见过凌晨四点的洛杉矶吗？」"
      },
      {
        "type": "video",
        "src": "assets/kobe/hero/kobe-moments.mp4",
        "poster": "assets/kobe/hero/kobe-moments.jpg",
        "autoplay": true,
        "title": "Mamba Moments",
        "sub": "生涯高光 · 24 秒",
        "line": "每一帧，都是曼巴"
      }
    ]
  },
  "bgm": [
    { "name": "Because of You", "src": "assets/kobe/Because of You.mp3", "local": true },
    { "name": "在线歌曲", "src": "https://example.com/song.mp3", "local": false }
  ],
  "spirit": {
    "interval": 6000,
    "images": [
      { "src": "assets/kobe/spirit/1.jpg", "caption": "Black Mamba · 曼巴精神" }
    ]
  },
  "videoGroups": [
    {
      "tag": "最后一战 · 退役战 60 分",
      "items": [
        { "bv": "BV1Xv8v6cEHL", "title": "最后一舞：退役战 60 分全场回顾", "dur": "41:24" }
      ]
    }
  ]
}
```

### hero

- `type`: `image` 或 `video`；视频建议 mp4，静音播放，`poster` 是没播放时显示的封面。
- `autoplay`: 仅视频有效。`true` 进入这一屏自动播放并等它播完再切下一张；`false` 只显示封面，点画面/播放键才播。
- `src`: 相对路径（打包在 APK 里）或 https 绝对地址。
- `title/sub/line`: 覆盖 hero 上的标题、副标题、金句；留空则不显示对应文字。
- `interval`: 图片自动切换毫秒数，最少 2500；视频播放时按视频时长走。
- 手机/桌面都支持按住画面左右拖动切换；桌面鼠标、触屏都生效。
- 内置的 `assets/kobe/hero/kobe-moments.mp4` 是 24 秒高光剪辑（素材来自 B 站 BV1ZVLQ6JE72，仅作球迷站展示）；想换素材，直接覆盖同名文件或在 JSON 里改 `src`。

### bgm

- 前 3 首保持 `local: true`，走 APK 内置 mp3，加载最快。
- 新增在线歌曲填 `local: false`，`src` 必须是**可直接播放的音频直链**（mp3 / m4a），不能是网易云/QQ 音乐的网页地址。

### spirit

- `images` 是曼巴精神组图，自动轮播，支持左右拖动/滑动切换；点击/按 OK 放大后，仍可左右切换、点两侧箭头切图。
- 建议 4:3、宽度 1400px 左右，单张控制在 300KB 内。

### videoGroups / items

- `bv`: B 站 BV 号（当前播放链路只解析 B 站，视频由本机 `/api/bili/video` 转发）。
- `title`: 卡片标题；`dur`: 时长角标，可留空。
- 封面优先读 `app/web/assets/kobe/covers/<BV>.jpg`；没有就自动走 `/api/bili/cover?bv=`。
- 想下线某个视频，直接删掉对应 item；想加新分类，新增一个 `{tag, items}` 对象即可。

## 关于非 B 站片源

现在片库按 BV 号走 B 站转发，其他站点不能直接填 BV。
如果要接 YouTube / 腾讯 / 直链 mp4，需要给播放页加新的 `url` 字段与解析器；m3u8 还要额外走 HLS 代理。
数据格式可以先预留 `url`，但播放链路要改代码，不能只改 JSON。
