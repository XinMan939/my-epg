# 两个项目能不能合并？——结论与方案

> 2026-10-27 评估。对比对象：
> - **my-epg**（本项目）：Node.js，抓 EPG → 输出 XMLTV
> - **iptv-api**（yt-dlp 系生态里的直播源聚合器，`.probe/iptvapi`）：Python，聚合 M3U → 测速 → 输出直播源
> - **iptv-tool**（taksssss，PHP + Docker）：EPG 管理 + 直播源管理 + 台标管理

## 一句话结论

**技术上能合，但不要合成一个仓库。** 建议合成一个**仓库、两个独立产物**（monorepo），共享 `channels.json` 这一个真源；而不是把两套抓取逻辑焊在一起。

理由在下面「为什么不焊在一起」一节。先给可执行方案。

> **2026-10-27 补充：id 改写版已经实现了，不用改 iptv-api 的配置。**
> `node src/index.mjs m3u <你的m3u>` + `build` 会额外产出 `output/epg-m3u.xml`，
> 其中 `<channel id>` 直接就是 iptv-api 输出的 `tvg-id`（`CCTV1`、`TVB翡翠`…）。
> 播放器「EPG 填 epg-m3u.xml.gz、直播源填 result.m3u」即可，实测覆盖 256/318（80.5%）。
> 细节见 [`m3u-coverage.md`](m3u-coverage.md)。

---

## 一、三个项目到底各做什么

| | my-epg（本项目） | iptv-api | iptv-tool |
|---|---|---|---|
| 语言 | Node.js ESM | Python | PHP |
| 运行方式 | GitHub Actions（无状态） | Docker 常驻 | Docker 常驻 |
| 核心产物 | `epg.xml` / `epg.xml.gz` | `result.m3u` / `result.txt` | DIYP/百川 JSON、超级直播、xmltv |
| 输入 | XMLTV 源（epg.pw、51zmt、tvmao） | M3U/TXT 直播源 | 两者都能吃 |
| 频道主键 | `tvg-id`（如 `CCTV1.cn`） | 频道名（中文归一化） | 频道名（中文归一化） |
| 简介能力 | ★ 强（多源补全 + 占位过滤 + 跨源标题对齐） | 弱（`parse_epg` 只取 `<title>`，desc/category/icon 全丢） | 中（百度/CNTV，无 desc） |
| 直播源能力 | 无 | ★ 强（聚合、测速、排序、分组） | ★ 强（聚合、测速、代理、台标） |

**关键差异**：my-epg 的 EPG 质量比 iptv-api 高一个量级，而 iptv-api 的直播源能力是 my-epg 完全没有的。两者是**互补**，不是重叠。

### iptv-api 的 EPG 到底差在哪（实测代码）

`updates/epg/request.py` 的 `parse_epg()`：

```python
channel_text = opencc_t2s.convert(programme.find('title').text)
channel_elem_s = ET.SubElement(channel_elem, 'title', attrib={"lang": "zh"})
channel_elem_s.text = channel_text
```

三个硬伤：
1. **只保留 `<title>`** —— `<desc>`、`<category>`、`<icon>`、`<episode-num>` 全部丢弃。所以 iptv-api 输出的 EPG 永远没有简介。
2. **拿 `channel_id` 当 `display-name`** —— `channels[channel_id] = display_name` 之后匹配走的是 `format_channel_name()`，纯精确名匹配，没有别名、没有包含匹配。
3. **`stop` 必填** —— `programme.get('stop')` 直接 `strptime`，源里没有 `stop` 就抛异常整批失败。

这三点在本项目里都已解决（见 `src/aggregator.mjs` 顶部注释）。

---

## 二、推荐方案：monorepo，共享频道主键

```
repo/
├── channels.json              ← ★ 唯一真源（tvg-id + 名字 + 别名 + 台标）
├── epg/                       ← 本项目（Node），读 channels.json 产出 epg.xml.gz
│   ├── src/
│   └── output/
├── live/                      ← 直播源侧（沿用 iptv-api 或 iptv-tool）
│   └── ...
├── web/                       ← 看板，同时展示 EPG 覆盖 + 直播源可用性
└── .github/workflows/
    ├── epg.yml                ← 每 6 小时跑 EPG
    └── live.yml               ← 每 6 小时跑直播源测速
```

### 合并点只有一个：`channels.json`

这是整件事的关键。两个项目原本各自维护一份频道清单，合并后**只留一份**：

```json
{
  "id": "CCTV1.cn",
  "name": "CCTV-1 综合",
  "group": "cctv",
  "aliases": ["CCTV-1", "CCTV1", "CCTV-1综合"],
  "logo": "https://...",
  "live": {
    "keywords": ["CCTV1", "CCTV-1", "CCTV1综合"],
    "exclude": ["CCTV1香港", "CCTV1澳门"]
  }
}
```

- `id` / `name` / `aliases` → EPG 侧用（已有）
- `live.keywords` / `live.exclude` → 直播源侧用（新增）

直播源抓回来后，按 `live.keywords` 匹配到 `id`，生成的 M3U 里 `tvg-id` 直接写 `CCTV1.cn`。**这样播放器就能自动把节目单和直播源对上，不用人工配。**

这是合并的**唯一真实收益**：现在两边靠频道名模糊对齐，经常对不上（`CCTV5+` vs `CCTV5`、`台視新聞` vs `台視`）；共用主键后是确定性匹配。

### 不要做的事

| 别做 | 原因 |
|---|---|
| 把 Node 和 Python 逻辑互相翻译 | 两套运行时都要维护，改一处要改两处 |
| 让 EPG 侧去测速直播源 | 职责混乱，而且 GitHub Actions 跑测速很慢、容易被限流 |
| 把 iptv-api 整个搬进本项目 | 它是 Docker 常驻服务（有 Web 面板、定时任务、SQLite），和 Actions 无状态模型冲突 |
| 用 iptv-tool 替掉本项目 | 它用 PHP + opencc，EPG 简介能力不如我们（无占位过滤、无跨源标题交集对齐） |

---

## 三、如果要「一个产物」怎么办

如果你的真实诉求是**播放器里只填一个地址**，那不需要合并代码，只需要让直播源的 M3U 里带对 `tvg-id`：

```
#EXTINF:-1 tvg-id="CCTV1.cn" tvg-name="CCTV-1 综合" group-title="央视",CCTV-1 综合
http://example.com/cctv1.m3u8
```

`tvg-id` 写成本项目 `channels.json` 里的 `id`，播放器（DIYP / TVBox / TiviMate）就会自动去 `epg.xml.gz` 里找对应节目单。**这是标准做法，两个项目天然可以配合，不需要合并。**

---

## 四、结论

| 诉求 | 建议 |
|---|---|
| 播放器一个地址搞定 | 不用合并。让 M3U 的 `tvg-id` 对齐 `channels.json` 的 `id` |
| 频道清单不想维护两份 | 合并成 monorepo，`channels.json` 做唯一真源 |
| 想要一个 Web 面板同时管 EPG 和直播源 | 用 **iptv-tool**（它已经做完了），把本项目的 `epg.xml.gz` 挂上去当上游源 |
| 想彻底替代 iptv-api | 不划算。它的直播源聚合/测速是成熟代码，重写成本远大于收益 |

**最省力的路径**：保持两个仓库独立，只做两件事——
1. 本项目输出 `channels.json`（已有，见 `output/`），供直播源侧读取；
2. 直播源侧生成的 M3U 用这份 `channels.json` 的 `id` 填 `tvg-id`。

这样「合并」在用户视角已经完成了，代码层面零风险。
