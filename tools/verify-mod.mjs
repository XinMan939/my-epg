/**
 * MOD 源端到端验证（CI 跑，本机被 DNS 污染打不开）
 *
 * 目的不是「证明能抓」，而是证明三件事：
 *   ① 频道清单 187 台能解析出名字（正则没被页面改版打掉）
 *   ② listChannels 的 days/count 是真探出来的（硬规则 11：不许硬编码）
 *   ③ getDayProgrammes 返回的行时间轴合法（stop > start、无 6 小时以上异常条）
 *
 * 用法：node tools/verify-mod.mjs
 */
import * as mod from '../src/sources/mod.mjs'
import { hasRealDesc } from '../src/utils.mjs'

function ymdOf(offsetDays = 0) {
  return new Date(Date.now() + 8 * 3600e3 + offsetDays * 86400e3).toISOString().slice(0, 10).replace(/-/g, '')
}

const out = {}

// ── ① 频道清单 ────────────────────────────────────────────
const chs = await mod.fetchChannelList()
out.channelCount = chs.length
out.channelSample = chs.slice(0, 10)
console.log(`\n=== ① 频道清单：${chs.length} 台 ===`)
console.log(chs.slice(0, 12).map((c) => `${c.sourceId} ${c.name}`).join(' | '))

// ── ② listChannels 真探 ──────────────────────────────────
const t0 = Date.now()
const list = await mod.listChannels()
out.listElapsedMs = Date.now() - t0
out.listTotal = list.length
out.listWithDays = list.filter((c) => c.days > 0).length
out.listDaysHist = {}
for (const c of list) out.listDaysHist[c.days] = (out.listDaysHist[c.days] || 0) + 1
out.listWithDesc = list.reduce((s, c) => s + (c.withDesc || 0), 0)
out.listCount = list.reduce((s, c) => s + (c.count || 0), 0)
out.top10 = [...list].sort((a, b) => b.count - a.count).slice(0, 10)

console.log(`\n=== ② listChannels（${out.listElapsedMs}ms）===`)
console.log(`有节目 ${out.listWithDays}/${out.listTotal} 台，共 ${out.listCount} 条，简介 ${out.listWithDesc} 条`)
console.log('天数分布:', JSON.stringify(out.listDaysHist))

// ── ③ getDayProgrammes 时间轴校验 ───────────────────────
const today = ymdOf(0)
const picks = ['6', '2', '200', '521', '560'].filter((id) => chs.some((c) => c.sourceId === id))
out.timeline = []
console.log(`\n=== ③ 时间轴校验（今天 ${today}）===`)
for (const id of picks) {
  const name = chs.find((c) => c.sourceId === id)?.name || '?'
  const rows = []
  for (let d = 0; d < 7; d++) {
    const ymd = ymdOf(d)
    const r = await mod.getDayProgrammes(id, 0, ymd)
    if (r.programmes?.length) rows.push(...r.programmes.map((p) => ({ ...p, ymd })))
  }
  const bad = rows.filter((r) => !(r.stopTs > r.startTs))
  const long = rows.filter((r) => r.stopTs - r.startTs > 6 * 3600e3)
  const descN = rows.filter((r) => hasRealDesc(r.desc, r.title)).length
  const perDay = {}
  for (const r of rows) perDay[r.ymd] = (perDay[r.ymd] || 0) + 1
  const rec = { id, name, rows: rows.length, bad: bad.length, long: long.length, withDesc: descN, perDay }
  out.timeline.push(rec)
  console.log(
    `${id} ${name}: ${rows.length} 条 | 时间轴非法 ${bad.length} | 超6h ${long.length} | 简介 ${descN} | ${JSON.stringify(perDay)}`
  )
}

// ── ④ 匹配自检：MOD 频道名能否与 channels.json 对上 ────
import fs from 'node:fs'
import { normalizeName, nameVariants } from '../src/utils.mjs'

const channels = JSON.parse(fs.readFileSync(new URL('../channels/channels.json', import.meta.url), 'utf8'))
const targets = Array.isArray(channels) ? channels : channels.channels || []
const twTargets = targets.filter((t) => (t.group || '').toLowerCase() === 'tw')

const cands = list.map((c) => ({ ...c, norm: normalizeName(c.name), variants: nameVariants(c.name) }))
const byNorm = new Map()
for (const c of cands) {
  if (!c.norm) continue
  if (!byNorm.has(c.norm)) byNorm.set(c.norm, [])
  byNorm.get(c.norm).push(c)
}

out.match = []
console.log(`\n=== ④ 与 channels.json 的台湾台做匹配自检（目标 ${twTargets.length} 台）===`)
for (const t of twTargets) {
  const variants = new Set(nameVariants(t.name))
  for (const a of t.aliases || []) for (const v of nameVariants(a)) variants.add(v)
  const hit = cands.filter((c) => variants.has(c.norm) || c.variants.some((v) => variants.has(v)))
  if (hit.length) {
    out.match.push({ id: t.id, name: t.name, hit: hit.map((h) => `${h.sourceId}:${h.name}`).slice(0, 3) })
    console.log(`  ✓ ${t.id} (${t.name}) → ${hit.map((h) => `${h.sourceId}:${h.name}`).join(', ')}`)
  }
}
console.log(`匹配上 ${out.match.length} / ${twTargets.length} 台`)

fs.writeFileSync('mod-verify.json', JSON.stringify(out, null, 2))
console.log('\n结果已写入 mod-verify.json')
