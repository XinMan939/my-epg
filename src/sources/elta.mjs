/**
 * 台湾 ELTA OTT 节目单数据源（eltaott.tv）—— 2026-10-28 第十轮新增
 *
 * 来源：用户提供网页 https://eltaott.tv/channel/program_detail，
 * 说「要挂 VPN 才能看」。实测**本机打不开、CI 完全正常**，原因见下方 ★★。
 *
 * ★★ 为什么本机抓不到（和 TDM 一模一样的坑，但更严重）：
 *   页面本身 `eltaott.tv` 本机直连 200（0.42s），解析到真实台湾 IP `210.61.47.160`。
 *   但真正的数据在 CDN 子域 `piceltaott-elta.cdn.hinet.net`，本机解析到：
 *     `157.240.8.50` / `69.171.224.36` / `108.160.169.55` + IPv6 `face:b00c`
 *   —— 全是 **Meta（Facebook）IP 段**，DNS 被污染。
 *   ★ 换 DNS 没用：阿里 223.5.5.5、腾讯 119.29.29.29、Google 8.8.8.8、DoH 全部返回同样的假 IP，
 *     说明劫持发生在 DNS 查询链路上游，不是本机 hosts 问题。
 *   ★ 本机代理也不行：代理上游同样解析失败（CONNECT tunnel 502）。
 *   ★ CI（GitHub 海外机房）解析到 **8 个真实中华电信 IP** `203.66.32.x / 203.66.34.x`，直连 200、0.77s。
 *
 *   → **境外 CDN 源一律交 CI 抓，本机只做代码验证。**（pitfalls §7.1c）
 *
 * ★ 破解路径（比 TDM 简单得多，因为它是**服务端渲染 + 静态 JSON**）：
 *   1. `curl --compressed` 抓页面 HTML（109KB）。★ 必须带 `--compressed`，
 *      不带会拿到 gzip 二进制乱码（本项目 fetchText 已内置解压）。
 *   2. 页面里 jQuery 的 `$.ajax` 直接写明数据地址（明文，不用逆向 APK）：
 *      ```js
 *      url: "https://piceltaott-elta.cdn.hinet.net/production/json/channel/channel_list.json"
 *      url: "https://piceltaott-elta.cdn.hinet.net/production/json/program_list/program_list_" + assignDate + ".json"
 *      ```
 *   3. 页面里还有 `replayChannels` 对象，带**全部频道的 HLS 直播地址**（做 m3u 可直接用）。
 *
 * 接口（全部实测 2026-10-28，CI run 40562069762）：
 *   GET /production/json/channel/channel_list.json              → 130 个频道（38 个上架）
 *   GET /production/json/program_list/program_list_{YYYY-MM-DD}.json → 38 个台 × 当天节目
 *
 * ⚠️ 六个坑（全部实测，别改回去）：
 *
 * ① **节目字段只有 5 个，没有简介**：
 *    `program_sn, start_time, end_time, program_desc, contents_order`
 *    `program_desc` 是**节目标题**（不是简介），`contents_order` 实测 100% 为 null。
 *    → 所以本源的 `withDesc` 恒为 0。**别为了让数字好看去把标题当简介**（pitfalls §5.1）。
 *    它的价值是「补台湾体育/新闻台的节目时间表」，不是补简介。
 *
 * ② **`start_time` / `end_time` 是 Unix 秒级时间戳**（不是字符串、不是毫秒）。
 *    例：`1793116620` = `2026-10-27 23:57 +08`。直接 `* 1000` 喂 Date。
 *
 * ③ **★★ date key 是「广播日」，且跨天重叠严重**：
 *    抓 `program_list_2026-10-28.json` 返回的范围是 `10-27 18:00 ~ 10-29 02:00`，
 *    **不是** 10-28 00:00~24:00。相邻两个日期文件有大量重叠节目（同一 start_time 出现两次）。
 *    → 必须**在源内部按 start_time 去重**，否则同一节目进 build 两次。
 *      虽然 normalize 也会按 `startTs|title` 去重，但上游标题带「今日最新」这类后缀会变，
 *      靠 normalize 兜不住（pitfalls §3）。
 *
 * ④ **可用天数 11 天，但末尾几天是「半成品」**：
 *    实测 10-25 ~ 11-04 都有数据，条数：818 / 794 / 781 / 769 / 786 / 791 / 786 / **483 / 417 / 408 / 396**。
 *    11-01 起骤降到 483，且部分台 `0 条`（每台最少 0 条）。
 *    → `days` 只数「今天及以后**且条数正常**」的天。判断标准：该天总条数 ≥ 当天首日的 60%。
 *      不然会把「只填了几个台」的日子算成满覆盖，骗到 pickBest（pitfalls §6.7c）。
 *
 * ⑤ **频道清单要过滤三态**：
 *    `channel_list.json` 有 130 条，但只有 `cl_status==1 && cl_display==1` 才上架显示。
 *    页面还额外要求 `cp_show_type==1 || (cp_show_type==2 && 在档期内)`。
 *    → 实测 38 个台通过。**别直接用 130**，否则 92 个台会返回空节目。
 *
 * ⑥ **频道号 `cl_num` 是 OTT 界面编号（101/105/540...），不是电视遥控器台号**。
 *    `cl_no` 才是内部 id（1/5/6/92...）。节目 JSON 的 key 用的是 **`cl_num`**（101 等）。
 *    → `sourceId` 用 `cl_num`，因为它同时是 JSON key 和界面标识。
 *
 * ★ 节目质量观察（38 台里真正有独立价值的）：
 *    101/105/110/115 體育 1~4 台、540~549 體育MAX1~10台、701 Ginx電競、
 *    901~904 民視系、909/910 華視系、915 鏡電視、918~920 寰宇系 —— 这些是台湾本土台，
 *    epg.pw / litv 覆盖不全。國際台（Travel Channel / Mezzo / TRACE / PET CLUB）多数已有别的源。
 */
import { fetchText, log, hasRealDesc } from '../utils.mjs'

const BASE = 'https://piceltaott-elta.cdn.hinet.net/production/json'
const PAGE = 'https://eltaott.tv/channel/program_detail'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

/** 探测窗口：今天往前 3 天（含过去，只为确认边界），往后 7 天 */
const PROBE_BACK = 3
const PROBE_AHEAD = 7

/** 日期缓存：channel_list 很少变，一天抓一次即可 */
let _chCache = null

async function getJson(url) {
  const res = await fetchText(url, {
    timeout: 25000,
    retries: 2,
    headers: { 'User-Agent': UA, Referer: PAGE, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status || res.error}`)
  return JSON.parse(res.text)
}

/** 台北时区的今天（ELTA 是台湾站，日期按台北算） */
function taipeiYmd(offsetDays = 0) {
  return new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3)
    .toISOString()
    .slice(0, 10)
    .replace(/-/g, '')
}

/** YYYYMMDD → YYYY-MM-DD */
function dash(ymd) {
  return `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
}

/**
 * 频道原始清单（带三态过滤）
 *
 * @returns [{ sourceId, name, num, order, desc }]  sourceId = cl_num
 */
export async function fetchChannelList() {
  const j = await getJson(`${BASE}/channel/channel_list.json`)
  if (!Array.isArray(j)) throw new Error('channel_list 不是数组')

  const now = Date.now()
  const out = []
  for (const c of j) {
    if (Number(c.cl_status) !== 1) continue // 上架状态
    if (Number(c.cl_display) !== 1) continue // 显示状态
    // cp_show_type: 1 = 常驻上架；2 = 档期节目（要在档期内才显示）
    const st = String(c.cp_schedule_from_datetime || '')
    const et = String(c.cp_schedule_to_datetime || '')
    const inWindow =
      !st || !et || st.startsWith('0000')
        ? true
        : Date.parse(st.replace(' ', 'T') + '+08:00') <= now &&
          Date.parse(et.replace(' ', 'T') + '+08:00') > now
    const type = Number(c.cp_show_type)
    if (!(type === 1 || (type === 2 && inWindow))) continue

    out.push({
      sourceId: String(c.cl_num),
      name: String(c.cl_title || '').trim(),
      num: String(c.cl_num),
      order: Number(c.cl_order) || 0,
      desc: String(c.cl_dec || '').trim(),
    })
  }
  out.sort((a, b) => a.order - b.order)
  return out
}

/**
 * 抓某台某一天的节目
 *
 * ⚠️ 见文件头坑③：返回的是「广播日」范围（约 前一天18:00 ~ 次日02:00），
 *    相邻日期文件有重叠，所以**这里按 start_time 去重**。
 *
 * @param sourceId cl_num（如 '101'）
 * @param weekday  1..7，不吃
 * @param ymd      YYYYMMDD
 * @returns { programmes, pageTitle, error }
 */
export async function getDayProgrammes(sourceId, weekday, ymd) {
  const cid = String(sourceId || '').trim()
  if (!cid) return { programmes: [], pageTitle: '', error: 'no sourceId' }

  const url = `${BASE}/program_list/program_list_${dash(ymd)}.json`
  let j
  try {
    j = await getJson(url)
  } catch (e) {
    return { programmes: [], pageTitle: '', error: e.message }
  }
  if (!j || typeof j !== 'object') return { programmes: [], pageTitle: '', error: 'bad json' }

  const arr = Array.isArray(j[cid]) ? j[cid] : []
  if (!arr.length) return { programmes: [], pageTitle: '', error: 'empty schedule' }

  // ★ 坑②：秒级时间戳；坑①：没有简介，program_desc 是标题
  const seen = new Set()
  const rows = []
  for (const x of arr) {
    const st = Number(x.start_time)
    const et = Number(x.end_time)
    const title = String(x.program_desc || '').trim()
    if (!Number.isFinite(st) || st <= 0) continue
    if (!Number.isFinite(et) || et <= 0 || et <= st) continue // 上游用 0 表示无效（见页面源码判断）
    if (!title) continue

    const key = `${st}|${title}`
    if (seen.has(key)) continue
    seen.add(key)

    rows.push({
      startTs: st * 1000,
      stopTs: et * 1000,
      title,
      desc: '', // ★ 本源无简介，见坑①
      category: '',
    })
  }
  rows.sort((a, b) => a.startTs - b.startTs)
  return { programmes: rows, pageTitle: '' }
}

/**
 * 频道清单 + 真实覆盖统计（对外的标准接口，签名与 epgpw/webncode 一致）
 *
 * ★ 坑④：末尾几天是半成品，不能一律算满。
 *   判断标准：该天总条数 ≥ 今天的 60%，且该台当天条数 ≥ 该台今天的 60%。
 *   这样 11-01 之后那些「只填了几个台」的日子会被正确排除。
 *
 * ★ 坑⑥：JSON key 是 cl_num，所以统计时按 cl_num 取。
 */
export async function listChannels() {
  const chs = await fetchChannelList()
  const out = []
  const todayYmd = taipeiYmd(0)

  // 先把每天的全量 JSON 抓一次（同一个日期只抓一遍，38 个台共用）
  const dayList = []
  for (let i = -PROBE_BACK; i <= PROBE_AHEAD; i++) dayList.push(taipeiYmd(i))

  const perDay = new Map() // ymd → { chNum: [rows] }
  for (const ymd of dayList) {
    try {
      const j = await getJson(`${BASE}/program_list/program_list_${dash(ymd)}.json`)
      perDay.set(ymd, j && typeof j === 'object' ? j : {})
    } catch (e) {
      log.warn(`[elta] 探测 ${ymd} 失败：${e.message}`)
      perDay.set(ymd, {})
    }
  }

  // 每天的总条数（判断「半成品日」用）
  const dayTotal = new Map()
  for (const [ymd, j] of perDay) {
    let t = 0
    for (const k of Object.keys(j)) if (Array.isArray(j[k])) t += j[k].length
    dayTotal.set(ymd, t)
  }

  for (const ch of chs) {
    const dayset = new Set()
    let count = 0
    let withDesc = 0
    // 该台在「今天」的条数，作为 60% 基准
    const baseArr = (perDay.get(todayYmd) || {})[ch.sourceId] || []
    const baseline = baseArr.length || 1

    for (const ymd of dayList) {
      if (ymd < todayYmd) continue // 只算今天及以后（pitfalls §6.7c）
      const j = perDay.get(ymd) || {}
      const arr = Array.isArray(j[ch.sourceId]) ? j[ch.sourceId] : []
      if (!arr.length) continue
      // ★ 坑④：半成品日不算满覆盖
      if (dayTotal.get(ymd) < (dayTotal.get(todayYmd) || 1) * 0.6) continue
      if (arr.length < baseline * 0.6) continue

      dayset.add(ymd)
      for (const x of arr) {
        const st = Number(x.start_time)
        const et = Number(x.end_time)
        const title = String(x.program_desc || '').trim()
        if (!Number.isFinite(st) || st <= 0) continue
        if (!Number.isFinite(et) || et <= 0 || et <= st) continue
        if (!title) continue
        count++
        // ★ 坑①：本源没有简介，withDesc 恒 0。用 hasRealDesc 保持口径一致（虽然必为 false）
        if (hasRealDesc('', title)) withDesc++
      }
    }

    out.push({
      source: 'elta',
      region: 'TW',
      sourceId: ch.sourceId,
      name: ch.name,
      logo: '',
      days: dayset.size,
      count,
      withDesc,
    })
  }

  const ok = out.filter((c) => c.days > 0).length
  const tot = out.reduce((s, c) => s + c.count, 0)
  log.ok(`[elta] ${ok}/${out.length} 个台有节目，共 ${tot} 条（无简介源，withDesc 恒 0）`)
  return out
}

export { log }
