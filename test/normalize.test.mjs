/**
 * normalizeProgrammes 的回归测试
 *
 * 为什么单独写这个文件（2026-10-27）：
 *   这一轮的三个缺陷全部藏在 normalize.mjs 里，而且**都不会报错**：
 *     ① 30 秒垫片被第 4 步拉长、又被第 5 步截回 —— 两步互相抵消，632 条一条没修好
 *     ② 后一条被前一条包住时，旧代码把后一条的 start 改成前一条的 stop
 *        → 电视猫的「00:03 讲武堂」变成「02:00 讲武堂」，时间轴倒序
 *     ③ 末条 stop 写成窗口末尾 → 被截成整齐的 12.00 小时
 *   CI 全绿、日志全绿，只有把产物拆开逐条比对才看得出来。
 *   所以这里把每种边界场景都钉死，改 normalize 必须跑通。
 *
 * 运行：npm test
 */
import { normalizeProgrammes } from '../src/normalize.mjs'

const T = (s) => Date.parse(s + '+08:00')
const P = (s) => {
  const m = s.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/)
  return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`)
}
const WIN = { dayStartTs: T('2026-10-27T00:00:00'), dayEndTs: T('2026-11-03T00:00:00') }
const lenSec = (r) => (P(r.stop) - P(r.start)) / 1000

let pass = 0
let fail = 0
function check(name, cond, detail = '') {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}  ${detail}`)
  }
}

// ── 1. 后一条被前一条完全包住 ────────────────────────────────────────
// 电视猫真实数据：大家谈 23:22→次日02:00 吞掉了 00:03 的讲武堂
// 旧代码把讲武堂 start 改成 02:00 → 时间轴倒序（后面还有 00:58 影视背景）
console.log('\n[1] 后一条被前一条完全包住（乱序根因）')
{
  const out = normalizeProgrammes(
    [
      { startTs: T('2026-11-01T23:22:00'), stopTs: T('2026-11-02T02:00:00'), title: '大家谈' },
      { startTs: T('2026-11-02T00:03:00'), stopTs: T('2026-11-02T00:57:00'), title: '讲武堂' },
    ],
    WIN
  )
  check('两条都保留', out.length === 2, `实际 ${out.length}`)
  check('讲武堂 start 未被改写', out[1].start.startsWith('202611020003'), out[1].start)
  check('大家谈 stop 截到 00:03', out[0].stop.startsWith('202611020003'), out[0].stop)
  check('无重叠', P(out[1].start) >= P(out[0].stop))
  check('无零长度', out.every((r) => P(r.stop) > P(r.start)))
}

// ── 2. 部分重叠 ─────────────────────────────────────────────────────
console.log('\n[2] 部分重叠：只截前一条')
{
  const out = normalizeProgrammes(
    [
      { startTs: T('2026-11-02T10:00:00'), stopTs: T('2026-11-02T12:00:00'), title: 'A' },
      { startTs: T('2026-11-02T11:00:00'), stopTs: T('2026-11-02T13:00:00'), title: 'B' },
    ],
    WIN
  )
  check('A.stop == B.start', P(out[0].stop) === P(out[1].start), `${out[0].stop} vs ${out[1].start}`)
  check('B 时长不变（2h）', lenSec(out[1]) === 2 * 3600, `${lenSec(out[1])}s`)
}

// ── 3. 三连重叠 ─────────────────────────────────────────────────────
console.log('\n[3] 三连重叠')
{
  const out = normalizeProgrammes(
    [
      { startTs: T('2026-11-02T10:00:00'), stopTs: T('2026-11-02T12:00:00'), title: 'A' },
      { startTs: T('2026-11-02T11:00:00'), stopTs: T('2026-11-02T13:00:00'), title: 'B' },
      { startTs: T('2026-11-02T12:30:00'), stopTs: T('2026-11-02T14:00:00'), title: 'C' },
    ],
    WIN
  )
  let ov = 0
  for (let i = 1; i < out.length; i++) if (P(out[i].start) < P(out[i - 1].stop)) ov++
  check('无重叠', ov === 0, `重叠 ${ov} 处`)
  check('三条都保留', out.length === 3, `实际 ${out.length}`)
}

// ── 4. 30 秒垫片连播 ────────────────────────────────────────────────
// CCTV-8K 的真实形态：492 条 30 秒宣传片首尾相接
// 旧代码第 4 步拉长、第 5 步截回 → 一条都没修好，也没人发现
console.log('\n[4] 30 秒垫片连播：保留真实时长，不编造')
{
  const out = normalizeProgrammes(
    [
      { startTs: T('2026-10-27T07:00:00'), stopTs: T('2026-10-27T07:00:35'), title: 'A' },
      { startTs: T('2026-10-27T07:00:35'), stopTs: T('2026-10-27T07:01:05'), title: 'B' },
      { startTs: T('2026-10-27T07:01:05'), stopTs: T('2026-10-27T07:01:35'), title: 'C' },
    ],
    WIN
  )
  check('三条都保留', out.length === 3, `实际 ${out.length}`)
  check('A 保持 35 秒（没被拉成 60 秒）', lenSec(out[0]) === 35, `${lenSec(out[0])}s`)
  check('B 保持 30 秒', lenSec(out[1]) === 30, `${lenSec(out[1])}s`)
  check('首尾相接无重叠', P(out[1].start) === P(out[0].stop))
}

// ── 5. 孤立短节目 ───────────────────────────────────────────────────
console.log('\n[5] 孤立 30 秒：有空位才拉到 1 分钟')
{
  const out = normalizeProgrammes(
    [
      { startTs: T('2026-10-27T07:00:00'), stopTs: T('2026-10-27T07:00:30'), title: 'A' },
      { startTs: T('2026-10-27T08:00:00'), stopTs: T('2026-10-27T09:00:00'), title: 'B' },
    ],
    WIN
  )
  check('A 拉到 60 秒', lenSec(out[0]) === 60, `${lenSec(out[0])}s`)
  check('不压到 B', P(out[0].stop) <= P(out[1].start))
}

// ── 6. 末条超长 ─────────────────────────────────────────────────────
// epg.pw 把末条 stop 写成数据窗口末尾：CCTV1「宗师列传」02:49→次日00:00 = 21.2h
console.log('\n[6] 末条 21 小时：截到 12h（保留覆盖，不留空洞）')
{
  const out = normalizeProgrammes(
    [{ startTs: T('2026-11-02T02:49:30'), stopTs: T('2026-11-03T00:00:00'), title: '宗师列传' }],
    WIN
  )
  check('截到 12h', lenSec(out[0]) === 12 * 3600, `${lenSec(out[0]) / 3600}h`)
}

// ── 7. 去重 ─────────────────────────────────────────────────────────
console.log('\n[7] 同 start 同标题去重')
{
  const out = normalizeProgrammes(
    [
      { startTs: T('2026-10-27T07:00:00'), stopTs: T('2026-10-27T08:00:00'), title: 'A' },
      { startTs: T('2026-10-27T07:00:00'), stopTs: T('2026-10-27T08:00:00'), title: 'A' },
    ],
    WIN
  )
  check('只留一条', out.length === 1, `实际 ${out.length}`)
}

// ── 8. 窗口裁剪 ─────────────────────────────────────────────────────
console.log('\n[8] 窗口裁剪')
{
  const out = normalizeProgrammes(
    [
      { startTs: T('2026-10-20T07:00:00'), stopTs: T('2026-10-20T08:00:00'), title: '窗口前' },
      { startTs: T('2026-10-27T07:00:00'), stopTs: T('2026-10-27T08:00:00'), title: '窗口内' },
      { startTs: T('2026-11-10T07:00:00'), stopTs: T('2026-11-10T08:00:00'), title: '窗口后' },
    ],
    WIN
  )
  check('只留窗口内', out.length === 1 && out[0].title === '窗口内', out.map((r) => r.title).join(','))
}

// ── 9. stop 缺失 ────────────────────────────────────────────────────
console.log('\n[9] stop 缺失：用下一条 start')
{
  const out = normalizeProgrammes(
    [
      { startTs: T('2026-10-27T07:00:00'), stopTs: null, title: 'A' },
      { startTs: T('2026-10-27T08:00:00'), stopTs: T('2026-10-27T09:00:00'), title: 'B' },
    ],
    WIN
  )
  check('A.stop == B.start', P(out[0].stop) === P(out[1].start), `${out[0].stop} vs ${out[1].start}`)
}

// ── 10. 整体不变量 ──────────────────────────────────────────────────
// 随便造一批乱数据，只验证「输出永远满足」的三条不变量
console.log('\n[10] 随机乱数据的不变量')
{
  const rows = []
  let t = T('2026-10-27T00:00:00')
  for (let i = 0; i < 200; i++) {
    const dur = [30, 60, 1800, 3600, 5 * 3600, 20 * 3600][i % 6] * 1000
    const gap = [0, 0, -600e3, 1800e3][i % 4] // 含重叠、含断档
    t += gap
    rows.push({ startTs: t, stopTs: t + dur, title: `P${i}` })
    t += dur
  }
  const out = normalizeProgrammes(rows, WIN)
  let sorted = true
  let overlap = 0
  let zero = 0
  for (let i = 0; i < out.length; i++) {
    if (P(out[i].stop) <= P(out[i].start)) zero++
    if (i > 0) {
      if (P(out[i].start) < P(out[i - 1].start)) sorted = false
      if (P(out[i].start) < P(out[i - 1].stop)) overlap++
    }
  }
  check('按 start 单调递增', sorted)
  check('无重叠', overlap === 0, `${overlap} 处`)
  check('无零长度', zero === 0, `${zero} 条`)
  check('未超数量上限', out.length <= 3000)
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
if (fail) {
  console.error('\nnormalize.mjs 的边界行为被改坏了，见上面 FAIL 行。')
  process.exit(1)
}
