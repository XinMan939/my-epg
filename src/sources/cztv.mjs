/**
 * 浙江广电「新蓝网」官方源（p.cztv.com）—— 2026-10-28 第十五轮新增
 *
 * 起因：用户给了 https://www.cztv.com/liveTV/108 的截图，页面右侧有完整节目单，
 * 问「这个页面真的有 epg，你再试着抓一下」。
 *
 * ★★ 先纠正一个旧结论：docs 里写的是「纯 SPA + 全压缩分包，接口未破解」——
 *    **那个结论是错的**。不是破解不了，是只看了首页那 3.9KB 的壳就下判断了。
 *    分包根本没有压缩，接口也没有签名，全程 curl + grep 就能搞定，不需要 playwright。
 *
 * 破解路径（4 步，可复用）：
 *   1. `curl https://www.cztv.com/liveTV/108` → 只有 SPA 壳，但壳里有
 *      `<script type="module" src="/assets/index-XXXX.js">`，这就是入口
 *   2. 入口 1.2MB，是**路由表**。里面直接写着
 *      `{path:"/liveTV/:id?", name:"directSeedingTV", component:()=>import("./directSeedingTV-XXXX.js")}`
 *      ★ 关键：路由表里的 `import()` 字符串就是分包文件名，不用去猜 hash
 *   3. 该分包开头几行是**全部依赖清单**：
 *      `import{d as j,e as D,f as E}from"./new-XXXX.js"`
 *      —— j 取频道表、D 取播放地址、E 取节目单，三个函数都在 new-XXXX.js
 *   4. `new-XXXX.js` 里一眼看到（全都明文）：
 *      ```js
 *      n = () => s({ url: 'api/paas/channel/tv' })                          // 频道表
 *      c = (a, t) => s({ url: `api/paas/program/${a}/${t}` })               // 节目单
 *      ```
 *      base URL `https://p.cztv.com/` 写在 `reqOnline-XXXX.js` 的 `axios.create({baseURL})`。
 *
 * 接口（2026-10-28 实测，全部免鉴权免签名）：
 *   GET https://p.cztv.com/api/paas/channel/tv
 *       → content.list[]: { station_code, name, logo, station_playing }
 *         实测 10 个台：101 浙江卫视 / 102 钱江都市 / 103 经济生活 / 104 教科影视 /
 *         106 民生休闲 / 107 新闻 / 108 少儿频道 / 110 浙江国际 / 111 好易购 / 112 之江纪录
 *   GET https://p.cztv.com/api/paas/program/{station_code}/{yyyymmdd}
 *       → content.list[0]: { station_id, station_name, station_date, list[] }
 *         list[]: { program_title, play_time, duration, program_id, ... }
 *
 * ★★★ 三个必须记住的坑：
 *
 * ① **`play_time` 是「毫秒」不是秒**（`1793116800000` = 北京 2026-10-28 00:00）。
 *    前端 `new Date(Number(p.play_time))` 就是这个原因。当秒处理会得到 1970 年。
 *    `duration` 也是**毫秒**（`1600000` = 26.7 分钟）。
 *
 * ② ★★★ **只有「今天」是真实节目单，明天起全是占位**（本文件存在的最大理由）
 *    实测 2026-10-28 16:00 的 10 个台：
 *      101 浙江卫视  今天 98 条真实  / 明天 24 条，全是「精彩节目」×60min
 *      108 少儿频道  今天185 条真实  / 明天 24 条，全是「精彩节目」
 *      112 之江纪录  今天 55 条真实  / 明天 24 条，全是「精彩节目」
 *      ……10 个台无一例外，往后 6 天都是同一份 24 条占位
 *
 *    如果把 7 天照单全收，会得到 `days=7 / count=168`，
 *    在 `pickBest` 里以「天数最多」**稳赢** epgpw 的真实数据 ——
 *    而且这次连条数都是真的（168 条确实存在），只是**内容全是空壳**。
 *    这是 §6.7 那类「自报数据骗排序」的变种：以前是条数虚高，这次是条数真实但内容假。
 *    → 所以必须按**内容**过滤（见 isFiller），过滤后 cztv 的真实天数就是 **1 天**。
 *      这是源本身的限制，不是 bug，别试图「修好」它。
 *
 * ③ **没有简介字段**。整条只有 title / time / duration / program_id。
 *    → 本源的定位是「补空台、补低条数台」，**不是简介源**，不要在后处理里指望它。
 *
 * ★ 为什么只接 110（浙江国际）和 108（浙江少儿）就够：
 *   `pickBest` 的排序是 `days → withDesc → count`。cztv 只有 1 天 + 0 简介，于是：
 *     浙江经视(epgpw 1天/52条/40简介) vs cztv(1天/120条/0简介) → epgpw 赢（withDesc 40>0）
 *     浙江民生休闲(1天/28条/24简介) vs cztv(1天/114条/0简介)          → epgpw 赢
 *     浙江少儿(1天/24条/**0简介**)      vs cztv(1天/185条/0简介)      → **cztv 赢**（count）
 *     浙江国际(epgpw **0 天**)          vs cztv(1天/81条)             → **cztv 赢**（days）
 *   即「有简介的台自动不被抢，空台和 0 简介的低条数台自动被补」——不需要写 override。
 *   这也顺带验证了上一轮踩的 §6.7h：**想要高简介源不被换掉，靠职责分离/排序，不靠 override 硬顶**。
 */
import { fetchText, log, countCoveredYmds, mapLimit } from '../utils.mjs'

const BASE = 'https://p.cztv.com/api/paas'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

/** 探测窗口：今天起 7 天。cztv 只有今天真实，但要真探才能知道，不能外推（§6.7） */
const PROBE_DAYS = 7

/**
 * 占位条目判定（见 ★★★②）
 *
 * 「精彩节目」是 cztv 给未来天填的模板：一天 24 条、每条 60 分钟、标题完全一样。
 * 实测 111 好易购连**今天**都是这份占位 → 这个台等于没有节目单，不该进 catalog。
 *
 * ⚠️ 只按标题就够了，**不要**按「60 分钟」或「24 条」判：真实节目里
 *    也有 60 分钟的栏目（《凡人歌》单集 45~60 分钟），拿时长当条件会误杀。
 */
const FILLER_RE = /^(?:精彩节目|敬请期待|节目预告|测试信号)$/

function isFiller(p) {
  return FILLER_RE.test(String(p?.program_title || '').trim())
}

/**
 * 补全台名（★★ 不补就少接一个台，实测踩过）
 *
 * cztv 的频道表里有一半是**裸名**：`少儿频道` / `新闻` / `经济生活` / `民生休闲` /
 * `教科影视` / `钱江都市` / `之江纪录` / `好易购`。
 * 而我们的目标频道叫 `浙江少儿`（别名 `浙江少儿频道`），归一化后 `少儿频道` ≠ `浙江少儿`，
 * 三级匹配（精确/别名/包含）全都不中 —— **cztv 的少儿频道根本进不了候选池**，
 * 于是 185 条的源拿不到、继续用 epgpw 那 24 条。这是本轮实测发现的，
 * 不是猜的：加名前 match 结果里 `浙江少儿` 仍是 `epgpw:539691`。
 *
 * 补成 `浙江少儿频道` 后走的正是目标别名，精确命中。
 *
 * ★ 为什么敢补：cztv 是**浙江广电集团**官网，这 10 个台本来就全是浙江的，
 *   `少儿频道` 的正式全称就是「浙江少儿频道」。这不是编造，是补全省名。
 * ★ 为什么必须补：裸名 `新闻` / `少儿频道` 在 catalog 里是**跨省通用词**，
 *   不补省名就有机会被别的省的「新闻频道」抢走（或反过来抢别人的）。
 */
function fullName(raw) {
  const n = String(raw || '').trim()
  if (!n) return ''
  if (/^(?:浙江|之江)/.test(n)) return n
  return `浙江${n}`
}

async function getJson(url, { retries = 2 } = {}) {
  const res = await fetchText(url, {
    timeout: 20000,
    retries,
    headers: {
      'User-Agent': UA,
      Referer: 'https://www.cztv.com/',
      Accept: 'application/json, text/plain, */*',
    },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status || res.error}`)
  const j = JSON.parse(res.text)
  // 成功标志是 state===0（不是 code===0，cztv 和 tdm 不一样）
  if (j && typeof j.state === 'number' && j.state !== 0) {
    throw new Error(j.alertMessage || j.message || 'api error')
  }
  return j
}

/** yyyymmdd（北京）—— 与工程其他地方一致，别用 TZ 环境变量（§7.1e） */
function ymdInCST(offsetDays = 0) {
  return new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '')
}

/**
 * 抓某台某一天的节目
 *
 * @param sourceId station_code（如 '110'）
 * @param weekday  1..7 —— 不吃 weekday，只为对齐统一签名
 * @param ymd      YYYYMMDD
 * @returns { programmes, pageTitle, error }
 */
export async function getDayProgrammes(sourceId, weekday, ymd) {
  const code = String(sourceId || '').trim()
  if (!/^\d+$/.test(code)) return { programmes: [], pageTitle: '', error: 'bad sourceId' }
  if (!/^\d{8}$/.test(String(ymd || ''))) return { programmes: [], pageTitle: '', error: 'bad ymd' }

  let j
  try {
    j = await getJson(`${BASE}/program/${code}/${ymd}`)
  } catch (e) {
    return { programmes: [], pageTitle: '', error: e.message }
  }

  const st = j?.content?.list?.[0]
  if (!st) return { programmes: [], pageTitle: '', error: 'empty schedule' }

  const items = []
  for (const p of Array.isArray(st.list) ? st.list : []) {
    if (isFiller(p)) continue
    const ts = Number(p.play_time) // ★ 毫秒（见坑①）
    const dur = Number(p.duration)
    const title = String(p.program_title || '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!title || !Number.isFinite(ts) || ts <= 0) continue
    items.push({ ts, dur: Number.isFinite(dur) && dur > 0 ? dur : 0, title })
  }
  if (!items.length) return { programmes: [], pageTitle: st.station_name || '', error: 'empty schedule' }

  // 上游偶有乱序（广告插播会导致同一分钟两条），统一按开始时间升序
  items.sort((a, b) => a.ts - b.ts)

  const rows = []
  for (let i = 0; i < items.length; i++) {
    const x = items[i]
    const next = items[i + 1]
    let stopTs = next ? next.ts : x.ts + (x.dur || 3600e3)
    // ★ 上游偶尔漏一条导致「上一条的 stop 被撑到几小时后」，
    //   那会把半天算成一个节目、并把覆盖时长虚高。间隔明显大于自报时长时退回时长。
    if (x.dur > 0 && stopTs - x.ts > Math.max(x.dur * 2, 6 * 3600e3)) stopTs = x.ts + x.dur
    if (stopTs <= x.ts) stopTs = x.ts + (x.dur || 60e3)
    rows.push({ startTs: x.ts, stopTs, title: x.title, desc: '' }) // 无简介（见坑③）
  }

  return { programmes: rows, pageTitle: st.station_name || '' }
}

/**
 * 频道清单
 *
 * ★ `days` / `count` 必须**逐日真探**（§6.7）：cztv 的「明天起全占位」
 *   只有真去抓了才知道，任何「× 7 天」的外推都会造出假天数。
 * ★ 只累计「今天及以后」（§6.7c）；探测窗口本身就是今天起 7 天，所以不用额外切分。
 * ★ `days === 0` 的台**不进 catalog**（好易购今天也是占位）：
 *   进了也会被 pickBest 选中、然后每天返回空，白白浪费请求还污染日志。
 */
export async function listChannels() {
  let j
  try {
    j = await getJson(`${BASE}/channel/tv`)
  } catch (e) {
    log.error(`[cztv] 频道表抓取失败：${e.message}`)
    return []
  }
  const stations = (j?.content?.list || []).filter((s) => s && s.station_code && s.name)
  if (!stations.length) {
    log.warn('[cztv] 频道表为空')
    return []
  }

  const dayList = Array.from({ length: PROBE_DAYS }, (_, i) => ymdInCST(i))

  // 10 台 × 7 天 = 70 个请求，限并发 4（实测约 8~12 秒）
  const tasks = []
  for (const st of stations) for (const ymd of dayList) tasks.push({ st, ymd })
  const fetched = await mapLimit(tasks, 4, async ({ st, ymd }) => {
    const r = await getDayProgrammes(String(st.station_code), 1, ymd)
    return { code: String(st.station_code), ymd, rows: r.programmes }
  })

  const byCode = new Map()
  for (const f of fetched) {
    if (!byCode.has(f.code)) byCode.set(f.code, [])
    byCode.get(f.code).push(...f.rows)
  }

  const out = []
  for (const st of stations) {
    const code = String(st.station_code)
    const rows = byCode.get(code) || []
    if (!rows.length) continue
    const days = countCoveredYmds(rows, dayList) // ★ 按「覆盖满 6 小时」算，不按条数（§4）
    if (days === 0) continue
    out.push({
      source: 'cztv',
      region: 'CN',
      sourceId: code,
      name: fullName(st.name),
      logo: st.logo || '',
      days,
      count: rows.length,
      withDesc: 0, // 源不带简介（坑③）
    })
  }

  const tot = out.reduce((s, c) => s + c.count, 0)
  log.ok(`[cztv] ${out.length}/${stations.length} 个台有真实节目，共 ${tot} 条（逐日真探；未来天是占位已剔除）`)
  return out
}

export { log }
