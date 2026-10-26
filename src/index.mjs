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

/** 汇总所有源的频道清单 */
async function collectCatalog() {
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
  return all
}

async function cmdCatalog() {
  const catalog = await collectCatalog()
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
  const catalog = await collectCatalog()
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
  const catalog = await collectCatalog()
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
      emptyList.push(`${r.id}(${r.reason || 'empty'})`)
    }
  }

  log.info(`有节目频道 ${okCount}/${targets.length}`)
  if (fallbacks.length) {
    log.info(`自动降级 ${fallbacks.length} 个: ${fallbacks.map((f) => `${f.id} ${f.from}→${f.to}`).join(', ')}`)
  }
  if (emptyList.length) {
    log.warn(`空频道 ${emptyList.length} 个: ${emptyList.slice(0, 20).join(', ')}${emptyList.length > 20 ? ' ...' : ''}`)
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
    emptyChannels: emptyList,
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
