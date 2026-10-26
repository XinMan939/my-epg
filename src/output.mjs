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

/** 生成统计报告 */
export function buildReport(channels, epgMap, extra = {}) {
  const rows = []
  for (const c of channels) {
    const list = epgMap.get(c.id) || []
    rows.push({
      id: c.id,
      name: c.name,
      group: c.group,
      source: c.source || '',
      count: list.length,
      first: list[0]?.start || '',
      last: list[list.length - 1]?.stop || '',
    })
  }
  const ok = rows.filter((r) => r.count > 0)
  const total = rows.reduce((s, r) => s + r.count, 0)
  return {
    generatedAt: new Date().toISOString(),
    channelsTotal: channels.length,
    channelsWithEpg: ok.length,
    channelsEmpty: rows.length - ok.length,
    programmesTotal: total,
    ...extra,
    detail: rows,
  }
}
