/**
 * 「源自报 days 不许含过去的天」单元测试（2026-10-28 第十二轮新增）
 *
 * 为什么单独测：这是 §6.7 / §6.7b / §6.7c 那条硬规则的**第 4 次回归**。
 * 每次的症状都一样：某个源靠「多报 1 天」在 pickBest 里赢过数据更好的源，
 * 而报表只显示「匹配成功」，简介/天数悄悄变差。
 *
 * 本次实测事故（CI run 40625776572 产物）：
 *   nowNews.hk  简介 271 → **0**
 *   根因：webncode:nowtv_332 报 days=6（`availableDates.length` 含过去的天），
 *        压过 epgpw:410344 的 5 天，而 webncode 那台 withDesc=0。
 *        产物 perDay 是 {10-28..11-01 有, 11-02:0, 11-03:0} —— 实际可用只有 5 天。
 *
 * 跑法：node test/days-source.test.mjs
 */
import fs from 'node:fs'

let pass = 0
let fail = 0

function check(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`)
  }
}

console.log('\n[1] 静态检查：所有源的 listChannels 不许用「窗口长度」当天数')
{
  const files = fs
    .readdirSync(new URL('../src/sources/', import.meta.url))
    .filter((f) => f.endsWith('.mjs'))
  const bad = []
  // 白名单：这两处是**保守的实测上限**，不是虚报高（不是「窗口长度」推断）
  //   fengshows: days=1（实测只有当天可靠，明天不保证）
  //   kbro:      days=3（源本身只给 3 天）
  const ALLOW = { 'fengshows.mjs': [1], 'kbro.mjs': [3] }
  for (const f of files) {
    const src = fs.readFileSync(new URL(`../src/sources/${f}`, import.meta.url), 'utf8')
    // 典型错法（都是「用窗口大小推断天数」，会随日期变化而失真）：
    if (/days:\s*availableDates\.length/.test(src)) bad.push(`${f}: days=availableDates.length`)
    if (/const\s+days\s*=\s*j\.availableDates\.length/.test(src)) bad.push(`${f}: days=j.availableDates.length`)
    if (/days:\s*MAX_DAYS\b/.test(src)) bad.push(`${f}: days=MAX_DAYS`)
    // days: <数字>  —— 只允许 0（安全默认）和白名单里的保守上限
    for (const m of src.matchAll(/days:\s*(\d+)\s*,/g)) {
      const n = Number(m[1])
      if (n === 0) continue
      if ((ALLOW[f] || []).includes(n)) continue
      bad.push(`${f}: days=${n}`)
    }
  }
  check('没有源用「窗口长度」当天数（常数只允许 0 和白名单保守上限）', bad.length === 0, bad.join('; '))
}

console.log('\n[2] webncode.probeStat 必须切掉过去的天')
{
  const src = fs.readFileSync(new URL('../src/sources/webncode.mjs', import.meta.url), 'utf8')
  check('★ 有 todayYmd 过滤', /todayYmd/.test(src) && /d >= todayYmd|d < todayYmd/.test(src))
  check('★ 不再直接 availableDates.length 当 days', !/const days = j\.availableDates\.length/.test(src))
  check('有 futureDates 变量（先过滤再计数）', /futureDates/.test(src))
}

console.log('\n[3] 排序口径回归：days 相同后必须按 withDesc 选，不能选 0 简介的')
{
  // 用实测数据（catalog.json 里 nowNews 三个候选）
  const pickBest = (list) =>
    [...list].sort(
      (a, b) =>
        (b.days || 0) - (a.days || 0) ||
        (b.withDesc || 0) - (a.withDesc || 0) ||
        (b.count || 0) - (a.count || 0)
    )[0]

  const fixed = [
    { source: 'epgpw', days: 5, withDesc: 271, count: 273 },
    { source: 'nowplayer', days: 5, withDesc: 259, count: 259 },
    { source: 'webncode', days: 5, withDesc: 0, count: 312 }, // 修后：6 → 5
  ]
  check('★ 修后选 epgpw（271 简介）', pickBest(fixed).source === 'epgpw', pickBest(fixed).source)

  // 反证：webncode 报 6 天时它会赢，简介掉到 0
  const broken = [
    { source: 'epgpw', days: 5, withDesc: 271, count: 273 },
    { source: 'nowplayer', days: 5, withDesc: 259, count: 259 },
    { source: 'webncode', days: 6, withDesc: 0, count: 312 }, // 修前
  ]
  check('（反证）webncode 报 6 天时会赢 —— 这就是简介 271→0 的成因', pickBest(broken).source === 'webncode')
}

console.log('\n[4] catalog 快照自检（存在才跑）：nowNews 的候选里不该有「天数最多但简介为 0」的')
{
  let cat = null
  try {
    cat = JSON.parse(fs.readFileSync(new URL('../channels/catalog.json', import.meta.url), 'utf8'))
  } catch {
    /* 没有 catalog 就跳过 */
  }
  if (!cat) {
    console.log('  skip 没有 catalog.json')
  } else {
    const cands = cat.items.filter((c) => {
      const n = String(c.name || '')
      return n.includes('Now新聞') || n.includes('Now新闻')
    })
    const top = [...cands].sort((a, b) => (b.days || 0) - (a.days || 0))[0]
    check(
      'catalog 里 Now新聞台 天数最多的源不是「0 简介」',
      !top || (top.withDesc || 0) > 0,
      top ? `最高是 ${top.source}:${top.sourceId} ${top.days}天 withDesc=${top.withDesc}` : ''
    )
    console.log('   候选:', cands.map((c) => `${c.source}:${c.sourceId} ${c.days}天/${c.withDesc}简介`).join(' | '))
  }
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`)
if (fail) process.exit(1)
