/**
 * 台湾中华电信 MOD 节目单数据源（mod.cht.com.tw）—— 2026-10-28 第十二轮新增
 *
 * 来源：用户提供的三个页面
 *   https://mod.cht.com.tw/頻道TV/全部.do       ← 频道总表
 *   https://mod.cht.com.tw/program.do?id=6       ← 民视无线台的节目单页（用户从上面点进来的）
 *
 * ★★ 用户没说「要挂 VPN」，实测本机确实要挂、CI 直连正常（本项目第四个境外源）：
 *   CI 解析到 `modweb-chtmod.cdn.hinet.net`（中华电信 203.66.32.x/34.x/35.x），
 *   `全部.do` 200/1.9s，`epginfob.php` 200/1.5s。→ 交 CI 抓（pitfalls §7.1c）。
 *
 * ★ 破解路径（关键：`program.do` 是个空壳，节目数据在 iframe 里）：
 *   1. 抓 `program.do?id=6`（60KB HTML），**页面里没有节目数据**。
 *      真正的节目表是一个 iframe：
 *      ```html
 *      <iframe src="https://modp.cht.com.tw/modinfo/epginfob.php?id=6">
 *      ```
 *      ★ 这个 iframe 指向**另一个域名** `modp.cht.com.tw`（不是 mod.cht.com.tw），
 *        只抓 mod.cht.com.tw 会以为「没有节目单」，很容易放弃。
 *   2. 直接抓 `https://modp.cht.com.tw/modinfo/epginfob.php?id=N&w=0` 就拿到完整 7 天 HTML。
 *   3. 频道清单在 `全部.do`（478KB），结构是：
 *      ```html
 *      <div class="number">6</div> ... <h3><a ...>民視HD</a></h3>
 *      ```
 *      注意：这个列表里还带「当前正在播的节目」和「时间」，但不是完整节目单，别用。
 *
 * 接口（全部实测 2026-10-28，CI run 40575970909 / 40590576999）：
 *   GET https://mod.cht.com.tw/頻道TV/全部.do                → 187 个频道
 *   GET https://modp.cht.com.tw/modinfo/epginfob.php?id=N&w=0 → 7 天节目（今天起 7 天）
 *   GET https://modp.cht.com.tw/modinfo/epginfob.php?id=N&w=1 → 再往后 7 天（11-04~11-10）
 *   GET ...&w=2 → 空
 *
 * ⚠️ 七个坑（全部实测，别改回去）：
 *
 * ① **`w=0` 是 7 天，不是 5 天**（第一版正则踩过）：
 *    周末那两天的日期被 `<font color='#c03'>` 包了一层：
 *      `<div class='item' style='background-color:#ccc;padding:5px;'>2026-10-30星期五</div>`
 *      `<div class='item' style='background-color:#ccc;padding:5px;'><font color='#c03'>2026-10-31星期六</font></div>`
 *    只匹配 `...>'(\d{4}-\d{2}-\d{2})` 会把周末两天漏掉，得出「w=0 只有 5 天且跳过周末」的
 *    错误结论。**必须把 `<font>` 标签剥掉再取日期。**
 *
 * ② **`w` 是「周序号」不是天数**：w=0 给 10-28~11-03，w=1 给 11-04~11-10（也是 7 天），w=2 空。
 *    → 可用 14 天，但本项目只要 7 天，只抓 w=0 就够。
 *
 * ③ **节目没有简介**：只有 `time`（HH:MM）和 `channelTitle`。
 *    `channelTitle` 末尾的 `(普)` `(護)` 是分级标记，不是简介。
 *    → 本源的 `withDesc` 恒为 0。价值在「补台湾本土台的节目时间表」。
 *
 * ④ **只有开始时间，没有结束时间**：每条 `<div class='time'> 01:30</div>` 只有一个时刻。
 *    结束时间 = 下一条的开始时间；当天最后一条 = 次日首条（跨天）或 24:00。
 *    → 必须按天把节目串起来算 stopTs，最后一条单独处理（见 `buildRows`）。
 *
 * ⑤ **节目可能从 00:00 之前开始**：实测 id=6 的 10-28 首条是 01:30，
 *    但 10-31 首条是 01:30、11-01 首条是 00:00 —— 不保证每天从 00:00 起。
 *    缺失的头部时段（00:00~首条）就是上游没给，**不要瞎补**（pitfalls §4 硬规则）。
 *
 * ⑥ **并发会偶发 500**：实测 P=1/P=3/P=5 都是 9 个 200 + 1 个 500（约 10% 失败率），
 *    但**串行重试 10 次全 200**。→ 每个台必须带 `retries: 2`，别指望一次成功。
 *    并发数保持在 4~6 即可，加大并发不会更快（响应本身就快，1.1~2.3s 跑完 10 个）。
 *
 * ⑦ **`id=2` 是「頻道總表」占位台**，7 天只有 7 条（每小时一条占位），别当正经频道统计。
 *
 * ★ 用法定位：本源**只做补天 / 兜底**，不做主源 override。原因见 `docs/pitfalls.md` §6.7：
 *   它没有简介，拿它当主源会把有简介的 epgpw 换掉。但对「epgpw 只给 1~2 天的台湾本土台」，
 *   它能补到 7 天，这正是本项目最大的缺口。
 */
import { fetchText, log, hasRealDesc, mapLimit, countCoveredYmds } from '../utils.mjs'
import { CONFIG } from '../config.mjs'

const LIST_URL = 'https://mod.cht.com.tw/%E9%A0%BB%E9%81%93TV/%E5%85%A8%E9%83%A8.do'
const EPG_BASE = 'https://modp.cht.com.tw/modinfo/epginfob.php'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

/** 抓取并发（坑⑥：10% 概率 500，靠 retries 兜） */
const CONCURRENCY = 5

/** 频道清单缓存（一次 build 内有效，187 台只抓一次页面） */
let _listCache = null

async function getText(url, timeout = 25000) {
  const res = await fetchText(url, {
    timeout,
    retries: 2, // ★ 坑⑥：偶发 500，必须重试
    retryDelay: 800,
    headers: { 'User-Agent': UA, Referer: 'https://mod.cht.com.tw/' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status || res.error}`)
  return res.text
}

/**
 * 频道清单（187 台）
 *
 * 页面结构（实测）：
 *   <div class="number">6</div>  ...（最多 900 字符内）... <h3><a ...>民視HD</a></h3>
 *
 * @returns [{ sourceId, name, num }]
 */
export async function fetchChannelList() {
  if (_listCache) return _listCache

  const html = await getText(LIST_URL, 35000)
  const re = /<div class="number">(\d+)<\/div>[\s\S]{0,900}?<h3><a[^>]*>([^<]+)<\/a><\/h3>/g
  const out = []
  const seen = new Set()
  let m
  while ((m = re.exec(html))) {
    const id = m[1]
    if (seen.has(id)) continue
    seen.add(id)
    out.push({ sourceId: id, name: m[2].trim(), num: id })
  }
  if (!out.length) throw new Error('频道清单解析为空（页面结构可能变了）')
  _listCache = out
  return out
}

/** 台湾时区的今天（YYYYMMDD） */
function twYmd(offsetDays = 0) {
  return new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '')
}

/**
 * 解析 epginfob.php 的 HTML → [{ date, items:[{hhmm,title}] }]
 *
 * ★ 坑①：周末日期被 <font color='#c03'> 包着，必须先剥标签
 * ★ 坑④：只有开始时刻，没有结束时刻
 */
export function parseEpgHtml(html) {
  const days = []
  // 按 epgdays 分块
  const blocks = html.split("<div class='epgdays'>").slice(1)
  for (const b of blocks) {
    // 日期头：把 <font> 剥掉再取 YYYY-MM-DD
    const head = b.slice(0, 260)
    const headPlain = head.replace(/<[^>]*>/g, '')
    const dm = /(\d{4})-(\d{2})-(\d{2})/.exec(headPlain)
    if (!dm) continue
    const date = `${dm[1]}${dm[2]}${dm[3]}`

    const items = []
    const pre = /<div class='(past|now|future)'[^>]*><div class='time'>\s*([\d:]+)<\/div><div class='channelTitle'>\s*([^<]+?)\s*<\/div>/g
    let pm
    while ((pm = pre.exec(b))) {
      const hhmm = pm[2].trim()
      const title = pm[3].trim()
      if (!/^\d{1,2}:\d{2}$/.test(hhmm) || !title) continue
      items.push({ hhmm, title })
    }
    days.push({ date, items })
  }
  return days
}

/** "HH:MM" → 当天分钟数 */
function toMin(hhmm) {
  const [h, mi] = hhmm.split(':').map(Number)
  return h * 60 + mi
}

/**
 * 把「只有开始时刻」的节目串成带 stopTs 的行
 *
 * ★★ 坑④-1（2026-10-28 产物实测发现，最严重的一个）：**时区**。
 *   页面给的 `HH:MM` 是**台湾本地时间（UTC+8）**，不是 UTC。
 *   第一版写 `baseTs = Date.UTC(y, m, d)` 当当天 00:00 —— 那其实是北京 08:00，
 *   于是全部节目**整体晚 8 小时**，而且跨天：10-28 的 00:00 节目变成 10-28 08:00，
 *   10-28 的 20:00 节目溢出到 10-29 04:00。
 *
 *   实测证据（产物 epg.xml，三立综合台主源换成 mod:301 之后）：
 *     MOD 页面：`<div class='time'> 00:00</div>`（台湾 10-28 00:00）
 *     产物 XML：`<programme start="20261028080000 +0800"`  ← 晚了 8 小时
 *
 *   ⚠️ 这个 bug 的隐蔽性：`countCoveredDays` 按「小时覆盖」算，
 *      偏移 8 小时后每天仍覆盖 24 小时，所以「满 7 天」指标**不降反升**（203→224），
 *      报表好看、日志全绿，只有把 XML 拆开看具体时刻才看得出来。
 *      属于 pitfalls §6.7 那类「数据看着更好，内容是错的」。
 *
 *   正确写法：`Date.UTC(y, m, d) - 8 * 3600e3` = 台湾当天 00:00 的 UTC 时刻。
 *   （对照 kbro.mjs 的 `parseKbroTime`：`Date.UTC(+y, +mo-1, +d, +h-8, +mi, +se)`）
 *
 * ★ 坑④-2：结束时间 = 下一条的开始时间。
 *   当天最后一条的结束时间 = 次日首条开始时间（若次日首条是 00:00 则就是 24:00）。
 *   没有次日数据时按 24:00 收（pitfalls §3：宁可短，不要瞎延）。
 *
 * ★ 跨天处理：MOD 的节目是「当天 00:00~24:00」切的，
 *   次日首条若不是 00:00（如 01:30），说明 00:00~01:30 上游没给，
 *   这时前一天的末条按 24:00 收（而不是延到次日 01:30），避免凭空造出 90 分钟节目。
 */
export function buildRows(days, ymd) {
  const target = days.find((d) => d.date === ymd)
  if (!target || !target.items.length) return []

  // ★★ 坑④-1：减 8 小时，把「台湾当天 00:00」换成正确的 UTC 时刻
  const baseTs =
    Date.UTC(
      Number(ymd.slice(0, 4)),
      Number(ymd.slice(4, 6)) - 1,
      Number(ymd.slice(6, 8))
    ) -
    8 * 3600e3
  const rows = []
  for (let i = 0; i < target.items.length; i++) {
    const it = target.items[i]
    const startTs = baseTs + toMin(it.hhmm) * 60e3
    let stopTs
    if (i + 1 < target.items.length) {
      stopTs = baseTs + toMin(target.items[i + 1].hhmm) * 60e3
    } else {
      // ★ 末条一律收到 24:00，不延到次日首条（见上方注释）。
      stopTs = baseTs + 86400e3
    }
    if (stopTs <= startTs) continue
    // 单条超过 6 小时视为上游异常（实测正常最长 2h15m）
    if (stopTs - startTs > 6 * 3600e3) continue
    rows.push({
      startTs,
      stopTs,
      title: it.title,
      desc: '', // ★ 坑③：本源无简介
      category: '',
    })
  }
  return rows
}

/**
 * 抓某台某一天的节目（标准接口）
 *
 * ⚠️ 本源的接口按「周」返回 7 天，所以这里**每次请求都拿整周再挑当天**。
 *   为了不重复请求，用 `_dayCache` 缓存「sourceId → 整周解析结果」。
 *
 * @param sourceId 频道号（'6'）
 * @param weekday  不吃
 * @param ymd      YYYYMMDD
 */
export async function getDayProgrammes(sourceId, weekday, ymd) {
  const cid = String(sourceId || '').trim()
  if (!cid) return { programmes: [], pageTitle: '', error: 'no sourceId' }

  const today = twYmd(0)
  // w 只有 0/1 有效（坑②），按 ymd 落在哪一周选
  const diff = dayDiff(ymd, today)
  if (diff < 0 || diff > 13) {
    return { programmes: [], pageTitle: '', error: `日期 ${ymd} 超出 MOD 可用范围（今天+13 天内）` }
  }
  const w = diff < 7 ? 0 : 1

  let days
  try {
    days = await fetchWeek(cid, w)
  } catch (e) {
    return { programmes: [], pageTitle: '', error: e.message }
  }
  const rows = buildRows(days, ymd)
  if (!rows.length) return { programmes: [], pageTitle: '', error: 'empty schedule' }
  return { programmes: rows, pageTitle: '' }
}

/** 整周缓存：`${id}|${w}` → 解析后的 days */
const _weekCache = new Map()

async function fetchWeek(cid, w) {
  const key = `${cid}|${w}`
  if (_weekCache.has(key)) return _weekCache.get(key)
  const html = await getText(`${EPG_BASE}?id=${encodeURIComponent(cid)}&w=${w}`)
  const days = parseEpgHtml(html)
  _weekCache.set(key, days)
  return days
}

/** 两个 YYYYMMDD 相差几天 */
function dayDiff(a, b) {
  const pa = Date.UTC(Number(a.slice(0, 4)), Number(a.slice(4, 6)) - 1, Number(a.slice(6, 8)))
  const pb = Date.UTC(Number(b.slice(0, 4)), Number(b.slice(4, 6)) - 1, Number(b.slice(6, 8)))
  return Math.round((pa - pb) / 86400e3)
}

/**
 * 频道清单 + 真实覆盖统计（对外标准接口）
 *
 * 按硬规则 11/14/17：真探 days、只算今天及以后、count 真数。
 * withDesc 恒 0（坑③，已确认为 0 非未探测），但**必须显式写 0 而不是省略**
 * —— 省略会让 pickBest 拿到 undefined。
 *
 * ★ 天数按「覆盖满 6 小时」判，不按「有节目」判（pitfalls §4）。
 *   MOD 有大量「某天只有 2~3 条垫片」的情况，按条数会把半天空白算成 1 天。
 */
export async function listChannels() {
  const chs = await fetchChannelList()
  const todayYmd = twYmd(0)
  const allYmds = []
  for (let i = 0; i < 7; i++) allYmds.push(twYmd(i))

  const out = []
  await mapLimit(chs, CONCURRENCY, async (ch) => {
    let days = []
    try {
      days = await fetchWeek(ch.sourceId, 0)
    } catch (e) {
      log.warn(`[mod] 探测 ${ch.name} 失败：${e.message}`)
      return
    }
    const rowsAll = []
    let count = 0
    let withDesc = 0
    for (const d of days) {
      if (d.date < todayYmd) continue // 只算今天及以后（pitfalls §6.7c）
      const rows = buildRows(days, d.date)
      if (!rows.length) continue
      rowsAll.push(...rows)
      count += rows.length
      for (const r of rows) if (hasRealDesc(r.desc, r.title)) withDesc++
    }
    out.push({
      source: 'mod',
      region: 'TW',
      sourceId: ch.sourceId,
      name: ch.name,
      logo: '',
      days: countCoveredYmds(rowsAll, allYmds, CONFIG.dayFillMinHours),
      count,
      withDesc,
    })
  })

  const ok = out.filter((c) => c.days > 0).length
  const tot = out.reduce((s, c) => s + c.count, 0)
  log.ok(`[mod] ${ok}/${out.length} 个台有节目，共 ${tot} 条（无简介源，withDesc 恒 0）`)
  return out
}

export { log }
