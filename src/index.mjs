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
import { fileURLToPath } from 'node:url'
import {
  CONFIG,
  PATHS,
  loadChannels,
  loadOverrides,
  saveJson,
  ensureOutputDir,
} from './config.mjs'
import { log, mapLimit, isRealDesc, hasRealDesc, sameRegionVersion } from './utils.mjs'
import { matchChannels } from './match.mjs'
import { buildDateRange, normalizeProgrammes, mergeDays, dayStartTs } from './normalize.mjs'
import { buildXmltv, writeOutput, buildReport, writeChannelsJson } from './output.mjs'
import { aggregate } from './aggregator.mjs'
import { enrichDescs } from './desc.mjs'
import { parseM3u, alignToM3u, listUnmatched } from './m3u.mjs'

import * as epgpw from './sources/epgpw.mjs'
import * as tvmao from './sources/tvmao.mjs'
import * as tvsou from './sources/tvsou.mjs'
import * as fengshows from './sources/fengshows.mjs'
import * as webncode from './sources/webncode.mjs'
import * as litv from './sources/litv.mjs'
import * as tdm from './sources/tdm.mjs'
import * as elta from './sources/elta.mjs'
import * as nowplayer from './sources/nowplayer.mjs'
import * as mod from './sources/mod.mjs'
import * as cztv from './sources/cztv.mjs'
import { enrichFromZ51, loadPacks, fillEmptyChannels } from './sources/z51.mjs'
import { enrichFromKbro } from './sources/kbro.mjs'
import { enrichFromLitv } from './sources/litv.mjs'

const SOURCES = { epgpw, tvmao, tvsou, fengshows, webncode, litv, tdm, elta, nowplayer, mod, cztv }

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
    case 'm3u':
      return cmdM3u()
    default:
      console.log('用法: node src/index.mjs [catalog|init|check|build|m3u <m3u路径或URL>]')
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
          // ⚠️ 校验缓存里有没有 days 字段。
          //
          // 2026-10-26 踩过：catalog.json 是修复 listChannels 之前生成的，
          // 2050 条全都没有 days。于是 pickBest() 拿不到覆盖天数，
          // 只能退回按条数和名字长度挑，结果台湾频道全挑了 3 天/desc 全空的
          // 旧 id（370141 而非 456508）、翡翠台挑了 1 天的 539871（而非 368611），
          // 简介覆盖率凭空掉了 30 个百分点，而且节目数从 22827 缩到 14344。
          //
          // 这种"缓存结构过期"比缓存过期更隐蔽：文件很新（几小时前），
          // 但字段缺失导致匹配逻辑静默降级，日志里完全看不出来。
          // 所以这里显式校验结构，缺字段就当缓存无效、强制重扫。
          const sample = data.items.find((c) => c.source === 'epgpw')
          const hasDays = sample && Object.prototype.hasOwnProperty.call(sample, 'days')
          if (!hasDays) {
            log.warn('频道清单缓存缺少 days 字段（结构过期），强制重扫')
          } else {
            log.info(`复用频道清单缓存（${data.items.length} 条，${(ageMs / 3600e3).toFixed(1)} 小时前）`)
            return data.items
          }
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

/**
 * ★ 数一个节目数组「真正覆盖了几天」（2026-10-27 第六轮新增）
 *
 * 为什么不能只数「这天有没有节目」：
 *   epg.pw 的 CN 包对 352 个频道只给滚动 24 小时，形态是
 *   「今天 16 小时 + 明天 8 小时，再往后全空」。
 *   如果按「有 1 条就算有」来数，明天那 8 小时也算「有数据」，
 *   于是 44 个频道会被数成「2 天有数据」，而播放器实际从第 2 天下午就没内容了。
 *
 * 所以按「这天被覆盖满 minHours 小时」才算 1 天。
 *
 * @param {Array} rows        节目数组（startTs / stopTs）
 * @param {Array} dates       buildDateRange 的结果（含 ts0 / ts1）
 * @param {number} minHours   一天至少要覆盖多少小时才算「有数据」
 */
export function countCoveredDays(rows, dates, minHours) {
  const hours = new Array(dates.length).fill(0)
  for (const r of rows) {
    const a = r.startTs
    const b = r.stopTs
    if (!a || !b || b <= a) continue
    for (let i = 0; i < dates.length; i++) {
      const oa = Math.max(a, dates[i].ts0)
      const ob = Math.min(b, dates[i].ts1)
      if (ob > oa) hours[i] += (ob - oa) / 3600000
    }
  }
  // 同一天可能被多条节目重叠累加，封顶到 24 小时再比较
  return hours.filter((h) => Math.min(h, 24) >= minHours).length
}

/**
 * ★ 从备选源的节目里，只挑出「现有结果还没覆盖的那些时段」（2026-10-27 第六轮新增）
 *
 * ⚠️ 第一版是按「天」挑的，注释写「只补没覆盖的时间段」，实现却是「整天塞」，
 *    当天就踩了：
 *
 *    东方卫视 11-01：主源（epgpw）只有 00:00-04:00 这 4 小时，不足 6 小时阈值
 *    → 这天被判为「需要补」→ tvmao 当天 36 条**全部**塞进来
 *    → 结果 11-01 变成 62 条（其他天 42 条），时间轴上
 *      「电视剧：南来北往」和「电视剧：南来北往(25)」交替出现，
 *      同一时段两条节目并存 —— 播放器上会显示成节目在乱跳。
 *
 *    根因：判断用「天」，塞入用「天」，中间缺了「这条节目和已有内容重不重叠」这一层。
 *
 * 现在的规则（两段式，宁可少补）：
 *   ① 先用「天」判断哪些天不足 minHours 小时 → 只在这些天里找
 *   ② 再逐条检查：**这条节目的时间段与已有内容有任何重叠就整条丢弃**
 *      （不做裁剪 —— 裁出来的半条节目在播放器上是个假节目）
 *
 * 为什么重叠就整条丢、而不是裁剪：
 *   两个源的节目边界本来就不对齐（epg.pw 08:00-09:55，tvmao 08:00-09:45），
 *   裁剪会造出「09:45-09:55 的 10 分钟节目」，标题还是前一条的 —— 假数据。
 *   整条丢的代价是那天可能仍不满 6 小时，但不会产出错误内容。
 *
 * 保守点：某天只要已有 minHours 小时覆盖，就完全不碰它。
 *
 * @param {Array} candRows     备选源的节目（startTs / stopTs）
 * @param {Array} existingRows 已确定要保留的节目（主源 + 已补进来的）
 * @param {Array} dates        buildDateRange 的结果（含 ts0 / ts1）
 * @param {number} minHours    一天覆盖满这么多小时就算「够」，不补
 */
export function pickMissingDays(candRows, existingRows, dates, minHours) {
  const hours = new Array(dates.length).fill(0)
  for (const r of existingRows) {
    if (!r.startTs || !r.stopTs || r.stopTs <= r.startTs) continue
    for (let i = 0; i < dates.length; i++) {
      const oa = Math.max(r.startTs, dates[i].ts0)
      const ob = Math.min(r.stopTs, dates[i].ts1)
      if (ob > oa) hours[i] += (ob - oa) / 3600000
    }
  }
  const need = new Set()
  for (let i = 0; i < dates.length; i++) {
    if (Math.min(hours[i], 24) < minHours) need.add(i)
  }
  if (!need.size) return []

  // 已有内容的占用区间（用来判重叠）
  const taken = existingRows
    .filter((r) => r.startTs && r.stopTs && r.stopTs > r.startTs)
    .map((r) => [r.startTs, r.stopTs])

  const out = []
  for (const r of candRows) {
    if (!r.startTs || !r.stopTs || r.stopTs <= r.startTs) continue
    // 这条节目落在哪天就补哪天（跨天节目取「开始时间所在的天」）
    let dayIdx = -1
    for (let i = 0; i < dates.length; i++) {
      if (r.startTs >= dates[i].ts0 && r.startTs < dates[i].ts1) {
        dayIdx = i
        break
      }
    }
    if (dayIdx < 0 || !need.has(dayIdx)) continue

    // ★ 与已有内容有任何重叠 → 整条丢弃（不裁剪，见上面的说明）
    let clash = false
    for (const [a, b] of taken) {
      if (r.startTs < b && r.stopTs > a) {
        clash = true
        break
      }
    }
    if (clash) continue

    out.push(r)
    // 补进来的也要占位，避免同一个备选源内部重复（同日两条同源节目本来就重叠）
    taken.push([r.startTs, r.stopTs])
  }
  return out
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

  // 补天统计（主源天数不够、被备选源补齐的频道）
  const dayFillStats = []

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

    /**
     * 抓单个源，同时返回「规整后的（给产物用）」和「原始行（给补天判断用）」
     *
     * 为什么要两套：
     *   normalizeProgrammes 的输出是 {start, stop} 的 XMLTV 字符串（tsToXmltv 转过了），
     *   而补天判断要比时间戳（startTs/stopTs）。
     *   第六轮一开始只拿了 normalized 去算，结果 `r.startTs` 全是 undefined，
     *   countCoveredDays 恒等于 0 —— 补天逻辑看起来在跑，其实一条都没补上。
     */
    async function tryOneRaw(cand) {
      const src = SOURCES[cand.source]
      if (!src) throw new Error(`unknown source ${cand.source}`)

      // ★ 期望的频道名（数组），用于 tvmao 的串台校验（2026-10-27 第七轮新增）
      //
      // 为什么必须传：tvmao 路径猜错时返回 **200 + 别的频道的节目单**，
      //   不校验就会静默污染产物。实测 SITV-FASHION 走 /program/ 拿到的是
      //   「DOX映画」的 9 条，title 明写着 DOX映画，但旧代码抓了 pageTitle 从不看。
      //
      // 为什么给一串名字：overrides 里的 sourceId 常常不在 catalog（如 NANFANG-NANFANG6），
      //   拿不到中文名；这时必须退到频道表里的 name + aliases 去比，
      //   否则「大湾区卫视」会因为期望名是裸 id 而全部被判串台。
      const expectNames = [
        cand.sourceName,
        m.sourceName,
        ch.name,
        ...(ch.aliases || []),
      ].filter(Boolean)

      const chOverride = loadOverrides()[ch.id] || {}

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
        // overrides 里显式写 tvmaoPath 时，强制走那条路径（跳过探测）
        // 注意：loadOverrides 每次都读盘，必须在逐日循环外取一次
        const forcePath = cand.source === 'tvmao' ? chOverride?.tvmaoPath : undefined
        // 逐日抓取
        for (const d of dates) {
          const r = await src.getDayProgrammes(cand.sourceId, d.weekday, d.ymd, expectNames, forcePath)
          if (r.programmes && r.programmes.length) rows.push(...r.programmes)
        }
      }
      return { rows, normalized: normalizeProgrammes(rows, { dayStartTs: globalStart, dayEndTs: globalEnd }) }
    }

    try {
      // 先试主源；空节目时按备选顺序降级。
      // 原因：epg.pw 里有大量"注册了但零节目"的空壳频道（如三沙卫视 539632、
      // 浙江民生休闲 539891），名字匹配上了却拿不到任何节目，
      // 必须能自动换到 tvmao / tvsou 的同名频道。
      //
      // ★ 降级链必须做区域版本校验（2026-10-28 踩过，别删）：
      //   第六轮只在「补天」分支加了 sameRegionVersion，降级链漏了。
      //   本地一次 epgpw 抽风，CCTV4欧洲 / CCTV4美洲 的主源（539832 / 539751）抓空，
      //   于是顺着备选链降到了 `webncode:nowtv_542(CCTV-4)` —— 那是**亚洲版**。
      //   结果：三台都播国内版节目，报表显示「278 条 7 天」，比原来还完整，
      //   日志里没有任何异常。这是本项目最危险的一类错误：数据看着更好，内容是错的。
      //
      //   注意备选链两个方向都会串：
      //     CCTV4欧洲 → CCTV-4（亚洲）    ← 主源抓空时
      //     CCTV4亚洲 → CCTV-4 (美洲)     ← 亚洲版抓空时
      //   所以校验要双向做，不能只在"有区域词降级到无区域词"时拦。
      const baseName = m.sourceName || ch.name
      const chain = [
        { source: m.source, sourceId: m.sourceId, region: m.region, sourceName: m.sourceName },
        ...(m.alternatives || []),
      ].filter((cand, idx) => {
        if (idx === 0) return true // 主源自身永远保留
        if (sameRegionVersion(baseName, cand.sourceName)) return true
        log.warn(
          `[match] ${ch.id} 跳过备选 ${cand.source}:${cand.sourceId}(「${cand.sourceName}」)：与主源「${baseName}」是不同区域版本`
        )
        return false
      })

      let normalized = []
      let used = null
      const tried = []

      // 主源结果（两套格式都要留着，见 tryOneRaw 注释）
      let primaryRows = null
      let primaryCand = null

      for (const cand of chain) {
        try {
          const { rows, normalized: norm } = await tryOneRaw(cand)
          tried.push(`${cand.source}:${cand.sourceId}=${norm.length}`)
          if (norm.length) {
            normalized = norm
            used = cand
            primaryRows = rows
            primaryCand = cand
            break
          }
        } catch (e) {
          tried.push(`${cand.source}:${cand.sourceId}=err(${e.message.slice(0, 40)})`)
        }
      }

      // 3.45) ★ 天数不足时用备选源「补天」（2026-10-27 第六轮新增）
      //
      // 踩过的坑：降级链是 `if (list.length) break` —— 只要有 1 条节目就停。
      //   而 epg.pw 的 CN 包对 352 个频道只给「滚动 24 小时」（今天 08:00 → 明天 08:00），
      //   实测形态是 `16h 8h 0 0 0 0 0`：今天 16 小时 + 明天 8 小时，再往后全空。
      //   于是 44 个频道在 7 天订阅里只有 1~2 天有节目，播放器从第 3 天起显示「暂无节目」。
      //
      // 为什么不是「直接换源」而是「合并」：
      //   epg.pw 这 44 个频道里 35 个带真实简介（CCTV4美洲 100%、第一剧场 100%），
      //   而 tvmao 的详情页要逐条抓、这里拿不到 desc。
      //   换源 = 用「7 天无简介」换掉「1 天有简介」，是拆东墙补西墙。
      //   合并 = 保留 epg.pw 的简介，同时用 tvmao 把后面 5 天填上。
      //
      // 合并规则（保守，宁可少补不可串台）：
      //   ① 只在「现有覆盖天数 < 目标天数」时触发，够 7 天就完全不跑，省流量；
      //   ② 只补「现有完全没覆盖」的时间段 —— 已有时段一律保留主源（有简介的那份）；
      //   ③ 按天判断：某天已有 ≥ minHoursPerDay 小时覆盖就不动那天，避免半截拼接。
      const wantDays = dates.length
      if (primaryRows && primaryRows.length && !process.env.NO_DAY_FILL) {
        const coveredDays = countCoveredDays(primaryRows, dates, CONFIG.dayFillMinHours)
        if (coveredDays < wantDays) {
          const alts = (m.alternatives || []).filter(
            (a) => !(a.source === primaryCand.source && String(a.sourceId) === String(primaryCand.sourceId))
          )
          const extra = []
          const filledBy = []
          for (const alt of alts) {
            const missing = wantDays - countCoveredDays([...primaryRows, ...extra], dates, CONFIG.dayFillMinHours)
            if (missing <= 0) break

            // ★ 区域版本校验：宁可少补，不可串台（2026-10-27 第六轮踩到）
            //
            // 实测事故：CCTV4欧洲 / CCTV4美洲 被「CCTV-4 (亚洲)」补齐了 6 天，
            //   补进来的是国内版电视剧《爱在青山绿水间》，而欧洲版实际放
            //   《精彩音乐汇（海外版）》《走遍中国》。
            //   根因是 nameVariants('CCTV4欧洲') 会产出裸 'cctv4'，
            //   而 nameVariants('CCTV-4 (亚洲)') 也产出 'cctv4'，于是进了备选链。
            //
            // 这里只拦「明确是不同区域版本」的，一边没写区域词的不拦
            //（「CCTV-4」= 默认亚洲版，是正确配对）。
            if (!sameRegionVersion(primaryCand.sourceName || m.sourceName, alt.sourceName)) {
              log.warn(
                `[day-fill] 跳过 ${ch.id}：主源「${primaryCand.sourceName}」与备选「${alt.sourceName}」是不同区域版本`
              )
              continue
            }

            try {
              const { rows: candRows } = await tryOneRaw(alt)
              if (!candRows.length) continue
              // 只取「主源还没覆盖的那些天」的节目
              const add = pickMissingDays(candRows, [...primaryRows, ...extra], dates, CONFIG.dayFillMinHours)
              if (!add.length) continue
              extra.push(...add)
              filledBy.push(`${alt.source}:${alt.sourceId}+${add.length}`)
            } catch (e) {
              // 补天失败不影响主流程
            }
          }
          if (extra.length) {
            normalized = normalizeProgrammes([...primaryRows, ...extra], {
              dayStartTs: globalStart,
              dayEndTs: globalEnd,
            })
            const after = countCoveredDays([...primaryRows, ...extra], dates, CONFIG.dayFillMinHours)
            log.ok(
              `[day-fill] ${ch.id} ${coveredDays}天→${after}天 (${filledBy.join(' ')})`
            )
            dayFillStats.push({ id: ch.id, before: coveredDays, after, sources: filledBy })
          }
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

  // 3.5) 51zmt 节目单兜底
  //
  // 比 3.55 的通用聚合器优先，理由：
  //   ① 51zmt 的频道是「中文名对齐」，比聚合器按 tvg-id 猜准得多；
  //   ② 它带真实简介（e1 有 69.6%），而聚合器只拿得到 title/desc 混杂的原始数据；
  //   ③ 包已经在补简介那步下载好了，这里零额外网络成本。
  //
  // 覆盖对象：epg.pw 完全抓空的大陆地方台（浙江/湖南/江苏系列共 16 个）。
  const stillEmpty = emptyList.map((e) => e.id)
  let z51Filled = []
  if (stillEmpty.length && !process.env.NO_Z51) {
    try {
      const { byKey } = await loadPacks()
      const filled = fillEmptyChannels(targets, epgMap, byKey, { overrides: loadOverrides() })
      for (const [id, v] of filled) {
        const norm = normalizeProgrammes(v.programmes, { dayStartTs: globalStart, dayEndTs: globalEnd })
        if (!norm.length) continue
        epgMap.set(id, norm)
        usedSources.set(id, {
          source: `z51:${v.sourceKey}`,
          sourceId: v.sourceName,
          sourceName: v.sourceName,
        })
        z51Filled.push({ id, sourceKey: v.sourceKey, sourceName: v.sourceName, count: norm.length })
        okCount++
        const idx = emptyList.findIndex((e) => e.id === id)
        if (idx >= 0) emptyList.splice(idx, 1)
      }
      if (z51Filled.length) {
        log.ok(`[z51] 节目单补全 ${z51Filled.length} 个: ${z51Filled.map((f) => f.id).join(', ')}`)
      }
    } catch (e) {
      log.warn(`[z51] 节目单兜底失败，忽略: ${e.message}`)
    }
  }

  // 3.55) 外部 XML 源兜底聚合
  //
  // 只在「本地三源全部抓空」的频道上启用。理由：外部源是整包下载（1MB+），
  // 而且数据质量明显不如本地源（老张的EPG 只有 2 天、0 条简介），
  // 无差别跑一遍等于白花流量。所以这里按需触发。
  //
  // 覆盖规则：外部源拿到的节目数 > 0 且当前为空 → 填入；
  //          若外部源天数更多但当前已有节目，默认不动（本地源有 desc，质量更高）。
  const aggSources = []
  let aggReport = []
  // ⚠️ 必须重算：3.5 的 51zmt 已经补掉一部分，emptyList 被 splice 过了，
  //    如果沿用前面的 stillEmpty 快照，会对已经补好的频道再跑一遍聚合，白花流量。
  const aggStillEmpty = emptyList.map((e) => e.id)
  if (aggStillEmpty.length && !process.env.NO_AGGREGATE) {
    log.info(`[aggregator] 仍有 ${aggStillEmpty.length} 个空频道，尝试外部 XML 源兜底`)
    try {
      const aggTargets = targets.filter((c) => aggStillEmpty.includes(c.id))
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
  // 现状：epg.pw 自带 desc 的只有港澳台频道，大陆频道（央视/卫视/地方台）基本为 0。
  //
  // ⚠️ 2026-10-27 起分两步，顺序很重要：
  //
  //   ① 先用「老张的 EPG」(51zmt) 的 e1/e2 整包——
  //      一次下载 2.2MB（实测 2.5 秒）就能覆盖 80 个频道，
  //      大陆央视/卫视真实简介覆盖率 60~100%，零额外请求成本。
  //      这一步能解决绝大部分缺口，务必排在 tvmao 前面。
  //
  //   ② 剩下的缺口再交给电视猫（tvmao）逐频道抓详情页——
  //      慢（每频道 7 天节目单 + 每条详情页）、有反爬风险，
  //      但因为 ① 已经补掉大头，这里只需要处理残余，请求量能降一个量级。
  //
  // 统计口径统一用「真实简介」：51zmt 有 74% 的 desc 是「暂无节目描述」这类占位，
  // 不做过滤会把覆盖率吹到 99%，实际用户看到的全是废话。
  let descStats = null
  if (!process.env.NO_DESC) {
    // ⚠️ 统计口径必须和 output.mjs / 看板完全一致，否则日志报 63.9%、
    //    report.json 里却是 62.1%，两个数字对不上会让人不知道该信哪个。
    //    统一走 utils 的 isRealDesc（要求 ≥12 字且非占位文本）。
    //    ★ 再加上「非标题复读」：epg.pw 有 799 条 desc 就是把标题抄一遍，
    //      长度够但零信息量，光靠 isRealDesc 拦不住。见 utils.isEchoDesc。
    const countReal = () => {
      let n = 0
      let real = 0
      let echo = 0
      for (const [, rows] of epgMap) {
        for (const r of rows) {
          n++
          if (isRealDesc(r.desc)) {
            if (hasRealDesc(r.desc, r.title)) real++
            else echo++
          }
        }
      }
      return { n, real, echo }
    }

    const base = countReal()

    // ① 老张的 EPG
    let z51Stats = null
    if (!process.env.NO_Z51) {
      try {
        log.info('[desc] ① 用 51zmt 整包补简介...')
        const ov = loadOverrides()
        // blockTitles：从 overrides 里抽出「同名不同物」的黑名单，结构 { 频道id: ['标题', ...] }
        // 典型场景：江苏卫视的「非诚勿扰」是相亲综艺，CatchPlay 的同名条目是冯小刚电影
        const blockTitles = {}
        for (const [id, cfg] of Object.entries(ov)) {
          if (id.startsWith('_')) continue
          if (Array.isArray(cfg?.blockTitles) && cfg.blockTitles.length) blockTitles[id] = cfg.blockTitles
        }
        const r = await enrichFromZ51(targets, epgMap, {
          force: process.env.Z51_FORCE === '1',
          titleMap: ov,
          blockTitles,
        })
        z51Stats = {
          channels: r.stats.size,
          filled: [...r.stats.values()].reduce((a, v) => a + v.filled, 0),
          packs: r.report,
          detail: r.detail,
          stage3: r.stage3 || 0,
          byChannel: Object.fromEntries([...r.stats].map(([id, v]) => [id, v])),
        }
        if (z51Stats.filled) log.ok(`[desc] ① 51zmt 补了 ${z51Stats.filled} 条`)
        else log.info('[desc] ① 51zmt 没补到任何条目')
      } catch (e) {
        log.warn(`[desc] ① 51zmt 失败，忽略: ${e.message}`)
      }
    }

    const afterZ51 = countReal()
    if (z51Stats) {
      z51Stats.coverageBefore = +(base.real / base.n * 100).toFixed(1)
      z51Stats.coverageAfter = +(afterZ51.real / afterZ51.n * 100).toFixed(1)
    }

    // ② 电视猫补残余
    let tvmaoStats = null
    if (!process.env.NO_TVMAO_DESC) {
      try {
        log.info('[desc] ② 用 tvmao 详情页补剩余缺口...')
        const descMap = await enrichDescs(targets, catalog, epgMap, {
          concurrency: Number(process.env.DESC_CONCURRENCY || 4),
          force: process.env.DESC_FORCE === '1',
          maxFetch: Number(process.env.DESC_MAX_FETCH || 600),
        })
        if (descMap && descMap.size) {
          let filled = 0
          for (const [, rows] of epgMap) {
            for (const r of rows) {
              // ★ 复读标题也算「没有简介」，要给它补的机会
              if (hasRealDesc(r.desc, r.title)) continue
              const d = descMap.get(r.title)
              if (d && hasRealDesc(d, r.title)) {
                r.desc = d
                filled++
              }
            }
          }
          tvmaoStats = { titles: descMap.size, filled }
          log.ok(`[desc] ② tvmao 补了 ${filled} 条`)
        } else {
          log.info('[desc] ② tvmao 没有可补的简介')
        }
      } catch (e) {
        log.warn(`[desc] ② tvmao 失败，忽略: ${e.message}`)
      }
    }

    // ③ 台湾大宽频 kbro —— 台湾/香港频道专用简介源
    //
    // 为什么放在 tvmao 之后：
    //   tvmao 只索引 61 个大陆频道，港澳台完全没有；而 kbro 有 296 个台湾频道、
    //   212 个带真简介，且大量是 100% 覆盖（CBeebies 164/164、達文西 87/87、
    //   Discovery 25/25）。实测能补 774 条，简介率 62.3% → 64.0%。
    //
    // ★ 它只给 3 天数据，所以只当简介源、不当节目单源（见 kbro.mjs 的 meta.role）。
    let kbroStats = null
    if (!process.env.NO_KBRO) {
      try {
        log.info('[desc] ③ 用 kbro（台湾大宽频）补港澳台简介...')
        const r = await enrichFromKbro(targets, epgMap, {})
        if (r.stats && r.stats.filled) {
          kbroStats = { ...r.stats, detail: r.detail, report: r.report }
          log.ok(`[desc] ③ kbro 补了 ${r.stats.filled} 条`)
        } else {
          log.info('[desc] ③ kbro 没有可补的简介')
        }
      } catch (e) {
        log.warn(`[desc] ③ kbro 失败，忽略: ${e.message}`)
      }
    }

    // ④ litv 补残余（台湾付费台）—— 2026-10-28 第十三轮新增
    //
    // 为什么需要：litv 有 33 个台简介率 ≥90%（博斯/龍華/八大系列 100%），
    //   但它们只有 6 天，在 pickBest 的第一维 `days` 就被 epgpw 的 7~8 天淘汰，
    //   **简介这一维根本没机会参与比较**。实测 15 个台约 1239 条简介被白扔：
    //     龙华偶像  7天/106条/**0简介**  vs  litv 6天/139条/**139简介**
    //     博斯无限Ⅱ 7天/ 74条/**1简介**  vs  litv 6天/ 67条/**67简介**
    //
    // ★ 为什么不改 pickBest：天数确实是硬需求（订阅 7 天不能缺天），
    //   把简介提到天数前面会让整台少一天。正确做法是职责分离 ——
    //   epgpw 出 7 天节目单，litv 只出简介，和 kbro 的定位完全一致。
    //
    // ★ 放在 kbro 之后：kbro 先补（它专补港澳台、有自己的一套去重规则），
    //   litv 再补残余。顺序反了的话 kbro 就补不到 litv 已填的条目 —— 无意义。
    let litvDescStats = null
    if (!process.env.NO_LITV_DESC) {
      try {
        log.info('[desc] ④ 用 litv 补台湾付费台简介...')
        const r = await enrichFromLitv(targets, epgMap, {})
        if (r.stats && r.stats.size) {
          const filled = [...r.stats.values()].reduce((a, v) => a + v.filled, 0)
          litvDescStats = {
            channels: r.stats.size,
            filled,
            detail: r.detail,
            byChannel: Object.fromEntries([...r.stats].map(([id, v]) => [id, v])),
          }
          log.ok(`[desc] ④ litv 补了 ${filled} 条（${r.stats.size} 个频道）`)
        } else {
          log.info('[desc] ④ litv 没有可补的简介')
        }
      } catch (e) {
        log.warn(`[desc] ④ litv 失败，忽略: ${e.message}`)
      }
    }

    const final = countReal()
    descStats = {
      // 真实简介口径（去掉「暂无节目描述」等占位，以及「desc 复读标题」）
      realCoverage: +(final.real / final.n * 100).toFixed(1),
      realCount: final.real,
      totalCount: final.n,
      // 有 desc 但只是标题复读 —— 不计入真实简介，单独记出来
      echoCount: final.echo,
      // 历史字段，保留兼容看板
      titles: tvmaoStats?.titles || 0,
      filled:
        (z51Stats?.filled || 0) +
        (tvmaoStats?.filled || 0) +
        (kbroStats?.filled || 0) +
        (litvDescStats?.filled || 0),
      z51: z51Stats,
      tvmao: tvmaoStats,
      kbro: kbroStats,
      litv: litvDescStats,
    }
    log.info(
      `[desc] 最终真实简介覆盖 ${descStats.realCoverage}% (${descStats.realCount}/${descStats.totalCount})` +
        (final.echo ? `，另有 ${final.echo} 条 desc 只是复读标题（不计入）` : '')
    )
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

  // 直播源对接版：把 channel id 改写成 m3u 里的 tvg-id
  //
  // 只有 channels/m3u-map.json 存在时才生成。这是「节目单能不能挂上」的关键——
  // 自建 m3u 普遍用裸名（tvg-id="CCTV1"），而本项目规范 id 是 CCTV1.cn，
  // 不改写的话播放器一个都对不上，内容再丰富也没用。
  let m3uOut = null
  const m3uMapPath = path.join(PATHS.root, 'channels', 'm3u-map.json')
  if (fs.existsSync(m3uMapPath)) {
    try {
      const mm = JSON.parse(fs.readFileSync(m3uMapPath, 'utf8'))
      const idMap = mm.mapping || {}
      const extraNames = {}
      for (const c of enriched) {
        if (!idMap[c.id]) continue
        const alt = idMap[c.id]
        if (alt && alt !== c.name) extraNames[c.id] = [alt]
      }
      const xmlM = buildXmltv(enriched, epgMap, { idMap, extraNames })
      const outM = writeOutput(xmlM, 'epg-m3u')
      m3uOut = { ...outM, mapped: Object.keys(idMap).length }
    } catch (e) {
      log.warn(`[m3u] 生成对接版失败，忽略: ${e.message}`)
    }
  }

  // 频道清单：给直播源侧填 M3U 的 tvg-id 用（见 docs/merge-plan.md）
  const chJson = writeChannelsJson(enriched, epgMap)

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
    z51Filled,
    dayFillStats,
    descStats,
    dayList: dates.map((d) => d.ymd),
  })
  saveJson(path.join(PATHS.output, 'report.json'), report)

  console.log('\n=== 输出 ===')
  console.log(`  ${xmlPath}  ${(xmlBytes / 1024).toFixed(0)} KB`)
  console.log(`  ${gzPath}  ${(gzBytes / 1024).toFixed(0)} KB`)
  console.log(`  ${chJson.path}  ${chJson.count} 个频道（${chJson.withEpg} 个有节目）`)
  console.log(`  频道 ${report.channelsWithEpg}/${report.channelsTotal}，节目 ${report.programmesTotal} 条`)
  console.log(`  真实简介覆盖 ${report.descCoverage}%（${report.programmesWithDesc}/${report.programmesTotal}）`)
  if (m3uOut) {
    console.log(`  ${m3uOut.xmlPath}  ${(m3uOut.xmlBytes / 1024).toFixed(0)} KB（直播源对接版，${m3uOut.mapped} 个频道 id 已改写）`)
  }
}

/**
 * 生成「直播源对接映射表」：channels/m3u-map.json
 *
 * 用途：把本项目频道的规范 id（CCTV1.cn）对上你自己 m3u 里的 tvg-id（CCTV1）。
 * 跑完之后再 build，会多出一个 output/epg-m3u.xml，其 channel id 已是 m3u 侧的写法，
 * 播放器订阅它 + 你的 m3u 就能自动挂上节目单，不用改任何一侧。
 *
 * 用法：node src/index.mjs m3u <m3u路径或URL>
 */
async function cmdM3u() {
  const arg = process.argv[3]
  if (!arg) {
    console.error('用法: node src/index.mjs m3u <m3u文件路径或URL>')
    process.exit(1)
  }

  let text
  if (/^https?:\/\//i.test(arg)) {
    // ⚠️ jsdelivr 的反爬规则是反的：浏览器 UA → 403，curl UA → 200。
    // 实测 `User-Agent: curl/8.5.0` 能过，项目默认的 Chrome UA 会被拦。
    // 所以这里不用 utils 的 fetchText（它固定用浏览器 UA），自己带 UA 抓。
    // raw.githubusercontent 在部分网络下不可达，失败时自动换镜像重试。
    const candidates = [arg]
    const ghRaw = arg.match(/^https?:\/\/raw\.githubusercontent\.com\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/i)
    if (ghRaw) {
      const [, owner, repo, branch, file] = ghRaw
      candidates.push(`https://cdn.jsdelivr.net/gh/${owner}/${repo}@${branch}/${file}`)
      candidates.push(`https://ghfast.top/${arg}`)
    }

    let lastErr = ''
    for (const url of candidates) {
      log.info('下载 ' + url)
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 60000)
      try {
        const res = await fetch(url, {
          redirect: 'follow',
          signal: ac.signal,
          headers: { 'User-Agent': 'curl/8.5.0', Accept: '*/*' },
        })
        const body = await res.text()
        clearTimeout(timer)
        if (res.ok && body) {
          text = body
          break
        }
        lastErr = `HTTP ${res.status}`
      } catch (e) {
        clearTimeout(timer)
        lastErr = e.message
      }
      log.warn(`下载失败（${lastErr}）${candidates.length > 1 ? '，换下一个地址' : ''}`)
    }
    if (!text) throw new Error('下载失败：' + lastErr)
  } else {
    text = fs.readFileSync(arg, 'utf8')
  }

  const parsed = parseM3u(text)
  if (!parsed.byId.size) throw new Error('m3u 里没解析到任何 tvg-id')

  const channels = loadChannels().filter((c) => c.enabled !== false)

  // 补「有没有节目」，用于判断映射的实际价值
  let withEpg = new Set()
  const chJsonPath = path.join(PATHS.output, 'channels.json')
  if (fs.existsSync(chJsonPath)) {
    try {
      const cj = JSON.parse(fs.readFileSync(chJsonPath, 'utf8'))
      withEpg = new Set(cj.filter((c) => c.hasEpg).map((c) => c.id))
    } catch {
      /* 忽略 */
    }
  }
  const enriched = channels.map((c) => ({ ...c, hasEpg: withEpg.has(c.id) }))

  const mapPath = path.join(PATHS.root, 'channels', 'm3u-map.json')
  let manual = {}
  if (fs.existsSync(mapPath)) {
    try {
      manual = JSON.parse(fs.readFileSync(mapPath, 'utf8')).manual || {}
    } catch {
      /* 忽略 */
    }
  }

  const { mapping, detail, stats } = alignToM3u(enriched, parsed, manual)
  const { list, byGroup } = listUnmatched(parsed, mapping)

  // 安全阀：上游 m3u 改版 / 抓取半途中断时，匹配数会突然塌下来。
  // 这时如果照旧覆盖 m3u-map.json，会把一份好映射换成坏映射，
  // 下次 build 出来的 epg-m3u.xml 会大面积挂不上——比不更新更糟。
  // 所以只要比上一版少了两成以上，就拒绝覆盖。
  let prev = null
  if (fs.existsSync(mapPath)) {
    try {
      prev = JSON.parse(fs.readFileSync(mapPath, 'utf8'))
    } catch {
      /* 忽略 */
    }
  }
  const prevMatched = prev?.stats?.matched || 0
  const regressed = prevMatched > 0 && stats.matched < prevMatched * 0.8
  if (regressed) {
    log.warn(
      `[m3u] 匹配数从 ${prevMatched} 掉到 ${stats.matched}（降幅 ${Math.round(
        (1 - stats.matched / prevMatched) * 100
      )}%），疑似上游改版或抓取不完整，保留原映射表不覆盖`
    )
    log.warn('[m3u] 确认这次是对的就手工删掉 channels/m3u-map.json 再跑一遍')
  } else {
    saveJson(mapPath, {
      generatedAt: new Date().toISOString(),
      source: arg,
      stats,
      manual,
      mapping,
      detail,
      unmatched: list,
    })
  }

  console.log('\n=== 对齐结果 ===')
  console.log('  我们 ' + stats.epgChannels + ' 个频道，能对上 m3u 的 ' + stats.matched + ' 个（其中 ' + stats.matchedWithEpg + ' 个有节目）')
  console.log('  覆盖 m3u 的 ' + stats.m3uCovered + '/' + stats.m3uIds + ' 个 tvg-id（' + stats.m3uCoverage + '%）')
  console.log('  映射表' + (regressed ? '未更新（见上方告警）' : '已写入 ' + mapPath))

  console.log('\n=== m3u 里我们还没有的频道（按分组）===')
  const rows = [...byGroup].sort((a, b) => b[1].length - a[1].length)
  for (const [g, names] of rows) {
    console.log('  ' + g + '：' + names.length + ' 个')
    console.log('    ' + names.slice(0, 12).join(' / ') + (names.length > 12 ? ' ...' : ''))
  }
  console.log('\n下一步：node src/index.mjs build  → 会额外产出 output/epg-m3u.xml')
}

// 只在「直接运行」时执行 CLI。
// 为什么加这个判断：test/day-fill.test.mjs 要 import countCoveredDays / pickMissingDays，
// 如果不判断，import 就会跑一遍 main()，测试进程直接去抓数据了。
const isDirectRun =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectRun) {
  main().catch((e) => {
    log.error(e.stack || e.message)
    process.exit(1)
  })
}
