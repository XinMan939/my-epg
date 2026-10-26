# my-epg

自建中文 EPG（电子节目单）。抓取央视 / 卫视 / 地方台 / 港澳台节目表，输出标准 **XMLTV** 格式，由 GitHub Actions 定时更新并发布到 GitHub Pages。

## 订阅地址

仓库：`https://github.com/XinMan939/my-epg`

| 用途 | 地址 |
|---|---|
| 播放器订阅（推荐，体积小） | `https://xinman939.github.io/my-epg/epg.xml.gz` |
| 未压缩版 | `https://xinman939.github.io/my-epg/epg.xml` |
| 频道清单（对接 M3U 用） | `https://xinman939.github.io/my-epg/channels.json` |
| 构建报告 | `https://xinman939.github.io/my-epg/report.json` |

> Pages 需先在仓库 Settings → Pages 里把 Source 设为 `gh-pages` 分支，首次 Actions 跑完后生效。

大多数播放器（DIYP、TVBox、Kodi、Emby、Jellyfin、TiviMate）直接填 gz 地址即可，它们会自动解压。

## 当前覆盖情况（2026-10-26 实测）

| 分组 | 有节目/总数 |
|---|---|
| 央视 | 22 / 22 |
| 卫视 | 41 / 42 |
| 地方台 | 10 / 13 |
| 中国香港 | 14 / 16 |
| 中国澳门 | 0 / 3 |
| 中国台湾 | 17 / 18 |
| **合计** | **104 / 114** |

共 20965 条节目，覆盖 7 天（今天起）。输出 `epg.xml` 4.6 MB / `epg.xml.gz` 391 KB。

## 频道 id 规范

`channels/channels.json` 里的 `id` 采用 [iptv-org](https://github.com/iptv-org/iptv) 的 tvg-id 命名规范 —— `频道名.国家码`，例如 `CCTV1.cn`、`HunanTV.cn`、`Jade.hk`、`TTV.tw`。

**这样做的意义**：你 M3U 播放列表里的 `tvg-id` 如果也用同一套规范，播放器就能自动把节目单挂到频道上，不需要任何手工映射。

## 目录结构

```
epg/
├── channels/
│   ├── channels.json      ← 你要哪些台（唯一需要手工维护的文件）
│   ├── overrides.json     ← 自动匹配失败时手工指定（兜底）
│   ├── catalog.json       ← 自动生成：所有源里的频道清单
│   └── match-cache.json   ← 自动生成：本次匹配结果
├── src/
│   ├── index.mjs          ← 主入口
│   ├── config.mjs         ← 配置与路径
│   ├── utils.mjs          ← 抓取 / 时间 / 转义工具
│   ├── match.mjs          ← 频道匹配（核心）
│   ├── normalize.mjs      ← 节目清洗 / 补 stop / 去重
│   ├── output.mjs         ← XMLTV 生成
│   └── sources/
│       ├── epgpw.mjs      ← 主源
│       ├── tvmao.mjs      ← 补充源
│       └── tvsou.mjs      ← 兜底源
├── output/
│   ├── epg.xml
│   ├── epg.xml.gz
│   └── report.json
└── .github/workflows/update.yml
```

## 本地运行

```bash
node src/index.mjs catalog   # 扫描所有源的频道，导出 channels/catalog.json
node src/index.mjs check     # 只检查匹配命中率，不抓节目
node src/index.mjs build     # 抓节目并输出 output/epg.xml + epg.xml.gz
```

环境变量：

| 变量 | 说明 | 默认 |
|---|---|---|
| `DAYS` | 覆盖天数（含今天） | `7` |
| `ONLY` | 只处理指定频道，逗号分隔 tvg-id（调试用） | 全部 |
| `CONCURRENCY` | 并发数 | `6` |

调试单个频道：

```bash
ONLY=CCTV1.cn,Jade.hk node src/index.mjs build
```

## 怎么加频道

1. 打开 `channels/channels.json`，在 `channels` 数组里加一条：

```json
{ "id": "HunanTV.cn", "name": "湖南卫视", "group": "satellite", "aliases": ["湖南卫视", "湖南卫视高清"] }
```

2. 跑 `node src/index.mjs check` 看能不能匹配上。
3. 匹配不上就查 `channels/catalog.json`，找到源里的真实频道名，把 id 和源 id 写进 `channels/overrides.json`：

```json
{
  "HunanTV.cn": { "source": "epgpw", "sourceId": "545960" }
}
```

`overrides.json` 优先级最高，会覆盖任何自动匹配结果。

## 数据源

| 源 | 覆盖 | 特点 |
|---|---|---|
| **epg.pw** | 大陆 + 港澳台 | 主源。标准 XMLTV，start/stop 齐全，港澳台覆盖是免费源里最好的 |
| **电视猫**（m.tvmao.com） | 大陆 | 补充源。带真实结束时间，但需按天逐日抓 |
| **搜视网**（tvsou.com） | 大陆 | 兜底源。频道多但只有开始时间，港澳台全空 |

优先级：`epgpw → tvmao → tvsou`。主源返回 0 条节目时，会自动按 `alternatives` 列表降级到同名的其它源频道（日志里会打 `[fallback]`）。

### 三个必须知道的坑

**1. epg.pw 的时区标注是错的。**
它的 `start` / `stop` 全部标 `+0000`，但时间数字实际已经是当地时间（UTC+8）。判断依据（CCTV-1 综合）：06:00 朝闻天下 / 12:00 新闻30分 / 19:00 新闻联播 / 22:00 晚间新闻，四个锚点全部命中北京时间。港澳台同理（明珠台 09:30 交易直播室对港股开盘，台视 07:00 早安您好台视新闻）。代码里已强制按 `+0800` 解读（`epgpw.mjs` 的 `parseTimeCST`），**不要改回去**，否则整体偏 8 小时。

**2. epg.pw 同一频道名有多个 id，数据完整度差异巨大。**
比如「湖南卫视」在源里有 3 个 id：`539731` 只有当天 1 天 34 条、`545960` 有满 7 天 236 条、`572162` 也有 7 天 229 条。匹配器如果按名字长度挑，会挑到 1 天那个，卫视节目表就只剩今天。

代码里的处理：`epgpw.listChannels()` 会把每个 id 的 `days`（覆盖天数）和 `count`（节目条数）带出来，`match.pickBest()` 优先选天数多的。**这条逻辑不能删**，删了卫视会大面积退化。

**3. epg.pw 有大量「注册了但零节目」的空壳频道。**
如三沙卫视 `539632`/`410381`、浙江民生休闲 `539891`，名字能匹配上但一条节目都没有。这就是 `alternatives` + `[fallback]` 机制存在的原因，不要简化掉。

### 下载的两个坑（`utils.mjs`）

**超时计时器必须覆盖到 body 读完。** 早期实现在 `fetch()` 拿到响应头后就 `clearTimeout`，而 epg.pw 响应头秒回、body 龟速，导致 `arrayBuffer()` 永久卡死（实测挂 14 分钟）。现在计时器一直保留到 `arrayBuffer()` 返回。

**Node 的 fetch 不读 `https_proxy` 环境变量。** 国内网络下直连 epg.pw 会卡死，所以 `fetchBuffer()` 做了三级降级：fetch 快速超时（90s）→ curl 子进程（能读代理环境变量）→ 报错交给调用方用旧缓存。GitHub Actions 在海外直连很快，走的是第一级。

## 自动更新

`.github/workflows/update.yml`：每 6 小时跑一次（UTC `0/6/12/18` 点，即北京时间 02/08/14/20 点），也支持在 Actions 页面手动触发（可指定天数、可只跑部分频道）。

构建后会校验产物完整性（XML 头、`</tv>` 闭合、节目条数），失败会直接标红，不会把坏文件发到 Pages。

## 已知限制

### 10 个频道当前拿不到节目

| 频道 | 原因 |
|---|---|
| `HunanCityChannel.cn`（湖南都市） | 三个源里都没有这个频道 |
| `HunanPublicChannel.cn`（湖南公共） | 三个源里都没有 |
| `JiangsuPublicNewsChannel.cn`（江苏公共新闻） | 三个源里都没有 |
| `HOYTV.hk`（HOY 台） | 三个源里完全没有（前奇妙电视） |
| `CTiNews.tw`（中天新闻台） | epgpw 只有中天綜合/娛樂/亞洲台，没有新闻台 |
| `ZhejiangInternationalChannel.cn`（浙江国际） | epgpw 539842 是空壳（注册了但零节目），别处也没有 |
| `PhoenixHongKongChannel.hk`（凤凰卫视香港台） | tvsou 有空表；epgpw 的 410378 是中文台（已被 `PhoenixChineseChannel.hk` 占用），不能混用 |
| `MacauTV.hk`（澳门电视台） | tvsou 空表，epgpw 无澳门频道 |
| `MacauLotus.hk`（澳门莲花） | 同上 |
| `AsiaSatelliteTV.hk`（澳亚卫视） | 同上 |

**澳门 3 个台全部无源**，这是当前最大的覆盖缺口。

### 其他

- **部分地方台只有 1 天**：epg.pw 的地方台多数只给当天数据，这是源的限制。央视和卫视是 7 天完整的。
- **tvmao 补的频道天数取决于该频道自身**：如三沙卫视在 tvmao 只填了 3 天（w1~w3 有数据，w4 之后空），而湖南卫视 w1/w4/w6/w8 都有。这是上游编辑的进度问题，不是抓取失败。
- **节目简介较少**：20965 条里只有 4634 条带 `desc`（22%），主要是香港频道有简介。epg.pw 的大陆节目基本只有标题。XMLTV 允许 desc 为空，播放器只是不显示简介。
- **`category` 为空**：三个源都不提供节目分类，所以输出里没有 `<category>`。播放器会显示为未分类。
- **台标只有 21 个频道有**：多数源频道不带 icon。

## 排查方法

build 失败或某频道没节目时，按这个顺序查：

```bash
# 1. 看匹配命中情况（不抓节目，快）
node src/index.mjs check

# 2. 看某个源里到底有哪些频道
node -e "const c=require('./channels/catalog.json');console.log(c.items.filter(x=>x.name.includes('湖南')))"

# 3. 只跑一个频道，看详细过程（含备选降级日志）
ONLY=HunanTV.cn node src/index.mjs build
```

`output/report.json` 里有每个频道实际使用的源（`detail[].source`）和降级记录（`fallbacks`），可以直接定位是哪个环节出的问题。
