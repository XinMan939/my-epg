/**
 * 增量刷新 catalog 里 tvsou / tvmao 的 days / count（2026-10-28 第十七轮）
 *
 * 为什么不直接 `npm run catalog`：
 *   全量重扫会把 epgpw 三个包（CN/HK/TW，本地 HK 包 19MB）也重下一遍，
 *   本地走代理经常超时，而且我们这次只改了这两个源的探测逻辑。
 *
 * 做什么：
 *   ① 只跑 tvsou.listChannels() / tvmao.listChannels()（内部逐台真探 days/count，带当天缓存）
 *   ② 把结果按 `source + sourceId` 合并进现有 channels/catalog.json
 *      —— 只覆盖 days / count / withDesc，其它字段（名字/logo/group）保持原样，
 *         避免因为上游改名把匹配结果整体洗掉
 *   ③ 打印「多少条从『没有 days 字段』变成『N 天』」的对照，便于人工复核
 *
 * 跑法：node tools/refresh-days.mjs [tvsou|tvmao|all]
 */
import fs from 'node:fs'
import { log } from '../src/utils.mjs'

const WHICH = process.argv[2] || 'all'
const CATALOG = new URL('../channels/catalog.json', import.meta.url)

const cat = JSON.parse(fs.readFileSync(CATALOG, 'utf8'))
const items = cat.items

const want = WHICH === 'all' ? ['tvsou', 'tvmao'] : [WHICH]
const fresh = []
for (const src of want) {
  const mod = await import(`../src/sources/${src}.mjs`)
  log.info(`扫描 ${src}...`)
  const list = await mod.listChannels()
  fresh.push(...list)
  log.ok(`${src}: ${list.length} 条（其中 ${list.filter((c) => c.days > 0).length} 个台有节目）`)
}

// source+sourceId → 新探测结果
const byKey = new Map(fresh.map((c) => [`${c.source}:${c.sourceId}`, c]))

let merged = 0
let fromMissing = 0
const changes = []
const samples = []
for (const it of items) {
  if (!want.includes(it.source)) continue
  const n = byKey.get(`${it.source}:${it.sourceId}`)
  if (!n) continue
  const hadDays = Object.prototype.hasOwnProperty.call(it, 'days')
  const before = hadDays ? it.days : null
  it.days = n.days
  it.count = n.count
  if (Object.prototype.hasOwnProperty.call(n, 'withDesc')) it.withDesc = n.withDesc
  // ★ fallbackOnly 也要带进来：它决定这个源能不能当主源（见 match.mjs pickBest）
  if (Object.prototype.hasOwnProperty.call(n, 'fallbackOnly')) it.fallbackOnly = n.fallbackOnly
  merged++
  if (!hadDays) fromMissing++
  const line = `${it.source}:${it.sourceId} ${it.name} ${hadDays ? before + '天' : '(缺字段)'} → ${n.days}天/${n.count}条`
  if (!hadDays || before !== n.days) changes.push(line)
  else if (samples.length < 10) samples.push(line)
}

// 探测到了但 catalog 里没有的（上游新增频道）——只提示，不擅自插入
let notInCatalog = 0
for (const n of fresh) {
  if (!items.some((it) => it.source === n.source && String(it.sourceId) === String(n.sourceId))) notInCatalog++
}
if (notInCatalog) log.warn(`有 ${notInCatalog} 条探测结果在 catalog 里找不到对应条目（上游新增？未插入，需人工决定）`)

cat.generatedAt = new Date().toISOString()
cat.total = items.length
fs.writeFileSync(CATALOG, JSON.stringify(cat, null, 2) + '\n', 'utf8')

console.log(`\n合并完成：${merged} 条（其中 ${fromMissing} 条原本完全没有 days 字段）`)
console.log(`\n变化 ${changes.length} 条（前 40 条）：`)
for (const s of changes.slice(0, 40)) console.log('  ' + s)
if (changes.length > 40) console.log(`  ... 另有 ${changes.length - 40} 条`)
if (samples.length) {
  console.log('\n未变抽样：')
  for (const s of samples) console.log('  ' + s)
}
const stat = {}
for (const it of items) {
  if (!want.includes(it.source)) continue
  const k = it.days > 0 ? 'live' : 'empty'
  stat[`${it.source}:${k}`] = (stat[`${it.source}:${k}`] || 0) + 1
}
console.log('分布:', JSON.stringify(stat))
