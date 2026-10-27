/**
 * 凤凰卫视官网数据源（fengshows.com）
 *
 * 为什么需要这个源（2026-10-27 第七轮）：
 *   「鳳凰衛視香港台」四源全无 —— epgpw/tvsou/z51/tvmao 都拿不到，
 *   而凤凰官网自己提供节目单。这是唯一能救这个台的途径。
 *
 * 接口（逆向自 /live 页面的 Nuxt 前端，2026-10-27 实测）：
 *   GET https://m.fengshows.com/api/v3/live/{liveId}/resources
 *       ?dir=asc&date=YYYYMMDD&page=1&page_size=99
 *
 *   liveId 来自 /live 页 HTML 里的 fs-id 属性：
 *     中文台  f7f48462-9b13-485b-8101-7b54716411ec
 *     資訊台  7c96b084-60e1-40a9-89c5-682b994fb680
 *     香港台  15e02d92-1698-416c-af2f-3e9a872b4d78
 *
 * ⚠️ 三个必须注意的点（都是实测踩出来的）：
 *
 * ① **不带 date 参数会返回 2021 年的死数据**。
 *    我第一次调 `live/{id}/resources`（没带参数）拿到 99 条，
 *    时间全是 2021-07-09 —— 看着"有数据"，实际是陈年垃圾。
 *    必须显式带 `date=YYYYMMDD`。
 *
 * ② **event_time 是 UTC，不是北京时间**。
 *    实测 `2026-10-26T16:00:00.000Z` 对应的正是北京时间 10-27 00:00。
 *    直接 Date.parse 得到的是 UTC 时刻，是正确的绝对时间戳，不需要额外加减；
 *    但判断「这条属于哪一天」时必须按 +08:00 换算，否则会把当天 00:00-08:00
 *    的节目算到前一天。
 *
 * ③ **一天的节目表从「当天 00:00」到「次日 00:00 前」**，
 *    所以 date=20261027 返回的 49 条里，第一条 event_time 是
 *    2026-10-26T16:00:00Z（= 北京 10-27 00:00），最后一条是
 *    2026-10-27T15:30:00Z（= 北京 10-27 23:30）。
 *
 * 简介：API 里 content / brief 字段实测全空（49 条里 0 条有内容），
 *      所以这个源只提供节目单，不提供简介。港台频道的简介仍走 kbro / z51。
 */
import { fetchText, log } from '../utils.mjs'

const BASE = 'https://m.fengshows.com/api/v3'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

/** 官网 /live 页里三个台的 fs-id（2026-10-27 从 HTML 抓出，硬编码因为不常变） */
export const LIVE_IDS = {
  中文台: 'f7f48462-9b13-485b-8101-7b54716411ec',
  資訊台: '7c96b084-60e1-40a9-89c5-682b994fb680',
  香港台: '15e02d92-1698-416c-af2f-3e9a872b4d78',
}

/** 节目单每页最多 99 条（前端写死 page_size:99），一天 40~65 条够用 */
const PAGE_SIZE = 99

/**
 * 抓某台某一天的节目
 *
 * @param sourceId  LIVE_IDS 里的 key（中文台 / 資訊台 / 香港台），或直接给 uuid
 * @param weekday   1..7（周一..周日）—— 这个源不吃 weekday，只为对齐接口签名
 * @param ymd       YYYYMMDD
 * @returns { programmes, pageTitle, error }
 */
export async function getDayProgrammes(sourceId, weekday, ymd) {
  const liveId = LIVE_IDS[sourceId] || sourceId
  if (!liveId) return { programmes: [], pageTitle: '', error: 'no liveId' }

  const url = `${BASE}/live/${liveId}/resources?dir=asc&date=${ymd}&page=1&page_size=${PAGE_SIZE}`

  let res
  try {
    res = await fetchText(url, {
      timeout: 20000,
      retries: 2,
      headers: { 'User-Agent': UA, Referer: 'https://www.fengshows.com/live' },
    })
  } catch (e) {
    return { programmes: [], pageTitle: '', error: e.message }
  }
  if (!res.ok) return { programmes: [], pageTitle: '', error: `HTTP ${res.status}` }

  let arr
  try {
    arr = JSON.parse(res.text)
  } catch {
    return { programmes: [], pageTitle: '', error: 'JSON parse failed' }
  }
  if (!Array.isArray(arr)) return { programmes: [], pageTitle: '', error: 'not an array' }

  // 只收 type=schedule（实测全是 schedule，但上游字段别信，过滤一下更稳）
  const rows = []
  for (const x of arr) {
    if (x.type && x.type !== 'schedule') continue
    if (!x.event_time || !x.title) continue
    const startTs = Date.parse(x.event_time)
    if (!Number.isFinite(startTs)) continue
    rows.push({
      startTs,
      // 这个 API **不给结束时间**（没有 end_time / duration 字段）。
      // 交给 normalize 用「下一条的开始时间」补 —— 这是它本来就支持的逻辑，
      // 且比我们自己猜时长更准。
      stopTs: null,
      title: String(x.title).trim(),
      desc: '',
    })
  }

  rows.sort((a, b) => a.startTs - b.startTs)
  return { programmes: rows, pageTitle: sourceId }
}

/**
 * 频道清单
 *
 * 这个源只有三个台，且 id 是硬编码的 uuid，没有「清单页」可扫。
 * 直接返回固定三项，让 matchChannels 能按名字对上。
 */
export async function listChannels() {
  return Object.entries(LIVE_IDS).map(([name, id]) => ({
    source: 'fengshows',
    region: 'HK',
    sourceId: name, // 用中文名当 sourceId，可读性比 uuid 好，getDayProgrammes 会翻译
    name: `鳳凰衛視${name}`,
    logo: '',
    days: 1, // 实测只有当天（今天）可靠；明天也可能有，但不保证
    count: 0,
  }))
}

export { log }
