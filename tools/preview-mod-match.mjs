/**
 * 本地预览：MOD 频道清单 vs channels.json 台湾台的匹配情况
 *
 * 纯离线（读 .probe/modfull/all.html），不需要联网。
 * 用来在决定「MOD 哪些台值得映射」之前，先看清自动匹配能覆盖多少、缺哪些。
 */
import fs from 'node:fs'
import { normalizeName, nameVariants } from '../src/utils.mjs'

const html = fs.readFileSync(new URL('../.probe/modfull/all.html', import.meta.url), 'utf8')
const re = /<div class="number">(\d+)<\/div>[\s\S]{0,900}?<h3><a[^>]*>([^<]+)<\/a><\/h3>/g
const mods = []
const seen = new Set()
let m
while ((m = re.exec(html))) {
  if (seen.has(m[1])) continue
  seen.add(m[1])
  mods.push({ sourceId: m[1], name: m[2].trim() })
}

const cands = mods.map((c) => ({ ...c, norm: normalizeName(c.name), variants: nameVariants(c.name) }))
const all = JSON.parse(fs.readFileSync(new URL('../channels/channels.json', import.meta.url), 'utf8')).channels
const tw = all.filter((x) => x.group === 'tw')

let hit = 0
const miss = []
console.log(`MOD ${mods.length} 台，channels.json 台湾台 ${tw.length} 台\n`)
for (const t of tw) {
  const v = new Set(nameVariants(t.name))
  for (const a of t.aliases || []) for (const x of nameVariants(a)) v.add(x)
  const h = cands.filter((c) => v.has(c.norm) || c.variants.some((y) => v.has(y)))
  if (h.length) {
    hit++
    console.log(`✓ ${t.id} (${t.name}) → ${h.map((x) => `${x.sourceId}:${x.name}`).join(', ')}`)
  } else {
    miss.push(`${t.id}/${t.name}`)
  }
}
console.log(`\n自动匹配 ${hit} / ${tw.length}`)
console.log(`未匹配 ${miss.length} 台：`)
console.log(miss.join('\n'))
