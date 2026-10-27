/**
 * 对比 webncode 的 nowtv_* 与 nowplayer 的同台质量（临时脚本）
 *
 * 目的：按硬规则 18（override/接新源必须变好），判断 nowplayer 到底该不该留。
 * 判断维度：天数、条数、真实简介数、标题是否中文、时间轴是否干净。
 */
import * as np from '../src/sources/nowplayer.mjs'
import * as wc from '../src/sources/webncode.mjs'

const bj = (t) => new Date(t + 8 * 3600e3).toISOString().slice(5, 16).replace('T', ' ')
const todayYmd = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '')

const PAIRS = [
  ['332', 'nowtv_332', 'Now新聞台'],
  ['333', 'nowtv_333', 'Now財經台'],
  ['331', 'nowtv_331', 'Now直播台'],
  ['366', 'nowtv_366', '鳳凰衛視資訊台'],
  ['548', 'nowtv_548', '鳳凰衛視中文台'],
]

const days = []
for (let i = 0; i < 7; i++) {
  days.push(new Date(Date.now() + 8 * 3600e3 + i * 86400e3).toISOString().slice(0, 10).replace(/-/g, ''))
}

function analyze(name, rows) {
  const seen = new Set()
  const uniq = []
  for (const r of rows) {
    const k = r.startTs + '|' + r.title
    if (seen.has(k)) continue
    seen.add(k)
    uniq.push(r)
  }
  uniq.sort((a, b) => a.startTs - b.startTs)
  let ov = 0
  for (let i = 1; i < uniq.length; i++) if (uniq[i].startTs < uniq[i - 1].stopTs) ov++
  let desc = 0
  let cjk = 0
  for (const r of uniq) {
    if (r.desc && r.desc.length > 20) desc++
    if (/[\u4e00-\u9fff]/.test(r.title)) cjk++
  }
  // 按北京日覆盖小时数
  const hrs = {}
  for (const r of uniq) {
    const d = new Date(r.startTs + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '')
    hrs[d] = (hrs[d] || 0) + (r.stopTs - r.startTs) / 3600e3
  }
  const fullDays = Object.values(hrs).filter((h) => Math.min(h, 24) >= 6).length
  return {
    rows: uniq.length,
    desc,
    cjk,
    ov,
    fullDays,
    hrs,
    sample: uniq.slice(0, 3).map((r) => r.title + (r.desc ? ' ▸' + r.desc.slice(0, 30) : '')),
  }
}

const out = {}

for (const [npid, wcid, label] of PAIRS) {
  console.log('\n════ ' + label + ' ════')
  const npRows = []
  const wcRows = []
  for (const ymd of days) {
    try {
      const r = await np.getDayProgrammes(npid, 1, ymd)
      if (r.programmes && r.programmes.length) npRows.push(...r.programmes)
    } catch (e) {
      console.log('  np ' + ymd + ' 失败 ' + e.message)
    }
    try {
      const r = await wc.getDayProgrammes(wcid, 1, ymd)
      if (r.programmes && r.programmes.length) wcRows.push(...r.programmes)
    } catch (e) {
      console.log('  wc ' + ymd + ' 失败 ' + e.message)
    }
  }
  const a = analyze('nowplayer', npRows)
  const b = analyze('webncode', wcRows)
  console.log('  nowplayer: 条' + a.rows + ' 简介' + a.desc + ' 中文标题' + a.cjk + ' 重叠' + a.ov + ' 满6h天' + a.fullDays)
  console.log('             ' + JSON.stringify(a.hrs))
  console.log('             样例: ' + a.sample.join(' | '))
  console.log('  webncode : 条' + b.rows + ' 简介' + b.desc + ' 中文标题' + b.cjk + ' 重叠' + b.ov + ' 满6h天' + b.fullDays)
  console.log('             ' + JSON.stringify(b.hrs))
  console.log('             样例: ' + b.sample.join(' | '))
  out[label] = { nowplayer: a, webncode: b }
}

import fs from 'fs'
fs.writeFileSync('np-compare.json', JSON.stringify(out, null, 1))
