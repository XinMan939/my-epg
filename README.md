# my-epg

自建中文 EPG（电子节目单）。抓取央视 / 卫视 / 地方台 / 港澳台节目表，输出标准 **XMLTV** 格式，由 GitHub Actions 定时更新并发布到 GitHub Pages。

## 订阅地址

仓库：`https://github.com/XinMan939/my-epg`

| 用途 | 地址 |
|---|---|
| **频道看板（直观检查）** | `https://xinman939.github.io/my-epg/` |
| 播放器订阅（推荐，体积小） | `https://xinman939.github.io/my-epg/epg.xml.gz` |
| **直播源对接版（自己的 m3u 用这个）** | `https://xinman939.github.io/my-epg/epg-m3u.xml.gz` |
| 未压缩版 | `https://xinman939.github.io/my-epg/epg.xml` |
| 频道清单（对接 M3U 用） | `https://xinman939.github.io/my-epg/channels.json` |
| 构建报告（看板的数据源） | `https://xinman939.github.io/my-epg/report.json` |

> Pages 已配好（Source = `gh-pages` 分支），Actions 每 6 小时自动更新并部署，无需手工操作。

**产物直接存仓库里（`output` 分支）**

除了 Pages，每次跑完还会把产物推到独立的 `output` 分支，可以直接当文件夹用：

```bash
# 只拉产物，不拉代码
git clone --depth 1 -b output https://github.com/XinMan939/my-epg.git my-epg-output
# → my-epg-output/epg-m3u.xml.gz  epg.xml.gz  channels.json  report.json
```

或者放进自己项目的子目录，每次 `git pull` 就是最新一份（自动覆盖）：

```bash
cd 你的项目
git remote add epg https://github.com/XinMan939/my-epg.git   # 只需加一次
git fetch epg output
git checkout epg/output -- .    # 产物落到当前目录，旧的自动覆盖
```

> **为什么不提交到 main**：`epg-m3u.xml.gz` 是 1.6MB 二进制，每 6 小时全量重写，git 无法增量压缩。
> 提交到 main 一年累积约 5.4GB 历史，clone 会越来越慢。`output` 分支每次 `force_orphan` 重建，
> **永远只有最新一份，仓库体积恒定**。
>
> 分支里只放 `epg.xml.gz` / `epg-m3u.xml.gz` / `channels.json` / `report.json` 四个文件，
> 不放 19MB 的未压缩 `epg.xml`（需要就用 Pages 地址）。

**怎么用（两种场景）**

- 你用的是**别人的/通用的** m3u 直播源 → 填 `epg.xml.gz`
- 你用的是**自己抓的** m3u（tvg-id 是裸名 `CCTV1` / `浙江卫视`）→ 填 `epg-m3u.xml.gz`，
  它已经把 channel id 改写成你 m3u 的写法。详见 [`docs/m3u-coverage.md`](docs/m3u-coverage.md)。

大多数播放器（DIYP、TVBox、Kodi、Emby、Jellyfin、TiviMate）直接填 gz 地址即可，它们会自动解压。

## 频道看板

首页是一个纯静态看板（`web/index.html` + 同目录 `report.json`），用来回答四个问题：

1. **现在有多少频道** —— 顶部概览卡片，按分组显示总数 / 有节目数 / 完整数 / 缺天数 / 完全无数据。
2. **哪些在有效更新、哪些找不到** —— 每行有状态标签（完整 / 不全 / 无数据）和 7 天每日柱状图，红色柱子表示那天是 0 条。
3. **频道命名规则** —— 第二列直接显示 `tvg-id` 和别名，一眼看出这个台的 id 是怎么定的。
4. **匹配的节目单对不对** —— 「匹配依据」列显示是精确 / 别名 / 包含匹配，后面跟源里那个频道的真实名字。两者差得远就是配错了，点「备选」能看到同名的其它候选源。

页面顶部有一个筛选开关「只看需核查」，会把「包含匹配」和「节目不全」的行挑出来，建议每次更新后过一眼。

## 当前覆盖情况（2026-10-27 实测）

| 分组 | 有节目/总数 |
|---|---|
| 央视 | 42 / 43 |
| 卫视 | 40 / 43 |
| 数字付费 | 23 / 26 |
| 地方台 | 17 / 23 |
| 中国香港 | 26 / 28 |
| 中国澳门 | 0 / 3 |
| 中国台湾 | 118 / 119 |
| **合计** | **275 / 284** |

共 **44731 条节目**，覆盖 7 天（今天起）。输出 `epg.xml` 20.4 MB / `epg.xml.gz` 1.7 MB。

> 频道清单在 2026-10-27 从 114 扩到 284，原因是「能对上直播源」比「只收精品台」更有用 ——
> 实测自己的 `result.m3u` 有 318 个 tvg-id，114 个频道只能覆盖 30%，扩到 284 后覆盖 82.7%。
> 代价是新频道里有一批源方只给 1~2 天，甚至只有频道壳没有节目（**9 个空频道**，见下）。
> 详见 [`docs/m3u-coverage.md`](docs/m3u-coverage.md)。

### 节目简介：真实覆盖 62.3%（27910 / 44796）

> ⚠️ **口径说明**：这里统计的是「**真实简介**」——要求去掉空白后 ≥12 字，且不是「暂无节目描述」「此阶段播放精彩电视剧内容」这类占位文本。
> 如果按「`<desc>` 非空」统计，覆盖率会虚高到 90%+，但用户看到的全是废话。看板（`report.json`）和 build 日志都用同一套 `isRealDesc()` 判定，三处口径完全一致。

| 分组 | 频道 | 节目 | 真实简介 | 覆盖率 |
|---|---|---|---|---|
| 数字付费 | 21 | 4143 | 3497 | **84%** |
| 中国香港 | 26 | 6907 | 4979 | **72%** |
| 卫视 | 40 | 7886 | 5576 | **71%** |
| 地方台 | 17 | 957 | 574 | **60%** |
| 央视 | 41 | 7958 | 4303 | **54%** |
| 中国台湾 | 118 | 16945 | 8981 | **53%** |

对比 2026-10-26 那版（18.4% 真实覆盖），**提升 44 个百分点**，主要靠接入老张的 EPG（51zmt）。
台湾从 84% 掉到 53% 是因为新收的 98 个台湾付费台（龙华/靖天/博斯/纬来系列）上游基本不给简介，拉低了均值 —— 不是抓取退化。

### 简介从哪来（三级流水线）

```
epg.pw 自带        →  港澳台有（TW 84% / HK 46%），大陆 0 条
   ↓
① 51zmt 频道级对齐  →  一次下载 2.2MB（2.5 秒），补 6125 条，覆盖 83 个频道
   ↓
② 51zmt 全局标题索引 →  跨频道同名简介，补 1927 条（自动跳过 desc 冲突的 110 个标题）
   ↓
③ 51zmt 手工标题映射 →  非中文标题逐条人工对照，补 202 条（港台35 转播 CGTN、延边卫视朝鲜语）
   ↓
④ 电视猫详情页      →  残余缺口逐条抓，补 627 条
```

**为什么这个顺序**：51zmt 是整包下载、零额外请求，先跑它能把大头吃掉；电视猫要逐频道抓 7 天节目单 + 逐条抓详情页，慢且有反爬风险，放最后只处理残余。

### 仍无简介的频道（上游确实没有，非抓取失败）

| 频道 | 节目 | 原因 |
|---|---|---|
| CCTV-8K | 1557 | 节目几乎全是「8K标识演绎」「宣传片」「中秋晚会分轨」这类垫片，51zmt/电视猫都没有对应词条 |
| 港台电视34 | 361 | 纪录片频道，节目标题带集数后缀（「重走馬可波羅之路2」），51zmt/电视猫都没有对应词条 |
| 港台电视35 | 85 | 265 条里 180 条已靠 CGTN 中英对照补上；剩余是 Global Business / The Vibe / Big Story 等 51zmt 无中文译名的栏目 |
| 港台电视31 | 227 | 港台自制节目（海鸚特攻隊 / 灣區全媒睇 / 凝聚香港），无任何源收录 |
| 港台电视32 | 224 | 同上，且 125 条是「生活．健康．資訊」循环垫播 |
| 公視 | 188 | epg.pw 与 51zmt 的「公视」条目 desc 均全空；标题带 (209)(普) 后缀，去后缀后仍无匹配 |
| 延边卫视 | 145 | 节目标题全是朝鲜语（드라마 / 일기예보 / 특집프로），51zmt 该台 8 条真实简介已全部用上 |
| CCTV-5+ | 107 | 全是赛事实况（「实况录像-2026年亚运会…」），上游无简介 |
| 浙江少儿 | 48 | 51zmt 该台 48 条 desc 全是「暂无节目描述」占位 |
| 華視新聞 | 45 | 51zmt 只有「华视」综合台，新闻台无条目 |

### 还缺节目单的 24 个频道

分两种，都很明确：

**A. 源里有频道壳但零节目（13 个）** —— epg.pw 注册了 id 却不给数据，最常见的「看着有其实没有」：

`HunanTVInternational.cn`（湖南国际）、`ZhejiangInternationalChannel.cn`（浙江国际）、`ZhejiangFilmEntertainmentChannel.cn`（浙江影视）、`CCTVHealth.cn`（CCTV-卫生健康）、`CCTVTVGuide.cn`（CCTV-电视指南）、`CGTNFrench.cn`、`CGTNDocumentary.cn`、`BRTVKakuChildrensChannel.cn`（卡酷少儿）、`求索纪录.cn`、`求索生活.cn`、`劲爆体育.cn`、`乐游.cn`、`金色学堂.cn`、`CHCHomeTheater.cn`（CHC家庭影院）、`广州新闻.cn`、`广州竞赛.cn`

**B. 四个源都没有这个频道（8 个）**：

| 频道 | 说明 |
|---|---|
| 中国澳门 3 个台（澳门电视台 / 莲花 / 澳亚卫视） | epg.pw、51zmt、电视猫、搜视网四源均无 |
| 凤凰卫视香港台 | 三源均无（注意别错配到「凤凰卫视中文台」） |
| HOY TV | 三源均无 |
| 湖南都市 / 湖南公共 | 三源均无 |
| 中天新聞（台湾） | epg.pw 只有中天綜合/娛樂/亞洲台，无新闻台 |

## 外部数据源实测记录

| 源 | 结论 | 实测数据 |
|---|---|---|
| **epg.pw** | 主源 | CN 611 频道/37812 节目/0 desc；HK 230/46653/真实 74%；TW 519/90219/真实 41% |
| **老张的 EPG（51zmt）e1** | ★ 最佳简介源 | 283 频道 / 16790 节目 / 有 desc 17239 / **真实 70.3%** / 覆盖 2 天 |
| **老张的 EPG e2** | ★ 港澳台+国际 | 223 频道 / 12926 节目 / **真实 62.3%** / 覆盖 3 天 |
| 老张的 EPG `e`（旧包） | ❌ 不接 | 100 频道 / 7374 节目 / **0 条 desc** |
| 电视猫 tvmao | 补充 | 详情页有简介，但要逐条抓；无省级地面频道 |
| 搜视网 tvsou | 兜底 | 节目表有，无简介 |
| **台湾大宽频 kbro** | ★ 港台简介主力 | 296 频道 / 251 有节目 / 213 带真简介，大量 100%；**只给 3 天**，所以只当简介源 |
| mytvsuper（香港官方） | ⏸ 暂不接 | 128 频道 / 满 7 天 / 带真简介，但对我方增益极小（能对上的 16 个里 13 个已 100%）；国际台全是「全日24小時為你送上精彩節目」占位 |
| CNTV 官方接口 | ❌ 不接 | 央视覆盖好（cctv8k 258 条），但**无 desc**；`column_url` 指向的栏目页实测 7 个里只有 1 个有「栏目介绍」正文，命中率太低 |
| 百度 EPG 接口 | ❌ 不接 | 多天数据（CCTV1 232 条）但**无 desc**，GBK 编码 |
| timetv.cn | ❌ 不接 | 164 频道含浙江/江苏地面全套，但**只有当天**、与 epg.pw 同源、无 desc |
| tv-8.com | ❌ 不可用 | 数据是模板填充的错误占位（浙江少儿在播「晋江新闻」「东营新闻联播」——福建/山东新闻） |
| erw.cc | ❌ 不可用 | http 502 / https 000；镜像包 512 频道但仅 7 条 desc |
| 浙江广电 `epg.api-app.tbit.top` | ❌ 已下线 | 阿里 DoH 返回 NXDOMAIN |

### Gitee 镜像仓 `taksssss/tv`（每 2 小时同步）

国内直连比 epg.pw 快，且 51zmt 的错误 `+0000` 时区已被作者改成 `+0800`。

```
https://gitee.com/taksssss/tv/raw/main/epg/{112114,51zmt,51zmte1,51zmte2,erw,epgpw_cn,epgpw_hk,epgpw_tw}.xml.gz
```

## 和直播源项目怎么配合

见 [`docs/merge-plan.md`](docs/merge-plan.md) 和 [`docs/m3u-coverage.md`](docs/m3u-coverage.md)。一句话：**不需要合并代码**。

有两种接法，选一种：

### 接法 A：把 m3u 的 tvg-id 改成我们的规范 id（干净，但要改直播源配置）

本项目已输出 `output/channels.json`，直播源侧（iptv-api / iptv-tool / 手写 M3U）读它，把 `tvg-id` 填成同样的 id，播放器就能自动挂上节目单：

```
#EXTINF:-1 tvg-id="CCTV1.cn" tvg-name="CCTV-1 综合" group-title="央视",CCTV-1 综合
```

这比按中文名模糊匹配可靠得多——实测名字匹配会串台（`CCTV5+` 吸到 `CCTV5`、`台視新聞` 吸到 `台視`）。

### 接法 B：不动 m3u，改用 EPG 侧的 id 改写版（省事，推荐）

自己的 m3u 几乎是裸名 id（`tvg-id="CCTV1"`、`tvg-id="浙江卫视"`），跟我们的 `CCTV1.cn` 一个都对不上。这时跑一次对齐，生成一份 **channel id 已改写成 m3u 侧写法** 的 EPG：

```bash
node src/index.mjs m3u https://raw.githubusercontent.com/XinMan939/iptv-api/master/output/result.m3u
node src/index.mjs build
```

产物：

- `channels/m3u-map.json` —— 映射表（建议入库，CI 直接复用）
- `output/epg-m3u.xml` / `.gz` —— 对接版 EPG，`<channel id>` 就是你的 `tvg-id`

播放器里 **EPG 填 `epg-m3u.xml.gz`、直播源填你的 m3u** 即可，两边都不用改。

**匹配规则是五级保守匹配**（宁可漏不可串台）：手工映射 → id 完全相等 → 去国家后缀 → 名字唯一 → 宽松归一化（繁→简 + 去 `TVB`/`CCTV` 前缀 + 去「卫视/电视/频道/台」，且**两侧都唯一**才认）。名字撞车一律跳过留给人工。

**实测**（`iptv-api` 的 `result.m3u`，4376 条 / 318 个 tvg-id）：

| | 频道扩充前（114） | 扩充后（282） |
|---|---|---|
| 我们的频道能对上 | 95（83%） | **263** |
| 反向覆盖它的 318 个 tvg-id | 95（29.9%） | **263（82.7%）** |

一开始只有 30%，看着像「名字对不上」，其实是**频道清单不匹配**：它的 318 个里有台湾 125、数字付费 35、咪咕赛事 17、广东地方 11，我们一个都没有。所以除了做 id 改写，还把频道清单按它的缺口扩了一轮（114 → 282），覆盖才到 82.7%。

剩下 55 个挂不上的、以及每个缺口的确切原因，见 [`docs/m3u-coverage.md`](docs/m3u-coverage.md)。

> ⚠️ **判断「上游有没有」不能只跑一次名字匹配。** 第一版把 7 个台判成「上游没有」，全错 ——
> `AsianFood` 在 epg.pw 叫 `亞洲美食頻道`、`阿里郎` 叫 `韓國阿里郎`、`农林卫视` 叫 `陕西农林卫视`，
> 名字差得远，自动匹配永远命中不了，但数据一直都在。正确做法是把上游有节目的频道**全列出来人工扫一遍**。


## 频道 id 规范

`channels/channels.json` 里的 `id` 采用 [iptv-org](https://github.com/iptv-org/iptv) 的 tvg-id 命名规范 —— `频道名.国家码`，例如 `CCTV1.cn`、`HunanTV.cn`、`Jade.hk`、`TTV.tw`。

**这样做的意义**：你 M3U 播放列表里的 `tvg-id` 如果也用同一套规范，播放器就能自动把节目单挂到频道上，不需要任何手工映射。

### 例外：对不上 iptv-org 的频道

2026-10-27 扩频道时新增 161 个台，其中 83 个能在 [iptv-org 的 channels API](https://iptv-org.github.io/api/channels.json) 里按名字对上，直接沿用官方 id（`CCTVWeaponTechnology.cn`、`VideolandDrama.tw`、`EBCMovie.tw`）。

剩下 78 个 iptv-org 压根没有条目（台湾的靖天/龙华/博斯系列、大陆的求索/睛彩系列），这时 id 直接用「**直播源侧 tvg-id + 国家码**」：

```
靖天电影.tw    纬来育乐.tw    求索纪录.cn    金色学堂.cn
```

理由：① 编一个假英文名只会让以后核对更痛苦；② 这样它和 m3u 的匹配天然是 `id-exact`，不存在名字漂移风险；③ 反正 `epg-m3u.xml` 会对 id 做改写，播放器看到的还是你原来的写法。

判断规则很简单：`id` 里含汉字的就是这一类。

## 目录结构

```
epg/
├── channels/
│   ├── channels.json      ← 你要哪些台（唯一需要手工维护的文件）
│   ├── overrides.json     ← 自动匹配失败时手工指定（兜底）+ 51zmt 频道映射
│   ├── epg-sources.json   ← 外部 XMLTV 源清单 + 各源实测记录
│   ├── m3u-map.json       ← 自动生成：我们的频道 ↔ 你 m3u 的 tvg-id 映射
│   ├── catalog.json       ← 自动生成：所有源里的频道清单
│   └── match-cache.json   ← 自动生成：本次匹配结果
├── docs/
│   ├── merge-plan.md      ← 和直播源项目（iptv-api / iptv-tool）怎么配合
│   └── m3u-coverage.md    ← M3U 对接实测：每条规则命中数、缺口、可补频道清单
├── web/
│   ├── index.html         ← 频道看板（纯静态，读同目录 report.json）
│   └── report.json        ← 看板数据（build 后从 output/ 同步过来）
├── src/
│   ├── index.mjs          ← 主入口
│   ├── config.mjs         ← 配置与路径
│   ├── utils.mjs          ← 抓取 / 时间 / 转义 / 名称归一化 / isRealDesc
│   ├── match.mjs          ← 频道匹配（核心）
│   ├── m3u.mjs            ← M3U 解析 + 五级保守对齐（生成 m3u-map.json）
│   ├── normalize.mjs      ← 节目清洗 / 补 stop / 去重
│   ├── output.mjs         ← XMLTV 生成 + channels.json + report 统计
│   ├── aggregator.mjs     ← 外部 XMLTV 源聚合（空频道兜底）
│   ├── desc.mjs           ← 节目简介抓取（电视猫）+ 缓存
│   └── sources/
│       ├── epgpw.mjs      ← 主源
│       ├── z51.mjs        ← ★ 老张的 EPG：补简介 + 补空频道节目单
│       ├── tvmao.mjs      ← 补充源
│       └── tvsou.mjs      ← 兜底源
├── output/
│   ├── epg.xml
│   ├── epg.xml.gz
│   ├── epg-m3u.xml        ← 直播源对接版：channel id 已改写成 m3u 的 tvg-id
│   ├── epg-m3u.xml.gz
│   ├── channels.json      ← 频道清单，给直播源侧填 tvg-id 用
│   └── report.json
└── .github/workflows/update.yml
```

### `src/sources/z51.mjs` 为什么单独一个模块

它做了两件其他源不做的事，且都需要专门的算法：

1. **补简介**：两级对齐
   - 频道级：用「节目标题交集」判断某个 51zmt 频道是不是同一个台（阈值：交集 ≥5 条且占 ≥15%）。**不能用名字匹配**——港台频道必然串台（`台視新聞`→`台視`、`中天新聞`→`中天綜合台`）。
   - 全局级：跨频道的同名标题索引，只接受「全局唯一」或「多频道 desc 完全一致」的，跳过 110 个 desc 冲突的标题（如「晚间新闻」有 8 种写法）。

2. **补空频道节目单**：epg.pw 缺 16 个大陆地方台，51zmt 的 e1 里全都有。空频道没有标题可做交集，退回严格名字匹配 + `overrides.json` 手工指定（如「江苏公共·新闻」在 51zmt 叫「江苏新闻」）。


## 本地运行

```bash
node src/index.mjs catalog   # 扫描所有源的频道，导出 channels/catalog.json
node src/index.mjs check     # 只检查匹配命中率，不抓节目
node src/index.mjs build     # 抓节目并输出 output/epg.xml + epg.xml.gz
node src/index.mjs m3u <路径或URL>  # 对齐自己的 m3u，生成 channels/m3u-map.json
                             # （之后 build 会额外产出 output/epg-m3u.xml）
```

环境变量：

| 变量 | 说明 | 默认 |
|---|---|---|
| `DAYS` | 覆盖天数（含今天） | `7` |
| `ONLY` | 只处理指定频道，逗号分隔 tvg-id（调试用） | 全部 |
| `CONCURRENCY` | 并发数 | `6` |
| `EPGPW_CACHE_TTL` | epg.pw 原始包缓存有效期（毫秒）。本地想跳过重下大包时设 `86400000` | `1800000` |
| `CATALOG_TTL_HOURS` | 频道清单缓存有效期（小时）。build 默认复用，不重扫 | `24` |
| `NO_AGGREGATE` | 设 `1` 跳过外部 XML 源兜底 | 不跳过 |
| `NO_DESC` | 设 `1` 跳过节目简介抓取 | 不跳过 |
| `DESC_CONCURRENCY` | 简介页并发数 | `4` |
| `DESC_MAX_FETCH` | 单轮最多抓多少个简介页（防一次跑太久） | `600` |
| `DESC_FORCE` | 设 `1` 忽略简介缓存全部重抓 | 不重抓 |

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

**⚠️ 多 id 还会导致「简介整台丢失」，这个更隐蔽（2026-10-26 踩到）。**

同一个频道的新旧两个 id，**简介有无完全不同**：

| 频道 | 旧 id（3 天） | 新 id（7 天） |
|---|---|---|
| 中視 | `370141` 78条 / **desc 全空** | `456508` 174条 / **desc 全满** |
| TVBS新聞 | `370174` 54条 / desc 全空 | `456556` 126条 / desc 全满 |
| 東森新聞 | `370170` 41条 / desc 全空 | `456552` 156条 / desc 全满 |
| 翡翠台 | `539871` 1天 47条 / desc 全空 | `368366` 7天 312条 / desc 全满 |

如果 `pickBest()` 拿不到 `days`，就会挑到旧的空壳 id，结果**节目数从 22827 缩到 14344、台湾简介覆盖率从 90% 掉到 0%**，而日志里一切正常。

**这个坑的真实触发方式**：`catalog.json` 是修复 `listChannels` 之前生成的，2050 条全都没有 `days` 字段。文件很新（几小时前），但**结构过期**，导致匹配逻辑静默降级。现在 `collectCatalog()` 会显式校验 `days` 字段，缺失就强制重扫。

判断依据：`days` 字段在 epgpw 的条目里必须存在。手工排查时可以直接看：

```bash
node -e "const c=require('./channels/catalog.json');const s=c.items.find(x=>x.source==='epgpw');console.log('有days字段:', 'days' in s)"
```

**3. epg.pw 有大量「注册了但零节目」的空壳频道。**
如三沙卫视 `539632`/`410381`、浙江民生休闲 `539891`，名字能匹配上但一条节目都没有。这就是 `alternatives` + `[fallback]` 机制存在的原因，不要简化掉。

**⚠️ 还有个更坑的：`<desc />` 空标签。**

epg.pw 大量节目是 `<desc />` 这种自闭合空标签，**标签存在但没有任何内容**。统计简介覆盖率时如果只判断「有没有 `<desc` 」，会把它算成有简介（我 2026-10-26 就这么误判过，`/<desc[^>]*>\s*\S/` 把 `/` 当成了内容）。正确做法是取标签内文本再 `.trim()` 判断非空。

**4. 名称归一化里有两个字符必须保留，删掉就会错台。**（`utils.mjs` 的 `normalizeName`）

这是 2026-10-26 做聚合器时实测踩到的，影响的不只是 EPG，直播源聚合那边同样会错：

| 字符 | 错删的后果 | 正确做法 |
|---|---|---|
| `+` | `CCTV5+` 归一化成 `cctv5`，**体育赛事频道的节目挂到了 CCTV-5 体育上** | 保留 `+`，只把 `5加`/`5plus` 统一成 `5+` |
| `4k` / `8k` | `CCTV-4K` 归一化成 `cctv4`，撞 `CCTV-4 亚洲` | 只把「高清/HD/超清/标清/蓝光/杜比」当可忽略画质后缀，**4K/8K 是频道名的一部分** |

另外 `nameVariants()` 生成央视数字变体时也必须区分「频道号」和「频道号的修饰」：`CCTV-5+` 只能出 `cctv5+`，`CCTV-4K` 只能出 `cctv4k`，绝不能出裸 `cctv5` / `cctv4`。

顺带一个细节：画质后缀正则里 `超高清` 必须排在 `高清` 前面，否则只会剥掉「高清」留下一个「超」。

**5. 节目标题归一化：期号正则必须锚定结尾。**

我们（epg.pw）的标题带日期期号，电视猫是干净的：`寰宇视野2026-299` vs `寰宇视野`。去期号能对上，但**不能误删有意义的数字** —— `青春戏苑-2026-194溯光·花鼓戏` 里的 `2026-194` 后面还跟着内容，不是尾巴。所以期号正则一律用 `$` 锚定（`desc.mjs` 的 `normTitle`）。

### 下载的两个坑（`utils.mjs`）

**超时计时器必须覆盖到 body 读完。** 早期实现在 `fetch()` 拿到响应头后就 `clearTimeout`，而 epg.pw 响应头秒回、body 龟速，导致 `arrayBuffer()` 永久卡死（实测挂 14 分钟）。现在计时器一直保留到 `arrayBuffer()` 返回。

**Node 的 fetch 不读 `https_proxy` 环境变量。** 国内网络下直连 epg.pw 会卡死，所以 `fetchBuffer()` 做了三级降级：fetch 快速超时（90s）→ curl 子进程（能读代理环境变量）→ 报错交给调用方用旧缓存。GitHub Actions 在海外直连很快，走的是第一级。

## 外部 XMLTV 源聚合

定位和 [iptv-api](https://github.com/XinMan939/iptv-api) 聚合直播源完全同构 —— 那边是「抓别人的 M3U → 归一化匹配 → 去重汇总」，这边是「抓别人的 XML → 归一化匹配 → 择优汇总」。

| 环节 | 直播源（iptv-api） | EPG（本项目） |
|---|---|---|
| 源列表 | `config/subscribe.txt` | `channels/epg-sources.json` |
| 拉取 | M3U / TXT | XML / XML.gz |
| 解析 | 正则提 `#EXTINF` | 解析 `<channel>` / `<programme>` |
| 匹配 | 归一化 + `alias.txt` | **同一套**归一化 + 别名表 |
| 去重 | 同名取最快/最稳 | 同名取**天数多、条数多** |
| 输出 | M3U / TXT | XMLTV + gz |

**别名表可以两个项目共享** —— 「CCTV1 = CCTV-1 = CCTV-1综合 = 央视一套」这张表不用维护两遍。

### 用法

编辑 `channels/epg-sources.json` 加源即可，不用改代码：

```json
{
  "sources": [
    { "name": "老张的EPG", "url": "http://epg.51zmt.top:8000/e.xml.gz",
      "tvgIdNative": false, "priority": 10, "enabled": true }
  ]
}
```

`tvgIdNative` 表示该源的 channel id 是否已经是 iptv-org 规范（`CCTV1.cn`）。`false` 时会退回按 `display-name` 匹配。

**触发时机**：只在本地三源全部抓空的频道上启用。因为外部源要整包下载（1MB+），且质量明显不如本地源，无差别跑一遍是白花流量。

### 与 iptv-api 的 `updates/epg/request.py` 的三个关键差异

那三个是它的硬伤，这边都避开了：

1. **它只取 `<title>`**，把 `<desc>` / `<category>` / `<icon>` / `<episode-num>` 全丢了 → 即使抓了带简介的源，输出也没简介。这边 `parseXmltvFull()` 完整保留所有子元素。
2. **它拿 channel_id 当 display-name 输出** → 播放器里显示 `CCTV1.cn` 而不是「CCTV-1 综合」。这边用目标频道自己的名字。
3. **它纯精确名匹配** → 「CCTV-1综合」匹配不上「CCTV1」。这边复用 `match.mjs` 的归一化 + 别名 + 包含匹配。

### 实测记录：老张的EPG

**可用，但只能当兜底，不能当主源。** 100 频道 / 7374 条 / **仅 2 天** / **0 条 desc** / 0 条 category。频道名极粗糙（`CCTV1`、`凤凰中文`、`中国教育1台`）。

四个坑，都记在 `epg-sources.json` 的 `_实测记录` 里：

- **必须用 `http` 起头。** `https://epg.51zmt.top:8000` 握手直接失败（返回 000），`http://` 会 302 到 `https://s.102031.xyz/xml/xxx.xml.gz`（Cloudflare），跟着跳才 200。
- **URL 写着 `e.xml.gz`，实际返回明文 XML**（首字节是 `<?xml` 不是 `1f 8b`）。所以只能靠魔数判断，不能信后缀。
- **channel id 是纯数字 `1/2/3`**，不是 iptv-org 规范，`tvgIdNative` 必须为 `false`。
- **有个 `id=9999` 的占位频道 `noepg`**，节目全是「精彩节目-暂未提供节目预告信息」，属于噪声。

`erw.cc` 当前不可用（http 502 / https 连不上），已设 `enabled: false`。

## 节目简介

**现状**：epg.pw 自带 `<desc>` 的只有港澳台频道（覆盖率很高，台湾部分频道 100%），大陆频道 desc 全是 0。三个源里只有电视猫的节目详情页有简介。

**做法**：`src/desc.mjs` 走三步 ——

1. **对齐频道**：把目标频道按归一化名/别名对齐到电视猫的频道 id
2. **建索引**：抓每个电视猫频道 **7 天**节目单，建「归一化节目名 → 详情页路径」索引
   （只抓周一会漏掉只在周末播的节目：体育赛事、特别节目、周末综艺）
3. **抓详情页**：按索引解析我们的每个节目标题，批量抓简介

### 三类详情页，简介藏在三个不同位置

| 路径 | 类型 | 简介位置 |
|---|---|---|
| `/tvcolumn/{hash}` | 栏目（新闻、综艺、固定栏目） | `<div class="...section">` 正文，**没有 meta description** |
| `/kanju/{hash}` | 剧集·移动端 | `<meta name="description">` |
| `/drama/{hash}` | 剧集·PC 端 | `<meta name="description">` |

### 缓存与 TTL（为什么必须分级）

**key 用详情页路径，不用节目名。** 因为栏目 hash 是**栏目级 ID，会长期复用** —— 「新闻联播」的 `/tvcolumn/eg==` 一年后还是它。所以一个 hash 抓一次就够，后面每天 build 直接命中缓存，零请求。

TTL 分级（热播剧会换、集数会加，所以剧集类要短）：

| 类型 | TTL | 理由 |
|---|---|---|
| 剧集（`/kanju` `/drama`） | 7 天 | 热播剧会更新，后面有新剧 |
| 栏目（`/tvcolumn`） | 90 天 | 新闻/固定栏目简介基本不动 |
| 抓取失败（空结果） | 3 天 | 别每天对同一个坏链接反复重试 |

索引本身也有缓存（`.cache/desc-index.json`，2 天 TTL），一天内重复 build 不必重抓节目单。

### 一个必须知道的解析坑

**不能用 `<div ...>...</div>` 简单配对正则提简介正文。** 简介正文里可能含内层 `div`/`span`，非贪婪匹配会在第一个 `</div>` 就截断。实测「经济半小时」页：简介明明有 1240 字，正则只截到 177 字的导航条，于是被判定「无简介」。

现在的做法是「先定位 class 含 `section` 的容器，取 3000 字窗口直接去标签」，不依赖精确配对。

### 为什么覆盖率只有 52%

剩下的一半主要是**天然没有简介的内容**，不是抓取失败：

- **8K / 4K 频道的宣传片、标识演绎、剧场填充内容**（`周末一起看电影-宣传片（8K）`、`4K节目预告`、`午夜剧场`）—— 电视猫上这些条目本来就没有简介页
- **地方台（local 组，覆盖率仅 3%）** —— 电视猫的数字频道组全是付费频道（风云足球、CHC 系列、SITV 系列），**没有省级地面频道**（湖南经视、浙江民生这些），所以对不上

## 自动更新

`.github/workflows/update.yml`：每 6 小时跑一次（UTC `0/6/12/18` 点，即北京时间 02/08/14/20 点），也支持在 Actions 页面手动触发（可指定天数、可只跑部分频道）。

构建后会校验产物完整性（XML 头、`</tv>` 闭合、节目条数），失败会直接标红，不会把坏文件发到 Pages。

## 已知限制

### 24 个频道当前拿不到节目

见上面「还缺节目单的 24 个频道」。**澳门 3 个台全部无源**，是最大的单点缺口。

### 扩到 275 个频道后新增的已知问题

- **不少新频道只有 1~2 天**：台湾付费台（龙华/靖天/博斯）走 epg.pw TW，多数只给当天到后天；数字付费台走 epg.pw CN，多数只有当天。51zmt 的 e1/e2 各给 2~3 天。
- **有 24 个频道只有壳没有节目**（见上），它们会以空频道形式出现在 `report.json` 里，看板会标「无数据」。
- **频道 id 有两套写法**：能对上 iptv-org 的用官方 id（`VideolandDrama.tw`），对不上的直接用你 m3u 的 tvg-id 加国家码（`靖天电影.tw`）。这些台 iptv-org 本来就没有条目，编一个假英文名只会更难核对。理由见 `docs/m3u-coverage.md`。

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
