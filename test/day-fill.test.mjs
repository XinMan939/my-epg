/**
 * 补天逻辑的单元测试
 *
 * 为什么单独写这个文件：
 *   「天数不够时用备选源补齐」是个**不报错的功能**——补少了看不出来，
 *   补错了会串台（把别的台的节目塞进来）。所以边界必须钉死。
 *
 * 本轮实测背景（2026-10-27）：
 *   epg.pw 的 CN 包对 352 个频道只给「滚动 24 小时」，
 *   形态是「今天 16h + 明天 8h，再往后 0h」。
 *   降级链 `if (list.length) break` 让这 44 个频道永远只有 1~2 天，
 *   而 tvmao 上其中 18 个有完整 7 天。
 *
 * 跑法：node test/day-fill.test.mjs
 */
import { countCoveredDays, pickMissingDays } from '../src/index.mjs'
import { sameRegionVersion } from '../src/utils.mjs'
import { normalizeProgrammes } from '../src/normalize.mjs'

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

const DAY = 24 * 3600 * 1000
// 窗口：2026-10-27 00:00 起，7 天（北京时间）
const W0 = Date.parse('2026-10-27T00:00:00+08:00')
const dates = Array.from({ length: 7 }, (_, i) => ({
  ts0: W0 + i * DAY,
  ts1: W0 + (i + 1) * DAY,
}))

const H = (n) => n * 3600 * 1000
/** 造一条节目：第 dayIndex 天的第 fromH 小时到 toH 小时 */
const seg = (dayIndex, fromH, toH) => ({
  startTs: dates[dayIndex].ts0 + H(fromH),
  stopTs: dates[dayIndex].ts0 + H(toH),
})

console.log('\n[1] countCoveredDays：正常满 7 天')
{
  const rows = []
  for (let d = 0; d < 7; d++) rows.push(seg(d, 0, 24))
  check('7 天全满 = 7', countCoveredDays(rows, dates, 6) === 7)
}

console.log('\n[2] ★ epg.pw 的真实形态「今天16h + 明天8h，其余0h」')
{
  const rows = [seg(0, 8, 24), seg(1, 0, 8)]
  // 按「有 1 条就算」的旧口径会数成 2 天；按「覆盖满 6 小时」也是 2 天
  // （今天 16h ≥ 6，明天 8h ≥ 6）—— 这里要确认的是「只有 2 天，不是 7 天」
  check('只算 2 天（不是 7 天）', countCoveredDays(rows, dates, 6) === 2)
}

console.log('\n[3] ★ 明天只有 3 小时：不该算成 1 天')
{
  const rows = [seg(0, 8, 24), seg(1, 0, 3)]
  check('今天 16h 算 1 天，明天 3h 不算', countCoveredDays(rows, dates, 6) === 1)
}

console.log('\n[4] 空数组 = 0 天')
{
  check('空 = 0', countCoveredDays([], dates, 6) === 0)
}

console.log('\n[5] 脏数据（stop <= start）不计入')
{
  const rows = [{ startTs: dates[0].ts0, stopTs: dates[0].ts0 }, ...Array.from({ length: 7 }, (_, d) => seg(d, 0, 24))]
  check('零长度被忽略，仍是 7 天', countCoveredDays(rows, dates, 6) === 7)
}

console.log('\n[6] 跨天节目（22:00 → 次日 06:00）两天都算')
{
  const rows = [{
    startTs: dates[0].ts0 + H(22),
    stopTs: dates[1].ts0 + H(6),
  }]
  // 第 0 天 2h，第 1 天 6h → 只有第 1 天达标
  check('跨天节目按实际覆盖小时拆分', countCoveredDays(rows, dates, 6) === 1)
}

console.log('\n[7] pickMissingDays：已满 7 天时返回空（不该多跑一次网络）')
{
  const existing = []
  for (let d = 0; d < 7; d++) existing.push(seg(d, 0, 24))
  const cand = [seg(0, 0, 24), seg(3, 0, 24)]
  check('够 7 天 → 返回 0 条', pickMissingDays(cand, existing, dates, 6).length === 0)
}

console.log('\n[8] ★ pickMissingDays：只补空缺的天，已有天一条不动')
{
  const existing = [seg(0, 8, 24), seg(1, 0, 8)] // 只有 0、1 两天
  const cand = []
  for (let d = 0; d < 7; d++) cand.push(seg(d, 0, 24))
  const add = pickMissingDays(cand, existing, dates, 6)
  check('只补 5 天（第 2~6 天）', add.length === 5, `实际 ${add.length}`)
  check('第 0 天不在补的里面', !add.some((r) => r.startTs >= dates[0].ts0 && r.startTs < dates[0].ts1))
  check('第 1 天不在补的里面', !add.some((r) => r.startTs >= dates[1].ts0 && r.startTs < dates[1].ts1))
  check('补的是第 2~6 天', add.every((r) => r.startTs >= dates[2].ts0 && r.startTs < dates[6].ts1))
}

console.log('\n[9] ★ 合并后主源内容完整保留（简介不丢）')
{
  const primary = [
    { ...seg(0, 8, 24), title: '主源节目A', desc: '主源简介A' },
    { ...seg(1, 0, 8), title: '主源节目B', desc: '主源简介B' },
  ]
  const cand = []
  for (let d = 0; d < 7; d++) cand.push({ ...seg(d, 0, 24), title: `备选节目${d}`, desc: '' })
  const add = pickMissingDays(cand, primary, dates, 6)
  const merged = [...primary, ...add]
  check('主源 2 条都在', merged.filter((r) => r.desc).length === 2)
  check('合并后覆盖 7 天', countCoveredDays(merged, dates, 6) === 7)
  check('总条数 = 2 + 5', merged.length === 7)
}

console.log('\n[10] 备选源给的天数也不够时，能补多少补多少')
{
  const existing = [seg(0, 8, 24)]
  const cand = [seg(0, 0, 24), seg(1, 0, 24), seg(2, 0, 24)] // 只有 3 天
  const add = pickMissingDays(cand, existing, dates, 6)
  check('补到第 1、2 天', add.length === 2)
  check('合并后 = 3 天', countCoveredDays([...existing, ...add], dates, 6) === 3)
}

console.log('\n[11] 时间窗外的节目不该被补进来')
{
  const existing = [seg(0, 8, 24)]
  const outOfWindow = { startTs: dates[0].ts0 - H(10), stopTs: dates[0].ts0 - H(2) }
  const add = pickMissingDays([outOfWindow], existing, dates, 6)
  check('窗口前的节目不补', add.length === 0)
}

console.log('\n[12] 随机：补完后覆盖天数只能增不能减')
{
  let ok = true
  for (let t = 0; t < 200; t++) {
    const existing = []
    for (let d = 0; d < 7; d++) {
      if (Math.random() < 0.5) {
        const from = Math.floor(Math.random() * 20)
        existing.push(seg(d, from, Math.min(24, from + 1 + Math.floor(Math.random() * 8))))
      }
    }
    const cand = []
    for (let d = 0; d < 7; d++) cand.push(seg(d, 0, 24))
    const before = countCoveredDays(existing, dates, 6)
    const after = countCoveredDays([...existing, ...pickMissingDays(cand, existing, dates, 6)], dates, 6)
    if (after < before) { ok = false; break }
  }
  check('200 次随机，补完不倒退', ok)
}

/* ==========================================================================
 * [13] ★ 区域版本校验：补天最危险的一种串台
 *
 * 实测事故（2026-10-27）：CCTV4 有亚洲/欧洲/美洲三个版本，节目编排完全不同。
 *   nameVariants('CCTV4欧洲') → ['cctv4欧洲', 'cctv4']
 *   nameVariants('CCTV-4 (亚洲)') → ['cctv4']          ← 裸 cctv4 撞上
 *   于是补天把「CCTV-4 (亚洲)」当成欧洲版的备选，补进来 6 天国内版电视剧
 *   《爱在青山绿水间》——而欧洲版实际放《精彩音乐汇（海外版）》。
 *
 * 这条断言的价值：它挡的是「补得越多错得越多」。
 *   补天把覆盖率从 73.6% 拉到 82.8%，如果里面混着串台的频道，
 *   那就是拿「看起来有节目」换「节目是错的」，比不补更糟。
 * ========================================================================== */
console.log('\n[13] ★ 区域版本：不同版本绝不能互相补天')
{
  const mustReject = [
    ['CCTV4欧洲', 'CCTV-4 (亚洲)', '欧洲版 vs 亚洲版'],
    ['CCTV4美洲', 'CCTV-4 (亚洲)', '美洲版 vs 亚洲版'],
    ['CCTV4欧洲', 'CCTV-4中文国际（美）', '欧洲版 vs 美洲版'],
    ['CCTV4美洲', 'CCTV-4 (欧洲)', '美洲版 vs 欧洲版'],
  ]
  for (const [a, b, why] of mustReject) {
    check(`拒绝：${why}`, sameRegionVersion(a, b) === false)
  }

  const mustPass = [
    ['CCTV4欧洲', 'CCTV-4 (欧洲)', '同名同版本'],
    ['CCTV4美洲', 'CCTV-4 (美洲)', '同名同版本'],
    ['CCTV4欧洲', 'CCTV-4中文国际（欧）', '「欧」=「欧洲」同义'],
    ['CCTV4美洲', 'CCTV-4中文国际（美）', '「美」=「美洲」同义'],
    // ★ 一边没写区域词 → 视为默认版，必须放行。
    //   否则「CCTV-4」与「CCTV-4 (亚洲)」这组正确配对会被误拒，
    //   白白丢掉大量能补的频道。
    ['CCTV-4', 'CCTV-4 (亚洲)', '无区域词 = 默认版，兼容'],
    ['CCTV4欧洲', 'CCTV-4', '一边没区域词，放行'],
    ['浙江卫视', '浙江卫视', '普通卫视不受影响'],
    ['东方卫视', '东方卫视', '普通卫视不受影响'],
    ['CCTV2', 'CCTV-2财经', '央视主频道不受影响'],
    ['博斯高球台', '博斯高球1台', '数字后缀不是区域词'],
    ['CGTN法语', 'CGTN 法语', '语种不是区域词'],
  ]
  for (const [a, b, why] of mustPass) {
    check(`放行：${why}`, sameRegionVersion(a, b) === true)
  }

  // 对称性：判定必须与参数顺序无关，否则「主源/备选谁在前」会改变结果
  let sym = true
  const all = [...mustReject, ...mustPass]
  for (const [a, b] of all) {
    if (sameRegionVersion(a, b) !== sameRegionVersion(b, a)) sym = false
  }
  check('判定对称（与参数顺序无关）', sym)
}

/* ==========================================================================
 * [14] ★ 重叠必须整条丢弃 —— 第六轮第二个真 bug
 *
 * 实测事故：东方卫视 11-01。
 *   主源（epg.pw）当天只有 00:00-04:00 这 4 小时，不足 6 小时阈值
 *   → 按「天」判断为「需要补」
 *   → 第一版实现把 tvmao 当天 36 条**全部**塞进来（包括与主源重叠的时段）
 *   → 那天变成 62 条（其他天 42 条），时间轴上
 *     「电视剧：南来北往」和「电视剧：南来北往(25)」交替出现，
 *     同一时段两条节目并存，播放器上节目会乱跳。
 *
 * 为什么不能裁剪而必须整条丢：
 *   两个源的节目边界不对齐（epg.pw 08:00-09:55，tvmao 08:00-09:45）。
 *   裁剪会造出「09:45-09:55 的 10 分钟节目，标题还是前一条的」——假数据。
 *   整条丢的代价是那天可能仍不满 6 小时，但不会产出错误内容。
 * ========================================================================== */
console.log('\n[14] ★ 与已有内容重叠的节目必须整条丢弃（不裁剪）')
{
  // 主源：第 3 天只有 00:00-04:00（4h，不足 6h 阈值）
  const existing = [seg(3, 0, 4)]
  // 备选源：第 3 天全天 0-24 覆盖
  const cand = [seg(3, 0, 24)]

  const add = pickMissingDays(cand, existing, dates, 6)

  check('重叠的那条被丢掉', add.length === 0, `实际补了 ${add.length} 条`)
  check('合并后没有重叠段', (() => {
    const merged = [...existing, ...add].sort((x, y) => x.startTs - y.startTs)
    for (let i = 1; i < merged.length; i++) {
      if (merged[i].startTs < merged[i - 1].stopTs) return false
    }
    return true
  })())

  // ★ 关键：备选源给了 6 条细粒度节目，只有「不重叠」的那部分能进
  const fine = [
    seg(3, 0, 2), seg(3, 2, 4),      // 与主源 0-4 重叠 → 全丢
    seg(3, 4, 8), seg(3, 8, 12),     // 4-12 与主源不重叠 → 保留
    seg(3, 12, 18), seg(3, 18, 24),  // 12-24 也不重叠 → 保留
  ]
  const add2 = pickMissingDays(fine, existing, dates, 6)
  check('只保留 4 条不重叠的', add2.length === 4, `实际 ${add2.length}`)
  check('保留的都从 04:00 之后开始', add2.every((r) => r.startTs >= dates[3].ts0 + H(4)))
  check('补齐后这天满 24 小时', countCoveredDays([...existing, ...add2], dates, 6) === 1
    && (() => {
      let h = 0
      for (const r of [...existing, ...add2]) h += (r.stopTs - r.startTs) / 3600000
      return Math.abs(h - 24) < 0.01
    })())
}

/* ==========================================================================
 * [15] 备选源内部的重复也要挡
 *
 * 同一个源同一天有时会给两条时间重叠的节目（上游脏数据），
 * 补进来后一样会让播放器乱跳。已经补进去的要占位。
 * ========================================================================== */
console.log('\n[15] 备选源内部的重复节目也要挡')
{
  const existing = [seg(2, 0, 4)]
  const cand = [
    seg(2, 6, 12),
    seg(2, 10, 16), // 与前一条重叠 10-12
    seg(2, 16, 24),
  ]
  const add = pickMissingDays(cand, existing, dates, 6)
  check('只进 2 条（第 2 条与前一条重叠）', add.length === 2, `实际 ${add.length}`)
  const sorted = [...add].sort((x, y) => x.startTs - y.startTs)
  check('进来的两条互不重叠', sorted.length < 2 || sorted[1].startTs >= sorted[0].stopTs)
}

/* ==========================================================================
 * [16] ★★ 为什么重叠必须挡在补天环节，而不能指望 normalize 兜底
 *
 * 这是本轮最贵的一条教训。
 *
 * normalize 第 5 步修重叠的规则是「只截前一条的 stop」：
 *   for (...) if (cur.startTs < prev.stopTs) prev.stopTs = cur.startTs
 *   list = list.filter(r => r.stopTs > r.startTs)   // 零长度的丢掉
 *
 * 于是「同 start、不同 title」的两条节目（主源 08:00-09:55 带简介，
 * 备选 08:00-09:45 无简介）走完这段会变成：
 *   prev(主源) 被截成 08:00-08:00 → 零长度 → 删除
 *   cur(备选) 08:00-09:45 → 留下
 * **结果：带简介的那条没了，留下的是无简介的。**
 *
 * 也就是说，补天如果放进重叠记录，不只是「节目重复显示」，
 * 而是「用无简介版本换掉有简介版本」——简介覆盖率会凭空下降。
 * 所以必须在 pickMissingDays 里就挡掉，normalize 兜不住。
 * ========================================================================== */
console.log('\n[16] ★★ 证明：重叠记录会让 normalize 删掉带简介的主源节目')
{
  const primary = { ...seg(0, 8, 9.9166), title: '主源节目', desc: '主源简介' }
  const cand = { ...seg(0, 8, 9.75), title: '备选节目', desc: '' }

  // ① 先证明「如果放进来」会出什么事（这是 pickMissingDays 存在的理由）
  const bad = normalizeProgrammes([primary, cand], { dayStartTs: W0, dayEndTs: W0 + 7 * DAY })
  const keptPrimary = bad.find((r) => r.title === '主源节目')
  check('（反证）直接合并 → 主源带简介的那条被删掉', keptPrimary === undefined)
  check('（反证）留下的是无简介的备选', bad.length === 1 && bad[0].title === '备选节目' && !bad[0].desc)

  // ② 走正确路径：pickMissingDays 挡掉重叠 → 主源简介保住
  const add = pickMissingDays([cand], [primary], dates, 6)
  check('正确路径：重叠的那条没被补进来', add.length === 0)
  const good = normalizeProgrammes([primary, ...add], { dayStartTs: W0, dayEndTs: W0 + 7 * DAY })
  const kept = good.find((r) => r.title === '主源节目')
  check('正确路径：主源带简介的那条活着', !!kept)
  check('正确路径：简介还在', !!kept && kept.desc === '主源简介')
  check('正确路径：主源时长没被截短（仍是到 09:55）',
    !!kept && kept.stop.startsWith('202610270954'),
    kept ? kept.stop : '(已删除)')
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===`)
process.exit(fail ? 1 : 0)
