/**
 * EPG 多源聚合器
 *
 * 定位：像 iptv-api 聚合直播源那样聚合 XMLTV 源。
 *
 *   别人的 XML 源 A ─┐
 *   别人的 XML 源 B ─┼→ 解析 → 频道名归一化匹配 → 同名择优 → 合并 → 输出 XMLTV
 *   别人的 XML 源 C ─┘
 *
 * 与 iptv-api 的 updates/epg/request.py 的关键差异（那三个是它的硬伤）：
 *   1. 它只取 <title>，把 <desc>/<category>/<icon>/<episode-num> 全丢了
 *      → 这里完整保留所有子元素
 *   2. 它拿 channel_id 当 display-name 输出
 *      → 这里用目标频道自己的名字
 *   3. 它纯精确名匹配
 *      → 这里复用 match.mjs 的归一化 + 别名 + 包含匹配
 *
 * 源清单在 channels/epg-sources.json，加源只改这个文件，不用改代码。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fetchBuffer, normalizeName, nameVariants, log, mapLimit } from './utils.mjs'
import { PATHS, CONFIG } from './config.mjs'

/**
 * 解析 XMLTV，完整保留所有子元素
 * @returns {channels: [{id, names:[], icon}], byChannel: Map<id, prog[]>}
 */
export function parseXmltvFull(xml) {
  const channels = []
  const byChannel = new Map()

  // 频道块
  const chRe = /<channel\s+([^>]*)>([\s\S]*?)<\/channel>/g
  let m
  while ((m = chRe.exec(xml))) {
    const attrs = m[1]
    const body = m[2]
    const id = (attrs.match(/id="([^"]*)"/) || [])[1]
    if (!id) continue
    const names = [...body.matchAll(/<display-name[^>]*>([\s\S]*?)<\/display-name>/g)].map((x) =>
      decodeEntities(x[1]).trim()
    )
    const icon = (body.match(/<icon\s+src="([^"]*)"/) || [])[1] || ''
    channels.push({ id, names: names.filter(Boolean), icon })
  }

  // 节目块：保留 inner XML 原文，这样 desc/category/episode-num/icon 全都不丢
  const prRe = /<programme\s+([^>]*)>([\s\S]*?)<\/programme>/g
  while ((m = prRe.exec(xml))) {
    const attrs = m[1]
    const inner = m[2]
    const channel = (attrs.match(/channel="([^"]*)"/) || [])[1]
    const start = (attrs.match(/start="([^"]*)"/) || [])[1]
    const stop = (attrs.match(/stop="([^"]*)"/) || [])[1]
    if (!channel || !start) continue

    const title = (inner.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || ''
    const desc = (inner.match(/<desc[^>]*>([\s\S]*?)<\/desc>/) || [])[1] || ''
    const category = (inner.match(/<category[^>]*>([\s\S]*?)<\/category>/) || [])[1] || ''
    const episodeNum = (inner.match(/<episode-num[^>]*>([\s\S]*?)<\/episode-num>/) || [])[1] || ''
    const icon = (inner.match(/<icon\s+src="([^"]*)"/) || [])[1] || ''

    if (!byChannel.has(channel)) byChannel.set(channel, [])
    byChannel.get(channel).push({
      startTs: parseXmltvTime(start),
      stopTs: stop ? parseXmltvTime(stop) : null,
      title: decodeEntities(title).trim(),
      desc: decodeEntities(desc).trim(),
      category: decodeEntities(category).trim(),
      episodeNum: decodeEntities(episodeNum).trim(),
      icon,
    })
  }

  return { channels, byChannel }
}

/** 解析 "20261026010400 +0800" → 毫秒时间戳（按字符串里的偏移量） */
export function parseXmltvTime(s) {
  if (!s) return null
  const m = String(s).trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/)
  if (!m) return null
  const [, y, mo, d, hh, mi = '00', ss = '00', off = '+0800'] = m
  const ts = Date.parse(`${y}-${mo}-${d}T${hh}:${mi}:${ss}${off.slice(0, 3)}:${off.slice(3)}`)
  return Number.isNaN(ts) ? null : ts
}

function decodeEntities(s) {
  if (!s) return ''
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
}

/** 读取源清单 */
export function loadEpgSources() {
  try {
    const data = JSON.parse(fs.readFileSync(PATHS.epgSources, 'utf8'))
    const list = Array.isArray(data) ? data : data.sources || []
    return list
      .filter((s) => s && s.url && s.enabled !== false)
      .map((s, i) => ({
        name: s.name || `source${i + 1}`,
        url: s.url,
        // 该源的频道名是否已经是 iptv-org tvg-id 规范（可直接精确对齐）
        tvgIdNative: s.tvgIdNative !== false,
        priority: s.priority ?? 100,
        enabled: s.enabled !== false,
      }))
  } catch {
    return []
  }
}

/** 下载并解压一个源，返回 XML 文本 */
async function fetchSource(src) {
  const { ok, buf, bytes, error } = await fetchBuffer(src.url, {
    timeout: 300000,
    fetchTimeout: 90000,
    retries: 1,
  })
  if (!ok || !buf || bytes < 64) {
    throw new Error(`下载失败: ${error || `HTTP ${bytes} bytes`}`)
  }

  // gzip 探测：看魔数，不看后缀（很多源后缀写 .xml 实际是 gz）
  let xml
  if (buf[0] === 0x1f && buf[1] === 0x8b) {
    try {
      xml = zlib.gunzipSync(buf).toString('utf8')
    } catch (e) {
      throw new Error(`gunzip 失败: ${e.message}`)
    }
  } else {
    xml = buf.toString('utf8')
  }

  if (!xml.includes('<tv')) throw new Error('内容不是合法 XMLTV')
  return xml
}

/**
 * 聚合所有外部源
 *
 * @param targets  目标频道 [{id, name, aliases}]
 * @returns {Map<tvgId, {programmes, sourceName, sourceChannelName}>}
 */
export async function aggregate(targets, opts = {}) {
  const sources = loadEpgSources()
  if (!sources.length) {
    log.info('[aggregator] 未配置外部 XML 源，跳过')
    return new Map()
  }

  // 目标频道索引：归一化名 → tvg-id
  const nameToTarget = new Map()
  for (const t of targets) {
    for (const v of new Set([...nameVariants(t.name), ...(t.aliases || []).flatMap((a) => nameVariants(a))])) {
      if (v && v.length >= 2 && !nameToTarget.has(v)) nameToTarget.set(v, t.id)
    }
  }

  const sorted = [...sources].sort((a, b) => a.priority - b.priority)
  log.info(`[aggregator] ${sorted.length} 个外部源，${targets.length} 个目标频道`)

  // 每个目标频道收集到的候选节目，最后按质量择优
  const bucket = new Map() // tvgId → [{sourceName, channelName, programmes, days, count}]
  const sourceReport = []

  for (const src of sorted) {
    let xml
    try {
      log.info(`[aggregator] 拉取 ${src.name} ...`)
      xml = await fetchSource(src)
    } catch (e) {
      log.warn(`[aggregator] ${src.name} 失败: ${e.message}`)
      sourceReport.push({ name: src.name, url: src.url, ok: false, error: e.message, channels: 0, matched: 0 })
      continue
    }

    const { channels, byChannel } = parseXmltvFull(xml)
    let matched = 0

    for (const ch of channels) {
      // 逐个别名尝试匹配目标频道
      let targetId = null
      if (src.tvgIdNative && nameToTarget.has(ch.id)) {
        targetId = nameToTarget.get(ch.id)
      }
      if (!targetId) {
        for (const n of ch.names) {
          const key = normalizeName(n)
          if (key && nameToTarget.has(key)) {
            targetId = nameToTarget.get(key)
            break
          }
        }
      }
      if (!targetId) continue

      const programmes = byChannel.get(ch.id) || []
      if (!programmes.length) continue
      matched++

      const days = new Set(
        programmes.filter((p) => p.startTs).map((p) => new Date(p.startTs + 8 * 3600e3).toISOString().slice(0, 10))
      ).size

      if (!bucket.has(targetId)) bucket.set(targetId, [])
      bucket.get(targetId).push({
        sourceName: src.name,
        priority: src.priority,
        channelName: ch.names[0] || ch.id,
        icon: ch.icon,
        programmes,
        days,
        count: programmes.length,
      })
    }

    log.ok(`[aggregator] ${src.name}: ${channels.length} 频道，命中 ${matched}`)
    sourceReport.push({
      name: src.name,
      url: src.url,
      ok: true,
      channels: channels.length,
      matched,
    })
  }

  // 择优：优先"覆盖天数多"，其次"节目条数多"，最后看源优先级
  const out = new Map()
  for (const [tvgId, list] of bucket) {
    list.sort((a, b) => b.days - a.days || b.count - a.count || a.priority - b.priority)
    const best = list[0]
    out.set(tvgId, {
      programmes: best.programmes,
      sourceName: best.sourceName,
      sourceChannelName: best.channelName,
      icon: best.icon,
      candidates: list.map((c) => ({
        sourceName: c.sourceName,
        channelName: c.channelName,
        days: c.days,
        count: c.count,
      })),
    })
  }

  log.ok(`[aggregator] 完成：${out.size}/${targets.length} 个频道有节目`)
  return { result: out, sourceReport }
}
