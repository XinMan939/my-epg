/**
 * 频道匹配的 override 回归测试（2026-10-27 第七轮）
 *
 * 本轮修的问题：overrides 指定了 catalog 里没有的 sourceId 时，
 * 旧代码 log.warn 一句就 continue → 该频道变成「无匹配」→ 走 z51 兜底 → 永远 2 天。
 * 实例：嘉佳卡通 GDTV-GDTV7、大湾区卫视 NANFANG-NANFANG6 都不在 catalog。
 *
 * 这个 bug 的特征同样是「不报错」：日志写着「在源清单中不存在，忽略」，
 * 看着像正常跳过，实际是整条 override 被丢弃。
 *
 * 运行：node test/match.test.mjs
 */

import { matchChannels } from '../src/match.mjs'

let pass = 0
let fail = 0
function check(name, cond, extra) {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? ' :: ' + extra : ''}`)
  }
}

/** 造一份最小的源清单 */
const catalog = [
  { source: 'epgpw', sourceId: '544268', name: '大湾区卫视', group: 'satellite', region: 'CN' },
  { source: 'tvmao', sourceId: 'SANSHATV', name: '三沙卫视', group: 'satellite', region: 'CN' },
  { source: 'tvmao', sourceId: 'SITV-FASHION', name: '生活时尚', group: 'digital', region: 'CN' },
]

console.log('\n[1] override 命中 catalog → confidence=override')

{
  const targets = [{ id: 'SanshaSatelliteTV.cn', name: '三沙卫视', aliases: [] }]
  const overrides = { 'SanshaSatelliteTV.cn': { source: 'tvmao', sourceId: 'SANSHATV' } }
  const { matched } = matchChannels(targets, catalog, { overrides })
  const m = matched.get('SanshaSatelliteTV.cn')
  check('命中并标 override', m && m.confidence === 'override', JSON.stringify(m))
  check('sourceName 取自 catalog', m && m.sourceName === '三沙卫视')
}

console.log('\n[2] ★ override 指向 catalog 里没有的 tvmao id → 不能丢弃')

{
  const targets = [{ id: 'JiaJiaCartoon.cn', name: '嘉佳卡通', aliases: [] }]
  const overrides = { 'JiaJiaCartoon.cn': { source: 'tvmao', sourceId: 'GDTV-GDTV7' } }
  const { matched } = matchChannels(targets, catalog, { overrides })
  const m = matched.get('JiaJiaCartoon.cn')

  check('★ 仍然匹配成功（旧代码在这里丢弃整条 override）', !!m, 'matched 里没有这条')
  check('★ confidence=override-unlisted', m && m.confidence === 'override-unlisted', m?.confidence)
  check('★ sourceId 保留原值', m && m.sourceId === 'GDTV-GDTV7', m?.sourceId)
  check('★ 用频道表的名字兜底', m && m.sourceName === '嘉佳卡通', m?.sourceName)
}

console.log('\n[3] 反证：epgpw 的 id 不能这样放行（epgpw 是整包，猜 id 必错）')

{
  const targets = [{ id: 'X.cn', name: '某某台', aliases: [] }]
  const overrides = { 'X.cn': { source: 'epgpw', sourceId: '999999' } }
  const { matched } = matchChannels(targets, catalog, { overrides })
  check('（反证）epgpw 不存在的 id 仍然被忽略', !matched.get('X.cn'), '不该放行')
}

console.log('\n[4] 没有 override 时走自动匹配')

{
  const targets = [{ id: 'GBASatelliteTV.cn', name: '大湾区卫视', aliases: ['南方卫视'] }]
  const { matched } = matchChannels(targets, catalog, { overrides: {} })
  const m = matched.get('GBASatelliteTV.cn')
  check('自动匹配到 epgpw:544268', m && m.sourceId === '544268', JSON.stringify(m))
  check('confidence 是自动匹配级别（不是 override）', m && m.confidence !== 'override')
}

console.log('\n[5] override 指向不存在的 epgpw 时，自动匹配仍然兜底')

{
  const targets = [{ id: 'GBASatelliteTV.cn', name: '大湾区卫视', aliases: [] }]
  const overrides = { 'GBASatelliteTV.cn': { source: 'epgpw', sourceId: '999999' } }
  const { matched } = matchChannels(targets, catalog, { overrides })
  const m = matched.get('GBASatelliteTV.cn')
  check('自动匹配接住了（没被错误 override 拖死）', m && m.sourceId === '544268', JSON.stringify(m))
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`)
process.exit(fail ? 1 : 0)
