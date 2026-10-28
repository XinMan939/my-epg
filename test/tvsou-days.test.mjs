/**
 * tvsou / tvmao 的 days / count 真探单元测试（2026-10-28 第十七轮新增）
 *
 * 为什么单独测：这两个源在 catalog 里长期「没有 days 字段」，
 * 而 match.mjs 的 pickBest 用 `a.days || 0` —— 缺字段 = 0 天 = **永远垫底**，
 * 于是任何一台只要被 tvsou/tvmao 选中，就说明别的源全是 0 天（空壳），
 * 报表里只剩一句 `empty(tvsou:b6d548b0=0)`，分不清「源是空壳」还是「解析坏了」。
 *
 * 这属于「自报数据静默失真」那一家族的第 N 次：日志全绿、报表有数字，
 * 但排序依据是假的。所以这里把行为钉死：
 *   [1] parseRows 的边界（标签剥离 / 空标题丢弃）
 *   [2] tvsou.probeWeek：空台必须早退（1 个请求），有数据的台必须探满 7 天
 *   [3] tvmao.probeWeek：半月（只 3 天有）必须如实报 3 天，不能虚报 7
 *   [4] 源码护栏：listChannels 推出去的条目必须带 days / count，
 *       且不许出现硬编码的非零天数（天数只能来自探测）
 *
 * 跑法：node test/tvsou-days.test.mjs
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

const tvsou = await import('../src/sources/tvsou.mjs')
const tvmao = await import('../src/sources/tvmao.mjs')

/** 造一页「n 条节目」的假 HTML（结构与真实页面一致） */
function pageOf(n, { emptyMark = false } = {}) {
  if (emptyMark) return '<html><body>所选日期暂无可用节目单</body></html>'
  const rows = []
  for (let i = 0; i < n; i++) {
    const hh = String(Math.floor(i / 2) % 24).padStart(2, '0')
    const mm = i % 2 === 0 ? '00' : '30'
    rows.push(`<tr><td>${hh}:${mm}</td><td>节目${i}</td></tr>`)
  }
  return `<html><body><table>${rows.join('')}</table></body></html>`
}

console.log('\n[1] tvsou.parseRows：边界')
{
  check('正常 3 条', tvsou.parseRows(pageOf(3)).length === 3)
  check('空页面 0 条', tvsou.parseRows('').length === 0)
  check('港澳台空表 0 条', tvsou.parseRows(pageOf(0, { emptyMark: true })).length === 0)
  const withTag = '<tr><td>01:04</td><td><a href="/x">新闻</a> <b>联播</b></td></tr>'
  const r = tvsou.parseRows(withTag)
  check('★ 剥离行内标签（不能把 <a> 当标题）', r.length === 1 && r[0].title === '新闻 联播', r[0]?.title)
  const blank = '<tr><td>01:04</td><td><span></span></td></tr>'
  check('★ 空标题丢弃（否则会刷出无数空节目）', tvsou.parseRows(blank).length === 0)
  const bad = '<tr><td>1:04</td><td>时间格式不对</td></tr>'
  check('★ 时间不是 HH:MM 就不算行', tvsou.parseRows(bad).length === 0)
}

console.log('\n[2] tvsou.probeWeek：空台早退 / 有数据探满 7 天')
{
  // 记录每次请求的是哪个 weekday
  const calls = []
  const fakeFetch = (url) => {
    const w = Number(url.match(/\/w(\d+)$/)[1])
    calls.push(w)
    return { ok: true, status: 200, text: pageOf(0, { emptyMark: true }) }
  }
  const st = await tvsou.probeWeek('deadbeef', { fetch: fakeFetch, weekday: 3 })
  check('★ 空台只发 1 个请求（早退，476 个台才不至于跑 1 小时）', calls.length === 1, `实际 ${calls.length} 个`)
  check('★ 早退请求的是「今天对应的 weekday」', calls[0] === 3, String(calls[0]))
  check('空台返回 {days:0, count:0}', st.days === 0 && st.count === 0, JSON.stringify(st))

  // 有数据：7 天各 10 条 → 7 天 / 70 条
  const calls2 = []
  const fakeAll = (url) => {
    calls2.push(url)
    return { ok: true, status: 200, text: pageOf(10) }
  }
  const st2 = await tvsou.probeWeek('live0001', { fetch: fakeAll, weekday: 3 })
  check('有数据的台探满 7 个 weekday', calls2.length === 7, `实际 ${calls2.length}`)
  check('days=7', st2.days === 7, String(st2.days))
  check('count=70（真数，不是估算）', st2.count === 70, String(st2.count))

  // ★ 只探到 6 天（w7 周日还没发布）——实测就是这种形态，不能报 7
  const calls3 = []
  const fakeSix = (url) => {
    const w = Number(url.match(/\/w(\d+)$/)[1])
    calls3.push(w)
    return { ok: true, status: 200, text: w === 7 ? pageOf(0, { emptyMark: true }) : pageOf(5) }
  }
  const st3 = await tvsou.probeWeek('sixdays', { fetch: fakeSix, weekday: 3 })
  check('★ w7 空时如实报 6 天（实测 4 个台就是这个形态）', st3.days === 6, String(st3.days))

  // 单天失败要跳过（保守），不能把失败当 0 天导致早退
  let n = 0
  const fakeFlaky = (url) => {
    n++
    const w = Number(url.match(/\/w(\d+)$/)[1])
    if (w === 4) return { ok: false, status: 0, text: '' }
    return { ok: true, status: 200, text: pageOf(2) }
  }
  const st4 = await tvsou.probeWeek('flaky', { fetch: fakeFlaky, weekday: 3 })
  check('★ 单天抓取失败不计入天数（不是 0 天）', st4.days === 6, String(st4.days))
}

console.log('\n[3] tvmao.probeWeek：半月必须如实报')
{
  // 三沙卫视实测形态：w1-w3 有 46 条，w4-w7 空
  const fakeGetDay = (id, w) => ({ programmes: w <= 3 ? new Array(46).fill(0) : [] })
  const st = await tvmao.probeWeek('SANSHATV', '三沙卫视', { getDay: fakeGetDay })
  check('★ 三沙卫视式半月：days=3（不能虚报 7）', st.days === 3, String(st.days))
  check('count=138（46×3，真数）', st.count === 138, String(st.count))

  // 快乐垂钓实测形态：w1-w4 有，w5-w7 空
  const fakeGetDay2 = (id, w) => ({ programmes: w <= 4 ? new Array(20).fill(0) : [] })
  const st2 = await tvmao.probeWeek('CCTVPAYFEE-KUAILECHUIDIAO', '快乐垂钓', { getDay: fakeGetDay2 })
  check('快乐垂钓式：days=4', st2.days === 4, String(st2.days))

  // 全空
  const st3 = await tvmao.probeWeek('EMPTY', '空台', { getDay: () => ({ programmes: [] }) })
  check('全空 → days=0 / count=0', st3.days === 0 && st3.count === 0, JSON.stringify(st3))
  // 全满
  const st4 = await tvmao.probeWeek('FULL', '满台', { getDay: () => ({ programmes: new Array(7).fill(0) }) })
  check('全满 → days=7 / count=49', st4.days === 7 && st4.count === 49, JSON.stringify(st4))
}

console.log('\n[4] 源码护栏：listChannels 必须带 days / count，且不许硬编码天数')
{
  for (const [f, mod] of [
    ['tvsou.mjs', tvsou],
    ['tvmao.mjs', tvmao],
  ]) {
    const src = fs.readFileSync(new URL(`../src/sources/${f}`, import.meta.url), 'utf8')
    check(`${f}: 推条目的对象里有 days: 0 占位`, /days:\s*0,/.test(src))
    check(`${f}: 推条目的对象里有 count: 0 占位`, /count:\s*0,/.test(src))
    check(`${f}: 调用了 probeWeek`, /probeWeek\(/.test(src))
    check(`${f}: 用了探测缓存（readProbeCache + writeProbeCache）`, /readProbeCache/.test(src) && /writeProbeCache/.test(src))
    check(`${f}: 有退出开关（probeDisabled）`, /probeDisabled\(/.test(src))
    check(`${f}: 探测结果写回条目（days = st.days）`, /c\.days\s*=\s*st\.days/.test(src))
    check(`${f}: meta.hasDesc 仍是 false（本源确实没有简介）`, mod.meta.hasDesc === false)
  }

  // ★ 天数只能来自探测，不许再出现「常量天数」（days-source.test.mjs 的同一口径）
  for (const f of ['tvsou.mjs', 'tvmao.mjs']) {
    const src = fs.readFileSync(new URL(`../src/sources/${f}`, import.meta.url), 'utf8')
    const bad = [...src.matchAll(/days:\s*(\d+)\s*,/g)].map((m) => Number(m[1])).filter((n) => n !== 0)
    check(`${f}: 没有硬编码的非零 days`, bad.length === 0, bad.join(','))
  }

  // 探测缓存必须带版本号（改了算法不改版本 → 旧缓存让改动静默失效）
  const pc = fs.readFileSync(new URL('../src/probe-cache.mjs', import.meta.url), 'utf8')
  check('★ 缓存命中条件包含版本号', /j\.ver\s*!==\s*ver/.test(pc))
  check('★ 缓存命中条件包含「当天」（跨天必须失效，周栅格会错位）', /j\.ymd\s*!==\s*dateInCST\(\)/.test(pc))
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`)
if (fail) process.exit(1)
