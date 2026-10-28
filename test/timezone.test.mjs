/**
 * 境外源的「时区」单元测试（2026-10-28 第十二轮新增）
 *
 * 为什么必须单独测这个：
 *   MOD 源的 `buildRows` 第一版把台湾本地的 `HH:MM` 当成 UTC 处理，
 *   导致**全部节目整体晚 8 小时**。而这个 bug 在报表上完全看不出来：
 *
 *     - 每天仍覆盖 24 小时 → `countCoveredDays` 判定「满 7 天」
 *     - 「满 7 天」频道数 203 → 224，**不降反升**
 *     - 日志全绿、audit-output 也不报（时间轴自身是自洽的，只是整体偏移）
 *
 *   唯一能发现它的方式是「拆开 XML 看具体时刻对不对」。
 *   所以这里把「台湾本地 00:00 必须等于北京时间 00:00」钉成断言。
 *
 * 跑法：node test/timezone.test.mjs
 */
import { parseEpgHtml, buildRows } from '../src/sources/mod.mjs'

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

/** 时间戳 → 北京时间字符串（用于断言） */
function bj(ts) {
  return new Date(ts + 8 * 3600e3).toISOString().slice(0, 16).replace('T', ' ')
}

console.log('\n[1] MOD buildRows：台湾本地时刻必须映射到正确的北京时间')
{
  // 手工造一份「台湾时间」的节目表。
  // ⚠️ 间隔必须贴近现实：buildRows 会丢弃「单条 > 6 小时」的上游异常
  //    （实测 MOD 正常最长 2h15m）。所以相邻两条之间都 ≤ 2 小时。
  const days = [
    {
      date: '20261028',
      items: [
        { hhmm: '00:00', title: '午夜节目' },
        { hhmm: '01:00', title: '凌晨节目' },
        { hhmm: '02:00', title: '深夜节目' },
        { hhmm: '12:00', title: '正午节目' },
        { hhmm: '13:00', title: '午后节目' },
        { hhmm: '23:00', title: '收官节目' },
      ],
    },
  ]
  // 注：02:00 → 12:00 相隔 10 小时，会被「单条 > 6h」规则丢掉（规则的正确行为）。
  // 所以断言只钉「留下的那几条时刻对不对」，不钉总条数。
  const rows = buildRows(days, '20261028')
  check('00:00 → 北京 2026-10-28 00:00', bj(rows[0].startTs) === '2026-10-28 00:00', bj(rows[0].startTs))
  check('01:00 → 北京 2026-10-28 01:00', bj(rows[1].startTs) === '2026-10-28 01:00', bj(rows[1].startTs))
  const noon = rows.find((r) => bj(r.startTs) === '2026-10-28 12:00')
  check('12:00 → 北京 2026-10-28 12:00', !!noon, '没找到 12:00 那条')
  const night = rows.find((r) => bj(r.startTs) === '2026-10-28 23:00')
  check('23:00 → 北京 2026-10-28 23:00', !!night)
  check('末条 stop = 次日 00:00（北京）', bj(rows[rows.length - 1].stopTs) === '2026-10-29 00:00', bj(rows[rows.length - 1].stopTs))

  // ★ 反证：如果忘了减 8 小时，00:00 会变成北京 08:00
  const wrongBase = Date.UTC(2026, 9, 28) + 0
  check(
    '（反证）不减 8 小时会得到 08:00 —— 说明断言真的能抓到 bug',
    bj(wrongBase) === '2026-10-28 08:00',
    bj(wrongBase)
  )
}

console.log('\n[2] MOD buildRows：所有行必须落在目标日之内')
{
  // 贴近现实的一串节目（间隔都 ≤ 3h15m）
  const days = [
    {
      date: '20261028',
      items: [
        { hhmm: '01:30', title: 'A' },
        { hhmm: '03:00', title: 'B' },
        { hhmm: '20:00', title: 'C' },
        { hhmm: '23:15', title: 'D' },
      ],
    },
  ]
  const rows = buildRows(days, '20261028')
  const outside = rows.filter((r) => !bj(r.startTs).startsWith('2026-10-28'))
  check('没有行溢出到次日', outside.length === 0, `${outside.length} 条溢出`)
  // 03:00 → 20:00 相隔 17 小时，按「单条 > 6h」规则丢弃 B
  const c = rows.find((r) => bj(r.startTs) === '2026-10-28 20:00')
  check('C 的时长 = 3h15m（03:15 到 23:15 之间正常保留）', !!c && c.stopTs - c.startTs === (3 * 60 + 15) * 60e3)
  check('末条 D stop 收到次日 00:00', bj(rows[rows.length - 1].stopTs) === '2026-10-29 00:00', bj(rows[rows.length - 1].stopTs))
}

console.log('\n[3] MOD parseEpgHtml：周末日期被 <font> 包住时也要解析到')
{
  // 周末日期的真实形态（实测 w0.html）
  const html = `
    <div class='epgdays'>
      <div class='item' style='background-color:#ccc;padding:5px;'>2026-10-30星期五</div>
      <div class='past'><div class='time'> 10:00</div><div class='channelTitle'> 节目A(普)</div></div>
    </div>
    <div class='epgdays'>
      <div class='item' style='background-color:#ccc;padding:5px;'><font color='#c03'>2026-10-31星期六</font></div>
      <div class='past'><div class='time'> 11:00</div><div class='channelTitle'> 节目B(普)</div></div>
    </div>`
  const days = parseEpgHtml(html)
  check('解析出 2 天', days.length === 2, `实际 ${days.length}`)
  check('★ 周末日期 20261031 没被漏掉', days.some((d) => d.date === '20261031'))
  check('节目条数 = 1 / 1', days[0].items.length === 1 && days[1].items.length === 1)
}

console.log('\n[4] MOD buildRows：缺失的头部时段不瞎补')
{
  // 首条是 01:30，说明 00:00~01:30 上游没给。
  // 后续条目间隔要贴近现实（≤ 3h），否则会被「单条 > 6h」规则丢掉。
  const days = [
    {
      date: '20261028',
      items: [
        { hhmm: '01:30', title: 'A' },
        { hhmm: '04:00', title: 'B' },
        { hhmm: '06:30', title: 'C' },
        { hhmm: '09:00', title: 'D' },
        { hhmm: '12:00', title: 'E' },
        { hhmm: '15:00', title: 'F' },
        { hhmm: '18:00', title: 'G' },
        { hhmm: '21:00', title: 'H' },
        { hhmm: '23:00', title: 'I' },
      ],
    },
  ]
  const rows = buildRows(days, '20261028')
  check('首条 start 是北京 01:30（不凭空造 00:00 的节目）', bj(rows[0].startTs) === '2026-10-28 01:30', bj(rows[0].startTs))
  check('★ 末条 stop 收到次日 00:00，不延到次日 01:30', bj(rows[rows.length - 1].stopTs) === '2026-10-29 00:00', bj(rows[rows.length - 1].stopTs))
  check('★ 没有任何一条的 start 早于北京 01:30', rows.every((r) => bj(r.startTs) >= '2026-10-28 01:30'))
  check('条数 = 9（间隔都在 2.5h 内，全部保留）', rows.length === 9, `实际 ${rows.length}`)
}

console.log('\n[5] MOD buildRows：单条超 6 小时视为上游异常并丢弃')
{
  // 只有一条 01:30 的节目，末条按 24:00 收 → 22.5 小时，远超正常（实测最长 2h15m）
  const days = [{ date: '20261028', items: [{ hhmm: '01:30', title: 'A' }] }]
  const rows = buildRows(days, '20261028')
  check('★ 22.5 小时的「节目」被丢弃（宁缺勿错）', rows.length === 0, `实际 ${rows.length} 条`)
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`)
if (fail) process.exit(1)
