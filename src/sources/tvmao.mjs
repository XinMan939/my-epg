/**
 * 电视猫 m.tvmao.com 数据源
 *
 * 实测（2026-10-26）：
 *   - 移动端页面自带 data-endtime，是真实结束时间（比 tvsou 只有开始时间强）
 *   - 三类频道 ID 命名不同：
 *       央视   /program/CCTV-CCTV1-w{N}.html
 *       卫视   /program_satellite/HUNANTV1-w{N}.html
 *       数字   /program_digital/CCTVPAYFEE-CCTVPAYFEE1-w{N}.html
 *   - w1=周一 ... w7=周日, w8=下周一（下周只有周一半天有效）
 *   - 连发 12 请求未触发频控
 *
 * 坑：错误 ID 会 200 返回"串台"页面（如 SMG-SMG1 返回 CCTV-1 内容），
 *    所以必须校验返回页面的 <title> 是否与预期频道名一致。
 */
import { fetchText, parseTimeToTs, log } from '../utils.mjs'

const BASE = 'https://m.tvmao.com'
const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

/** 三类频道页路径 */
export const PATHS = {
  cctv: '/program/',
  satellite: '/program_satellite/',
  digital: '/program_digital/',
}

/** 由 sourceId 推断路径前缀。sourceId 形如 "CCTV-CCTV1" / "HUNANTV1" / "CCTVPAYFEE-CCTVPAYFEE1" */
export function inferPath(sourceId) {
  if (/^CCTVPAYFEE-/i.test(sourceId)) return PATHS.digital
  if (/^CCTV-/i.test(sourceId)) return PATHS.cctv
  // 卫视类：形如 HUNANTV1 / ZJTV1 / BTV1
  return PATHS.satellite
}

/**
 * 抓单频道单日节目
 * @param sourceId  电视猫频道 ID（不含 -wN）
 * @param weekday   1..7（周一..周日），可到 8（下周一）
 * @param ymd       该节目对应的实际日期 YYYYMMDD（用于把 HH:MM 补成时间戳）
 * @returns { programmes, pageTitle, error }
 */
export async function getDayProgrammes(sourceId, weekday, ymd) {
  const prefix = inferPath(sourceId)
  const url = `${BASE}${prefix}${sourceId}-w${weekday}.html`

  const res = await fetchText(url, {
    timeout: 20000,
    retries: 2,
    headers: { 'User-Agent': UA_MOBILE },
  })

  if (!res.ok) return { programmes: [], pageTitle: '', error: `HTTP ${res.status}` }

  const html = res.text
  const pageTitle = ((html.match(/<title>([^<]*)<\/title>/) || [])[1] || '').trim()

  // 校验：页面标题应包含频道名片段，否则是串台
  const rows = []
  const rowRe =
    /<span class="epg-row-time"\s+data-endtime="([^"]*)"\s*\n?\s*data-time="([^"]*)">[^<]*<\/span>\s*<span class="epg-row-link"><a[^>]*>([^<]*)<\/a>([^<]*)<\/span>/g

  let m
  while ((m = rowRe.exec(html))) {
    const endRaw = m[1].trim()
    const startRaw = m[2].trim()
    const title = m[3].trim()
    const suffix = (m[4] || '').trim()
    const full = (title + suffix).trim()
    if (!full) continue

    const startTs = parseTimeToTs(startRaw, ymd)
    let stopTs = null
    if (endRaw) {
      stopTs = parseTimeToTs(endRaw, ymd)
      // 跨零点：结束时间小于开始时间 → 顺延一天
      if (stopTs && startTs && stopTs <= startTs) stopTs += 24 * 3600 * 1000
    }

    rows.push({ startTs, stopTs, title: full })
  }

  return { programmes: rows, pageTitle, error: rows.length ? null : 'no-rows' }
}

/**
 * 列出电视猫频道（供自动匹配用）
 * 实测可用的三个入口页：
 *   /program/duration/satellite/w1-h16.html  卫星（43 个）
 *   /program/duration/digital/w1-h16.html    数字（83 个）
 *   /program/duration/cctv/w1-h16.html       央视
 */
export async function listChannels() {
  const out = []
  const entries = [
    { path: '/program/duration/cctv/w1-h16.html', group: 'cctv' },
    { path: '/program/duration/satellite/w1-h16.html', group: 'satellite' },
    { path: '/program/duration/digital/w1-h16.html', group: 'digital' },
  ]

  for (const { path: p, group } of entries) {
    const res = await fetchText(`${BASE}${p}`, {
      timeout: 25000,
      retries: 2,
      headers: { 'User-Agent': UA_MOBILE },
    })
    if (!res.ok) {
      log.warn(`[tvmao] 频道列表 ${group} 抓取失败 HTTP ${res.status}`)
      continue
    }

    const re = /href="(\/program[a-z_]*\/([A-Za-z0-9\-]+)-w1\.html)"\s*\n?\s*title="([^"]+)"/g
    let m
    const seen = new Set()
    while ((m = re.exec(res.text))) {
      const sourceId = m[2]
      const name = m[3].trim()
      if (seen.has(sourceId)) continue
      seen.add(sourceId)
      out.push({ source: 'tvmao', group, sourceId, name, logo: '' })
    }
  }

  return out
}

export const meta = {
  id: 'tvmao',
  label: '电视猫',
  hasStop: true,
  hasDesc: false,
}
