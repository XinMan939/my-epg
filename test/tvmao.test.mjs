/**
 * tvmao 源的两个静默 bug 的回归测试（2026-10-27 第七轮）
 *
 * 为什么必须测：这两个 bug 的共同特征是 **不报错**。
 *   ① 解析器漏行 → 返回 0 条，和「上游真的没有」长得一模一样
 *   ② 路径猜错   → HTTP 200 + 别的频道的节目单，数据看起来完全正常
 * 没有断言守护，下次上游微调 HTML 又会静默退化。
 *
 * 运行：node test/tvmao.test.mjs
 */

import { parseRows, titleMatchesChannel, titleChannelName, inferPathCandidates, resetPathCache } from '../src/sources/tvmao.mjs'

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

const YMD = '20261027'

/** 造一段 tvmao 的节目行 HTML */
function row(timeCls, start, end, linkInner) {
  return `<li class="epg-row">
    <span class="epg-row-${timeCls}" data-endtime="${end}"
      data-time="${start}">${timeCls === 'playing' ? '直播中' : start}</span>
    <span class="epg-row-link">${linkInner}</span>
  </li>`
}

console.log('\n[1] ★ 节目行解析：三种 link 写法 + 两种时间标签都要吃')

{
  const html = [
    // ① <a> 独占整行
    row('time', '00:00', '00:30', '<a href="/tvcolumn/x">动画片</a>'),
    // ② <a> 夹在中间（旧正则漏这种，央视台球 28 行全靠它）
    row('time', '00:30', '01:00', '实况录像-2024/2025赛季<a href="/competition/y">斯诺克世界公开赛</a> 墨菲的147'),
    // ③ 纯文本
    row('time', '01:00', '02:00', '动画片'),
    // ④ 正在直播的那条，class 是 epg-row-playing
    row('playing', '02:00', '03:00', '<a href="/tvcolumn/z">晚间新闻</a>'),
  ].join('\n')

  const rows = parseRows(html, YMD)

  check('解析出 4 条（旧正则只能拿到 2 条）', rows.length === 4, `实得 ${rows.length}`)
  check('① <a> 独占：标题正确', rows[0]?.title === '动画片', rows[0]?.title)
  check(
    '② <a> 夹中间：前后文字都保留',
    rows[1]?.title === '实况录像-2024/2025赛季斯诺克世界公开赛 墨菲的147',
    rows[1]?.title
  )
  check('③ 纯文本：标题正确', rows[2]?.title === '动画片', rows[2]?.title)
  check('④ 直播中那条也被解析', rows[3]?.title === '晚间新闻', rows[3]?.title)
  check('④ 时间取自 data-time（不是「直播中」三个字）', rows[3] && rows[3].startTs > rows[2].startTs)
}

console.log('\n[2] ★ 反证：旧正则确实会漏掉 ② 和 ④')

{
  const html = [
    row('time', '00:00', '00:30', '<a href="/x">A</a>'),
    row('time', '00:30', '01:00', '前缀<a href="/y">B</a>后缀'),
    row('playing', '02:00', '03:00', '<a href="/z">C</a>'),
  ].join('\n')

  // 第七轮之前的正则，原样复制过来当反证
  const oldRe =
    /<span class="epg-row-time"\s+data-endtime="([^"]*)"\s*\n?\s*data-time="([^"]*)">[^<]*<\/span>\s*<span class="epg-row-link">(?:<a[^>]*>([^<]*)<\/a>([^<]*)|([^<]*))<\/span>/g
  let oldCount = 0
  while (oldRe.exec(html)) oldCount++

  check('（反证）旧正则只匹配到 1 条', oldCount === 1, `实得 ${oldCount}`)
  check('新解析器拿到 3 条', parseRows(html, YMD).length === 3)
}

console.log('\n[3] 时间解析：跨零点要顺延一天，非法行要丢掉')

{
  const html = [
    row('time', '23:30', '00:30', '跨零点节目'),
    `<li class="epg-row"><span class="epg-row-time" data-endtime="" data-time="12:00">12:00</span><span class="epg-row-link">无结束时间</span></li>`,
    `<li class="epg-row"><span class="epg-row-link">没有时间标签的行</span></li>`,
  ].join('\n')

  const rows = parseRows(html, YMD)
  check('跨零点那条：stop > start（顺延了 24h）', rows[0] && rows[0].stopTs > rows[0].startTs)
  check('跨零点那条：时长正好 1 小时', rows[0] && rows[0].stopTs - rows[0].startTs === 3600e3)
  check('无结束时间那条：stopTs 为 null', rows[1] && rows[1].stopTs === null)
  check('没有时间标签的行被丢掉（只留 2 条）', rows.length === 2, `实得 ${rows.length}`)
}

console.log('\n[4] ★ title 串台校验')

{
  check('生活时尚 ↔ 生活时尚节目表 → 通过', titleMatchesChannel('生活时尚节目表,生活时尚节目预告_电视猫', '生活时尚'))
  check('DOX映画 ≠ 生活时尚 → 拦下', !titleMatchesChannel('DOX映画节目表_电视猫', '生活时尚'))
  check('CCTV-1综合 ≠ 安徽卫视 → 拦下', !titleMatchesChannel('CCTV-1综合节目表,综合节目预告_电视猫', '安徽卫视'))
  check('三沙卫视 ↔ 海南三沙卫视频道 → 通过', titleMatchesChannel('三沙卫视节目表,海南三沙卫视频道节目预告_电视猫', '三沙卫视'))
  check('空 title → 放行（别一刀切废掉）', titleMatchesChannel('', '生活时尚'))
  check('期望名为空 → 放行', titleMatchesChannel('生活时尚节目表_电视猫', ''))
  check('数组任一命中即通过', titleMatchesChannel('大湾区卫视节目表_电视猫', ['NANFANG-NANFANG6', '大湾区卫视']))
  check('数组全不命中 → 拦下', !titleMatchesChannel('DOX映画节目表_电视猫', ['SITV-FASHION', '生活时尚']))
}

console.log('\n[5] title 提取')

{
  check('剥掉「节目表」', titleChannelName('生活时尚节目表,生活时尚节目预告_电视猫') === '生活时尚')
  check('剥掉「_电视猫」', titleChannelName('DOX映画节目表_电视猫') === 'DOX映画')
  check('保留 CCTV 前缀', titleChannelName('CCTV央视台球节目表,央视台球节目预告_电视猫') === 'CCTV央视台球')
}

console.log('\n[6] ★ 路径候选：猜错路径不报 404 而是串台，顺序必须对')

{
  resetPathCache()

  check('CCTVPAYFEE- 只走 /program/', JSON.stringify(inferPathCandidates('CCTVPAYFEE-CCTVPAYFEE36')) === '["/program/"]')
  check('BAMC- 只走 /program/', JSON.stringify(inferPathCandidates('BAMC-BAMC3')) === '["/program/"]')
  check('CCTV- 只走 /program/', JSON.stringify(inferPathCandidates('CCTV-CCTV1')) === '["/program/"]')

  // SITV- 走 /program/ 会拿到 DOX映画，必须首选 digital
  const sitv = inferPathCandidates('SITV-FASHION')
  check('★ SITV- 首选 /program_digital/', sitv[0] === '/program_digital/', JSON.stringify(sitv))
  check('★ SITV- 不再把 /program/ 放第一', sitv[0] !== '/program/')

  // 无连字符（卫视）走 /program/ 会拿到 CCTV-1综合
  const sat = inferPathCandidates('SANSHATV')
  check('★ 无连字符首选 /program_satellite/', sat[0] === '/program_satellite/', JSON.stringify(sat))
  check('★ 无连字符不把 /program/ 放第一', sat[0] !== '/program/')

  // 两段式
  check('两段式 id 走 /program/', inferPathCandidates('SHXITV/SHXITV9')[0] === '/program/')

  // override 强制路径
  check('forcePath 生效', inferPathCandidates('SITV-FASHION', '/program/')[0] === '/program/')
  check('非法 forcePath 被忽略', inferPathCandidates('SITV-FASHION', '/bogus/')[0] === '/program_digital/')
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`)
process.exit(fail ? 1 : 0)
