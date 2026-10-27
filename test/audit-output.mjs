/**
 * 产物时间轴体检
 *
 * 为什么需要（2026-10-27）：
 *   build 成功、CI 全绿、report.json 数字正常 —— 但产物里的时间轴可能是错的：
 *     · 同一频道有节目重叠（播放器会同时显示两条「正在播」）
 *     · XML 里的节目顺序不是按时间递增（播放器渲染出来是乱的）
 *     · 零长度 / 负长度节目
 *   这些都不会让任何一步报错。所以每次构建后跑一遍，有硬伤就 exit 1。
 *
 * 用法：node test/audit-output.mjs [xml 路径]
 *   默认读 output/epg.xml
 *
 * 判定口径（都是「一定有 bug」的硬伤，不看覆盖率这类软指标）：
 *   FAIL  重叠 > 1 分钟
 *   FAIL  XML 内 start 非单调递增
 *   FAIL  零长度 / 负长度
 *   FAIL  stop 缺失或无法解析
 *   WARN  时长 > 6 小时（末条 stop 常被上游写成窗口末尾，已知限制）
 *   WARN  时长 < 1 分钟（30 秒垫片，上游本来就这样）
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'

const file = process.argv[2] || 'output/epg.xml'
const abs = path.resolve(file)
if (!fs.existsSync(abs)) {
  console.error(`找不到 ${abs}`)
  process.exit(1)
}
const raw = fs.readFileSync(abs)
const xml = abs.endsWith('.gz') ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8')

function parseT(s) {
  const m = s && s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\s*([+-]\d{4})$/)
  if (!m) return null
  const [, y, mo, d, h, mi, se, tz] = m
  const sign = tz[0] === '-' ? -1 : 1
  const off = sign * (Number(tz.slice(1, 3)) * 60 + Number(tz.slice(3, 5)))
  return Date.UTC(+y, +mo - 1, +d, +h, +mi, +se) - off * 60000
}

const byCh = new Map()
let total = 0
for (const p of xml.split('<programme').slice(1)) {
  const head = p.split('>')[0]
  const ch = head.match(/channel="([^"]+)"/)?.[1]
  const st = head.match(/start="([^"]+)"/)?.[1]
  const sp = head.match(/stop="([^"]+)"/)?.[1]
  if (!ch) continue
  total++
  if (!byCh.has(ch)) byCh.set(ch, [])
  byCh.get(ch).push({ st, sp, a: parseT(st), b: sp ? parseT(sp) : null })
}

const bad = { overlap: [], unsorted: [], zeroLen: [], negLen: [], noStop: [], badStart: [] }
const warn = { over6h: 0, under1min: 0 }
const over6hCh = new Set()

for (const [ch, rows] of byCh) {
  // XML 里的原始顺序必须按 start 递增
  for (let i = 1; i < rows.length; i++) {
    if (rows[i].a != null && rows[i - 1].a != null && rows[i].a < rows[i - 1].a) {
      bad.unsorted.push(`${ch} 第 ${i} 条 ${rows[i].st} 早于上一条 ${rows[i - 1].st}`)
      break
    }
  }

  const sorted = [...rows].sort((x, y) => (x.a ?? 0) - (y.a ?? 0))
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i]
    if (r.a == null) {
      bad.badStart.push(`${ch} ${r.st}`)
      continue
    }
    if (r.b == null) {
      bad.noStop.push(`${ch} ${r.st}`)
      continue
    }
    const len = (r.b - r.a) / 60000
    if (len === 0) bad.zeroLen.push(`${ch} ${r.st}`)
    else if (len < 0) bad.negLen.push(`${ch} ${r.st} 长度 ${len.toFixed(1)}min`)
    else if (len < 1) warn.under1min++
    else if (len > 360) {
      warn.over6h++
      over6hCh.add(ch)
    }
    if (i > 0 && sorted[i - 1].b != null) {
      const g = (r.a - sorted[i - 1].b) / 60000
      if (g < -1) bad.overlap.push(`${ch} 重叠 ${(-g).toFixed(0)}min：${sorted[i - 1].st}→${sorted[i - 1].sp} 与 ${r.st}`)
    }
  }
}

console.log(`产物 ${file}`)
console.log(`频道 ${byCh.size} / 节目 ${total}`)
console.log('')

const lines = Object.entries(bad).filter(([, v]) => v.length)
if (lines.length) {
  console.log('★ 硬伤（必须修）：')
  for (const [k, v] of lines) {
    console.log(`  ${k}: ${v.length} 条`)
    v.slice(0, 5).forEach((s) => console.log(`      ${s}`))
    if (v.length > 5) console.log(`      … 另有 ${v.length - 5} 条`)
  }
  console.log('')
} else {
  console.log('★ 硬伤：无（重叠 0 / 乱序 0 / 零长度 0 / 缺 stop 0）')
  console.log('')
}

console.log('软指标（已知限制，不阻塞）：')
console.log(`  时长 > 6 小时：${warn.over6h} 条（涉及 ${over6hCh.size} 个频道）`)
console.log(`    多为末条 stop 被上游写成「数据窗口末尾」，截到 12h 后覆盖到窗口边界。`)
console.log(`  时长 < 1 分钟：${warn.under1min} 条（30 秒垫片，上游本来就这样）`)

const hardCount = lines.reduce((a, [, v]) => a + v.length, 0)
if (hardCount) {
  console.error(`\n产物有 ${hardCount} 处硬伤，退出码 1。`)
  process.exit(1)
}
console.log('\n时间轴体检通过。')
