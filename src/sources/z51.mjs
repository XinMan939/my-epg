/**
 * 老张的 EPG（51zmt）节目简介源
 *
 * 为什么要有这个模块：
 *   我们主源 epg.pw 的 <desc> 只覆盖港澳台（TW 41% / HK 74%），大陆频道 0 条；
 *   电视猫（tvmao）能补一部分，但要逐频道抓 7 天节目单 + 逐条抓详情页，
 *   速度慢、有反爬风险，且只对「被 tvmao 收录成词条」的节目有效。
 *
 *   而老张的 e1/e2 两个包本身就带 <desc>，一次整包下载（1.5MB + 0.7MB，实测 2.5 秒），
 *   大陆央视/卫视/地方台的真实简介覆盖率 60~100%。这是目前性价比最高的简介来源。
 *
 * 实测数据（2026-10-27）：
 *   包                    频道   节目    带 desc   去占位后真实
 *   51zmt e.xml.gz        100    7374    0        0%
 *   51zmt e1.xml.gz       287   17287   17239     74.1%
 *   51zmt e2.xml.gz       223   12781   12709     62.9%
 *
 * ⚠️ 关键陷阱：「有 <desc>」≠「有简介」。
 *    e1 里 74% 的 desc 是「暂无节目描述」「此阶段播放精彩电视剧内容」这类占位文本，
 *    如果不做过滤，统计覆盖率会虚高到 99.7%，但用户看到的全是废话。
 *    所以一律过 isRealDesc() 判定。
 *
 * 频道对齐不用「按名字猜」：
 *    名字匹配在港台频道上会串台（台視新聞 → 台視、華視新聞 → 華視），
 *    这里改用「节目标题交集」自动推导：拿我们某个频道全部归一化标题，
 *    去每个 51zmt 频道里数命中数，命中最多且占比够高的那个才是同一个频道。
 *    实测 114 个频道里 80 个能这样强映射，剩下的是「上游确实没这个台」。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { PATHS, ensureCacheDir } from '../config.mjs'
import { fetchBuffer, log, toSimplified, isRealDesc } from '../utils.mjs'

const DAY = 24 * 3600 * 1000

/** 缓存有效期：老张每天 07:10 更新，这里 6 小时刷一次足够 */
const TTL = 6 * 3600 * 1000

/** e1 国内（央视/卫视/数字/部分省级）、e2 海外（港澳台/国际） */
const PACKS = [
  { key: 'e1', url: 'http://epg.51zmt.top:8000/e1.xml.gz' },
  { key: 'e2', url: 'http://epg.51zmt.top:8000/e2.xml.gz' },
]


/**
 * 节目名归一化（跨源对齐用）
 *
 * 与 desc.mjs 的 normTitle 刻意分开，因为这边对「括号」的处理更激进：
 *   51zmt : 国际足球赛场-26-27赛季英超联赛第5轮 纽卡斯尔联-赫尔城(4K)
 *   epg.pw: 国际足球赛场-26-27赛季英超联赛第5轮 纽卡斯尔联—赫尔城（4K）
 *   全角/半角、破折号长短、括号形式全都不一样，只保留汉字和数字最稳。
 */
export function normTitleLoose(s) {
  if (!s) return ''
  let x = toSimplified(String(s))
  x = x.replace(/&amp;/g, '&').replace(/&nbsp;/g, ' ')
  // 全角 → 半角
  x = x.replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  // 去掉所有括号及其内容（含嵌套的《》）
  x = x.replace(/[（(][^（()）]*[）)]/g, '')
  x = x.replace(/《[^》]*》/g, '')
  // 期号尾巴：-2026-299 / 2026-299 / -2026
  x = x.replace(/[-–—]\s*\d{4}\s*[-–—]\s*\d+$/, '')
  x = x.replace(/\d{4}\s*[-–—]\s*\d+$/, '')
  x = x.replace(/[-–—]\s*\d{4}$/, '')
  // 裸集数尾巴
  x = x.replace(/(?<=[\u4e00-\u9fa5]{2,})\d{1,3}$/, '')
  // 只留汉字、数字、字母
  x = x.replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '')
  return x.toLowerCase()
}

/** 缓存文件路径 */
function cachePath(key) {
  return path.join(PATHS.cache, `z51_${key}.xml`)
}

function isFresh(p) {
  try {
    return Date.now() - fs.statSync(p).mtimeMs < TTL
  } catch {
    return false
  }
}

/** 同 region 并发去重（踩过 epg.pw 的坑：多请求同时写同一文件 → 读到半成品） */
const inflight = new Map()

async function ensurePack(key, url, { force = false } = {}) {
  ensureCacheDir()
  const out = cachePath(key)
  if (!force && isFresh(out)) return out
  if (inflight.has(key)) return inflight.get(key)

  const task = (async () => {
    log.info(`[z51] 下载 ${key} ...`)
    const { ok, buf, error } = await fetchBuffer(url, { timeout: 120000, fetchTimeout: 45000, retries: 2 })
    if (!ok || !buf || buf.length < 1024) throw new Error(`下载失败: ${error || 'empty'}`)

    let xml
    if (buf[0] === 0x1f && buf[1] === 0x8b) {
      xml = zlib.gunzipSync(buf).toString('utf8')
    } else {
      xml = buf.toString('utf8')
    }
    if (!xml.includes('<tv')) throw new Error('内容不是合法 XMLTV')

    // 先写临时文件再 rename，保证任何时刻读到的都是完整文件
    const tmp = `${out}.tmp`
    fs.writeFileSync(tmp, xml, 'utf8')
    fs.renameSync(tmp, out)
    log.ok(`[z51] ${key} 就绪 ${(xml.length / 1024 / 1024).toFixed(1)} MB`)
    return out
  })()

  inflight.set(key, task)
  try {
    return await task
  } finally {
    inflight.delete(key)
  }
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

/**
 * 解析一个包
 * @returns {{channels: Map<key,{file,id,name,titles:Set,descMap:Map,programmes:[]}>, programmeCount:number, descCount:number}}
 */
function parsePack(xml, key) {
  const channels = new Map()
  let programmeCount = 0
  let descCount = 0

  const chRe = /<channel\s+([^>]*)>([\s\S]*?)<\/channel>/g
  let m
  while ((m = chRe.exec(xml))) {
    const id = (m[1].match(/id="([^"]*)"/) || [])[1]
    if (!id) continue
    const nm = (m[2].match(/<display-name[^>]*>([\s\S]*?)<\/display-name>/) || [])[1]
    channels.set(`${key}:${id}`, {
      file: key,
      id,
      name: decodeEntities(nm || id).trim(),
      titles: new Set(),
      descMap: new Map(),
      programmes: [],
    })
  }

  const prRe = /<programme\s+([^>]*)>([\s\S]*?)<\/programme>/g
  while ((m = prRe.exec(xml))) {
    const channel = (m[1].match(/channel="([^"]*)"/) || [])[1]
    if (!channel) continue
    const start = (m[1].match(/start="([^"]*)"/) || [])[1]
    const stop = (m[1].match(/stop="([^"]*)"/) || [])[1]
    const inner = m[2]
    const title = decodeEntities((inner.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || '').trim()
    const desc = decodeEntities((inner.match(/<desc[^>]*>([\s\S]*?)<\/desc>/) || [])[1] || '')
      .replace(/\s+/g, ' ')
      .trim()
    if (!title) continue
    programmeCount++

    const ck = `${key}:${channel}`
    if (!channels.has(ck)) {
      channels.set(ck, {
        file: key,
        id: channel,
        name: channel,
        titles: new Set(),
        descMap: new Map(),
        programmes: [],
      })
    }
    const o = channels.get(ck)
    const nt = normTitleLoose(title)
    if (nt) {
      o.titles.add(nt)
      if (isRealDesc(desc) && !o.descMap.has(nt)) o.descMap.set(nt, desc)
    }
    if (isRealDesc(desc)) descCount++

    // 完整节目（补空频道节目单用）
    const startTs = parseZ51Time(start)
    if (startTs) {
      o.programmes.push({
        startTs,
        stopTs: stop ? parseZ51Time(stop) : null,
        title,
        desc,
        category: '',
      })
    }
  }

  return { channels, programmeCount, descCount }
}

/** 解析 "20261026010300 +0800" → 毫秒时间戳 */
export function parseZ51Time(s) {
  if (!s) return null
  const m = String(s).trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*([+-]\d{4})?/)
  if (!m) return null
  const [, y, mo, d, hh, mi = '00', ss = '00', off = '+0800'] = m
  const ts = Date.parse(`${y}-${mo}-${d}T${hh}:${mi}:${ss}${off.slice(0, 3)}:${off.slice(3)}`)
  return Number.isNaN(ts) ? null : ts
}

/** 解析后的内存缓存（一次 build 只解析一遍） */
let memo = null

/**
 * 拿到所有包的解析结果
 * @returns {{byKey: Map<string,{file,id,name,titles:Set,descMap:Map}>, stats: object[]}}
 */
export async function loadPacks({ force = false } = {}) {
  if (memo && !force) return memo

  const byKey = new Map()
  const stats = []

  for (const p of PACKS) {
    let file
    try {
      file = await ensurePack(p.key, p.url, { force })
    } catch (e) {
      log.warn(`[z51] ${p.key} 不可用: ${e.message}`)
      stats.push({ key: p.key, ok: false, error: e.message })
      continue
    }

    const xml = fs.readFileSync(file, 'utf8')
    const { channels, programmeCount, descCount } = parsePack(xml, p.key)
    for (const [k, v] of channels) byKey.set(k, v)
    log.ok(
      `[z51] ${p.key}: ${channels.size} 频道 / ${programmeCount} 节目 / 真实简介 ${descCount}` +
        ` (${((descCount / programmeCount) * 100).toFixed(1)}%)`
    )
    stats.push({ key: p.key, ok: true, channels: channels.size, programmes: programmeCount, descs: descCount })
  }

  memo = { byKey, stats }
  return memo
}

/**
 * 用「节目标题交集」给每个目标频道找它在 51zmt 里的对应频道
 *
 * 为什么不用名字匹配：
 *   名字匹配在港台频道上必然串台——
 *   「台視新聞」会被吸到「台視」、「華視新聞」吸到「華視」、
 *   「中天新聞」吸到「中天綜合台」，而它们的节目单完全不同。
 *   标题交集是内容级的证据，串不了台。
 *
 * 阈值（实测调出来的）：
 *   - 交集 ≥ 5 条，且占我们该频道标题数的 ≥ 15%
 *   低于这个就当没有对应，宁可漏补也不乱补。
 *
 * @param targets  目标频道
 * @param titlesByChannel  Map<tvgId, Set<normTitleLoose>>
 * @returns Map<tvgId, {key, name, inter, rate, descCount}>
 */
export function alignByTitles(targets, titlesByChannel, byKey) {
  const out = new Map()
  const detail = []

  for (const t of targets) {
    const mine = titlesByChannel.get(t.id)
    if (!mine || !mine.size) continue

    let best = null
    for (const [key, o] of byKey) {
      if (!o.titles.size) continue
      let inter = 0
      for (const nt of mine) if (o.titles.has(nt)) inter++
      if (inter < 2) continue
      const rate = inter / mine.size
      // 择优：先看交集条数，条数相同看覆盖率
      if (!best || inter > best.inter || (inter === best.inter && rate > best.rate)) {
        best = { key, name: o.name, inter, rate }
      }
    }

    if (!best) {
      detail.push({ id: t.id, name: t.name, status: 'none', mine: mine.size })
      continue
    }

    const strong = best.inter >= 5 && best.rate >= 0.15
    if (!strong) {
      detail.push({ id: t.id, name: t.name, status: 'weak', mine: mine.size, ...best })
      continue
    }

    const o = byKey.get(best.key)
    out.set(t.id, { ...best, descCount: o.descMap.size })
    detail.push({ id: t.id, name: t.name, status: 'ok', mine: mine.size, ...best })
  }

  log.info(
    `[z51] 频道对齐：${out.size} 个命中 / ${targets.length} 个目标` +
      `（弱匹配 ${detail.filter((d) => d.status === 'weak').length}，无对应 ${detail.filter((d) => d.status === 'none').length}）`
  )
  return { aligned: out, detail }
}

/**
 * 建全局标题索引（跨频道）
 *
 * 为什么要它：
 *   频道级对齐（alignByTitles）依赖「整台节目单能对上」，
 *   但很多台对不上——不是同一个台，只是**有大量相同节目**：
 *   内蒙古卫视/天津卫视/吉林卫视的 rate 只有 12~22%，
 *   却各自有 113~140 条节目能在 51zmt 的某个台里找到同名简介。
 *   这些如果只做频道级对齐就全浪费了。
 *
 * 安全规则（关键，不然会串台）：
 *   同一个标题在多个 51zmt 频道出现时，desc 可能完全不同——
 *   实测「晚间新闻」有 8 种写法：CCTV-1 的品牌栏目、江苏卫视的本省要闻、
 *   云南卫视的「云南新闻展现全方位云南」……直接按标题取就会张冠李戴。
 *
 *   所以只接受两类：
 *     ① 该标题在整个 51zmt 里只出现一次（6104/6562，占 93%）→ 无可争议
 *     ② 出现多次但 desc 完全一致（348/458）→ 说明是通用栏目（天气预报这类）
 *   剩下 110 个 desc 冲突的标题一律跳过，宁缺毋滥。
 */
function buildGlobalIndex(byKey) {
  const raw = new Map()
  for (const [, o] of byKey) {
    for (const [nt, d] of o.descMap) {
      if (!raw.has(nt)) raw.set(nt, [])
      raw.get(nt).push({ desc: d, channel: o.name })
    }
  }

  const index = new Map()
  let skipped = 0
  for (const [nt, list] of raw) {
    const uniq = new Set(list.map((x) => x.desc))
    if (uniq.size === 1) {
      index.set(nt, { desc: list[0].desc, channels: list.map((x) => x.channel), fromGlobal: true })
    } else {
      skipped++
    }
  }
  log.info(`[z51] 全局索引：${index.size} 个可用标题（跳过 ${skipped} 个 desc 冲突的）`)
  return index
}

/**
 * 端到端：给已抓到的节目补简介
 *
 * 两级策略，先频道级再全局级：
 *   ① 频道级（alignByTitles 命中的台）—— 同一个台的简介最可信，优先用
 *   ② 全局级（跨频道标题索引）—— 补那些「整台对不上但节目名对得上」的残余
 *
 * @param targets   目标频道
 * @param epgMap    Map<tvgId, programmes[]>
 * @param opts      {force}
 * @returns {stats, detail, report}
 */
export async function enrichFromZ51(targets, epgMap, opts = {}) {
  const { force = false, titleMap = {} } = opts

  const { byKey } = await loadPacks({ force })
  if (!byKey.size) {
    log.warn('[z51] 没有可用数据包，跳过')
    return { stats: new Map(), detail: [], report: [] }
  }

  // 建「我们每个频道的归一化标题集合」
  const titlesByChannel = new Map()
  for (const t of targets) {
    const rows = epgMap.get(t.id)
    if (!rows || !rows.length) continue
    const s = new Set()
    for (const r of rows) {
      const nt = normTitleLoose(r.title)
      if (nt) s.add(nt)
    }
    if (s.size) titlesByChannel.set(t.id, s)
  }

  const { aligned, detail } = alignByTitles(targets, titlesByChannel, byKey)

  // ① 频道级补
  const stats = new Map()
  let totalFilled = 0
  for (const [id, a] of aligned) {
    const rows = epgMap.get(id)
    if (!rows || !rows.length) continue
    const o = byKey.get(a.key)
    if (!o || !o.descMap.size) continue

    let filled = 0
    let before = 0
    for (const r of rows) {
      if (isRealDesc(r.desc)) {
        before++
        continue
      }
      const nt = normTitleLoose(r.title)
      if (!nt) continue
      const d = o.descMap.get(nt)
      if (d) {
        r.desc = d
        filled++
      }
    }
    if (filled) {
      totalFilled += filled
      stats.set(id, { filled, before, stage: 'channel', source: `${a.key}(${a.name})`, inter: a.inter, rate: a.rate })
    }
  }
  const stage1 = totalFilled
  log.info(`[z51] ① 频道级补 ${stage1} 条`)

  // ② 全局级补残余
  const globalIndex = buildGlobalIndex(byKey)
  let stage2 = 0
  let stage2Channels = 0
  for (const t of targets) {
    const rows = epgMap.get(t.id)
    if (!rows || !rows.length) continue
    let filled = 0
    for (const r of rows) {
      if (isRealDesc(r.desc)) continue
      const nt = normTitleLoose(r.title)
      if (!nt) continue
      const g = globalIndex.get(nt)
      if (g) {
        r.desc = g.desc
        filled++
      }
    }
    if (!filled) continue
    stage2 += filled
    stage2Channels++
    const prev = stats.get(t.id)
    if (prev) {
      prev.filled += filled
      prev.stage = 'channel+global'
    } else {
      stats.set(t.id, { filled, before: 0, stage: 'global', source: '全局索引' })
    }
  }
  totalFilled = stage1 + stage2
  log.ok(`[z51] ② 全局级补 ${stage2} 条（${stage2Channels} 个频道）`)

  // ③ 手工标题映射（最后兜底，专治「标题不是中文」）
  //
  // 为什么前两步救不了：
  //   ①② 全靠「标题文本相等」找简介，但有一类频道标题压根不是中文——
  //   · 港台电视35 转播 CGTN，标题是 The World Today / Dialogue / Africa Live；
  //   · 延边卫视大量节目标题是朝鲜语（드라마 / 일기예보）。
  //   这些在中文索引里永远命中不了，不管对齐算法多好。
  //
  //   而 51zmt 的 e1:20（CGTN）标题恰好就是中文译名（今日世界 / 对话 / 非洲直播室），
  //   且带真实简介 —— 缺的只是一张「英文/朝鲜语 → 中文」对照表。
  //
  // 安全边界：只对 channels/overrides.json 里显式声明 titleMap 的频道生效，
  //   不做任何模糊匹配。理由见 buildGlobalIndex 的注释——
  //   「对话」在 CCTV-2 和 CGTN 是两个完全不同的栏目，自动匹配必串台。
  let stage3 = 0
  if (titleMap && Object.keys(titleMap).length) {
    const gIndex = buildGlobalIndex(byKey)
    for (const t of targets) {
      const map = titleMap[t.id]
      if (!map || !map.titles) continue
      const rows = epgMap.get(t.id)
      if (!rows || !rows.length) continue

      // 目标库：overrides 里指定从哪个 51zmt 频道取简介，没写就用全局索引
      const srcKey = map.from || ''
      const srcObj = srcKey ? byKey.get(srcKey) : null

      let filled = 0
      for (const r of rows) {
        if (isRealDesc(r.desc)) continue
        const zh = map.titles[r.title]
        if (!zh) continue
        const nt = normTitleLoose(zh)
        if (!nt) continue
        const d = srcObj ? srcObj.descMap.get(nt) : (gIndex.get(nt) || {}).desc
        if (!d || !isRealDesc(d)) continue
        r.desc = d
        filled++
      }
      if (!filled) continue
      stage3 += filled
      const prev = stats.get(t.id)
      if (prev) {
        prev.filled += filled
        prev.stage += '+titleMap'
      } else {
        stats.set(t.id, { filled, before: 0, stage: 'titleMap', source: srcKey || '全局索引' })
      }
    }
    if (stage3) log.ok(`[z51] ③ 手工标题映射补 ${stage3} 条`)
    else log.info('[z51] ③ 手工标题映射没补到任何条目')
  }
  totalFilled = stage1 + stage2 + stage3
  log.ok(`[z51] 补简介完成：${stats.size} 个频道，共 ${totalFilled} 条`)

  return { stats, detail, report: (await loadPacks()).stats, stage1, stage2, stage3 }
}

/** 清空内存缓存（测试用） */
export function resetMemo() {
  memo = null
}

/**
 * 给「主源完全抓空」的频道补节目单
 *
 * 为什么需要：epg.pw 缺 16 个大陆地方台（浙江/湖南/江苏系列），
 * 而 51zmt 的 e1 里恰恰有这些台（浙江经视 111 条、浙江少儿 48 条、
 * 湖南电视剧 28 条…），且全部带真实简介。
 *
 * 对齐方式和补简介不同：
 *   空频道没有节目标题可做交集，只能退回「按频道名匹配」。
 *   这里用严格的归一化名相等 + 手工别名，宁可漏也不串台。
 *
 * @returns {Map<tvgId, {programmes, sourceKey, sourceName}>}
 */
export function fillEmptyChannels(targets, epgMap, byKey, opts = {}) {
  const { maxDays = 7, overrides = {} } = opts
  const out = new Map()

  // 51zmt 频道名 → key 索引
  const byName = new Map()
  for (const [key, o] of byKey) {
    if (!o.programmes.length) continue
    const n = normalizeZ51Name(o.name)
    if (!n) continue
    if (!byName.has(n)) byName.set(n, [])
    byName.get(n).push({ key, ...o })
  }

  for (const t of targets) {
    const rows = epgMap.get(t.id)
    if (rows && rows.length) continue // 已有节目，不动

    let best = null

    // ① 手工指定优先：overrides 里写 "z51SourceId": "e1:349"
    //    用于「台名对不上但是同一个台」的情况，比如
    //    江苏公共·新闻频道 在 51zmt 里叫「江苏新闻」，纯靠名字匹配永远命中不了。
    const ov = overrides[t.id]
    if (ov && ov.z51SourceId) {
      best = byKey.get(ov.z51SourceId) || null
    }

    // ② 按频道名匹配（严格归一化相等）
    if (!best) {
      const variants = new Set()
      for (const v of [t.name, ...(t.aliases || [])]) {
        const n = normalizeZ51Name(v)
        if (n) variants.add(n)
      }
      for (const v of variants) {
        const list = byName.get(v)
        if (!list) continue
        for (const c of list) {
          if (!best || c.programmes.length > best.programmes.length) best = c
        }
      }
    }
    if (!best || !best.programmes?.length) continue

    const sorted = [...best.programmes].sort((a, b) => a.startTs - b.startTs)
    out.set(t.id, {
      programmes: sorted,
      sourceKey: best.file ? `${best.file}:${best.id}` : best.key,
      sourceName: best.name,
      count: sorted.length,
    })
  }

  if (out.size) {
    log.ok(`[z51] 补节目单：${out.size} 个空频道 → ${[...out.keys()].join(', ')}`)
  }
  return out
}

/** 51zmt 频道名归一化（比 normTitleLoose 更严格，用于频道级匹配） */
function normalizeZ51Name(s) {
  if (!s) return ''
  let x = toSimplified(String(s))
  x = x.replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  // 去掉常见后缀
  x = x.replace(/[（(][^）)]*[）)]/g, '')
  x = x.replace(/(高清|超清|标清|HD|频道|节目单)$/gi, '')
  x = x.replace(/[^\u4e00-\u9fa5a-z0-9]/gi, '')
  return x.toLowerCase()
}
