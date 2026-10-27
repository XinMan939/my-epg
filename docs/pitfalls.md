# 踩坑台账（pitfalls）

> **这份文件是「按需查阅」的**，不进每次会话的常驻上下文。
> `MEMORY.md` 只放索引和一句话摘要，细节全在这里。
> 遇到相关问题时读这一节，而不是靠记忆。

---

## 一、tvmao 的三个静默 bug（2026-10-27 第七轮，全修）

这三个 bug 的共同特征：**都不报错**。不修就是「上游没有」的假结论。

### 1.1 行正则只认「`<a>` 独占整行」

页面 `epg-row-link` 有三种写法：

| 型 | HTML | 旧正则 |
|---|---|---|
| ① `<a>` 独占整行 | `<span class="epg-row-link"><a href="/tvcolumn/x">动画片</a></span>` | ✅ |
| ② `<a>` 夹在中间 | `<span class="epg-row-link">实况录像-2024/2025赛季<a href="/competition/y">斯诺克世界公开赛</a> 墨菲的147</span>` | ❌ 整行丢弃 |
| ③ 纯文本 | `<span class="epg-row-link">动画片</span>` | ✅ |

还有一类时间标签被漏掉：正在播出的那条 class 是 **`epg-row-playing`**（内文是「直播中」而不是时间）。

**实测代价**：`CCTV央视台球` 28 行 → 旧正则 **0 条**；抽样 24 个频道 15 个在丢数据，共丢 84 条
（CCTV-5 6→22、CCTV5+ 4→16、CCTV-7 29→38、CCTV-12 24→30、CGTN法语 25→33）。

**修法**：按 `<li class="epg-row">` 切块，块内分别取时间（`time|playing` 都吃）、取标题（剥 `<a>` 但保留前后文字）。
见 `src/sources/tvmao.mjs` 的 `parseRows()`。

### 1.2 路径猜错不报 404，而是 200 + 别人的节目单

| id | `/program/` | `/program_digital/` |
|---|---|---|
| SITV-FASHION | 200，**9行，title「DOX映画」** ✗ | 200，65行，title「生活时尚」✓ |
| SITV-CHILDREN | 200，**9行，title「DOX映画」** ✗ | 200，104行，title「动漫秀场」✓ |
| DOX-CINEMA | 200，**20行，title「CCTV-1综合」** ✗ | 200，20行 ✓ |
| KAMBA-TV | 200，**20行，title「CCTV-1综合」** ✗ | 200，48行 ✓ |
| 无连字符（114 个卫视） | 200，**20行，title「CCTV-1综合」** ✗ | 200，40行 ✓ |
| CCTVPAYFEE-* | 200 ✓ | 404 |

**这就是「生活时尚/动漫秀场补天拿到 0 条」的真因**——不是上游没有，是拿回来的是别的台。

更糟的是：代码早就抓了 `pageTitle`，注释也写着「必须校验 title」，**但实现里从来没校验过**。

**修法**：
1. 路径按前缀分组（`PATH_BY_PREFIX`），不再按「有没有连字符」一刀切
2. 强制 `titleMatchesChannel(pageTitle, expectNames)`，支持传一串名字，任一命中即通过；
   title 为空时放行（上游改版别一刀切全废掉）
3. `tvmaoPath` override 给探测也搞不定的频道钉死路径

**现行路径表**：
- `/program/` → `CCTV-` `BAMC-` `CCTVPAYFEE-` `CETV-` `CHC-` `HSCM-`（含两段式 `SHXITV/SHXITV9`）
- `/program_digital/` → `SITV-` `DOX-` `KAMBA-` `DIGITAL-`
- `/program_satellite/` → 无连字符的卫视（`AHTV1` `SANSHATV` …）

### 1.3 override 指向 catalog 外的 id 被整条丢弃

`GDTV-GDTV7`（嘉佳卡通）、`NANFANG-NANFANG6`（大湾区卫视）都不在 catalog
（catalog 只收频道清单页的链接，这两个不在清单页）。

旧代码 `log.warn` 一句就 `continue` → 该频道变「无匹配」→ 走 z51 兜底 → **永远 2 天**，
而且日志看起来是「正常跳过」。

**修法**：`tvmao`/`tvsou`/`fengshows` 允许 `override-unlisted` 直接使用
（抓不到自然留空，且有 title 校验兜底）。
⚠️ **`epgpw` 不能这样放行**——它是整包按 id 过滤，猜 id 必错。测试里有反证。

---

## 二、凤凰卫视（fengshows）官网 API

`鳳凰衛視香港台` 四个源（epgpw/tvsou/z51/tvmao）全无，只能走官网。

```
https://m.fengshows.com/api/v3/live/{liveId}/resources?dir=asc&date=YYYYMMDD&page=1&page_size=99
```

| 频道 | liveId | 7 天条数 |
|---|---|---|
| 中文台 | `f7f48462-9b13-485b-8101-7b54716411ec` | 296 |
| 資訊台 | `7c96b084-60e1-40a9-89c5-682b994fb680` | 382 |
| 香港台 | `15e02d92-1698-416c-af2f-3e9a872b4d78` | 294 |

**两个必须知道的坑**：

- **不带 `date` 参数会返回 2021 年的死数据**：99 条，`date` 范围 `20210709~20210710`。
  看着「有 99 条」很像正常，实际是陈年垃圾。
- **`event_time` 是 UTC**：`2026-10-26T16:00:00.000Z` = 北京 `10-27 00:00`。
  `Date.parse` 的绝对时间戳是对的，但「属于哪一天」必须按 `+08:00` 换算。

上游**不给结束时间也不给简介**（无 `end_time`/`duration`；`content`/`brief` 实测 0/49 全空），
结束时间交给 `normalize` 用下一条 start 补。

中文台/資訊台已有 7 天（epgpw），不动；只把香港台接过来。

---

## 三、时间轴（2026-10-27 第五轮）

### 3.1 重叠只截前一条 stop，绝不改 start

旧代码改「后一条的 start」→ 产物倒序（2 个频道）。
错的是前一条吞掉了后一条，两条都要保留，时间轴才连续，且没有编造任何时间。

### 3.2 拉短节目必须排在重叠修完之后，且只在有空位时拉

旧代码第 4 步拉长、第 5 步发现挤到下一条又截回，**两步互相抵消**，632 条一条都没修好。

### 3.3 末条 12 小时是「决定不修」

上游把末条 `stop` 写成「数据窗口末尾」，算出来 21 小时，被 `maxDurationHours = 12` 截成整齐的 12.00h。
压到 10.8h 试过，**已放弃**：那样 55 个频道在窗口末尾留 11 小时空白，
播放器显示「暂无节目」，比「一条长节目」更糟。

### 3.4 632 条 30 秒垫片是真实的

CCTV-8K/4K 的宣传片就是 30 秒，首尾相接，没有空位可以拉长。宁可显示真实 30 秒。

---

## 四、补天（day-fill，2026-10-27 第六轮）

### 4.1 降级链「有 1 条就 break」让 44 个频道只 1~2 天

epg.pw 的 CN 包对 352 个频道只给滚动 24h（`16h 8h 0 0 0 0 0`），
拿到 1 条就停，轮不到 tvmao 的 7 天。

**修法是「合并非换源」**：epg.pw 有简介，tvmao 有 7 天，换源等于拆东墙补西墙。

### 4.2 ★ 重叠记录会被 normalize 删掉带简介的主源

`normalize` 第 5 步 `if (cur.startTs < prev.stopTs) prev.stopTs = cur.startTs` 然后 filter 掉零长度。
同 start 不同 title 时，**前一条（带简介的主源）被截成零长度→删除**，留下的是无简介的那条。

所以补天必须**逐条判重叠、整条丢弃、不裁剪**（`pickMissingDays`）。
测试 `test/day-fill.test.mjs` 的 `[16]` 是反证。

### 4.3 ★ 区域版本必须校验

`nameVariants('CCTV4欧洲')` → `['cctv4欧洲','cctv4']`，裸 `cctv4` 与
`nameVariants('CCTV-4 (亚洲)')` → `['cctv4']` 撞车，
把国内版电视剧《爱在青山绿水间》补进了欧洲版。

`sameRegionVersion`：一边有区域词、另一边有不同区域词 → 拒；一边有一边没有 → 放行（默认版兼容）。
⚠️ 「欧」= 「欧洲」要用 `REGION_ALIAS` 归一，且用 lookbehind 避免「欧洲」被「欧」先吃掉。

### 4.4 「天数够不够」按覆盖小时，不按条数

求索纪录一天 12 条但覆盖满 24h（每条 2 小时）；电影台一天 10 条、新闻台一天 40 条，条数差 4 倍。
判据：`medHours >= 8 && v.hours < medHours * 0.5`，且要排除窗口最后一天。

---

## 五、简介（desc）

### 5.1 ★ desc 复读标题会锁死补简介位置

三源循环都 `if (isRealDesc) continue`，复读的 desc 骗过判断 → 真简介补不进。

`isEchoDesc`：`desc === title`，或 `desc = title + 尾巴`（剥数字/EP/季/集后 ≤2 字）。
⚠️ **别放宽成「以标题开头」**，会误伤 1177 条。

### 5.2 ★ 实体解码必须循环解到稳定

源里存 `&amp;quot;`，旧实现顺序错 → 产物留字面乱码 405 条（用户看到 `&quot;融媒体&quot;`）。

### 5.3 统计别只看非空或长度

统一走 `utils.hasRealDesc` = `isRealDesc`（≥12 字 + 非占位）+ `!isEchoDesc`。

### 5.4 简介索引必须按频道分开

三级：`buildChannelIndex` → `alignByTitles` → `buildGlobalIndex`（只收全站唯一）。
⚠️ 归一化必须繁简转换。

---

## 六、频道对齐

### 6.1 不能用名字匹配

`台視新聞` → `台視` 必串台。用「节目标题交集」（≥5 条且 ≥15%）。

### 6.2 非中文标题只能人工映射

港台35 转 CGTN 英文、延边朝鲜语，写 `overrides.json` 的 `titleMap`。
⚠️ **别用「起始时间相同」对齐**。

### 6.3 「上游没有」不能靠名字匹配下结论

`AsianFood` ↔ `亞洲美食頻道` 字面差得远但数据在。
要把上游有节目的频道人工扫一遍。

### 6.4 「清单页没有」≠「站点没有」

`GDTV-GDTV7` / `NANFANG-NANFANG6` / `SHXITV/SHXITV9` 都不在 catalog，但数据在。

### 6.5 epg.pw 的 display-name 会撒谎

`My Cinema Europe` 实为半岛英文台、`CGTN西语` 实为中文节目。

### 6.6 同名跨版本不可信

z51 的「CCTV4」是国内版（放电视剧），与 CCTV4欧洲/美洲交集仅 50~57%，合并前必须验证。

---

## 七、工程 / 环境

### 7.1 上游改版是静默的

tvmao 换路径后全消失，日志只报「跳过」。
★ **`catalog.json` TTL 24h，加新源后必须 `catalog` 重扫**，否则 match 报「源清单中不存在」。

### 7.2 行尾

`channels.json` / `index.mjs` / `README.md` 是 CRLF，其余 LF。
⚠️ `grep -c $'\r$'` 在 Git Bash 误报，**用 Node 核对**。
Python `io.open(p,'w')` 会转 CRLF，必须 `newline='\n'`。

### 7.3 四道防线

```bash
npm test    # 113 项（normalize 23 + day-fill 47 + tvmao 33 + match 10）
node test/audit-output.mjs output/epg.xml.gz   # 重叠/乱序/零长度/某天半截 → exit 1
```

**体检脚本必须拿「已知有病的产物」验证才算装上**（否则不知道它到底能不能抓）。

### 7.4 其他环境坑

- **改 workflow 走 `gh api`**（remote token 只有 repo scope）
- **Pages 需先有 gh-pages 否则 422**
- **jsdelivr UA 反爬是反的**（浏览器 UA 403），`m3u <URL>` 用 curl UA
- **epg.pw 的 `+0000` 是假的**（按 `+0800`）
- **同 region 并发写坏缓存**，已用 inflight 去重
- `check` 会重写 `catalog.json` 产生噪音 diff，提交前 `git checkout --` 掉
- **`z51` 不在 catalog**，写 `z51SourceId`，只对「节目为 0」的频道生效

### 7.5 审计脚本也会骗人

① 「繁体」不是串台证据
② 「含 `&lt;`」是假阳性
③ `epg-m3u.xml` 的 id 已改写，不能对 `channels.json` 判地区
④ 「某天条数少」要排除窗口最后一天

### 7.6 文档数字必须写清分子分母

`count` 是节目总数、`withDesc` 才是简介数。

---

## 八、已知缺口（上游确实没有，别再试）

- CCTV-8K、公视戏剧、浙江少儿/影视 全 0
- 港台34/31、延边 少量
- 澳门 3 台（无 MO 包）：澳门电视台、澳门莲花、澳亚卫视
- HOY TV、湖南都市、湖南公共、中天新闻：四源全无
- **浙江国际（cztv）**：纯 SPA + 全压缩分包，接口未破解，本机无 playwright
- 嘉佳卡通 tvmao 只 w1/w2 完整（w3~w7 只到 14~17 点）
- 三沙卫视 tvmao w3~w6 全空（3 天是上限）

**勿当缺口**（已有简介）：公視、港台35/32、CCTV-5+、華視新聞。

**不可用别重试的数据源**：CNTV、百度 EPG、timetv、tv-8、erw.cc、tbit.top。
