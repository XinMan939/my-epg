/**
 * XMLTV 输出
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { CONFIG, PATHS, ensureOutputDir } from './config.mjs'
import { esc } from './utils.mjs'

/**
 * 生成 XMLTV 字符串
 * @param channels  [{id, name, logo, group}]
 * @param epgMap    Map<tvgId, programmes[]>
 */
export function buildXmltv(channels, epgMap) {
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

  for (const c of withEpg) {
    lines.push(`  <channel id="${esc(c.id)}">`)
    lines.push(`    <display-name lang="zh">${esc(c.name)}</display-name>`)
    if (c.aliases && c.aliases.length) {
      for (const a of c.aliases) {
        if (a) lines.push(`    <display-name lang="zh">${esc(a)}</display-name>`)
      }
    }
    if (c.logo) lines.push(`    <icon src="${esc(c.logo)}" />`)
    lines.push('  </channel>')
  }

  for (const c of withEpg) {
    for (const p of epgMap.get(c.id)) {
      lines.push(
        `  <programme start="${p.start}" stop="${p.stop}" channel="${esc(c.id)}">`
      )
      lines.push(`    <title lang="zh">${esc(p.title)}</title>`)
      if (p.desc) lines.push(`    <desc lang="zh">${esc(p.desc)}</desc>`)
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

    const withDesc = list.filter((p) => p.desc && p.desc.trim()).length
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
