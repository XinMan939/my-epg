# my-epg

自建中文 EPG（电子节目单）。抓取央视 / 卫视 / 地方台 / 港澳台节目表，输出标准 **XMLTV** 格式，由 GitHub Actions 定时更新并发布到 GitHub Pages。

## 订阅地址

部署后（把 `<用户名>` / `<仓库名>` 换成你自己的）：

| 用途 | 地址 |
|---|---|
| 播放器订阅（推荐，体积小） | `https://<用户名>.github.io/<仓库名>/epg.xml.gz` |
| 未压缩版 | `https://<用户名>.github.io/<仓库名>/epg.xml` |
| 频道清单（对接 M3U 用） | `https://<用户名>.github.io/<仓库名>/channels.json` |
| 构建报告 | `https://<用户名>.github.io/<仓库名>/report.json` |

大多数播放器（DIYP、TVBox、Kodi、Emby、Jellyfin、TiviMate）直接填 gz 地址即可，它们会自动解压。

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

优先级：`epgpw → tvmao → tvsou`，前一个能出节目就不走后面。

### 两个必须知道的坑

**1. epg.pw 的时区标注是错的。**
它的 `start` / `stop` 全部标 `+0000`，但时间数字实际已经是当地时间（UTC+8）。判断依据（CCTV-1 综合）：06:00 朝闻天下 / 12:00 新闻30分 / 19:00 新闻联播 / 22:00 晚间新闻，四个锚点全部命中北京时间。港澳台同理（明珠台 09:30 交易直播室对港股开盘）。代码里已强制按 `+0800` 解读，**不要改回去**，否则整体偏 8 小时。

**2. epg.pw 同一频道名有多个 id，数据完整度差异巨大。**
比如「湖南卫视」在源里有 3 个 id：`539731` 只有当天 1 天 34 条、`545960` 有满 7 天 236 条、`572162` 也有 7 天 229 条。匹配器如果按名字长度挑，会挑到 1 天那个，卫视节目表就只剩今天。

代码里的处理：`epgpw.listChannels()` 会把每个 id 的 `days`（覆盖天数）和 `count`（节目条数）带出来，`match.pickBest()` 优先选天数多的。**这条逻辑不能删**，删了卫视会大面积退化。

## 自动更新

`.github/workflows/update.yml`：每 6 小时跑一次（UTC `0/6/12/18` 点，即北京时间 02/08/14/20 点），也支持在 Actions 页面手动触发（可指定天数、可只跑部分频道）。

构建后会校验产物完整性（XML 头、`</tv>` 闭合、节目条数），失败会直接标红，不会把坏文件发到 Pages。

## 已知限制

- **地方台节目表普遍只有 1 天**：epg.pw 的地方台多数只给当天数据，这是源的限制，不是代码问题。央视和卫视是 7 天完整的。
- **部分频道源里根本没有**：`HOYTV.hk`（HOY 台）、`HunanCityChannel.cn`（湖南都市）、`HunanPublicChannel.cn`（湖南公共）、`JiangsuPublicNewsChannel.cn`（江苏公共新闻）在当前三个源里都找不到对应频道，会一直显示未命中。等源补上或换源才能解决。
- **节目简介较少**：epg.pw 大部分节目只有标题，没有 `desc`。XMLTV 允许 desc 为空，播放器只是不显示简介。
