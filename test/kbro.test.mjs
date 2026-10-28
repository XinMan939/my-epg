/**
 * kbro（台湾大宽频）源 / 简介通道的单元测试（2026-10-28 第十六轮新增）
 *
 * 为什么必须测：2026-10-28 用户发来 `cpt.kbro.com.tw/K04/...?so=10` 的频道表页面，
 * 说「我感觉比上次发的要多几个频道」。核实下来，这句话本身是对的，但它暴露了
 * 一个**只要有人"顺手优化"就会静默丢台**的坑：
 *
 * ★★ 命门：`epg_channel.php?appid=WEB` 返回的 DATA 是「按经营区 so 分组」的
 *    （20 个区，4884 条 / 296 个唯一 channelid），**页面上的频道数只是 ?so= 挑一组**。
 *      T01 → so=61 永佳樂   显示 244 台
 *      K04 → so=10 豐盟台中 显示 246 台  ← 用户这次发的
 *    如果哪天有人看着页面觉得「一个区就是全部」，把 mergeChannelData 改成
 *    `data.DATA[defaultSO]`，会**一声不响地少掉 50 多个台**（每区都有自己独有的
 *    地方系統台），而报表上的简介数只会小幅下滑，根本看不出来。
 *    所以这里锁死：**输入两个区、各有一条独有的台，合并结果必须是并集**。
 *
 * ★ 第二个命门：`normChannelName` 只剥**结尾**后缀。
 *    全局替换会把「台視」剥成「視」，台湾频道立刻集体对不上。
 *
 * ★ 第三个命门：kbro 的 `endtime` 有时候是空的，得用 `duration`（秒）兜底，
 *    否则 stopTs 为 null，节目会互相吞掉。
 *
 * ★ 本文件不联网、不读 catalog.json（符合 §7.3c「单测必须确定性」）。
 *
 * 跑法：node test/kbro.test.mjs
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

const { mergeChannelData, parseKbroTime, normKbroTitle, normChannelName, toRows, targetNameMatches } = await import(
  '../src/sources/kbro.mjs'
)

/** 造一条 epg_channel.php 的条目 */
const ch = (id, name, num = '1', type = '綜合') => ({
  UNIQUE_ID: id,
  CHANNELID: id,
  SERVICEID: id,
  CHANNELNUMBER: num,
  CHANNELNAME: name,
  CHANNELTYPE: [type],
  CH_CODENAME: type,
})

/** ★ [1] 经营区必须是并集，不能只取一个 so */
console.log('\n[1] mergeChannelData：多个经营区取并集')
{
  const data = {
    // so=61 永佳樂（上次页面 T01）
    61: [ch('5', 'TVBS新聞台HD', '55'), ch('6817', '永佳樂生活頻道HD', '4'), ch('9001', '節目表HD', '1', '其他')],
    // so=10 豐盟台中（这次页面 K04?so=10）
    10: [ch('5', 'TVBS新聞台HD', '55'), ch('823', '豐盟台中台HD', '20'), ch('1341', '大台中生活頻道HD', '134')],
    // so=2 陽明山
    2: [ch('5', 'TVBS新聞台HD', '55'), ch('1119', '大立電視台HD', '97')],
  }
  const byId = mergeChannelData(data)
  check('并集不是单区：3 个区合并应得 6 个台', byId.size === 6, `实际 ${byId.size}`)
  check('★ 只在 so=61 出现的台不能丢', byId.has('6817'), '永佳樂生活頻道HD 丢了')
  check('★ 只在 so=10 出现的台不能丢', byId.has('823'), '豐盟台中台HD 丢了')
  check('★ 只在 so=2 出现的台不能丢', byId.has('1119'), '大立電視台HD 丢了')
  check('重复 channelid 只留一份', [...byId.keys()].filter((k) => k === '5').length === 1)
  check('字段映射正确', byId.get('823').name === '豐盟台中台HD' && byId.get('823').number === '20')
  check('type 取 CH_CODENAME', byId.get('9001').type === '其他')
  check('空/异常输入不炸', mergeChannelData(undefined).size === 0 && mergeChannelData({ 1: null }).size === 0)
}

/** ★ [2] 保险丝：源码里不许把「单区」当前提 */
console.log('\n[2] 源码护栏：合并逻辑不得退化成单区')
{
  const src = fs.readFileSync(new URL('../src/sources/kbro.mjs', import.meta.url), 'utf8')
  check('★ 必须遍历 Object.values(data)（全部经营区）', /Object\.values\(data\s*\|\|\s*\{\}\)/.test(src))
  check('★ 不得出现 `DATA[defaultSO]` 这类单区取法', !/DATA\[(?:default)?[sS][oO]\]/.test(src))
  check('loadChannels 必须走 mergeChannelData', /byId:\s*mergeChannelData\(/.test(src))
}

/** ★ [3] 时间解析：YYYYMMDDHHMMSS 按 +08:00 */
console.log('\n[3] parseKbroTime')
{
  const ts = parseKbroTime('20261028003000')
  check('解析成 UTC 2026-10-27T16:30:00Z', ts === Date.UTC(2026, 9, 27, 16, 30, 0), `实际 ${ts}`)
  check('非法输入返回 null', parseKbroTime('2026-10-28') === null && parseKbroTime('') === null)
}

/** ★ [4] 标题归一化（只用于找简介，不做跨台对齐） */
console.log('\n[4] normKbroTitle：剥集数 / 繁简 / 方括号')
{
  check('繁转简', normKbroTitle('我們的島') === normKbroTitle('我们的岛'))
  check('剥 :数字', normKbroTitle('大愛地球村:5369') === normKbroTitle('大愛地球村'))
  check('剥 第N季:N', normKbroTitle('驚喜假期第4季:6') === normKbroTitle('驚喜假期'))
  check('剥 (数字)', normKbroTitle('型男大主廚(209)') === normKbroTitle('型男大主廚'))
  check('剥 [粵] 方括号', normKbroTitle('[粵] 東張西望') === normKbroTitle('東張西望'))
  check('剥 #集数', normKbroTitle('綜藝大熱門#215') === normKbroTitle('綜藝大熱門'))
}

/** ★ [5] 频道名归一化：只剥结尾后缀，别把「台視」剥成「視」 */
console.log('\n[5] normChannelName：只剥结尾后缀')
{
  check('★ 「台視」不能被剥成「視」（只剥结尾）', normChannelName('台視') === '台视', `得到 ${normChannelName('台視')}`)
  check('剥结尾「台」', normChannelName('靖天映畫台HD') === normChannelName('靖天映畫'))
  check('剥结尾「電視台」', normChannelName('德國之聲電視台HD') === '德国之声', `得到 ${normChannelName('德國之聲電視台HD')}`)
  check('剥 HD', normChannelName('緯來精采台HD') === normChannelName('纬来精采'))
  check('剥 (免費)', normChannelName('深圳衛視國際頻道 (免費)') === normChannelName('深圳卫视国际频道'))
  check('★ 名字匹配不做包含（台視 ≠ 台視新聞）', targetNameMatches({ name: '台視', aliases: [] }, '台視新聞台HD') === false)
  check('完全相同才算命中', targetNameMatches({ name: '博斯網球台', aliases: [] }, '博斯網球台HD') === true)
}

/** ★ [6] toRows：endtime 缺失用 duration 兜底（duration 是秒） */
console.log('\n[6] toRows')
{
  const rows = toRows([
    { channelid: '5', programname: '晚間新聞', programdescr: '今日頭條', starttime: '20261028180000', endtime: '20261028190000' },
    // endtime 空，duration=1800 秒
    { channelid: '5', programname: '氣象報告', programdescr: '', starttime: '20261028190000', endtime: '', duration: '1800' },
    // 没标题的条目必须丢
    { channelid: '5', programname: '', starttime: '20261028200000', endtime: '20261028210000' },
  ])
  check('丢空标题', rows.length === 2, `实际 ${rows.length}`)
  const [a, b] = rows
  check('startTs 正确', a.startTs === Date.UTC(2026, 9, 28, 10, 0, 0))
  check('endtime 直接可用', a.stopTs === Date.UTC(2026, 9, 28, 11, 0, 0))
  check('★ endtime 空时用 duration(秒) 兜底', b.stopTs === b.startTs + 1800 * 1000, `实际 ${b.stopTs}`)
  check('desc 原样带出', a.desc === '今日頭條' && b.desc === '')
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`)
if (fail) process.exit(1)
