/**
 * XMLTV 输出
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { CONFIG, PATHS, ensureOutputDir } from './config.mjs'
import { esc, isRealDesc, hasRealDesc, isEchoDesc } from './utils.mjs'

/**
 * 生成 XMLTV 字符串
 * @param channels  [{id, name, logo, group, aliases}]
 * @param epgMap    Map<tvgId, programmes[]>
 * @param opts      { idMap?: {我们的id: 输出的id}, extraNames?: {我们的id: string[]} }
 *
 *   idMap 用于「按直播源 id 输出」——很多自建 m3u 的 tvg-id 是裸名（CCTV1 / 浙江卫视），
 *   与我们 iptv-org 规范的 id（CCTV1.cn）不同，播放器因此挂不上节目单。
 *   传 idMap 就能把 channel id 改写成直播源侧的写法。
 */
export function buildXmltv(channels, epgMap, opts = {}) {
  const { idMap = null, extraNames = null } = opts
  const now = new Date()
  const stamp = new Date(now.getTime() + 8 * 3600 * 1000)
    .toISOString()
    .replace(/[-:T]/g, '')
    .slice(0, 14)

  const lines = []
  lines.push('<?xml version="1.0" encoding="UTF-8"?>')
  lines.push(
    `<tv generator-info-name="my-epg" generator-info-url="https://github.com/" date="${stamp} +0800">`
  )

  // 只输出有节目的频道，避免播放器里出现空频道
  const withEpg = channels.filter((c) => {
    const list = epgMap.get(c.id)
    return list && list.length > 0
  })

  // 输出用哪个 id：有映射用映射值，否则用本项目的规范 id
  const outId = (c) => (idMap && idMap[c.id]) || c.id

  for (const c of withEpg) {
    lines.push(`  <channel id="${esc(outId(c))}">`)
    lines.push(`    <display-name lang="zh">${esc(c.name)}</display-name>`)
    if (c.aliases && c.aliases.length) {
      for (const a of c.aliases) {
        if (a) lines.push(`    <display-name lang="zh">${esc(a)}</display-name>`)
      }
    }
    // 补上直播源侧的原始写法，让按名字匹配的播放器也能命中
    if (extraNames && extraNames[c.id]) {
      for (const a of extraNames[c.id]) {
        if (a && a !== c.name) lines.push(`    <display-name lang="zh">${esc(a)}</display-name>`)
      }
    }
    if (c.logo) lines.push(`    <icon src="${esc(c.logo)}" />`)
    lines.push('  </channel>')
  }

  for (const c of withEpg) {
    for (const p of epgMap.get(c.id)) {
      lines.push(
        `  <programme start="${p.start}" stop="${p.stop}" channel="${esc(outId(c))}">`
      )
      lines.push(`    <title lang="zh">${esc(p.title)}</title>`)
      // ★ 「宁空不挂错」：desc 只是标题复读的，直接不输出。
      //   用户点开节目看到「2025-26司諾克賽季 世界大獎賽 四強(1)ZHA vs WAK」
      //   和标题一模一样，比不显示简介更糟 —— 前者是废话，后者是「暂无信息」。
      //   这些条目的上游（epg.pw 台湾包）本来就只给标题当 desc，补不进来就别硬塞。
      if (p.desc && !isEchoDesc(p.desc, p.title)) lines.push(`    <desc lang="zh">${esc(p.desc)}</desc>`)
      if (p.category) lines.push(`    <category lang="zh">${esc(p.category)}</category>`)
      lines.push('  </programme>')
    }
  }

  lines.push('</tv>')
  lines.push('')
  return lines.join('\n')
}

/** 写出 xml 与 xml.gz */
export function writeOutput(xml, basename = 'epg') {
  ensureOutputDir()
  const xmlPath = path.join(PATHS.output, `${basename}.xml`)
  const gzPath = path.join(PATHS.output, `${basename}.xml.gz`)

  fs.writeFileSync(xmlPath, xml, 'utf8')
  const gz = zlib.gzipSync(Buffer.from(xml, 'utf8'), { level: 9 })
  fs.writeFileSync(gzPath, gz)

  return {
    xmlPath,
    gzPath,
    xmlBytes: Buffer.byteLength(xml),
    gzBytes: gz.length,
  }
}

/**
 * 输出频道清单 channels.json
 *
 * 为什么需要单独一个文件：
 *   直播源侧（iptv-api / iptv-tool / 手工维护的 M3U）需要知道「这个台在本项目里的
 *   tvg-id 是什么」，才能把 M3U 的 tvg-id 填对，让播放器自动把节目单挂上去。
 *   没有这份清单，两边只能靠中文名模糊匹配——实测会串台
 *   （CCTV5+ 吸到 CCTV5、台視新聞 吸到 台視），用户看到的就是错节目单。
 *
 * 格式刻意做成「够用且稳定」：
 *   id     tvg-id，填进 M3U 的 tvg-id 属性
 *   name   显示名
 *   group  分组（央视/卫视/local/hk/tw…），对应 M3U 的 group-title
 *   aliases 该台在各类源里的常见写法，直播源侧做关键词匹配用
 *   logo   台标
 *   hasEpg 本次是否真的抓到了节目（false 表示这个台暂时挂不上节目单）
 *
 * @param channels 输出用频道数组（含 logo/source 等 enrich 过的字段）
 * @param epgMap   Map<tvgId, programmes[]>
 */
export function writeChannelsJson(channels, epgMap) {
  ensureOutputDir()
  const list = channels.map((c) => {
    const rows = epgMap.get(c.id) || []
    return {
      id: c.id,
      name: c.name,
      group: c.group || '',
      aliases: c.aliases || [],
      logo: c.logo || '',
      hasEpg: rows.length > 0,
      programmeCount: rows.length,
    }
  })
  const outPath = path.join(PATHS.output, 'channels.json')
  fs.writeFileSync(outPath, JSON.stringify(list, null, 2) + '\n', 'utf8')
  return { path: outPath, count: list.length, withEpg: list.filter((c) => c.hasEpg).length }
}

/**
 * 生成统计报告
 *
 * 这个 report.json 是看板（web/index.html）的唯一数据来源，
 * 所以字段要按看板需求一次算全，别让前端再猜。
 *
 * @param channels [{id, name, group, aliases, source, logo}]
 * @param epgMap   Map<tvgId, [{start, stop, title, desc, category}]>
 * @param extra    额外字段（匹配明细、外部源等）
 */
export function buildReport(channels, epgMap, extra = {}) {
  const { dayList = [], matchInfo = {}, usedSources = {} } = extra

  const rows = []
  for (const c of channels) {
    const list = epgMap.get(c.id) || []

    // 按天统计节目条数（按 start 的日期归属）
    const perDay = {}
    for (const d of dayList) perDay[d] = 0
    const daySeen = new Set()
    for (const p of list) {
      // p.start 形如 "20261026010400 +0800"，取前 8 位
      const ymd = String(p.start || '').slice(0, 8)
      if (ymd) {
        if (perDay[ymd] === undefined) perDay[ymd] = 0
        perDay[ymd]++
        daySeen.add(ymd)
      }
    }
    const daysCovered = daySeen.size

    // ⚠️ 口径必须是「真实简介」。
    //    51zmt 的 e1 里 70% 的 <desc> 是「暂无节目描述」「此阶段播放精彩电视剧内容」
    //    这类占位文本，只要非空就计数的话，覆盖率会虚高到 99%，用户看到的全是废话。
    //    统一走 isRealDesc 判定，看板和实际体验才对得上。
    //
    //    ★ 还要再排除「复读标题」：epg.pw 有 799 条 desc 就是标题本身，
    //      长度够、不算占位，但零信息量。hasRealDesc = 非占位 + 非复读。
    const withDesc = list.filter((p) => hasRealDesc(p.desc, p.title)).length
    const withCategory = list.filter((p) => p.category && p.category.trim()).length
    const uniqTitles = new Set(list.map((p) => p.title)).size

    const mi = matchInfo[c.id] || null
    rows.push({
      id: c.id,
      name: c.name,
      group: c.group || '',
      aliases: c.aliases || [],
      logo: c.logo || '',
      count: list.length,
      days: daysCovered,
      perDay,
      withDesc,
      descRate: list.length ? Math.round((withDesc / list.length) * 100) : 0,
      withCategory,
      uniqTitles,
      // 首次/末次节目时间，方便一眼看出数据新鲜度
      first: list[0]?.start || '',
      last: list[list.length - 1]?.stop || '',
      // 匹配信息：用的哪个源、源的频道名叫什么、依据是什么、备选有哪些
      usedSource: usedSources[c.id] || (c.source ? `${c.source}` : ''),
      matchConfidence: mi?.confidence || '',
      matchedSourceName: mi?.sourceName || '',
      alternatives: mi?.alternatives || [],
      // 有节目但天数不足 = 需要关注的"半残"频道
      status: list.length === 0 ? 'empty' : daysCovered >= dayList.length ? 'full' : 'partial',
    })
  }

  const ok = rows.filter((r) => r.count > 0)
  const total = rows.reduce((s, r) => s + r.count, 0)
  const totalDesc = rows.reduce((s, r) => s + r.withDesc, 0)

  return {
    generatedAt: new Date().toISOString(),
    days: dayList.length,
    dayList,
    channelsTotal: channels.length,
    channelsWithEpg: ok.length,
    channelsEmpty: rows.length - ok.length,
    channelsFull: rows.filter((r) => r.status === 'full').length,
    channelsPartial: rows.filter((r) => r.status === 'partial').length,
    programmesTotal: total,
    programmesWithDesc: totalDesc,
    descCoverage: total ? Math.round((totalDesc / total) * 100) : 0,
    ...extra,
    detail: rows,
  }
}
