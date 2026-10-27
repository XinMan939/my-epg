/**
 * 香港电视节目表数据源（tv.webncode.com）—— 2026-10-27 第八轮新增
 *
 * 来源：用户提供的 Android APK「TV Guide」（com.webncode.tv.mobile）。
 * 逆向 `assets/index.android.bundle` 只拿到域名 `https://tv.webncode.com`，
 * 接口是逐个猜出来的（Spring Boot 后端，404 会返回标准 timestamp/status/error/path JSON）。
 *
 * ★ 为什么值得接（实测 2026-10-27 23:3x）：
 *   1. **HOY TV** 从「0 天 0 条」变成「6 天 234 条 52 条简介」—— 四源全无的缺口直接补上。
 *   2. **HOY 資訊台 / HOY 國際財經台** 两个新台，现网一个都没有。
 *   3. **翡翠台 8 天完整、69% 简介**，比 epgpw 的 7 天 71% 天数更长（可以做交叉校验）。
 *   4. myTV SUPER 免费区有一批内地国际频道（浙江国际、湖南国际、大湾区、深圳卫视…），
 *      但**实测是占位数据**（见下方 ⚠️②），不要指望它救「浙江国际」。
 *
 * 接口（逆向 + 实测）：
 *   GET /api/channels                        → 6 个台组
 *   GET /api/channels/{provider}             → 该台组的频道列表（含 number / name）
 *   GET /api/schedule/{channelId}            → 今天（含昨天尾巴 + 今天全天）
 *   GET /api/schedule/{channelId}/{YYYY-MM-DD} → 指定那一天  ★ 日期只能走路径，不能走 query
 *
 * ⚠️ 四个坑（全部实测，别改回去）：
 *
 * ① **日期参数只认路径形式**。
 *    `/api/schedule/tvb_jade?date=2026-10-28` 返回的仍是 `date: 2026-10-27`，
 *    而且 HTTP 200、46 条数据看着完全正常 —— 典型的静默失败。
 *    我试过 day / d / dt / ymd / start / offset / days 七种 query 名，**全部被忽略**。
 *    正确写法是 `/api/schedule/tvb_jade/2026-10-28`。
 *
 * ② **mytvsuper 的内地国际频道是占位数据**。
 *    浙江国际（mytvsuper_ZJTV）、湖南国际（mytvsuper_HNTV）每天 7 条，
 *    标题和简介都是同一句「XX電視台國際頻道全日24小時為你送上精彩節目」，
 *    切成 4 小时一块。**看着 100% 有简介，实际零信息量**。
 *    这类数据比"空"更危险：报表上简介率 100%，用户打开全是废话。
 *    → 接入时用 `PLACEHOLDER_TITLE` 过滤掉，宁可留空也不要假数据。
 *
 * ③ **时间戳是 UTC（带 Z）**。`2026-10-26T17:00:00.000Z` = 北京 10-27 01:00。
 *    直接用 Date.parse 拿到的是正确绝对时间，不用加减；但判断「属于哪一天」
 *    必须按 +08:00 换算。这跟 fengshows 是同一类坑。
 *
 * ④ **可用日期数每个台不一样**（availableDates 字段）。
 *    tvb_jade 10 天、fantv 8 天、rthk 8 天、部分 nowtv 7 天。
 *    越界日期不会报错，会返回空 schedule + 空 availableDates，
 *    所以抓之前先看 availableDates，别硬猜。
 */
import { fetchText, log, hasRealDesc } from '../utils.mjs'

const BASE = 'https://tv.webncode.com'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

/** 6 个台组（实测 /api/channels 返回），用于扫清单 */
export const PROVIDERS = ['tvb', 'viutv', 'nowtv', 'rthk', 'mytvsuper', 'fantv']

/**
 * ★ 占位标题黑名单（见 ⚠️②）
 *
 * 这些标题的共同特征：整段是"频道在播"的废话，不含任何节目信息。
 * 命中就整条丢弃 —— 保留它会让「简介覆盖率」这个指标彻底失真。
 */
const PLACEHOLDER_TITLE =
  /^(?:.*?(?:全日\s*24\s*小時|24\s*小時為你送上|精彩節目|節目預告|敬請期待|稍後播出|待定|暫無節目|電視節目)\s*)$/

/**
 * 抓某台某一天的节目
 *
 * @param sourceId  webncode 的频道 id（如 tvb_jade / fantv_77）
 * @param weekday   1..7 —— 这个源不吃 weekday，只为对齐接口签名
 * @param ymd       YYYYMMDD
 * @returns { programmes, pageTitle, error }
 */
export async function getDayProgrammes(sourceId, weekday, ymd) {
  if (!sourceId) return { programmes: [], pageTitle: '', error: 'no sourceId' }

  // YYYYMMDD → YYYY-MM-DD（★ 必须走路径，见 ⚠️①）
  const d = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
  const url = `${BASE}/api/schedule/${encodeURIComponent(sourceId)}/${d}`

  let res
  try {
    res = await fetchText(url, {
      timeout: 20000,
      retries: 2,
      headers: { 'User-Agent': UA, Referer: `${BASE}/` },
    })
  } catch (e) {
    return { programmes: [], pageTitle: '', error: e.message }
  }
  if (!res.ok) return { programmes: [], pageTitle: '', error: `HTTP ${res.status}` }

  let j
  try {
    j = JSON.parse(res.text)
  } catch {
    return { programmes: [], pageTitle: '', error: 'JSON parse failed' }
  }

  const pageTitle = (j.channel && j.channel.name) || ''
  const arr = Array.isArray(j.schedule) ? j.schedule : []
  if (!arr.length) return { programmes: [], pageTitle, error: 'empty schedule' }

  // ★ 日期越界时后端返回的是「今天」而不是空，靠 j.date 校验（见 ⚠️①）
  if (j.date && j.date !== d) {
    return { programmes: [], pageTitle, error: `date mismatch: asked ${d}, got ${j.date}` }
  }

  const rows = []
  for (const x of arr) {
    if (!x.start || !x.name) continue
    const title = String(x.name).trim()
    if (!title) continue
    // ★ 占位数据整条丢弃（见 ⚠️②）
    if (PLACEHOLDER_TITLE.test(title)) continue

    const startTs = Date.parse(x.start)
    if (!Number.isFinite(startTs)) continue
    const stopTs = x.end ? Date.parse(x.end) : null

    const desc = x.description ? String(x.description).trim() : ''
    rows.push({
      startTs,
      stopTs: Number.isFinite(stopTs) ? stopTs : null,
      title,
      // ★ desc 不能复读标题（pitfalls §5.1），否则会锁死补简介的位置
      desc: desc && desc !== title ? desc : '',
    })
  }

  rows.sort((a, b) => a.startTs - b.startTs)
  return { programmes: rows, pageTitle }
}

/**
 * 探测单个频道真实的可用天数和节目密度（读 availableDates + 当天 schedule）
 *
 * ★ 为什么必须真探（2026-10-28 踩过，别改回硬编码 7）：
 *   第一版 `days: 7` 是硬编码的乐观值，直接骗过了 match.mjs 的 pickBest()。
 *   Now新聞台 / Now財經台 明明 epgpw 有「6 天 325 条 323 简介」，
 *   却因为 webncode 自报 days=7 被选中，实际只有「5 天 273 条 133 简介」——
 *   **简介直接掉一半，天数还少一天，而且日志里一切正常**。
 *   这是典型的"自报数据骗排序"，和 catalog 缺 days 字段那次是同一类错误。
 *
 * ★ count 也必须给（不能恒为 0）：
 *   pickBest 的排序是「天数 → 条数」。count 恒 0 时，webncode 要么靠天数压过
 *   一个条数多十倍的源，要么在平局时无条件输掉，两种都不对。
 *   这里用「当天条数 × 天数」外推总量，口径和 epgpw 的 count（全期总条数）一致。
 *
 * 越界/失败时返回 {days:0, count:0}，让 pickBest 老老实实把它排在后面。
 */
async function probeStat(sourceId) {
  try {
    const res = await fetchText(`${BASE}/api/schedule/${encodeURIComponent(sourceId)}`, {
      timeout: 15000,
      retries: 1,
      headers: { 'User-Agent': UA, Referer: `${BASE}/` },
    })
    if (!res.ok) return { days: 0, count: 0, withDesc: 0 }
    const j = JSON.parse(res.text)
    if (!Array.isArray(j.availableDates)) return { days: 0, count: 0, withDesc: 0 }
    const days = j.availableDates.length
    const arr = Array.isArray(j.schedule) ? j.schedule : []
    // 当天条数当密度样本（占位数据已在 getDayProgrammes 过滤，这里只做量级估计）
    const perDay = arr.length
    // 当天真简介比例，外推到全期
    const descPerDay = arr.filter((x) => {
      const t = String(x.name || '').trim()
      const d = String(x.description || '').trim()
      return t && !PLACEHOLDER_TITLE.test(t) && hasRealDesc(d, t)
    }).length
    return { days, count: perDay * days, withDesc: descPerDay * days }
  } catch {
    return { days: 0, count: 0, withDesc: 0 }
  }
}

/** 简单并发限流：同时最多 n 个，避免 246 个请求把对方打挂 */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return out
}

/**
 * 频道清单
 *
 * 逐个台组扫（6 个请求）拿到频道名，再逐台探测真实可用天数。
 *
 * ⚠️ 天数必须真探，不能硬编码（见 probeDays 注释）。
 *    246 个台 × 1 请求，6 并发约 30 秒，只在 catalog/init/build 重扫时跑一次，
 *    结果落进 catalog.json 缓存 24 小时，日常 build 复用。
 */
export async function listChannels() {
  const out = []
  for (const p of PROVIDERS) {
    let res
    try {
      res = await fetchText(`${BASE}/api/channels/${p}`, {
        timeout: 20000,
        retries: 2,
        headers: { 'User-Agent': UA, Referer: `${BASE}/` },
      })
    } catch (e) {
      log.warn(`[webncode] 台组 ${p} 抓取失败：${e.message}`)
      continue
    }
    if (!res.ok) {
      log.warn(`[webncode] 台组 ${p} HTTP ${res.status}`)
      continue
    }

    let j
    try {
      j = JSON.parse(res.text)
    } catch {
      log.warn(`[webncode] 台组 ${p} JSON 解析失败`)
      continue
    }

    const list = Array.isArray(j.channels) ? j.channels : []
    for (const c of list) {
      if (!c.id) continue
      // 名字里带频道号前缀（"81 翡翠台"），去掉数字更利于匹配
      const name = String(c.name || c.id)
        .replace(/^\d+\s+/, '')
        .trim()
      if (!name) continue
      out.push({
        source: 'webncode',
        region: 'HK',
        sourceId: c.id,
        name,
        logo: '',
        days: 0, // 下面真探后覆盖；0 是安全默认（排序时垫底，不会骗 pickBest）
        count: 0,
      })
    }
  }

  // ★ 逐台探真实天数与条数（见 probeStat 注释，别改回硬编码）
  const probed = await mapLimit(out, 6, async (c) => {
    const st = await probeStat(c.sourceId)
    return { ...c, days: st.days, count: st.count, withDesc: st.withDesc }
  })
  const okCount = probed.filter((c) => c.days > 0).length
  log.ok(
    `[webncode] 探测真实覆盖：${okCount}/${probed.length} 个台有节目，最多 ${Math.max(0, ...probed.map((c) => c.days))} 天`
  )

  return probed
}

export { log }
