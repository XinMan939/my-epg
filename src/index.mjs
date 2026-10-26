#!/usr/bin/env node
/**
 * my-epg 主入口
 *
 * 用法：
 *   node src/index.mjs catalog            扫描所有源，导出频道清单（人工挑选用）
 *   node src/index.mjs init               根据频道清单生成匹配结果，写入 channels/match-cache.json
 *   node src/index.mjs build              抓取节目并输出 output/epg.xml + epg.xml.gz
 *   node src/index.mjs check              只做匹配检查，报告命中率，不抓节目
 *
 * 环境变量：
 *   DAYS=7            覆盖天数
 *   ONLY=id1,id2      只处理指定频道（调试用）
 *   CONCURRENCY=6     并发数
 */
import fs from 'node:fs'
import path from 'node:path'
import {
  CONFIG,
  PATHS,
  loadChannels,
  saveJson,
  ensureOutputDir,
} from './config.mjs'
import { log, mapLimit } from './utils.mjs'
import { matchChannels } from './match.mjs'
import { buildDateRange, normalizeProgrammes, mergeDays, dayStartTs } from './normalize.mjs'
import { buildXmltv, writeOutput, buildReport } from './output.mjs'
import { aggregate } from './aggregator.mjs'
import { enrichDescs } from './desc.mjs'

import * as epgpw from './sources/epgpw.mjs'
import * as tvmao from './sources/tvmao.mjs'
import * as tvsou from './sources/tvsou.mjs'

const SOURCES = { epgpw, tvmao, tvsou }

/**
 * 源优先级：靠前的优先。
 * epgpw 有真实 stop + 简介 + 港澳台全覆盖，所以排第一；
 * tvmao 补 epgpw 缺的大陆频道；
 * tvsou 最后兜底。
 */
const SOURCE_PRIORITY = ['epgpw', 'tvmao', 'tvsou']

const cmd = process.argv[2] || 'build'

async function main() {
  if (process.env.DAYS) CONFIG.days = Number(process.env.DAYS)
  if (process.env.CONCURRENCY) CONFIG.concurrency = Number(process.env.CONCURRENCY)

  switch (cmd) {
    case 'catalog':
      return cmdCatalog()
    case 'init':
      return cmdInit()
    case 'check':
      return cmdCheck()
    case 'build':
      return cmdBuild()
    default:
      console.log('用法: node src/index.mjs [catalog|init|check|build]')
  }
}

/**
 * 读取频道清单。
 *
 * 关键：build 不要每次都联网重扫所有源。
 * epgpw 的 listChannels 要先下载 3 个整包 XML（CN 9MB / HK 19MB / TW 29MB），
 * 每跑一次 build 就重扫一遍等于把流量和时间白扔——而频道清单本身几周都不变。
 *
 * 所以：
 *   - catalog 命令 → 强制重扫，写 channels/catalog.json
 *   - init / check  → 重扫（匹配结果需要最新清单）
 *   - build         → 复用 catalog.json；文件不存在或超过 CATALOG_TTL 才重扫
 */
async function collectCatalog({ force = false } = {}) {
  const cacheFile = path.join(PATHS.root, 'channels', 'catalog.json')

  if (!force) {
    try {
      const st = fs.statSync(cacheFile)
      const ageMs = Date.now() - st.mtimeMs
      const ttlMs = Number(process.env.CATALOG_TTL_HOURS || 24) * 3600 * 1000
      if (ageMs < ttlMs) {
        const data = JSON.parse(fs.readFileSync(cacheFile, 'utf8'))
        if (data.items && data.items.length) {
          log.info(`复用频道清单缓存（${data.items.length} 条，${(ageMs / 3600e3).toFixed(1)} 小时前）`)
          return data.items
        }
      }
    } catch {
      /* 缓存不可用，走重扫 */
    }
  }

  log.info('扫描数据源频道清单...')
  const all = []
  const results = await Promise.all(
    Object.entries(SOURCES).map(async ([key, mod]) => {
      try {
        const list = await mod.listChannels()
        log.ok(`${key}: ${list.length} 个频道`)
        return list
      } catch (e) {
        log.error(`${key}: 扫描失败 ${e.message}`)
        return []
      }
    })
  )
  for (const r of results) all.push(...r)

  if (all.length) {
    saveJson(cacheFile, { generatedAt: new Date().toISOString(), total: all.length, items: all })
  }
  return all
}

async function cmdCatalog() {
  const catalog = await collectCatalog({ force: true })
  const outPath = path.join(PATHS.root, 'channels', 'catalog.json')
  saveJson(outPath, { generatedAt: new Date().toISOString(), total: catalog.length, items: catalog })
  log.ok(`已导出 ${catalog.length} 条到 channels/catalog.json`)

  // 按源统计
  const by = {}
  for (const c of catalog) by[c.source] = (by[c.source] || 0) + 1
  console.log('按源统计:', by)
}

async function cmdInit() {
  const channels = loadChannels()
  if (!channels.length) {
    log.error('channels/channels.json 为空，请先填写目标频道')
    process.exit(1)
  }
  const catalog = await collectCatalog({ force: true })
  const { matched, stats } = matchChannels(channels, catalog)

  const out = {}
  for (const [id, v] of matched) out[id] = v
  saveJson(PATHS.matchCache, out)

  console.log('\n=== 匹配结果 ===')
  console.log(`目标频道: ${channels.length}`)
  console.log(`命中: ${matched.size}`)
  console.log(`  手工指定: ${stats.override}`)
  console.log(`  精确匹配: ${stats.exact}`)
  console.log(`  别名匹配: ${stats.alias}`)
  console.log(`  包含匹配: ${stats.contains}`)
  console.log(`未命中: ${stats.miss}`)
  console.log(`\n匹配表已写入 channels/match-cache.json`)
}

async function cmdCheck() {
  const channels = loadChannels()
  const catalog = await collectCatalog({ force: true })
  const { matched, stats } = matchChannels(channels, catalog)

  console.log('\n=== 匹配检查 ===')
  const misses = channels.filter((c) => !matched.has(c.id))
  for (const c of channels) {
    const m = matched.get(c.id)
    if (m) {
      const flag = m.confidence === 'contains' ? ' ⚠' : ''
      console.log(`  ✓ ${c.id.padEnd(28)} → ${m.source}:${m.sourceId} (${m.sourceName})${flag}`)
    } else {
      console.log(`  ✗ ${c.id.padEnd(28)} 未命中`)
    }
  }
  console.log(`\n命中 ${matched.size}/${channels.length}，未命中 ${misses.length}`)
}

async function cmdBuild() {
  ensureOutputDir()
  const channels = loadChannels()
  if (!channels.length) {
    log.error('channels/channels.json 为空')
    process.exit(1)
  }

  const only = process.env.ONLY ? new Set(process.env.ONLY.split(',').map((s) => s.trim())) : null
  const targets = only ? channels.filter((c) => only.has(c.id)) : channels.filter((c) => c.enabled)

  log.info(`目标频道 ${targets.length} 个，覆盖 ${CONFIG.days} 天`)

  // 1) 建立匹配
  const catalog = await collectCatalog()
  const { matched } = matchChannels(targets, catalog)
  saveJson(
    PATHS.matchCache,
    Object.fromEntries([...matched])
  )

  const dates = buildDateRange(CONFIG.days)
  const globalStart = dates[0].ts0
  const globalEnd = dates[dates.length - 1].ts1

  log.info(
    `日期范围 ${dates[0].ymd} ~ ${dates[dates.length - 1].ymd} (${dates.length} 天)`
  )

  // 2) 逐频道抓取
  const epgMap = new Map()
  const sourceStats = {}
  let done = 0

  const results = await mapLimit(targets, CONFIG.concurrency, async (ch) => {
    const m = matched.get(ch.id)
    done++
    if (!m) {
      return { id: ch.id, programmes: [], reason: 'no-match' }
    }

    // 抓单个 (source, sourceId) 组合，返回规整后的节目数组
    async function tryOne(cand) {
      const src = SOURCES[cand.source]
      if (!src) throw new Error(`unknown source ${cand.source}`)

      let rows = []
      if (cand.source === 'epgpw') {
        // epg.pw 是整包 XMLTV，一次取全量再过滤（内部已按 mtime 缓存解析结果）
        const list = await epgpw.getProgrammes(cand.sourceId, cand.region || 'CN')
        rows = list.map((p) => ({
          startTs: p.startTs,
          stopTs: p.stopTs,
          title: p.title,
          desc: p.desc,
          category: p.category,
        }))
      } else {
        // 逐日抓取
        for (const d of dates) {
          const r = await src.getDayProgrammes(cand.sourceId, d.weekday, d.ymd)
          if (r.programmes && r.programmes.length) rows.push(...r.programmes)
        }
      }

      return normalizeProgrammes(rows, {
        dayStartTs: globalStart,
        dayEndTs: globalEnd,
      })
    }

    try {
      // 先试主源；空节目时按备选顺序降级。
      // 原因：epg.pw 里有大量"注册了但零节目"的空壳频道（如三沙卫视 539632、
      // 浙江民生休闲 539891），名字匹配上了却拿不到任何节目，
      // 必须能自动换到 tvmao / tvsou 的同名频道。
      const chain = [
        { source: m.source, sourceId: m.sourceId, region: m.region, sourceName: m.sourceName },
        ...(m.alternatives || []),
      ]

      let normalized = []
      let used = null
      const tried = []

      for (const cand of chain) {
        try {
          const list = await tryOne(cand)
          tried.push(`${cand.source}:${cand.sourceId}=${list.length}`)
          if (list.length) {
            normalized = list
            used = cand
            break
          }
        } catch (e) {
          tried.push(`${cand.source}:${cand.sourceId}=err(${e.message.slice(0, 40)})`)
        }
      }

      if (done % 20 === 0 || done === targets.length) {
        log.info(`进度 ${done}/${targets.length}`)
      }

      if (!normalized.length) {
        return { id: ch.id, programmes: [], reason: `empty(${tried.join(' ')})` }
      }

      if (used.source !== m.source) {
        log.warn(`[fallback] ${ch.id} 主源 ${m.source} 空，改用 ${used.source}:${used.sourceId} (${used.sourceName})`)
      }
      sourceStats[used.source] = (sourceStats[used.source] || 0) + 1
      return {
        id: ch.id,
        programmes: normalized,
        reason: null,
        source: used.source,
        sourceId: used.sourceId,
        sourceName: used.sourceName,
      }
    } catch (e) {
      return { id: ch.id, programmes: [], reason: `error: ${e.message}` }
    }
  })

  // 3) 汇总
  let okCount = 0
  const emptyList = []
  const usedSources = new Map() // id → 实际使用的源信息
  const fallbacks = []
  for (const r of results) {
    if (!r) continue
    if (r.programmes && r.programmes.length) {
      epgMap.set(r.id, r.programmes)
      usedSources.set(r.id, { source: r.source, sourceId: r.sourceId, sourceName: r.sourceName })
      const m = matched.get(r.id)
      if (m && r.source !== m.source) {
        fallbacks.push({ id: r.id, from: `${m.source}:${m.sourceId}`, to: `${r.source}:${r.sourceId}` })
      }
      okCount++
    } else {
      emptyList.push({ id: r.id, reason: r.reason || 'empty' })
    }
  }

  log.info(`有节目频道 ${okCount}/${targets.length}`)
  if (fallbacks.length) {
    log.info(`自动降级 ${fallbacks.length} 个: ${fallbacks.map((f) => `${f.id} ${f.from}→${f.to}`).join(', ')}`)
  }
  if (emptyList.length) {
    log.warn(`空频道 ${emptyList.length} 个: ${emptyList.map((e) => e.id).slice(0, 20).join(', ')}${emptyList.length > 20 ? ' ...' : ''}`)
  }

  // 3.5) 外部 XML 源兜底聚合
  //
  // 只在「本地三源全部抓空」的频道上启用。理由：外部源是整包下载（1MB+），
  // 而且数据质量明显不如本地源（老张的EPG 只有 2 天、0 条简介），
  // 无差别跑一遍等于白花流量。所以这里按需触发。
  //
  // 覆盖规则：外部源拿到的节目数 > 0 且当前为空 → 填入；
  //          若外部源天数更多但当前已有节目，默认不动（本地源有 desc，质量更高）。
  const aggSources = []
  let aggReport = []
  const stillEmpty = emptyList.map((e) => e.id)
  if (stillEmpty.length && !process.env.NO_AGGREGATE) {
    log.info(`[aggregator] 仍有 ${stillEmpty.length} 个空频道，尝试外部 XML 源兜底`)
    try {
      const aggTargets = targets.filter((c) => stillEmpty.includes(c.id))
      const agg = await aggregate(aggTargets)
      aggReport = agg.sourceReport || []
      for (const [id, v] of agg.result || new Map()) {
        const rows = v.programmes.map((p) => ({
          startTs: p.startTs,
          stopTs: p.stopTs,
          title: p.title,
          desc: p.desc,
          category: p.category,
        }))
        const norm = normalizeProgrammes(rows, { dayStartTs: globalStart, dayEndTs: globalEnd })
        if (!norm.length) continue
        epgMap.set(id, norm)
        usedSources.set(id, {
          source: `ext:${v.sourceName}`,
          sourceId: v.sourceChannelName,
          sourceName: v.sourceChannelName,
        })
        aggSources.push({
          id,
          from: v.sourceName,
          channelName: v.sourceChannelName,
          count: norm.length,
          candidates: v.candidates,
        })
        okCount++
      }
      const filled = aggSources.map((a) => a.id)
      for (const id of filled) {
        const idx = emptyList.findIndex((e) => e.id === id)
        if (idx >= 0) emptyList.splice(idx, 1)
      }
      if (filled.length) {
        log.ok(`[aggregator] 外部源补全 ${filled.length} 个: ${filled.join(', ')}`)
      } else {
        log.info('[aggregator] 外部源未能补全任何频道')
      }
    } catch (e) {
      log.warn(`[aggregator] 聚合失败，忽略: ${e.message}`)
    }
  }

  // 3.6) 补节目简介
  //
  // 现状：epg.pw 自带 desc 的只有港澳台频道（覆盖率很高），
  //       大陆频道（央视/卫视/地方台）desc 全是 0。
  // 方案：从电视猫的节目详情页抓简介，按「节目名」对齐补进来。
  //       详情页 hash 是栏目级 ID，长期复用，所以有持久化缓存，日常增量很小。
  let descStats = null
  if (!process.env.NO_DESC) {
    try {
      log.info('[desc] 开始补节目简介...')
      const descMap = await enrichDescs(targets, catalog, epgMap, {
        concurrency: Number(process.env.DESC_CONCURRENCY || 4),
        force: process.env.DESC_FORCE === '1',
        maxFetch: Number(process.env.DESC_MAX_FETCH || 600),
      })
      if (descMap && descMap.size) {
        let filled = 0
        for (const [, rows] of epgMap) {
          for (const r of rows) {
            if (r.desc && r.desc.trim()) continue
            const d = descMap.get(r.title)
            if (d) {
              r.desc = d
              filled++
            }
          }
        }
        log.ok(`[desc] 已补 ${filled} 条简介`)
        descStats = { titles: descMap.size, filled }
      } else {
        log.info('[desc] 没有可补的简介')
      }
    } catch (e) {
      log.warn(`[desc] 补简介失败，忽略: ${e.message}`)
    }
  }

  // 4) 输出
  // 频道台标：channels.json 里显式写的优先，否则用匹配到的源台标
  const enriched = targets.map((c) => {
    const m = matched.get(c.id)
    const u = usedSources.get(c.id)
    return {
      ...c,
      logo: c.logo || m?.logo || '',
      source: u?.source || m?.source || '',
    }
  })
  const xml = buildXmltv(enriched, epgMap)
  const { xmlPath, gzPath, xmlBytes, gzBytes } = writeOutput(xml, 'epg')

  const report = buildReport(enriched, epgMap, {
    days: CONFIG.days,
    dateRange: [dates[0].ymd, dates[dates.length - 1].ymd],
    sourceStats,
    fallbacks,
    emptyChannels: emptyList.map((e) => `${e.id}(${e.reason})`),
    // ↓ 看板需要的明细：匹配依据、源频道名、备选、每日分布
    matchInfo: Object.fromEntries(
      [...matched].map(([id, v]) => [
        id,
        {
          confidence: v.confidence,
          source: v.source,
          sourceId: v.sourceId,
          sourceName: v.sourceName,
          alternatives: (v.alternatives || []).map((a) => `${a.source}:${a.sourceId}(${a.sourceName})`),
        },
      ])
    ),
    usedSources: Object.fromEntries(
      [...usedSources].map(([id, v]) => [id, `${v.source}:${v.sourceId}(${v.sourceName})`])
    ),
    aggregated: aggSources,
    aggregateReport: aggReport,
    descStats,
    dayList: dates.map((d) => d.ymd),
  })
  saveJson(path.join(PATHS.output, 'report.json'), report)

  console.log('\n=== 输出 ===')
  console.log(`  ${xmlPath}  ${(xmlBytes / 1024).toFixed(0)} KB`)
  console.log(`  ${gzPath}  ${(gzBytes / 1024).toFixed(0)} KB`)
  console.log(`  频道 ${report.channelsWithEpg}/${report.channelsTotal}，节目 ${report.programmesTotal} 条`)
}

main().catch((e) => {
  log.error(e.stack || e.message)
  process.exit(1)
})
