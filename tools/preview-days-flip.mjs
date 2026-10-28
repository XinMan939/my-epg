/**
 * 离线复核：把新 catalog 灌进 matchChannels，逐台对比「主源会不会翻转」
 *
 * 为什么必须先跑这一步（不是直接 build）：
 *   days 是 pickBest 的第一排序键，把 tvsou/tvmao 的 days 从 0 改成真实值，
 *   意味着这两个源**第一次有能力赢下主源**。而 tvsou/tvmao 都是
 *   `hasDesc: false`（没有简介）—— 典型的坏翻转是「多 1 天，简介掉到 0」，
 *   那正是 §6.7c / days-source 那条硬规则反复踩到的坑。
 *
 *   build 一次要下 epgpw 三个包，本机经常超时；而且翻转之后报表只看得到
 *   最终数字，看不出「是哪个台换了主源」。所以先离线跑一遍，把翻转清单打出来，
 *   人工确认没有「拿简介换天数」的，再去跑真 build。
 *
 * 跑法：node tools/preview-days-flip.mjs
 */
import fs from 'node:fs'
import { loadChannels, loadOverrides } from '../src/config.mjs'
import { matchChannels } from '../src/match.mjs'
import { normalizeName, nameVariants } from '../src/utils.mjs'

const catalog = JSON.parse(fs.readFileSync(new URL('../channels/catalog.json', import.meta.url), 'utf8')).items
const targets = loadChannels().filter((c) => c.enabled)
const overrides = loadOverrides()

/** 把 tvsou / tvmao 的 days / count 抹掉，还原成「修复前」的 catalog */
const oldCatalog = catalog.map((c) =>
  c.source === 'tvsou' || c.source === 'tvmao' ? { ...c, days: undefined, count: undefined, withDesc: undefined } : c
)

const before = matchChannels(targets, oldCatalog, { overrides }).matched
const after = matchChannels(targets, catalog, { overrides }).matched

// 报表里的现状（真 build 的结果），用来判断「翻转后是变好还是变差」
let detail = new Map()
try {
  const r = JSON.parse(fs.readFileSync(new URL('../output/report.json', import.meta.url), 'utf8'))
  detail = new Map((r.detail || []).map((d) => [d.id, d]))
} catch {
  /* 没有 report 就只比匹配层 */
}

const byKey = new Map(catalog.map((c) => [`${c.source}:${c.sourceId}`, c]))
const flips = []
for (const t of targets) {
  const b = before.get(t.id)
  const a = after.get(t.id)
  if (!a) continue
  if (b && b.source === a.source && String(b.sourceId) === String(a.sourceId)) continue
  const ac = byKey.get(`${a.source}:${a.sourceId}`) || {}
  const bc = b ? byKey.get(`${b.source}:${b.sourceId}`) || {} : {}
  flips.push({
    id: t.id,
    name: t.name,
    from: b ? `${b.source}:${b.sourceId}(${b.sourceName}) ${bc.days ?? '缺'}天/${bc.withDesc ?? '缺'}简介` : '(无)',
    to: `${a.source}:${a.sourceId}(${a.sourceName}) ${ac.days ?? '缺'}天/${ac.withDesc ?? '缺'}简介`,
    report: detail.get(t.id)?.usedSource || '',
    reportDays: detail.get(t.id)?.days ?? '',
    reportDesc: detail.get(t.id)?.descRate ?? '',
  })
}

console.log(`目标 ${targets.length}，主源翻转 ${flips.length} 个：\n`)
const NO_DESC = new Set(['tvsou', 'tvmao'])
for (const f of flips) {
  const newSrc = f.to.split(':')[0]
  const oldSrc = f.from === '(无)' ? '' : f.from.split(':')[0]
  const warn = NO_DESC.has(newSrc) && oldSrc && !NO_DESC.has(oldSrc) ? '   ← 注意：新主源无简介，确认不是「拿简介换天数」' : ''
  console.log(`${f.id}（${f.name}）`)
  console.log(`   改前主源 ${f.from}`)
  console.log(`   改后主源 ${f.to}${warn}`)
  console.log(`   线上现状 ${f.report || '(空)'} days=${f.reportDays} descRate=${f.reportDesc}`)
}
if (!flips.length) console.log('（没有翻转 —— 说明补 days 只影响备选排序，不动主源）')

// 备选链变化（补天顺序会变，影响的是请求量，不是内容正确性）
let altChanged = 0
for (const t of targets) {
  const b = before.get(t.id)
  const a = after.get(t.id)
  if (!b || !a) continue
  const bs = (b.alternatives || []).map((x) => `${x.source}:${x.sourceId}`).join(',')
  const as = (a.alternatives || []).map((x) => `${x.source}:${x.sourceId}`).join(',')
  if (bs !== as) altChanged++
}
console.log(`\n备选链顺序变化 ${altChanged} 个（只影响补天时的尝试顺序，不影响正确性）`)
