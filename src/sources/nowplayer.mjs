/**
 * 香港 Now TV 官方节目单数据源（nowplayer.now.com）—— 2026-10-28 第十一轮新增
 *
 * 来源：用户提供网页 https://nowplayer.now.com/tvguide，
 * 说「也上不去，这个是香港台的，带简介，好像有缓存加载，要慢慢加载才能看到全部节目单」。
 *
 * ★★ 「上不去」= DNS 污染，不是被墙（和 TDM / ELTA 同一个坑，本项目第三次）：
 *   本机 nslookup nowplayer.now.com → `199.96.62.17` + IPv6 `face:b00c`（**Meta 段**）。
 *   CI（GitHub 海外机房）解析到 AWS 真实 IP `16.162.169.178`，直连 **200、0.89s**。
 *   → 照旧交 CI 抓，本机只做代码验证（pitfalls §7.1c）。
 *
 * ★ 「要慢慢加载」不是网速问题，是**懒加载**：
 *   页面是 React SSR（`data-react-helmet`），HTML 里只有频道条和空壳 `.program-row loading`，
 *   节目数据靠滚动时逐个区块走 `GET /tvguide/epglist` 拉。用户看到的「慢慢加载」就是它。
 *
 * ★ 破解路径（比 TDM 简单、比 ELTA 稍复杂，因为要挖内联 JS）：
 *   1. `curl --compressed` 抓 `https://nowplayer.now.com/tvguide`（61KB）
 *   2. 页面里 **没有** 独立 JS 提供接口 —— `/js/tv-guide.js` 只有 1757 字节，纯滚动交互。
 *      真正的接口写在内联 `<script>` 里（约第 5001 行）：
 *      ```js
 *      function retrieveChannelList(idList, day) {
 *        $.ajax({ url:'/tvguide/epglist', type:'GET',
 *                 data:{ channelIdList: idList, day: day }, dataType:'text' })
 *      }
 *      function showProgramDetail(programId) {
 *        $.ajax({ url:'/tvguide/epgprogramdetail', type:'GET',
 *                 data:{ programId: programId }, dataType:'json' })
 *      }
 *      ```
 *   3. `idList` 来源：`$('.channelbar .item').children('.ch-num').html()` —— 即频道号 `096`/`332`。
 *      页面里频道条是 `<span class="ch-num">096</span>`，所以 sourceId = **三位频道号**。
 *   4. `day` 是 1..7 的**广播日序号**，不是日期。
 *
 * 接口（全部实测 2026-10-28，CI run 40566682857 / 40567448341 / 40567863172 / 40568617805 / 40571403150）：
 *   GET  /tvguide/epglist?channelIdList=096&channelIdList=099&day=N&lang=zh
 *        → `[[节目...],[节目...]]`，**按 channelIdList 顺序一一对应**
 *   GET  /tvguide/epgprogramdetail?programId=xxx&lang=zh → 单个节目详情（含简介）
 *   POST /tvguide/appepglist  → 移动端分页版，**不带简介，已弃用**
 *
 * ⚠️ 八个坑（全部实测，别改回去）：
 *
 * ① **★★ 必须带 `lang=zh`，否则节目标题全是英文**：
 *    不带时 366 返回 `Phoenix Intercontinental Express / News On The Hour 0100`，
 *    带 `&lang=zh` 才是 `鳳凰洲際快車 / 鳳凰正點播報 0100`。
 *    ★ 试过无效的三种：`lang=zh-hk`（仍是英文）、`lang=chi`（仍是英文）、
 *      `Cookie: lang=zh`（仍是英文）。**只有 query 参数 `lang=zh` 有效**。
 *    这个坑最危险 —— 英文标题在产物里看着"有内容"，中文用户完全没法用。
 *
 * ② **`channelIdList` 必须重复参数名，不能逗号拼接**：
 *    `channelIdList=096&channelIdList=099`  → 2 个台 ✅
 *    `channelIdList[]=096&channelIdList[]=099` → 同样可行（jQuery 默认序列化格式）
 *    `channelIdList=096,099` → 返回 `[[]]`，**静默空结果** ❌
 *    实测一次可传 **32 台**（43KB 响应）无截断，所以批量抓没问题。
 *
 * ③ **`epglist` 的 19 个字段里没有简介**：
 *    `key, vimProgramId, name, start, end, date, startTime, endTime, duration,
 *     recordable, restartTv, restartOtt, npvrProg, npvrEndTime, npvrStartTime,
 *     cid, sid, cc, isInWatchlist`
 *    → 简介只能走 `epgprogramdetail` 逐条抓（N+1 请求）。
 *    ★ 但**按标题去重后成本极低**：366 的 435 条节目只有 **33 个唯一标题**（省 92%），
 *      548 的 336 条只有 130 个（省 61%）。实测唯一标题的简介命中率 **95~97%**。
 *      所以本模块的策略是：**先抓全部节目 → 按标题去重 → 只抓唯一标题的详情 → 回填**。
 *      并发 8 路抓 60 个详情只要 5 秒，不会被限速。
 *
 * ④ **`start` / `end` 是 Unix 毫秒时间戳**（不是秒！和 ELTA 相反）。
 *    例：`1793125200000` = `2026-10-28 02:20 +08`。
 *
 * ⑤ **★★ `day=1` 是「从当前时刻起滚动 24 小时」，不是今天 00:00~24:00**：
 *    CI 在 UTC 19:30（北京 03:30）抓 day=1，首条就是 **03:30**，前面 3.5 小时是空的。
 *    day=2..7 才是规整的 00:00~24:00（实测每天 24.0h 满覆盖）。
 *    → 后果：**白天跑 CI 时，今天会缺 00:00~当前时刻**。
 *      本项目现有覆盖里 nowNews/nowBusiness 主源是 epgpw（6 天），
 *      本源的定位是「补天数」而不是「替主源」，正好避开这个缺陷（见下方用法说明）。
 *
 * ⑥ **广播日重叠要去重**：
 *    day=N 的返回范围是 `当天 00:00 ~ 次日 00:57`（含次日开头几条），
 *    相邻 day 之间有 5 条重复（实测 366：原始 443 → 去重 435）。
 *    → 必须**源内按 `start|name` 去重**，别指望 normalize 的 `startTs|title` 兜住
 *      （上游标题带「-29/10/26」「第1257集」这类后缀会变，见 pitfalls §3）。
 *
 * ⑦ **`day=8` 只有 1 条，`day=9/10` 是空数组**：可用天数就是 7 天，别外推。
 *
 * ⑧ **`Now Direct`（331）永远没有简介**（实测 0/7 唯一标题命中）。
 *    它是「随时直播各类时事新闻及记者会」的滚动直播台，标题恒定不变。
 *    → 别为了「凑简介数」把它算进去（pitfalls §5.1）。
 *
 * ★ 用法定位（硬规则 18：override 是「强制」不是「择优」，接新源必须变好）：
 *    本源**只用于补天**，不作为主源 override。原因：
 *    - 凤凰中文/资讯（548/366）已有 epgpw 主源，6 天 + 240 条简介，比本源强；
 *    - Now 新闻/财经（332/333）已有 epgpw 主源，5 天 + 271/247 条简介；
 *    - 本源的优势是**能补到 7 天**（epgpw 只给 6 天）。
 *    → 走 `alternatives` 补天链，让 pickMissingDays 只补空缺时段，不动主源内容。
 */
import { fetchText, log, hasRealDesc, mapLimit, countCoveredYmds } from '../utils.mjs'
import { CONFIG } from '../config.mjs'

const BASE = 'https://nowplayer.now.com'
const PAGE = `${BASE}/tvguide`
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

/** day 参数只有 1..7 有效（坑⑦） */
const MAX_DAY = 7

/** 一次请求最多传多少台（实测 32 台正常，保守取 24） */
const BATCH = 24

/** 抓详情并发数（实测 8 路 60 条 5 秒，无限速） */
const DESC_CONCURRENCY = 8

/** 抽样多少组标题来估简介覆盖率（越多越准，越慢；实测 8 组足够稳） */
const SAMPLE_TITLES = 8

/**
 * 简介缓存：programId → desc
 * 同一节目在 7 天里会重复出现（直播/重播），缓存能省掉大量请求。
 * 进程内缓存，一次 build 有效。
 */
const _descCache = new Map()

async function getText(url, opts = {}) {
  const res = await fetchText(url, {
    timeout: 25000,
    retries: 2,
    headers: {
      'User-Agent': UA,
      Referer: `${PAGE}?lang=zh`,
      Accept: '*/*',
      'X-Requested-With': 'XMLHttpRequest',
      ...(opts.headers || {}),
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status || res.error}`)
  return res.text
}

async function getJson(url, opts = {}) {
  const t = await getText(url, opts)
  return JSON.parse(t)
}

/** 香港时区的今天（YYYYMMDD）。Now TV 是香港站，日期按香港算（= 北京同时区） */
function hkYmd(offsetDays = 0) {
  return new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '')
}

/**
 * 从频道清单页提取全部频道 id + 中文名
 *
 * 页面结构（实测）：
 *   <div class="item free"><span class="ch-num">096</span>...<a href="/tvguide/channeldetail/096/1?...">
 *   <img class="ch-logo" ... />
 *
 * 中文名只能从 channeldetail 页的 `<title>` 拿（`Now TV網頁版 - 全日節目表 > 鳳凰衛視資訊台`），
 * 频道清单页本身只有编号和 logo。
 *
 * @returns [{ sourceId, name, num }]
 */
export async function fetchChannelList() {
  const html = await getText(`${PAGE}?lang=zh`)

  // 抓 channelbar 区块里的 ch-num
  const ids = new Set()
  const re = /<span class="ch-num">(\d+)<\/span>/g
  let m
  while ((m = re.exec(html))) ids.add(m[1])

  // 兜底：从 channeldetail 链接提取（页面里两者都有一份）
  if (!ids.size) {
    const re2 = /\/tvguide\/channeldetail\/(\d+)\/\d+/g
    while ((m = re2.exec(html))) ids.add(m[1])
  }

  const out = [...ids].sort().map((id) => ({ sourceId: id, name: '', num: id }))

  // 频道名只能从 channeldetail 页的 <title> 拿，逐台抓（并发 8 路，135 台约 10 秒）
  await mapLimit(out, DESC_CONCURRENCY, async (c) => {
    try {
      const h = await getText(`${BASE}/tvguide/channeldetail/${c.sourceId}/1?lang=zh`)
      const t = /<title>([^<]*)<\/title>/.exec(h)
      if (t) {
        // "Now TV網頁版 - 全日節目表 > 鳳凰衛視資訊台" → 取 ">" 之后
        const s = t[1].trim()
        const gt = s.lastIndexOf('>')
        c.name = (gt >= 0 ? s.slice(gt + 1) : s).trim()
      }
    } catch {
      /* 名字抓不到就留空，不影响节目抓取 */
    }
  })

  return out
}

/**
 * 批量抓多台某一天的节目（坑②：重复参数名）
 *
 * @param {string[]} sourceIds
 * @param {number} day 1..7
 * @returns {Map<string, Array>}  sourceId → 节目数组
 */
async function fetchDayBatch(sourceIds, day) {
  const q = sourceIds.map((id) => `&channelIdList=${encodeURIComponent(id)}`).join('')
  const url = `${BASE}/tvguide/epglist?day=${day}${q}&lang=zh` // ★ 坑①：lang=zh 必须带
  let j
  try {
    j = await getJson(url)
  } catch (e) {
    log.warn(`[nowplayer] epglist day=${day} 失败：${e.message}`)
    return new Map()
  }
  if (!Array.isArray(j)) return new Map()

  const out = new Map()
  for (let i = 0; i < sourceIds.length; i++) {
    const arr = Array.isArray(j[i]) ? j[i] : []
    out.set(sourceIds[i], arr)
  }
  return out
}

/** 把 epglist 的原始行转成标准行（坑④毫秒时间戳、坑⑥去重） */
function toRows(arr) {
  const seen = new Set()
  const rows = []
  for (const x of arr) {
    const st = Number(x.start)
    const et = Number(x.end)
    const title = String(x.name || '').trim()
    if (!Number.isFinite(st) || st <= 0) continue
    if (!Number.isFinite(et) || et <= 0 || et <= st) continue
    if (!title) continue

    // ★ 坑⑥：源内按 start|name 去重（相邻 day 有 5 条重叠）
    const key = `${st}|${title}`
    if (seen.has(key)) continue
    seen.add(key)

    rows.push({
      startTs: st, // 坑④：毫秒，直接用
      stopTs: et,
      title,
      desc: '', // 稍后按标题回填
      category: '',
      _pid: String(x.vimProgramId || ''),
    })
  }
  rows.sort((a, b) => a.startTs - b.startTs)
  return rows
}

/**
 * 抓单个节目的中文简介
 *
 * 详情里三个候选字段，按优先级取：
 *   chiSynopsis（中文简介） > synopsis（通用） > engSynopsis（英文，最后兜底）
 * ★ 必须带 `lang=zh`，不带时 chiSynopsis 常常是空（实测 366 的「鳳凰氣象站」
 *   不带 lang 时 chiSynopsis/synopsis/engSynopsis 三个全空）。
 */
async function fetchDesc(pid) {
  if (!pid) return ''
  if (_descCache.has(pid)) return _descCache.get(pid)

  let desc = ''
  try {
    const d = await getJson(
      `${BASE}/tvguide/epgprogramdetail?programId=${encodeURIComponent(pid)}&lang=zh`
    )
    const pick = [d.chiSynopsis, d.synopsis, d.engSynopsis]
      .map((s) => String(s || '').trim())
      .find((s) => s.length > 20)
    desc = pick || ''
  } catch {
    desc = ''
  }
  _descCache.set(pid, desc)
  return desc
}

/**
 * 抓某台某一天的节目（标准接口，签名与 epgpw/tdm/elta 一致）
 *
 * ⚠️ 本源的 day 是**序号**不是日期，所以这里要把 ymd 换算成 day 序号：
 *    day = (ymd - 今天) + 1
 *    今天 → 1，明天 → 2 ... 第 7 天 → 7
 *    过去的日期 → day <= 0，直接返回空（本源只给今天及以后）
 *    超过 7 天 → 空（坑⑦）
 *
 * ★ 简介回填：先抓全部节目，再按**唯一标题**去重抓详情（坑③）。
 *    同一标题在 7 天里会重复出现几十次（新闻台的「Now深宵新聞」出现 50+ 次），
 *    按标题去重能把详情请求量压到 1/3 ~ 1/10。
 *
 * @param sourceId 三位频道号（如 '332'）
 * @param weekday  1..7，不吃（本源用 day 序号）
 * @param ymd      YYYYMMDD
 * @param expectNames 不吃
 * @param forcePath   不吃
 */
export async function getDayProgrammes(sourceId, weekday, ymd) {
  const cid = String(sourceId || '').trim()
  if (!cid) return { programmes: [], pageTitle: '', error: 'no sourceId' }

  const today = hkYmd(0)
  const dayIdx = ymdToDayIndex(ymd, today)
  if (dayIdx < 1 || dayIdx > MAX_DAY) {
    return { programmes: [], pageTitle: '', error: `day ${dayIdx} 超出 1..${MAX_DAY}` }
  }

  const m = await fetchDayBatch([cid], dayIdx)
  const arr = m.get(cid) || []
  if (!arr.length) return { programmes: [], pageTitle: '', error: 'empty schedule' }

  const rows = toRows(arr)

  // ★ 坑③：按唯一标题去重，只抓一份简介
  await fillDescs(rows)

  return { programmes: rows.map(({ _pid, ...r }) => r), pageTitle: '' }
}

/** ymd → day 序号（今天=1） */
function ymdToDayIndex(ymd, todayYmd) {
  const a = Date.UTC(
    Number(ymd.slice(0, 4)),
    Number(ymd.slice(4, 6)) - 1,
    Number(ymd.slice(6, 8))
  )
  const b = Date.UTC(
    Number(todayYmd.slice(0, 4)),
    Number(todayYmd.slice(4, 6)) - 1,
    Number(todayYmd.slice(6, 8))
  )
  return Math.round((a - b) / 86400e3) + 1
}

/**
 * 按唯一标题回填简介
 *
 * 实测收益（CI run 40570434202 / 40571403150）：
 *   366: 435 条 → 33 个唯一标题（省 92%），命中 31/32 = 96%
 *   548: 336 条 → 130 个唯一标题（省 61%），命中 125/129 = 96%
 *   332: 266 条 → 48 个唯一标题（省 82%），命中 46/47 = 97%
 *   333: 242 条 → 85 个唯一标题（省 65%），命中 80/84 = 95%
 */
async function fillDescs(rows) {
  // 标题 → 第一个可用 pid
  const byTitle = new Map()
  for (const r of rows) {
    if (!byTitle.has(r.title) && r._pid) byTitle.set(r.title, r._pid)
  }
  const titles = [...byTitle.keys()]
  const descByTitle = new Map()

  await mapLimit(titles, DESC_CONCURRENCY, async (t) => {
    const d = await fetchDesc(byTitle.get(t))
    if (d) descByTitle.set(t, d)
  })

  for (const r of rows) {
    const d = descByTitle.get(r.title)
    if (d) r.desc = d
  }
}

/**
 * 频道清单 + 真实覆盖统计（对外标准接口）
 *
 * 按硬规则 11/14/17：
 *   - 真探 days（逐日抓，不按常数外推）
 *   - days 只算「今天及以后」
 *   - count / withDesc 都是真数，不估
 *
 * ★★ withDesc 必须真算，不能填 0（2026-10-28 踩过，别改回去）：
 *    第一版为了「省时间」把 withDesc 填 0，注释还写着「保守值，宁可排后面」。
 *    结果 build 日志里 nowplayer **一次都没被用上** —— 因为 webncode 也有
 *    `nowtv_366/548/332/333/331` 同名台，days 完全一样，按
 *    `days → withDesc → count` 排序时，nowplayer 的 0 让它永远排在 webncode 后面。
 *
 *    但实测质量是反的（CI run 40574446907）：
 *      鳳凰衛視資訊台  nowplayer 434条 272简介 7天  vs  webncode 383条 **0简介** 6天
 *      鳳凰衛視中文台  nowplayer 335条 276简介 7天  vs  webncode 293条 **0简介** 6天
 *      Now新聞台       nowplayer 265条 263简介 5天  vs  webncode 273条 **0简介** 5天
 *    → 填 0 等于把「唯一有简介的源」排到「零简介源」后面，正好是 pitfalls §6.7
 *      那个坑的镜像：数字看着保守，实际把好源锁死了。
 *
 * ★ 简介怎么省着真算：
 *    全量 135 台 × 7 天 × 逐条详情会跑几十分钟。这里按**标题分组后加权抽样**：
 *    对每台取「当天覆盖节目数最多的前 SAMPLE_TITLES 个标题」抓详情，
 *    再按这些标题**覆盖的节目数**算比例，外推到 count。
 *    为什么按节目数加权而不是按标题数：366 有 33 个唯一标题，31 个有简介（94%），
 *    但实际节目级覆盖只有 272/434 = 63% —— 没简介的那 2 个标题各占 80+ 条。
 *    按标题数算会高估到 94%，按节目数加权才接近真实。
 */
export async function listChannels() {
  const chs = await fetchChannelList()
  const todayYmd = hkYmd(0)

  // 逐日批量抓（每天一批，24 台一组）
  const perDay = new Map() // dayIdx → Map(sourceId → arr)
  for (let d = 1; d <= MAX_DAY; d++) {
    const m = new Map()
    for (let i = 0; i < chs.length; i += BATCH) {
      const slice = chs.slice(i, i + BATCH).map((c) => c.sourceId)
      const got = await fetchDayBatch(slice, d)
      for (const [k, v] of got) m.set(k, v)
    }
    perDay.set(d, m)
  }

  // 先算天数/条数（纯本地，不联网）
  //
  // ★ 天数必须按「覆盖满 6 小时」判，不能按「有节目」判（pitfalls §4 / §6.7）。
  //   实测踩到（2026-10-28，CI run 40623856220 诊断）：
  //     Now新聞台 332 的 day=6 只返回 1 条「11-01 23:30 ~ 11-02 10:30」，
  //     一条 11 小时的跨天节目。按「有节目就算 1 天」→ 报 6 天，
  //     但实际第 6 天只有这一条，播放器上等于没有节目单。
  //   修正后按 6 小时口径 → 5 天，与 epgpw 的 5 天一致（补不上是上游真没有）。
  const stats = []
  const allYmds = []
  for (let d = 1; d <= MAX_DAY; d++) {
    const ymd = hkYmd(d - 1)
    if (ymd >= todayYmd) allYmds.push(ymd)
  }
  for (const ch of chs) {
    const rowsAll = []
    let count = 0
    for (let d = 1; d <= MAX_DAY; d++) {
      const arr = (perDay.get(d) || new Map()).get(ch.sourceId) || []
      if (!arr.length) continue
      const rows = toRows(arr)
      if (!rows.length) continue
      const ymd = hkYmd(d - 1)
      if (ymd < todayYmd) continue
      rowsAll.push(...rows)
      count += rows.length
    }
    stats.push({ ch, days: countCoveredYmds(rowsAll, allYmds, CONFIG.dayFillMinHours), count })
  }

  // 再抽样算 withDesc（只对「有节目」的台，抽样标题抓详情）
  await mapLimit(
    stats.filter((s) => s.count > 0),
    DESC_CONCURRENCY,
    async (s) => {
      s.withDesc = await estimateDescCount(s.ch.sourceId, s.count, perDay)
    }
  )

  const out = stats.map((s) => ({
    source: 'nowplayer',
    region: 'HK',
    sourceId: s.ch.sourceId,
    name: s.ch.name || `Now-${s.ch.sourceId}`,
    logo: '',
    days: s.days,
    count: s.count,
    withDesc: s.withDesc || 0,
  }))

  const ok = out.filter((c) => c.days > 0).length
  const tot = out.reduce((s, c) => s + c.count, 0)
  const desc = out.reduce((s, c) => s + c.withDesc, 0)
  log.ok(
    `[nowplayer] ${ok}/${out.length} 个台有节目，共 ${tot} 条，抽样估简介 ${desc} 条（${Math.round((desc / (tot || 1)) * 100)}%）`
  )
  return out
}

/**
 * 抽样估计某台的简介条数
 *
 * 做法：取「今天」的节目（已经抓过，不用再请求），按标题分组，
 * 挑覆盖节目数最多的前 N 组抓详情，用它们的**节目数**算比例，外推到 count。
 *
 * @returns {number} 估计的带真实简介节目数
 */
async function estimateDescCount(sourceId, totalCount, perDay) {
  const arr = (perDay.get(1) || new Map()).get(sourceId) || []
  const rows = toRows(arr)
  if (!rows.length) return 0

  // 按标题分组，记录每组覆盖的节目数
  const groups = new Map()
  for (const r of rows) {
    const g = groups.get(r.title) || { n: 0, pid: r._pid }
    g.n++
    groups.set(r.title, g)
  }
  const sorted = [...groups.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, SAMPLE_TITLES)

  let covered = 0
  let withDesc = 0
  for (const [title, g] of sorted) {
    covered += g.n
    const d = await fetchDesc(g.pid)
    if (hasRealDesc(d, title)) withDesc += g.n
  }
  if (!covered) return 0

  const ratio = withDesc / covered
  return Math.round(totalCount * ratio)
}

export { log }
