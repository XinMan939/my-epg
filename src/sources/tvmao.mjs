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

/**
 * 由 sourceId 推断 URL 前缀（可能返回空字符串，表示 sourceId 自带完整路径）
 * sourceId 形如 "CCTV-CCTV1" / "HUNANTV1" / "CCTVPAYFEE-CCTVPAYFEE1" / "SHXITV/SHXITV9"
 */
export function inferPath(sourceId) {
  // ★ 两段式写法：sourceId 里带 "/"，如 "SHXITV/SHXITV9"（陕西台/农林卫视）
  //   这类频道不在频道清单页的链接里（清单页只收主频道），
  //   但节目页真实存在且正确。用户 2026-10-27 直接给了这个 URL，
  //   说明「清单页没有」不等于「站点没有」。
  //   实测三条（2026-10-27，w2）：
  //     /program/SHXITV/SHXITV9-w2.html        72987B ✓ title 农林卫视节目表
  //     /program_satellite/SHXITV9-w2.html     72990B ✓ 同上（只给尾段也能用）
  //   走 /program/ 前缀即可，和央视同一条路径规则。
  if (sourceId.includes('/')) return PATHS.cctv

  // ⚠️⚠️ 2026-10-27 第二次实测：**数字付费频道也走 /program/** 了，
  //     /program_digital/ 现在返回 404。
  //     证据（w2，m 站）：
  //       /program/CCTVPAYFEE-CCTVPAYFEE35-w2.html   200 68862B  ✓ CCTV中学生频道
  //       /program_digital/CCTVPAYFEE-...-w2.html    404    92B  ✗
  //       /program/BAMC-CWJINGDIAN-w2.html           200 58942B  ✓ 重温经典频道
  //       /program_digital/BAMC-CWJINGDIAN-w2.html   404    92B  ✗
  //     所以「CCTVPAYFEE- 前缀走 digital」这条旧规则已经失效，
  //     现在唯一可靠的规则是：**带「分组-频道」前缀的一律走 /program/**。
  //
  //     这个坑很隐蔽：inferPath 猜错前缀 → 404 → getDayProgrammes 返回 0 条 →
  //     表现成「这个频道上游没有」，和真的没有一模一样。
  //     第二次踩：BAMC-CWJINGDIAN（重温经典频道）前缀是 BAMC- 不是 CCTV-，
  //     被归到 satellite 分支 → 404 → 又以为「上游没有」。实测 /program/ 是 200、58942B。
  //
  //     结论：只要 sourceId 形如 `XXX-YYY`（含连字符的二级分组 id），就走 /program/。
  if (sourceId.includes('-')) return PATHS.cctv
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

  // ★ 节目行有两种结构，必须都吃（2026-10-27 实测）：
  //   A) 节目被电视猫收录成词条，标题是 <a href="/tvcolumn/xxx">节目名</a>
  //   B) 没收录词条，标题是纯文本 <span class="epg-row-link">动画片</span>
  //
  //   旧正则只认 A，B 的行被整条丢掉。后果很隐蔽：
  //     重温经典频道 22 条全是 B 型 → 一条都抓不到，表现成「这个频道没有节目」
  //     农林卫视 17 条 A + 34 条 B → 只抓到 17 条，丢了三分之二
  //   这不是「上游没有数据」，是我们的解析器只认一半。
  const rowRe =
    /<span class="epg-row-time"\s+data-endtime="([^"]*)"\s*\n?\s*data-time="([^"]*)">[^<]*<\/span>\s*<span class="epg-row-link">(?:<a[^>]*>([^<]*)<\/a>([^<]*)|([^<]*))<\/span>/g

  let m
  while ((m = rowRe.exec(html))) {
    const endRaw = m[1].trim()
    const startRaw = m[2].trim()
    // A 型取 <a> 内文字 + 尾巴；B 型取整段文字
    const title = (m[3] || m[5] || '').trim()
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

    // ⚠️ 2026-10-27 站点改版，旧正则一条都匹配不上，tvmao 源整个消失（214 频道 → 0），
    //    连带简介率从 61.2% 掉到 60%。两处变化：
    //    ① 路径：央视/数字 → /program/<ID>-wN.html；卫视 → /program_satellite/<ID>-wN.html
    //       （旧正则写死 /program[a-z_]*/ 能同时吃两种，新写法反而只认 /program/，卫视全丢）
    //    ② ID：CCTV1 → CCTV-CCTV1，加了分组前缀
    //    所以这里把路径前缀做成捕获组，后面交给 inferPath 决定怎么拼。
    const re =
      /<a href="(\/program(?:_satellite|_digital)?\/([A-Za-z0-9\-]+)-w\d+\.html)"\s*\n?\s*title="([^"]+)"/g
    let m
    const seen = new Set()
    while ((m = re.exec(res.text))) {
      const sourceId = m[2]
      // 2026-10-27 改版后 title 变成了「CCTV-1综合节目单」，直接拿去匹配会把名字搞脏，
      // 剥掉结尾的「节目单」「节目预告」再入库。
      const name = m[3].trim().replace(/(?:节目单|节目预告|节目表)$/, '').trim()
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
