/**
 * 搜视网 tvsou.com 数据源
 *
 * 实测（2026-10-26）：
 *   - 页面结构极干净：<tr><td>01:04</td><td>节目名</td></tr>
 *   - 全站 438 个唯一频道（央视 34 / 卫视 40 / 地方 300+ / 数字 24 / 高清 29）
 *   - w1..w7 对应周一..周日
 *   - 只有开始时间，没有结束时间 → 结束时间由"下一条的开始时间"推算
 *   - 港澳台频道有入口但节目表全空（实测 TVB/凤凰/港台 均 0 条）
 *
 * 注意：直连偶发 000（连接被重置），必须带重试；走代理反而更容易失败。
 *
 * ─── 2026-10-28 第十七轮：补真探 days / count ───────────────────────────────
 *
 * ★ 之前的缺陷：listChannels 只从分类页抓 hash + 名字，**从不探有没有节目**。
 *   476 条 catalog 全都没有 days 字段，而 match.mjs 的 pickBest 里
 *   `a.days || 0` 会把「缺字段」当成 0 —— 于是 tvsou 永远排在最后。
 *   表现是：澳门莲花（b6d548b0）/ 澳亚卫视（d5f45f0e）这类「有源却抓 0 条」
 *   的频道，报表里只有 `empty(tvsou:xxx=0)`，看不出是「源是空壳」还是「解析坏了」。
 *
 * ★★ 但真探之后必须承认一个事实（实测，别再照着「补 days 就能救」的思路改）：
 *   这两个台在 tvsou 上**本来就是空的**，探完还是 0 天 0 条。
 *   60 个随机频道 × 7 天的实测样本（2026-10-28）：54 个全年空、6 个有数据，
 *   而且 `difang`（地方，最多的一类）44 个样本**一个都没有节目**。
 *   tvsou 的「地方台清单」大量是只登记了台标、从来没录过节目单的空壳。
 *   所以本源的 days 只影响**排序**（谁当主源 / 补天先试谁），不会变出数据。
 *
 * ★ days 的口径和别的源不一样，别套 §6.7c 的「掐掉过去的天」：
 *   build 是把「目标日期」映射成 weekday（周一到周日）再去抓 `/epg/{hash}/w{N}`，
 *   7 个目标日期恰好覆盖 7 个 weekday。所以这里 days = **w1..w7 里有节目的 weekday 数**
 *   （0~7），与「今天之前 / 之后」无关 —— 站点只发当周，past/future 在这里没有意义。
 *   实测 w7（周日）经常还没发布，于是出现 days=6 的台，属正常。
 */
import { fetchText, parseTimeToTs, log } from '../utils.mjs'
import { probeDisabled, readProbeCache, writeProbeCache, makeProgress } from '../probe-cache.mjs'

const BASE = 'https://www.tvsou.com'

/** 频道列表入口（分类页） */
const CATEGORIES = ['yangshi', 'weishi', 'shuzi', 'gaoqing', 'difang']

/** 探测缓存文件名 + 口径版本（改 probeWeek 的算法必须 +1，否则旧缓存会让改动静默失效） */
const PROBE_CACHE = 'tvsou-probe'
const PROBE_VER = 1

/** 探测并发（tvsou 实测 ~1 请求/秒就压不上去了，别指望调大能快多少） */
const PROBE_CONC = Number(process.env.TVSOU_PROBE_CONC || 6)

/**
 * 从频道日页解析节目行
 *
 * 只返回原文（时间串 + 标题），时间戳交给调用方按自己的 ymd 补 ——
 * 探测时不需要时间戳（只数条数），抓取时才有 ymd。
 */
export function parseRows(html) {
  const rows = []
  const re = /<tr><td>(\d{2}:\d{2})<\/td><td>([\s\S]*?)<\/td>/g
  let m
  while ((m = re.exec(String(html || '')))) {
    const title = m[2].replace(/<[^>]*>/g, '').trim()
    if (!title) continue
    rows.push({ startRaw: m[1], title })
  }
  return rows
}

/**
 * 抓单频道单日节目
 * @param sourceId  tvsou 的 hash 频道 ID（如 b3666b9d）
 * @param weekday   1..7
 * @param ymd       该日日期 YYYYMMDD
 */
export async function getDayProgrammes(sourceId, weekday, ymd) {
  const url = `${BASE}/epg/${sourceId}/w${weekday}`
  const res = await fetchText(url, { timeout: 20000, retries: 3, retryDelay: 1200 })

  if (!res.ok) return { programmes: [], error: `HTTP ${res.status}` }

  const html = res.text
  const pageTitle = ((html.match(/<title>([^<]*)<\/title>/) || [])[1] || '').trim()

  // 港澳台空表特征
  if (html.includes('所选日期暂无可用节目单')) {
    return { programmes: [], pageTitle, error: 'empty-schedule' }
  }

  const rows = parseRows(html).map((r) => ({
    startTs: parseTimeToTs(r.startRaw, ymd),
    stopTs: null,
    title: r.title,
  }))

  return { programmes: rows, pageTitle, error: rows.length ? null : 'no-rows' }
}

/** tvsou 的台标是相对路径（/media/f/xxx/yyy），补全成绝对 URL */
function absLogo(u) {
  if (!u) return ''
  if (/^https?:\/\//i.test(u)) return u
  return `${BASE}${u.startsWith('/') ? '' : '/'}${u}`
}

/** UTC+8 的今天是周几（1=周一 … 7=周日），与 buildDateRange 的 weekday 口径一致 */
export function cstWeekday(date = new Date()) {
  const jsDay = new Date(date.getTime() + 8 * 3600e3).getUTCDay() // 0=周日
  return jsDay === 0 ? 7 : jsDay
}

/**
 * 探测单个频道：w1..w7 里有几天有节目、一共多少条
 *
 * ★ 为什么要早退（这一步决定了 catalog 重扫是 13 分钟还是 1 小时）：
 *   实测 88% 的 tvsou 频道是全年空的（尤其 difang 分类，44/44 全空）。
 *   先探「今天对应的 weekday」，这条是空的就直接判定空台返回，
 *   一个死台只花 1 个请求而不是 7 个。
 *
 * ★ 为什么「今天这天空 = 整个台空」这次是可以假设的：
 *   60 频道 × 7 天的样本里，**没有一个**「今天空但其它天有数据」的频道
 *   （w3 空但其它天非空的：0 个）。空台是整站都没录，不是某天漏了。
 *   有数据的台里出现的缺口只有 w7（周日还没发布）。
 *   如果以后样本里出现反例，把这里改成「先探 2 天、都空才早退」即可。
 *
 * @returns {Promise<{days: number, count: number}>} 失败/空台一律 {days:0, count:0}
 */
export async function probeWeek(sourceId, opts = {}) {
  // fetch 可注入（单测里用假 fetch 打桩，见 test/tvsou-days.test.mjs）
  const doFetch = opts.fetch || fetchText
  const cur = opts.weekday || cstWeekday()
  const order = [cur, ...[1, 2, 3, 4, 5, 6, 7].filter((w) => w !== cur)]

  let days = 0
  let count = 0
  for (let i = 0; i < order.length; i++) {
    const w = order[i]
    const res = await doFetch(`${BASE}/epg/${sourceId}/w${w}`, {
      timeout: 20000,
      retries: 2,
      retryDelay: 1000,
    })
    if (!res.ok) continue // 单天失败不计入（保守：宁可少报天数）
    const n = parseRows(res.text).length
    if (n > 0) {
      days++
      count += n
    } else if (i === 0) {
      // 今天这天空 → 判定空台，省掉剩下 6 个请求（见上方样本说明）
      return { days: 0, count: 0 }
    }
  }
  return { days, count }
}

/** 简单并发限流 */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (i < items.length) {
        const idx = i++
        out[idx] = await fn(items[idx], idx)
      }
    })
  )
  return out
}

/** 列出 tvsou 全站频道（供自动匹配） */
export async function listChannels() {
  const out = []
  const seen = new Set()

  for (const cat of CATEGORIES) {
    const res = await fetchText(`${BASE}/epg/${cat}/`, { timeout: 25000, retries: 3 })
    if (!res.ok) {
      log.warn(`[tvsou] 分类 ${cat} 抓取失败 HTTP ${res.status}`)
      continue
    }

    // 两种 HTML 结构都要兼容：
    //   A) <a href="/epg/{cat}/{hash}/" ...><span style="background:url('...')"></span><i>名称</i></a>
    //   B) <a href="/epg/{hash}/" target="_blank" title="名称节目表">名称</a>
    const reA =
      /<a href="\/epg\/[a-z]+\/([a-z0-9]+)\/"[^>]*><span style="background: url\('([^']*)'\)[^"]*"><\/span><i[^>]*>([^<]+)<\/i><\/a>/g
    const reB = /<a href="\/epg\/([a-z0-9]+)\/"[^>]*title="([^"]+?)节目表"/g

    let m
    while ((m = reA.exec(res.text))) {
      const [, hash, logo, name] = m
      if (seen.has(hash)) continue
      seen.add(hash)
      out.push({
        source: 'tvsou',
        group: cat,
        sourceId: hash,
        name: name.trim(),
        logo: absLogo(logo),
        // 真探前先给 0：pickBest 里 0 是安全默认（垫底），不会骗排序
        days: 0,
        count: 0,
        withDesc: 0,
        // ★ 只做备选，不参与主源竞争（见 match.mjs pickBest 的第 0 条注释）
        fallbackOnly: true,
      })
    }
    while ((m = reB.exec(res.text))) {
      const [, hash, name] = m
      if (seen.has(hash)) continue
      seen.add(hash)
      out.push({
        source: 'tvsou',
        group: cat,
        sourceId: hash,
        name: name.trim(),
        logo: '',
        days: 0,
        count: 0,
        withDesc: 0,
        // ★ 只做备选，不参与主源竞争（见 match.mjs pickBest 的第 0 条注释）
        fallbackOnly: true,
      })
    }
  }

  // ★ 逐台真探 days / count（见 probeWeek 注释，别改回「不探」或「硬编码 7」）
  if (probeDisabled('TVSOU_PROBE')) {
    log.warn('[tvsou] 探测已关闭（TVSOU_PROBE=0 / NO_SOURCE_PROBE=1），days 全为 0')
    return out
  }

  const cache = readProbeCache(PROBE_CACHE, PROBE_VER)
  const stats = { ...cache.stats }
  const todo = out.filter((c) => !(c.sourceId in stats))

  if (cache.hit) {
    log.info(`[tvsou] 复用今日探测缓存：${out.length - todo.length}/${out.length} 个频道（${cache.ymd}）`)
  }
  if (todo.length) {
    const tick = makeProgress('tvsou', todo.length, 50)
    await mapLimit(todo, PROBE_CONC, async (c) => {
      try {
        stats[c.sourceId] = await probeWeek(c.sourceId)
      } catch {
        stats[c.sourceId] = { days: 0, count: 0 }
      }
      tick()
    })
    writeProbeCache(PROBE_CACHE, PROBE_VER, stats)
  }

  for (const c of out) {
    const st = stats[c.sourceId]
    if (st) {
      c.days = st.days || 0
      c.count = st.count || 0
    }
  }

  const live = out.filter((c) => c.days > 0)
  log.ok(
    `[tvsou] 探测真实覆盖：${live.length}/${out.length} 个台有节目，` +
      `最多 ${Math.max(0, ...out.map((c) => c.days))} 天，共 ${out.reduce((s, c) => s + c.count, 0)} 条` +
      `（无简介源，withDesc 恒 0）`
  )
  return out
}

export const meta = {
  id: 'tvsou',
  label: '搜视网',
  hasStop: false,
  hasDesc: false,
}
