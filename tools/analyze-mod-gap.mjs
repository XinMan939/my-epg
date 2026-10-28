/**
 * 交叉分析：哪些「不足 7 天」的台湾台能被 MOD 补齐（硬规则 18 的判断依据）
 *
 * 输入：
 *   - origin/output 分支的 report.json（当前产物里每个台的 days/count/withDesc/主源）
 *   - channels/catalog.json（MOD 每台的真探 days/count）
 *   - .probe/modfull/all.html（MOD 频道清单，离线可复现）
 *
 * 输出：一张「值得映射」清单，按「主源缺几天」排序。
 * 判据（不是拍脑袋）：
 *   ① 主源 days < 7
 *   ② MOD 侧 days > 主源 days
 *   ③ MOD 侧该台 count 与主源 count 数量级接近（0.3x ~ 3x）——否则可能不是同一个台
 */
import fs from 'node:fs'
import { execSync } from 'node:child_process'
import { normalizeName, nameVariants } from '../src/utils.mjs'

const report = JSON.parse(execSync('git show origin/output:report.json', { maxBuffer: 64 * 1024 * 1024 }).toString())
const catalog = JSON.parse(fs.readFileSync(new URL('../channels/catalog.json', import.meta.url), 'utf8'))

// MOD 频道清单（本地 HTML，避免联网）
const html = fs.readFileSync(new URL('../.probe/modfull/all.html', import.meta.url), 'utf8')
const modNames = new Map()
{
  const re = /<div class="number">(\d+)<\/div>[\s\S]{0,900}?<h3><a[^>]*>([^<]+)<\/a><\/h3>/g
  let m
  while ((m = re.exec(html))) if (!modNames.has(m[1])) modNames.set(m[1], m[2].trim())
}

const modCands = catalog.items
  .filter((c) => c.source === 'mod')
  .map((c) => ({ ...c, name: modNames.get(c.sourceId) || c.name, norm: normalizeName(modNames.get(c.sourceId) || c.name), variants: nameVariants(modNames.get(c.sourceId) || c.name) }))

const twDetail = (report.detail || []).filter((x) => /\.tw$/.test(x.id))
const rows = []
for (const t of twDetail) {
  const days = t.days || 0
  if (days >= 7) continue
  const v = new Set(nameVariants(t.name))
  for (const a of t.aliases || []) for (const x of nameVariants(a)) v.add(x)
  const hits = modCands.filter((c) => v.has(c.norm) || c.variants.some((y) => v.has(y)))
  if (!hits.length) {
    rows.push({ id: t.id, name: t.name, days, count: t.count, withDesc: t.withDesc, mod: null })
    continue
  }
  // 多个 MOD 候选时取 days 最多的
  const best = hits.sort((a, b) => (b.days || 0) - (a.days || 0) || (b.count || 0) - (a.count || 0))[0]
  const ratio = t.count ? (best.count || 0) / t.count : 0
  rows.push({
    id: t.id,
    name: t.name,
    days,
    count: t.count,
    withDesc: t.withDesc,
    usedSource: t.usedSource,
    mod: { sourceId: best.sourceId, name: best.name, days: best.days, count: best.count },
    ratio: Number(ratio.toFixed(2)),
    // 可疑：条数差 3 倍以上，可能不是同一个台
    suspect: ratio > 3 || ratio < 0.3,
  })
}

rows.sort((a, b) => a.days - b.days || b.count - a.count)

const usable = rows.filter((r) => r.mod && r.mod.days > r.days && !r.suspect)
const suspect = rows.filter((r) => r.mod && r.suspect)
const noMod = rows.filter((r) => !r.mod)

console.log(`不足 7 天的台湾台：${rows.length} 台\n`)
console.log(`✅ MOD 能补且条数对得上（${usable.length} 台）`)
console.log('ID'.padEnd(24), '主源'.padEnd(10), 'MOD'.padEnd(22), '条数比')
for (const r of usable) {
  console.log(
    r.id.padEnd(24),
    `${r.days}天/${r.count}条`.padEnd(10),
    `${r.mod.days}天/${r.mod.count}条 ${r.mod.name}`.padEnd(22),
    r.ratio
  )
}

console.log(`\n⚠️ MOD 有但条数差 3 倍以上，需人工确认（${suspect.length} 台）`)
for (const r of suspect) {
  console.log(` ${r.id} 主源 ${r.days}天/${r.count}条 vs MOD ${r.mod.days}天/${r.mod.count}条 ${r.mod.name} 比=${r.ratio}`)
}

console.log(`\n❌ MOD 没有对应台（${noMod.length} 台）`)
for (const r of noMod) console.log(` ${r.id} (${r.name}) ${r.days}天/${r.count}条`)

fs.writeFileSync(
  new URL('../.probe/mod-gap.json', import.meta.url),
  JSON.stringify({ usable, suspect, noMod }, null, 2)
)
console.log('\n明细已写入 .probe/mod-gap.json')
