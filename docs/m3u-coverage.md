# 把节目单挂到自己的直播源上（M3U 对接）

> 本文回答一个具体问题：**我自己抓的 m3u 直播源，能不能用这份 EPG？**
> 结论：能。但两边的频道 id 体系不同，直接订阅一个台都挂不上，必须生成一份 id 改写版。
> 全部数字都是对 [XinMan939/iptv-api](https://github.com/XinMan939/iptv-api) 的 `output/result.m3u` 实测得出的。

## 一、为什么直接用 epg.xml 挂不上

| | 我们（epg.xml） | 你的 m3u（result.m3u） |
|---|---|---|
| channel id 写法 | `CCTV1.cn` `ZhejiangSatelliteTV.cn` `Jade.hk`（iptv-org 规范） | `CCTV1` `浙江卫视` `TVB翡翠`（裸名） |
| 名字写法 | `CCTV-1 综合` | `CCTV1` / `CCTV-1` / `CCTV-1 HD` 混排 |

播放器挂节目单靠 `tvg-id` 与 `<channel id>` **字符串相等**。两边一个都不相等 → 直接订阅等于没挂。这不是内容问题，是 id 体系问题。

## 二、解法：两条命令

```bash
# 1) 对齐：m3u 的地址（本地路径或 URL 都行）
node src/index.mjs m3u https://raw.githubusercontent.com/XinMan939/iptv-api/master/output/result.m3u

# 2) 构建：会额外产出 output/epg-m3u.xml / .gz
node src/index.mjs build
```

- `channels/m3u-map.json` —— 映射表（**建议入库**，CI 直接复用，不用每次都跑第 1 步）
- `output/epg-m3u.xml` —— 对接版，`<channel id>` 已经是你的 `tvg-id`

```xml
<channel id="CCTV1">                      <!-- 不是 CCTV1.cn -->
  <display-name lang="zh">CCTV-1 综合</display-name>
  <display-name lang="zh">CCTV1</display-name>   <!-- 补上你那边原本的写法 -->
```

播放器里 **EPG 填 `epg-m3u.xml.gz`、直播源填你的 m3u**，两边都不用改。

## 三、匹配规则：五级，宁可漏不可串台

| 级别 | 规则 | 命中 |
|---|---|---|
| ① manual | `m3u-map.json` 里手工写死的映射，优先级最高 | 0 |
| ② id-exact | 两边 id 完全相等（扩容后大量命中——新频道的 id 就是按 tvg-id 起的） | 0 |
| ③ id-stripped | 我们的 id 去掉 `.cn/.hk/.tw/.mo` 后相等 | 109 |
| ④ name-unique | 名字/别名归一化后相等，且该名字在我方与 m3u 两侧都唯一 | 142 |
| ⑤ name-loose | 再去掉台标前缀（TVB/CCTV）和「卫视/电视/频道/台」，两侧仍唯一 | 5 |

**为什么必须两侧都唯一**：宽松规则会塌名字（湖南卫视 / 湖南国际 都塌成「湖南」）。只要某一侧塌出歧义就直接放弃，绝不猜。

### 归一化这一步是真正的脏活

一开始 318 个 tvg-id 里只对得上 90 个，剩下的大半不是「没有这个台」，而是名字没归一干净。逐条修出来的规则：

| 坑 | 表现 | 处理 |
|---|---|---|
| 繁简不统一 | `鳳凰衛視香港台` vs `凤凰香港`、`三立台灣台` vs `三立台湾` | 接入 OpenCC 完整字表（3221 字），不再靠手写表补字 |
| 手写繁简表漏字 | 漏一个「緯」→`緯來育樂台` 永远对不上 `纬来育乐`，整类台湾频道假性缺口 | 同上，`src/t2s.mjs` 兜底 |
| 台标前缀 | `TVB翡翠` vs `翡翠台`、`CCTV兵器科技` vs `兵器科技` | 剥前缀，但要求剩下部分**以汉字开头**，否则 `TVBS欢乐` 会变成 `s欢乐` |
| 结尾「台/频道」 | `無綫新聞台` vs `TVB无线新闻` | 去尾部「台」，去「卫视/电视/频道」 |
| 圈码 / 罗马数字 | `大爱Ⅰ` `大爱Ⅱ` 都塌成「大爱」→ 撞车被判不可匹配 | ①Ⅰ②Ⅱ 等统一成阿拉伯数字 |
| 画质后缀误伤 | `CCTV-4K` 被剥成 `cctv`，和 `CCTV-8K` 撞车 | 后缀只剥结尾、且**不剥 4k/8k**（它们是频道本身的区别） |

## 四、实测结果

你的 `result.m3u`：4376 条节目源，去重 **318 个 tvg-id**。

| | 数量 |
|---|---|
| 我们 275 个频道里能对上的 | **256 个**，其中 236 个有节目 |
| 反向覆盖你的 318 个 | **256 个（80.5%）** |

| 分组 | m3u 频道数 | 已覆盖 | 缺口 |
|---|---|---|---|
| 卫视频道🛸 | 40 | 38（95%） | 2 |
| 央视频道🇨🇳 | 42 | 38（90%） | 4 |
| 数字付费🎞️ | 35 | 23（66%） | 12 |
| 港澳频道🇭🇰 | 40 | 29（73%） | 11 |
| 台湾频道🏞️ | 125 | 116（93%） | 9 |
| 广东频道🌏 | 11 | 5（45%） | 6 |
| 湖南频道🌏 | 7 | 6（86%） | 1 |
| 咪咕赛事🌟 | 17 | 0（0%） | 17 |
| **合计** | **318** | **256（80.5%）** | **62** |

## 五、为了这套对接，频道清单从 114 扩到了 275

原来是「精品主频道」114 个，你的 m3u 是「铺量全收录」318 个 —— 台湾 125、数字付费 35、咪咕赛事 17、广东地方 11，这四类占了大半，我们一个都没有。**内容再丰富，没有这个频道就是挂不上。**

扩的方式：拿 51zmt（e1/e2）和 epg.pw（CN/HK/TW）的频道名，按上面同一套归一化规则去撞缺口，撞上且源里有节目的就补进 `channels/channels.json`。

| 分组 | 原有 | 现有 |
|---|---|---|
| 央视 | 22 | **42** |
| 卫视 | 42 | **42** |
| 数字付费 | 0 | **23** |
| 地方台 | 13 | **21** |
| 中国香港 | 16 | **28** |
| 中国澳门 | 3 | **3** |
| 中国台湾 | 18 | **116** |
| **合计** | **114** | **275** |

现状：**275 个频道，251 个有节目，40583 条节目，真实简介 61%**（20261027 ~ 20261102）。

### 新频道的 id 怎么定的

1. **优先用 iptv-org 官方 id**（拿 `iptv-org/api/channels.json` 按名字对，83 个对上了，如 `CCTVWeaponTechnology.cn` `VideolandDrama.tw` `EBCMovie.tw`）
2. **对不上的用 `<你的tvg-id>.<国家码>`**（78 个，如 `纬来育乐.cn`、`靖天电影.tw`）

第 2 种是刻意这么定的：这些台 iptv-org 根本没有条目（台湾的靖天、龙华、博斯系列，大陆的求索、睛彩系列），与其编一个假英文名，不如直接沿用你 m3u 里的写法 —— 这样它天然是 `id-exact` 命中，也不存在以后名字漂移的风险。

## 六、还挂不上的 62 个

**卫视频道🛸（2）**：安多卫视 / 农林卫视

**央视频道🇨🇳（4）**：CCTV文化精品 / CCTV中学生 / CGTN西班牙语 / CGTN阿拉伯语

**数字付费🎞️（12）**：重温经典 / 睛彩竞技 / 睛彩篮球 / 睛彩青少 / 睛彩广场舞 / 睛彩中原 / 黑莓电影 / 黑莓动画 / 哒啵赛事 / 哒啵电竞 / NewTV动作电影 / NewTV惊悚悬疑

**港澳频道🇭🇰（11）**：HKS香港卫视 / TVB星河 / 有线新闻 / 澳视体育 / 澳视资讯 / 澳视综艺 / 澳门Macau / HOY78 / HOY76 / 天映频道 / 澳视葡文

**台湾频道🏞️（9）**：TVBS台剧 / TVBS综艺 / 龙华日韩 / 龙祥时代电影 / 我的欧洲电影 / MTVLive / 阿里郎 / AsianFood / HBO电影

**广东频道🌏（6）**：广东珠江 / 广州南国都市 / 广州综合 / 广州影视 / 汕头经济 / 岭南戏曲

**湖南频道🌏（1）**：湖南教育

**咪咕赛事🌟（17）**：咪咕赛事4k / 咪咕赛事01 / 咪咕赛事02 / 咪咕赛事03 / 咪咕赛事04 / 咪咕赛事30 / 咪咕赛事31 / 咪咕赛事33 / 咪咕赛事34 / 咪咕赛事35 / 咪咕赛事36 / 咪咕赛事37 / 咪咕赛事38 / 咪咕赛事39 / 咪咕赛事40 / 咪咕赛事42 / 咪咕赛事45

原因分三类：

1. **咪咕赛事 17 个** —— 咪咕自有轮播赛事频道，全网没有任何 EPG 来源，无解。
2. **数字付费 / 睛彩 / 黑莓 / 哒啵 / NewTV 12 个** —— 源里根本没有这些频道；`睛彩中原` 有频道条目但 0 条节目。
3. **港澳 / 台湾 / 广东剩余** —— `TVB星河`、`有線新聞`、`澳視系列`、`HOY76/78`、`龍祥`、`龍華日韓` 等，epg.pw 和 51zmt 都没有对应频道。`广东珠江`/`广州综合` 是 epg.pw 有频道壳但零节目。

## 七、两个必须记住的坑

**时间轴对齐不可靠。** 试过按节目开始时间对齐（延边卫视朝鲜语标题 → 51zmt 中文标题），TOL=15 分钟能对出 12 组，但 `일기예보`（天气预报）被错配成「看神州」—— 两边时间轴本身有错位。已放弃，改走人工 `titleMap`（`channels/overrides.json`）。

**不要用「包含匹配」兜底。** 剩下的 62 个缺口里有 `澳视体育`/`澳视资讯`、`睛彩篮球`/`睛彩竞技`，包含匹配很容易把 `CCTV5+` 吸到 `CCTV5`、`台視新聞` 吸到 `台視`。宁可空着。

---

## 附录：本轮新增的 161 个频道

「有节目」列就是当前 build 的实际结果，空的那几个是源里暂时没数据或只有壳。

| id | 名称 | 分组 | 有节目 |
|---|---|---|---|
| `CCTVWeaponTechnology.cn` | CCTV兵器科技 | cctv | ✓ |
| `CCTVTheFirstTheater.cn` | CCTV第一剧场 | cctv | ✓ |
| `CNDFilmDiscoveryChannel.cn` | CCTV发现之旅 | cctv | ✓ |
| `CCTVStormTheater.cn` | CCTV风云剧场 | cctv | ✓ |
| `CCTVStormMusic.cn` | CCTV风云音乐 | cctv | ✓ |
| `CCTVStormFootball.cn` | CCTV风云足球 | cctv | ✓ |
| `CCTVBilliards.cn` | CCTV央视台球 | cctv | ✓ |
| `CCTVGolfTennis.cn` | CCTV高尔夫网球 | cctv | ✓ |
| `CCTVNostalgiaTheater.cn` | CCTV怀旧剧场 | cctv | ✓ |
| `CNDFilmOldStoryChannel.cn` | CCTV老故事 | cctv | ✓ |
| `CCTVWomensFashion.cn` | CCTV女性时尚 | cctv | ✓ |
| `CCTVWorldGeography.cn` | CCTV世界地理 | cctv | ✓ |
| `CCTVHealth.cn` | CCTV卫生健康 | cctv | — |
| `CCTVTVGuide.cn` | CCTV电视指南 | cctv | — |
| `CGTN.cn` | CGTN | cctv | ✓ |
| `CGTNFrench.cn` | CGTN法语 | cctv | — |
| `CGTNDocumentary.cn` | CGTN纪录 | cctv | — |
| `CETV1.cn` | CETV1 | cctv | ✓ |
| `CETV2.cn` | CETV2 | cctv | ✓ |
| `CETV4.cn` | CETV4 | cctv | ✓ |
| `BRTVKakuChildrensChannel.cn` | 卡酷少儿 | pay | — |
| `GoldenEagleCartoon.cn` | 金鹰卡通 | pay | ✓ |
| `哈哈炫动.cn` | 哈哈炫动 | pay | ✓ |
| `JiaJiaCartoon.cn` | 嘉佳卡通 | pay | ✓ |
| `LiyuanTV.cn` | 梨园频道 | pay | ✓ |
| `求索纪录.cn` | 求索纪录 | pay | — |
| `求索动物.cn` | 求索动物 | pay | ✓ |
| `求索科学.cn` | 求索科学 | pay | ✓ |
| `求索生活.cn` | 求索生活 | pay | — |
| `GreatSportsChannel.cn` | 五星体育 | pay | ✓ |
| `魅力足球.cn` | 魅力足球 | pay | ✓ |
| `GameChannel.cn` | 游戏风云 | pay | ✓ |
| `劲爆体育.cn` | 劲爆体育 | pay | — |
| `乐游.cn` | 乐游 | pay | — |
| `AnimationShowChannel.cn` | 动漫秀场 | pay | ✓ |
| `CityTheaterChannel.cn` | 都市剧场 | pay | ✓ |
| `ChannelLaw.cn` | 法治天地 | pay | ✓ |
| `LaughterTheater.cn` | 欢笑剧场 | pay | ✓ |
| `金色学堂.cn` | 金色学堂 | pay | — |
| `LifestyleChannel.cn` | 生活时尚 | pay | ✓ |
| `CHCAction.cn` | CHC动作电影 | pay | ✓ |
| `CHCHomeTheater.cn` | CHC家庭影院 | pay | — |
| `CHCFansMovieChannel.cn` | CHC影迷电影 | pay | ✓ |
| `EntertainmentNews.hk` | TVB娱乐新闻 | hk | ✓ |
| `TVB千禧经典.hk` | TVB千禧经典 | hk | ✓ |
| `nowNews.hk` | NOW新闻 | hk | ✓ |
| `nowBusinessNewsChannel.hk` | Now财经 | hk | ✓ |
| `PopC.hk` | PopC | hk | ✓ |
| `nowDirect.hk` | Now直播台 | hk | ✓ |
| `ROCKAction.sg` | ROCKAction | hk | ✓ |
| `Thrill.hk` | Thrill | hk | ✓ |
| `ChineseOperaChannel.hk` | 戏曲台 | hk | ✓ |
| `黄金华剧台.hk` | 黄金华剧台 | hk | ✓ |
| `MeiAhMovieChannel.hk` | 美亚电影 | hk | ✓ |
| `ZooMoo.sg` | ZooMoo | hk | ✓ |
| `TVBSEntertainmentChannel.tw` | TVBS欢乐 | tw | ✓ |
| `TVBS精采.tw` | TVBS精采 | tw | ✓ |
| `ETTVFinancial.tw` | 东森财经新闻 | tw | ✓ |
| `EBCSuper.tw` | 东森超视 | tw | ✓ |
| `EBCMovie.tw` | 东森电影 | tw | ✓ |
| `ETTVDrama.tw` | 东森戏剧 | tw | ✓ |
| `EBCForeignMovie.tw` | 东森洋片 | tw | ✓ |
| `EraNews.tw` | 年代新闻 | tw | ✓ |
| `UniqueBusinessNews.tw` | 非凡新闻 | tw | ✓ |
| `非凡商业.tw` | 非凡商业 | tw | ✓ |
| `寰宇新闻台湾.tw` | 寰宇新闻台湾 | tw | ✓ |
| `寰宇财经.tw` | 寰宇财经 | tw | ✓ |
| `GlobalNews.tw` | 寰宇新闻 | tw | ✓ |
| `mnews.tw` | 镜新闻 | tw | ✓ |
| `国会频道①.tw` | 国会频道① | tw | ✓ |
| `国会频道②.tw` | 国会频道② | tw | ✓ |
| `SETiNews.tw` | 三立财经新闻 | tw | ✓ |
| `三立综合.tw` | 三立综合 | tw | ✓ |
| `三立戏剧.tw` | 三立戏剧 | tw | ✓ |
| `SETMetro.tw` | 三立都会 | tw | ✓ |
| `CTVClassic.tw` | 中视经典 | tw | ✓ |
| `中视菁采.tw` | 中视菁采 | tw | ✓ |
| `CTiEntertainment.tw` | 中天娱乐 | tw | ✓ |
| `CTiAsia.tw` | 中天亚洲 | tw | ✓ |
| `FTVOne.tw` | 民视第一台 | tw | ✓ |
| `FTVTaiwan.tw` | 民视台湾 | tw | ✓ |
| `FTVDrama.tw` | 民视影剧 | tw | ✓ |
| `FTVVariety.tw` | 民视综艺 | tw | ✓ |
| `FTVTravel.tw` | 民视旅游 | tw | ✓ |
| `PTSTaigi.tw` | 公视台语 | tw | ✓ |
| `公视戏剧.tw` | 公视戏剧 | tw | ✓ |
| `台视综合.tw` | 台视综合 | tw | ✓ |
| `TTVFinance.tw` | 台视财经 | tw | ✓ |
| `纬来综合.tw` | 纬来综合 | tw | ✓ |
| `VideolandDrama.tw` | 纬来戏剧 | tw | ✓ |
| `VideolandJapan.tw` | 纬来日本 | tw | ✓ |
| `VideolandMovie.tw` | 纬来电影 | tw | ✓ |
| `VideolandSports.tw` | 纬来体育 | tw | ✓ |
| `纬来育乐.tw` | 纬来育乐 | tw | ✓ |
| `纬来精采.tw` | 纬来精采 | tw | ✓ |
| `八大综艺.tw` | 八大综艺 | tw | ✓ |
| `八大精彩.tw` | 八大精彩 | tw | ✓ |
| `龙华经典.tw` | 龙华经典 | tw | ✓ |
| `龙华偶像.tw` | 龙华偶像 | tw | ✓ |
| `龙华戏剧.tw` | 龙华戏剧 | tw | ✓ |
| `CelestialClassicMovies.hk` | 天映经典 | tw | ✓ |
| `Catchplay电影.tw` | Catchplay电影 | tw | ✓ |
| `AMC.tw` | AMC | tw | ✓ |
| `HollywoodMovieChannel.tw` | 好莱坞电影台 | tw | ✓ |
| `靖天电影.tw` | 靖天电影 | tw | ✓ |
| `龙华电影.tw` | 龙华电影 | tw | ✓ |
| `龙华洋片.tw` | 龙华洋片 | tw | ✓ |
| `采昌影剧.tw` | 采昌影剧 | tw | ✓ |
| `靖天映画.tw` | 靖天映画 | tw | ✓ |
| `靖天戏剧.tw` | 靖天戏剧 | tw | ✓ |
| `靖洋戏剧.tw` | 靖洋戏剧 | tw | ✓ |
| `影迷数位电影.tw` | 影迷数位电影 | tw | ✓ |
| `经典电影台.tw` | 经典电影台 | tw | ✓ |
| `CMusic.tw` | CMusic | tw | ✓ |
| `DreamWorks梦工厂动画.tw` | DreamWorks梦工厂动画 | tw | ✓ |
| `CinemaWorld.my` | CinemaWorld | tw | ✓ |
| `精选动漫台.tw` | 精选动漫台 | tw | ✓ |
| `金光布袋戏.tw` | 金光布袋戏 | tw | ✓ |
| `AXN.tw` | AXN | tw | ✓ |
| `Cinemax.tw` | Cinemax | tw | ✓ |
| `DAZN1.uk` | DAZN1 | tw | ✓ |
| `DAZN2.uk` | DAZN2 | tw | ✓ |
| `Discovery.tw` | Discovery | tw | ✓ |
| `DW德国之声.tw` | DW德国之声 | tw | ✓ |
| `EYETVTravel.tw` | EYETV旅游 | tw | ✓ |
| `EYETVDrama.tw` | EYETV戏剧 | tw | ✓ |
| `HITS.tw` | HITS | tw | ✓ |
| `博斯魅力.tw` | 博斯魅力 | tw | ✓ |
| `博斯网球.tw` | 博斯网球 | tw | ✓ |
| `博斯无限Ⅰ.tw` | 博斯无限Ⅰ | tw | ✓ |
| `博斯无限Ⅱ.tw` | 博斯无限Ⅱ | tw | ✓ |
| `博斯运动Ⅰ.tw` | 博斯运动Ⅰ | tw | ✓ |
| `博斯运动Ⅱ.tw` | 博斯运动Ⅱ | tw | ✓ |
| `博斯高球Ⅰ.tw` | 博斯高球Ⅰ | tw | ✓ |
| `博斯高球Ⅱ.tw` | 博斯高球Ⅱ | tw | ✓ |
| `DaAi1.tw` | 大爱Ⅰ | tw | ✓ |
| `DaAi2.tw` | 大爱Ⅱ | tw | ✓ |
| `GoodTV.tw` | 好消息Ⅰ | tw | ✓ |
| `Good2.tw` | 好消息Ⅱ | tw | ✓ |
| `AsiaTravelTV.tw` | 亚洲旅游 | tw | ✓ |
| `智林体育.tw` | 智林体育 | tw | ✓ |
| `靖天卡通.tw` | 靖天卡通 | tw | ✓ |
| `猪哥亮歌厅秀.tw` | 猪哥亮歌厅秀 | tw | ✓ |
| `HBO强档巨献.tw` | HBO强档巨献 | tw | ✓ |
| `HBO原创巨献.tw` | HBO原创巨献 | tw | ✓ |
| `HBO温馨家庭.tw` | HBO温馨家庭 | tw | ✓ |
| `爱尔达体育Ⅰ.tw` | 爱尔达体育Ⅰ | tw | ✓ |
| `爱尔达体育Ⅱ.tw` | 爱尔达体育Ⅱ | tw | ✓ |
| `爱尔达体育Ⅲ.tw` | 爱尔达体育Ⅲ | tw | ✓ |
| `爱尔达影剧.tw` | 爱尔达影剧 | tw | ✓ |
| `爱尔达体育Ⅳ.tw` | 爱尔达体育Ⅳ | tw | ✓ |
| `爱尔达娱乐.tw` | 爱尔达娱乐 | tw | ✓ |
| `爱尔达生活旅游.tw` | 爱尔达生活旅游 | tw | ✓ |
| `湖南电影.cn` | 湖南电影 | local | ✓ |
| `GoldenEagleDocumentary.cn` | 金鹰纪实 | local | ✓ |
| `快乐垂钓.cn` | 快乐垂钓 | local | ✓ |
| `广东体育.cn` | 广东体育 | local | ✓ |
| `GuangdongNewsChannel.cn` | 广东新闻 | local | ✓ |
| `广东民生.cn` | 广东民生 | local | ✓ |
| `广州新闻.cn` | 广州新闻 | local | — |
| `广州竞赛.cn` | 广州竞赛 | local | — |
