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
 */
import { fetchText, parseTimeToTs, log } from '../utils.mjs'

const BASE = 'https://www.tvsou.com'

/** 频道列表入口（分类页） */
const CATEGORIES = ['yangshi', 'weishi', 'shuzi', 'gaoqing', 'difang']

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

  const rows = []
  const re = /<tr><td>(\d{2}:\d{2})<\/td><td>([\s\S]*?)<\/td>/g
  let m
  while ((m = re.exec(html))) {
    const startRaw = m[1]
    const title = m[2].replace(/<[^>]*>/g, '').trim()
    if (!title) continue
    const startTs = parseTimeToTs(startRaw, ymd)
    rows.push({ startTs, stopTs: null, title })
  }

  return { programmes: rows, pageTitle, error: rows.length ? null : 'no-rows' }
}

/** tvsou 的台标是相对路径（/media/f/xxx/yyy），补全成绝对 URL */
function absLogo(u) {
  if (!u) return ''
  if (/^https?:\/\//i.test(u)) return u
  return `${BASE}${u.startsWith('/') ? '' : '/'}${u}`
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
      out.push({ source: 'tvsou', group: cat, sourceId: hash, name: name.trim(), logo: absLogo(logo) })
    }
    while ((m = reB.exec(res.text))) {
      const [, hash, name] = m
      if (seen.has(hash)) continue
      seen.add(hash)
      out.push({ source: 'tvsou', group: cat, sourceId: hash, name: name.trim(), logo: '' })
    }
  }

  return out
}

export const meta = {
  id: 'tvsou',
  label: '搜视网',
  hasStop: false,
  hasDesc: false,
}
