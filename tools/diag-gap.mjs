/**
 * 诊断：为什么 nowNews.hk / CTSNews.tw 有备选源却补不上天
 *
 * 实证（2026-10-28T02:47Z 产物）：
 *   nowNews.hk  主源 epgpw 5 天（11-02 / 11-03 全空）
 *               备选 nowplayer:332 自报 6 天 → 却仍停在 5 天，日志里连 day-fill 行都没有
 *   CTSNews.tw  主源 litv 5 天，备选只有 epgpw:370171 / 501118（★ 没有 mod:505）
 *
 * 查四件事：
 *   ① nowplayer:332 逐日抓 7 天，每天实际返回几条、首末时刻
 *   ② 这些行的时间戳落在哪些北京日（day 序号 vs 日历日是否错位）
 *   ③ pickMissingDays 能否从这些行里挑出 11-02 / 11-03 的
 *   ④ CTSNews.tw 与 mod:505 的归一化名为什么对不上
 *
 * 用法：node tools/diag-gap.mjs
 */
import fs from 'node:fs'
import * as nowplayer from '../src/sources/nowplayer.mjs'
import * as mod from '../src/sources/mod.mjs'
import { buildDateRange } from '../src/normalize.mjs'
import { countCoveredDays, pickMissingDays } from '../src/index.mjs'
import { normalizeName, nameVariants } from '../src/utils.mjs'

const dates = buildDateRange(7)
const minHours = 6
const bj = (ts) => new Date(ts + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')

console.log('=== 目标日期（北京日界）===')
for (const d of dates) console.log(` ${d.ymd} 周${d.weekday}  ${bj(d.ts0)} ~ ${bj(d.ts1)}`)

// ── ① nowplayer 332 逐日 ─────────────────────────────
console.log('\n=== ① nowplayer:332 Now新聞台 逐日抓取 ===')
const npRows = []
for (const d of dates) {
  let r
  try {
    r = await nowplayer.getDayProgrammes('332', d.weekday, d.ymd)
  } catch (e) {
    console.log(` ${d.ymd} 抛错 ${e.message}`)
    continue
  }
  if (r.error) {
    console.log(` ${d.ymd} error=${r.error}`)
    continue
  }
  const n = r.programmes?.length || 0
  if (n) {
    const s = bj(r.programmes[0].startTs)
    const e2 = bj(r.programmes[n - 1].stopTs)
    console.log(` ${d.ymd} → ${String(n).padStart(3)} 条   首=${s}  末=${e2}`)
    npRows.push(...r.programmes)
  } else {
    console.log(` ${d.ymd} →   0 条`)
  }
}
console.log(` 合计 ${npRows.length} 条`)

// ── ② 落在哪些北京日 ─────────────────────────────────
console.log('\n=== ② 这些行落在哪些北京日 ===')
const byDay = {}
for (const r of npRows) {
  for (const d of dates) {
    if (r.startTs >= d.ts0 && r.startTs < d.ts1) {
      byDay[d.ymd] = (byDay[d.ymd] || 0) + 1
      break
    }
  }
}
console.log(' ', JSON.stringify(byDay))
const outside = npRows.filter((r) => !dates.some((d) => r.startTs >= d.ts0 && r.startTs < d.ts1))
console.log(` 落在 7 天窗口之外的: ${outside.length} 条`)

// ── ③ pickMissingDays 能否补 ─────────────────────────
console.log('\n=== ③ pickMissingDays（模拟主源只覆盖前 5 天）===')
const primary = []
for (const d of dates.slice(0, 5)) {
  for (let h = 0; h < 24; h += 1) {
    primary.push({ startTs: d.ts0 + h * 3600e3, stopTs: d.ts0 + (h + 1) * 3600e3, title: 'p' })
  }
}
console.log(' 主源覆盖:', countCoveredDays(primary, dates, minHours), '/ 7')
const add = pickMissingDays(npRows, primary, dates, minHours)
console.log(` ★ 可补 ${add.length} 条`)
const addByDay = {}
for (const r of add) {
  const d = dates.find((x) => r.startTs >= x.ts0 && r.startTs < x.ts1)
  if (d) addByDay[d.ymd] = (addByDay[d.ymd] || 0) + 1
}
console.log(' 补入分布:', JSON.stringify(addByDay))
console.log(' 补后覆盖:', countCoveredDays([...primary, ...add], dates, minHours), '/ 7')

// ── ④ CTSNews 与 mod:505 的名字 ─────────────────────
console.log('\n=== ④ CTSNews.tw 与 mod:505 的归一化名 ===')
const t = { name: '華視新聞', aliases: ['华视新闻'] }
const modName = '華視新聞資訊HD'
const tv = new Set(nameVariants(t.name))
for (const a of t.aliases) for (const v of nameVariants(a)) tv.add(v)
const mv = nameVariants(modName)
console.log(' 目标变体:', [...tv].join(' | '))
console.log('mod:505 变体:', [...mv].join(' | '))
console.log(' 有交集?', [...mv].some((v) => tv.has(v)))

// 顺便看 mod:505 的实际覆盖
console.log('\n=== ⑤ mod:505 逐日抓取 ===')
const modRows = []
for (const d of dates) {
  const r = await mod.getDayProgrammes('505', d.weekday, d.ymd)
  if (r.error) {
    console.log(` ${d.ymd} error=${r.error}`)
    continue
  }
  const n = r.programmes?.length || 0
  console.log(` ${d.ymd} → ${String(n).padStart(3)} 条${n ? '  首=' + bj(r.programmes[0].startTs) + ' 末=' + bj(r.programmes[n - 1].stopTs) : ''}`)
  if (n) modRows.push(...r.programmes)
}

const out = {
  npRows: npRows.length,
  npByDay: byDay,
  npOutside: outside.length,
  npAddable: add.length,
  npAddByDay: addByDay,
  modRows: modRows.length,
}
fs.writeFileSync('diag-gap.json', JSON.stringify(out, null, 2))
console.log('\n结果已写入 diag-gap.json')
