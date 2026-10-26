/**
 * 节目简介抓取（电视猫 m.tvmao.com）
 *
 * 为什么要单独做这个模块：
 *   epg.pw 只有 22% 的节目带 <desc>（且集中在香港频道），
 *   tvmao / tvsou 的节目单页完全不提供简介。
 *   但电视猫的节目单每一条都挂着详情页链接，详情页里就有简介。
 *
 * 三类详情页，简介藏在三个不同位置（2026-10-26 实测）：
 *
 *   /tvcolumn/{hash}   栏目页（新闻、综艺、固定栏目）
 *      <div class="pb10 blank bg_white section">《生活圈》是全新的…</div>
 *      注意：没有 meta description，只能从正文 div 里提
 *
 *   /kanju/{hash}      剧集页·移动端（电视剧、纪录片）
 *      <meta name="description" content="电视剧中华古树剧情介绍：《中华古树》是…">
 *
 *   /drama/{hash}      剧集页·PC 端（同一部剧的另一条路径，内容同 kanju）
 *      <meta name="description" content="电视剧爱在山海间剧情介绍：…">
 *
 * 缓存设计（关键）：
 *   key = 详情页路径（/tvcolumn/aiFdZ2Jm），不是节目名。
 *   因为栏目 hash 是栏目级 ID，会长期复用——「新闻联播」的 /tvcolumn/eg== 一年后还是它。
 *   所以一个 hash 抓一次就够，后面每天 build 直接命中缓存，零请求。
 *
 * TTL 分级（用户明确要求"要更新，比如热播剧后面有新剧"）：
 *   - 剧集类（/kanju /drama）：7 天。热播剧会换、集数会加、简介会改。
 *   - 栏目类（/tvcolumn）：90 天。新闻栏目的简介基本不动。
 *   - 抓取失败：缓存空结果 3 天，避免每天对同一个坏链接反复重试。
 *
 * 输出：写回 .cache/desc-cache.json，build 时按 title 查表补 <desc>。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS } from './config.mjs'
import { fetchText, log, mapLimit, normalizeName, nameVariants } from './utils.mjs'

const BASE = 'https://m.tvmao.com'
const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

const DAY = 24 * 3600 * 1000
/** 剧集类 TTL：热播剧会更新，7 天重抓一次 */
const TTL_DRAMA = 7 * DAY
/** 栏目类 TTL：新闻/固定栏目简介几乎不变 */
const TTL_COLUMN = 90 * DAY
/** 失败结果 TTL：别每天对同一个坏链接反复重试 */
const TTL_FAIL = 3 * DAY

/** 简介长度上限，防止个别页面把整篇剧情都塞进来 */
const MAX_DESC_LEN = 400

/**
 * 从节目单 HTML 里抽出「节目名 → 详情页路径」映射
 *
 * 移动端节目单结构：
 *   <span class="epg-row-link"><a href="/tvcolumn/aiFdZ2Jm">生活早参考</a>…</span>
 *
 * 注意同一节目一天可能出现多次（重播），用 Map 自然去重。
 *
 * @returns {Map<title, path>}
 */
export function extractProgrammeLinks(html) {
  const out = new Map()
  const re = /<span class="epg-row-link"><a[^>]*href="(\/[a-z]+\/[^"]+)"[^>]*>([^<]*)<\/a>/g
  let m
  while ((m = re.exec(html))) {
    const href = m[1]
    const title = m[2].trim()
    if (!title || !href) continue
    // 只要这三类详情页
    if (!/^\/(tvcolumn|kanju|drama)\//.test(href)) continue
    if (!out.has(title)) out.set(title, href)
  }
  return out
}

/**
 * 从详情页 HTML 里抽简介正文
 * @returns {string} 空串表示这个页面没有简介
 */
export function extractDesc(html, href = '') {
  // 1) 剧集类：meta description 最干净（已含"电视剧xxx剧情介绍："前缀，稍后剥）
  const meta = html.match(/<meta\s+name="description"\s+content="([^"]*)"/i)
  if (meta && meta[1].trim()) {
    const d = cleanDesc(meta[1])
    if (d.length >= 20) return d
  }

  // 2) 栏目类：没有 meta，从正文 div 提。
  //
  // ⚠️ 这里不能用「<div ...>...</div>」这种简单配对正则：
  //    简介正文本身可能含内层 div/span，非贪婪匹配会在第一个 </div> 就截断，
  //    结果拿到一堆残缺文本（实测"经济半小时"页就是这种情况，
  //    简介明明有 1240 字，正则只截到 177 字的导航条）。
  //
  // 正确做法：先定位「简介」标题所在位置，再从那里往后取一段大窗口，
  //          然后在窗口里找 class 含 section/desc/intro/content 的容器，
  //          直接去标签取纯文本。窗口足够大，不依赖精确配对。
  const candidates = []

  // 2a) 优先：class 含 section 的容器（实测 tvmao 栏目简介都在
  //     class="pb10 blank bg_white section" 这个容器里）
  const sectionRe = /<div[^>]*class="[^"]*\bsection\b[^"]*"[^>]*>/gi
  let sm
  while ((sm = sectionRe.exec(html))) {
    const start = sm.index + sm[0].length
    // 取 3000 字窗口，够覆盖一条简介，又不会吃进整页
    const window = html.slice(start, start + 3000)
    const txt = stripTags(window).trim()
    if (txt.length >= 30 && /[\u4e00-\u9fa5]/.test(txt)) {
      const punct = (txt.match(/[，。！？、；]/g) || []).length
      if (punct >= 2) candidates.push(txt)
    }
  }

  // 2b) 兜底：找「简介」二字之后的正文块
  if (!candidates.length) {
    const idx = html.search(/简介\s*<\/div>/)
    if (idx >= 0) {
      const window = html.slice(idx, idx + 3000)
      const txt = stripTags(window).trim()
      if (txt.length >= 30) candidates.push(txt)
    }
  }

  if (candidates.length) {
    // 取最长的那条（简介通常比导航文字长得多）
    const best = candidates.sort((a, b) => b.length - a.length)[0]
    return cleanDesc(best)
  }

  return ''
}

/** 去标签 + 反转义 + 截断 */
function stripTags(s) {
  return String(s)
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 清洗简介：剥掉"电视剧xxx剧情介绍："这类前缀，截断到合理长度 */
export function cleanDesc(s) {
  let t = stripTags(s)
  // 剥前缀：「电视剧中华古树剧情介绍：」「爱在山海间剧情介绍」
  t = t.replace(/^[^：:]{0,20}(剧情介绍|节目介绍|栏目介绍|简介)[：:]\s*/, '')
  // 剥「《xxx》剧情介绍」这种
  t = t.replace(/^《[^》]*》\s*(剧情介绍|节目介绍|简介)[：:]?\s*/, '')
  if (t.length > MAX_DESC_LEN) t = t.slice(0, MAX_DESC_LEN).replace(/[，、；]$/, '') + '…'
  return t.trim()
}

/**
 * 节目标题归一化（跨源对齐同名节目用）
 *
 * 同一个节目在不同源里写法五花八门，实测样本：
 *   epg.pw : 寰宇视野2026-299 / 生活早参考-特别节目（生活圈）2026-293 / 爱在山海间20/20
 *   tvmao  : 寰宇视野        / 生活早参考-特别节目(生活圈)2026-293 / 爱在山海间第20集
 *
 * 处理顺序很关键：
 *   1. 先做「集数归一」——"第20集" 和 "20/20" 都变 20，必须在去括号之前做
 *   2. 再去「期号尾巴」——2026-299、-2026 这类
 *   3. 最后去标点空白
 *
 * ⚠️ 注意别误删：`青春戏苑-2026-194溯光·花鼓戏` 里的 2026-194 后面还跟着内容，
 *    不是尾巴，必须保留。所以期号正则一律用 $ 锚定结尾。
 */
export function normTitle(t) {
  if (!t) return ''
  let s = String(t)
  s = s.replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  s = s.replace(/\u3000/g, ' ')
  // 集数：「第20集」→ 20；「20/20」→ 20
  s = s.replace(/第\s*(\d+)\s*集/g, '$1')
  s = s.replace(/(\d+)\s*\/\s*\d+/g, '$1')
  // 期号尾巴（必须锚定结尾）
  s = s.replace(/[-–—]\s*\d{4}\s*[-–—]\s*\d+$/, '')
  s = s.replace(/\d{4}\s*[-–—]\s*\d+$/, '')
  s = s.replace(/[-–—]\s*\d{4}$/, '')
  // 画质标注
  s = s.replace(/[（(]\s*(4K|8K|高清|HD|超清|标清)\s*[）)]/gi, '')
  // 噪声后缀
  s = s.replace(/[-–—]\s*(宣传片|预告|片花|重播|精编|片段展播)$/g, '')
  // 标点空白
  s = s.replace(/[\s\-–—_·・()（）\[\]【】]/g, '')
  return s.toLowerCase()
}

/** 读缓存 */
export function loadDescCache() {
  try {
    return JSON.parse(fs.readFileSync(PATHS.descCache, 'utf8'))
  } catch {
    return { entries: {} }
  }
}

/** 写缓存 */
export function saveDescCache(cache) {
  fs.mkdirSync(path.dirname(PATHS.descCache), { recursive: true })
  fs.writeFileSync(PATHS.descCache, JSON.stringify(cache, null, 2), 'utf8')
}

/** 该条缓存是否还有效 */
function isFresh(entry, now = Date.now()) {
  if (!entry || !entry.fetchedAt) return false
  const ttl = entry.desc ? (entry.kind === 'column' ? TTL_COLUMN : TTL_DRAMA) : TTL_FAIL
  return now - entry.fetchedAt < ttl
}

function kindOf(href) {
  return /^\/tvcolumn\//.test(href) ? 'column' : 'drama'
}

/**
 * 给一批「节目名 → 详情页路径」补简介
 *
 * @param links  Map<title, href>
 * @param opts   {concurrency, force, dryRun}
 * @returns {Map<title, desc>} 只含有简介的项
 */
export async function fetchDescs(links, opts = {}) {
  const { concurrency = 4, force = false, maxFetch = 400 } = opts
  const cache = loadDescCache()
  const now = Date.now()

  const todo = []
  const hit = new Map()

  for (const [title, href] of links) {
    const entry = cache.entries[href]
    if (!force && isFresh(entry, now)) {
      if (entry.desc) hit.set(title, entry.desc)
      continue
    }
    todo.push({ title, href })
  }

  log.info(
    `[desc] 共 ${links.size} 个节目，缓存命中 ${hit.size}，需抓取 ${todo.length}` +
      (todo.length > maxFetch ? `（本轮上限 ${maxFetch}）` : '')
  )

  const batch = todo.slice(0, maxFetch)
  let ok = 0
  let fail = 0

  await mapLimit(batch, concurrency, async ({ title, href }) => {
    let desc = ''
    try {
      const res = await fetchText(`${BASE}${href}`, {
        timeout: 20000,
        retries: 1,
        headers: { 'User-Agent': UA_MOBILE },
      })
      if (res.ok) desc = extractDesc(res.text, href)
    } catch {
      /* 网络失败，落空结果缓存 */
    }

    // ⚠️ 重抓失败时不能把原有的好简介冲掉。
    //    force 模式（DESC_FORCE=1）常用于"解析逻辑改进了，重抓一遍"，
    //    但单轮有 maxFetch 上限，且网络会偶发失败。如果无条件覆盖，
    //    会把上一轮已经抓到的有效简介写成空，覆盖率反而下降
    //    （2026-10-26 实测：force 重抓后卫视覆盖率从 51% 掉到 17%）。
    const prev = cache.entries[href]
    const keepPrev = !desc && prev && prev.desc

    cache.entries[href] = {
      desc: keepPrev ? prev.desc : desc,
      kind: kindOf(href),
      // 重抓失败但保留了旧值时，不刷新 fetchedAt，让它下轮继续重试
      fetchedAt: keepPrev ? prev.fetchedAt : now,
      title,
    }

    if (cache.entries[href].desc) {
      hit.set(title, cache.entries[href].desc)
      ok++
    } else {
      fail++
    }
  })

  saveDescCache(cache)
  log.info(`[desc] 抓取完成：成功 ${ok}，无简介/失败 ${fail}，累计可用 ${hit.size}`)
  return hit
}

/**
 * 端到端补简介：给一批频道补 <desc>
 *
 * 完整流程：
 *   1. 把目标频道对齐到 tvmao 频道（用归一化名 + 别名 + 包含匹配）
 *   2. 抓每个 tvmao 频道 7 天节目单 → 建「归一化节目名 → 详情页」索引
 *   3. 用索引把我们的每个节目标题解析成详情页
 *   4. 批量抓详情页（走持久化缓存 + 分级 TTL）
 *   5. 返回 Map<ourTitle, desc>
 *
 * @param targets  目标频道 [{id, name, aliases, group}]
 * @param catalog  源频道清单（用于找 tvmao 的 id）
 * @param epgMap   Map<tvgId, programmes[]> 已抓到的节目
 * @param opts     {concurrency, force, maxFetch, skipGroups}
 */
export async function enrichDescs(targets, catalog, epgMap, opts = {}) {
  const {
    concurrency = 4,
    force = false,
    maxFetch = 600,
    // 港澳台频道 epg.pw 自带简介，不用补
    skipGroups = ['hk', 'mo', 'tw'],
  } = opts

  // ---- 1) 目标频道 → tvmao 频道 ----
  const tvmaoChannels = catalog.filter((c) => c.source === 'tvmao')
  if (!tvmaoChannels.length) {
    log.warn('[desc] 源清单里没有 tvmao 频道，跳过')
    return new Map()
  }

  const byNorm = new Map()
  for (const c of tvmaoChannels) {
    // tvmao 的 name 形如 "CCTV-1综合节目单"，去掉尾巴
    const clean = c.name.replace(/节目单$/, '')
    const n = normalizeName(clean)
    if (!n) continue
    if (!byNorm.has(n)) byNorm.set(n, [])
    byNorm.get(n).push({ ...c, clean })
  }

  function alignOne(t) {
    const variants = new Set([
      ...nameVariants(t.name),
      ...(t.aliases || []).flatMap((a) => nameVariants(a)),
    ])
    // 精确
    for (const v of variants) {
      const list = byNorm.get(v)
      if (list && list.length) return list[0]
    }
    // 包含（长度差 ≤ 4，防错台）
    for (const [n, list] of byNorm) {
      for (const v of variants) {
        if (v.length < 3) continue
        if (n.includes(v) || v.includes(n)) {
          if (Math.abs(n.length - v.length) <= 4) return list[0]
        }
      }
    }
    return null
  }

  const pairs = []
  for (const t of targets) {
    if (skipGroups.includes(t.group)) continue
    const rows = epgMap.get(t.id)
    if (!rows || !rows.length) continue
    // 已经有大量 desc 的频道不用补
    const withDesc = rows.filter((r) => r.desc && r.desc.trim()).length
    if (withDesc / rows.length > 0.5) continue

    const hit = alignOne(t)
    if (hit) pairs.push({ target: t, tvmaoId: hit.sourceId, tvmaoName: hit.clean })
  }

  log.info(`[desc] ${pairs.length} 个频道需要补简介（已跳过港澳台和已有简介的）`)
  if (!pairs.length) return new Map()

  // ---- 2) 建 title→href 索引 ----
  // 索引缓存也持久化：一天内重复 build 不必重抓节目单
  const indexCacheFile = path.join(PATHS.cache, 'desc-index.json')
  let indexCache = {}
  try {
    indexCache = JSON.parse(fs.readFileSync(indexCacheFile, 'utf8'))
  } catch {
    indexCache = {}
  }

  const index = new Map()
  const now = Date.now()
  const INDEX_TTL = 2 * DAY

  let reused = 0
  const needFetch = []
  for (const p of pairs) {
    const c = indexCache[p.tvmaoId]
    if (!force && c && now - c.fetchedAt < INDEX_TTL) {
      for (const [k, v] of Object.entries(c.items)) {
        if (!index.has(k)) index.set(k, v)
      }
      reused++
    } else {
      needFetch.push(p)
    }
  }
  log.info(`[desc] 索引：复用 ${reused} 个频道的缓存，需抓 ${needFetch.length} 个`)

  let idxFetched = 0
  await mapLimit(needFetch, 3, async (p) => {
    const local = new Map()
    try {
      await collectChannelIndex(p.tvmaoId, local, 7)
    } catch {
      /* 忽略单频道失败 */
    }
    const items = Object.fromEntries(local)
    indexCache[p.tvmaoId] = { fetchedAt: now, name: p.tvmaoName, items }
    for (const [k, v] of local) if (!index.has(k)) index.set(k, v)
    idxFetched++
    if (idxFetched % 10 === 0) log.info(`[desc] 索引进度 ${idxFetched}/${needFetch.length}`)
  })

  fs.mkdirSync(path.dirname(indexCacheFile), { recursive: true })
  fs.writeFileSync(indexCacheFile, JSON.stringify(indexCache, null, 2), 'utf8')
  log.info(`[desc] 索引建立完成：${index.size} 个节目标题可解析`)

  // ---- 3) 我们的标题 → 详情页 ----
  const links = new Map() // ourTitle -> href
  let resolvable = 0
  for (const t of targets) {
    if (skipGroups.includes(t.group)) continue
    const rows = epgMap.get(t.id)
    if (!rows || !rows.length) continue
    for (const r of rows) {
      if (r.desc && r.desc.trim()) continue // 已有简介不覆盖
      if (links.has(r.title)) continue
      const hit = resolveHref(r.title, index)
      if (hit) {
        links.set(r.title, hit.href)
        resolvable++
      }
    }
  }
  log.info(`[desc] ${resolvable} 个节目名能解析到详情页`)

  // ---- 4) 抓详情页 ----
  const descMap = await fetchDescs(links, { concurrency, force, maxFetch })
  return descMap
}

/* ==========================================================================
 * 第二步：从 tvmao 频道页建「节目名 → 详情页」索引
 * ========================================================================== */

/** 由 tvmao 的 sourceId 推断节目单路径前缀 */
function tvmaoPrefix(sourceId) {
  if (/^CCTVPAYFEE-/i.test(sourceId)) return '/program_digital/'
  if (/^CCTV-/i.test(sourceId)) return '/program/'
  return '/program_satellite/'
}

/**
 * 抓一个 tvmao 频道的 N 天节目单，累加到 title→href 索引
 *
 * 为什么要抓 7 天而不是 1 天：
 *   节目表是按周重复的，只抓周一（w1）会漏掉只在周末播的节目
 *   （体育赛事、特别节目、周末综艺）。7 天能覆盖绝大多数栏目名。
 *
 * @param sourceId  tvmao 频道 id（如 CCTV-CCTV1 / HUNANTV1）
 * @param index     Map<normTitle, {href, raw}> 输出到这里
 * @param days      抓几天，默认 7
 */
export async function collectChannelIndex(sourceId, index, days = 7) {
  const prefix = tvmaoPrefix(sourceId)
  let added = 0

  for (let w = 1; w <= days; w++) {
    let html = ''
    try {
      const res = await fetchText(`${BASE}${prefix}${sourceId}-w${w}.html`, {
        timeout: 20000,
        retries: 1,
        headers: { 'User-Agent': UA_MOBILE },
      })
      if (!res.ok) continue
      html = res.text
    } catch {
      continue
    }

    const links = extractProgrammeLinks(html)
    for (const [title, href] of links) {
      const n = normTitle(title)
      if (!n) continue
      if (index.has(n)) continue
      index.set(n, { href, raw: title })
      added++
    }
  }

  return added
}

/**
 * 给我们的节目标题找 tvmao 详情页
 *
 * 两级策略：
 *   1. 归一化后完全相等 —— 最可信
 *   2. 前缀包含：我们的标题归一化后以 tvmao 标题开头，且长度差 ≤ 8
 *      例：我们「青春戏苑2026194溯光花鼓戏」，tvmao「青春戏苑」→ 命中
 *      但长度差限制很重要，否则「新闻」会把「新闻联播」「新闻30分」全吸进来
 *
 * @param ourTitle 我们 XML 里的标题
 * @param index    collectChannelIndex 建好的索引
 */
export function resolveHref(ourTitle, index) {
  const n = normTitle(ourTitle)
  if (!n) return null
  const exact = index.get(n)
  if (exact) return exact

  // 前缀匹配：找最长的那个前缀，避免"新闻"抢走"新闻联播"
  let best = null
  let bestLen = 0
  for (const [key, val] of index) {
    if (key.length < 3) continue
    if (!n.startsWith(key)) continue
    const diff = n.length - key.length
    if (diff > 8) continue
    if (key.length > bestLen) {
      best = val
      bestLen = key.length
    }
  }
  return best
}
