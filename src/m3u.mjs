/**
 * m3u 直播源对齐
 *
 * 为什么需要这个模块：
 *   本项目输出的 channel id 是 iptv-org 规范（CCTV1.cn / ZhejiangSatelliteTV.cn），
 *   但绝大多数人自己抓的直播源用的是**裸名**（tvg-id="CCTV1" / tvg-id="浙江卫视"）。
 *   两边 id 不同 → 播放器挂不上节目单。
 *
 *   实测用户 iptv-api 产出的 result.m3u：
 *     - 4376 条节目源，去重 318 个唯一 tvg-id
 *     - 全部是中文裸名或简写（CCTV1 / CCTV5+ / 浙江卫视 / TVB翡翠）
 *     - 与我们 114 个频道按「id 完全相等」匹配 = 0 个
 *     - 按「去国家后缀 + display-name 归一化」匹配 = 93 个（29%）
 *
 *   所以必须生成一张显式映射表，并把 EPG 的 channel id 改写成 m3u 的 tvg-id。
 *
 * 匹配保守原则（宁可漏，不可串台）：
 *   ① tvg-id 与我们 id 完全相等 → 直接接受
 *   ② 我们 id 去掉 .cn/.hk/.tw/.mo 后与 tvg-id 相等 → 接受
 *   ③ 我方任一名字/别名与 m3u 的 tvg-name 归一化后相等，且该名字在 m3u 里**唯一** → 接受
 *   ④ 宽松归一化（繁→简 + 去台标前缀 + 去「卫视/电视/频道/台」）后相等，
 *      且该名在 m3u 侧与**我方侧**都唯一 → 接受（治 TVB翡翠 vs 翡翠台 这类）
 *   ⑤ 归一化名字撞车（多个 m3u 频道同名）→ 跳过，留给人工
 * 剩下对不上的写进报告的 unmatched，由人决定要不要手工补。
 */
import fs from 'node:fs'
import { log, toSimplified } from './utils.mjs'

/** 频道名归一化：繁→简 + 去空格/括号内容/清晰度后缀/标点，只留汉字数字字母和 + */
export function normName(s) {
  if (!s) return ''
  // 港台频道名大量是繁体（翡翠台/無綫新聞台/三立台灣台），m3u 侧是简体，
  // 不做繁简统一，这批频道永远匹配不上——实测这是最大的假性缺口来源。
  let x = toSimplified(String(s)).toLowerCase()
  x = x.replace(/\s+/g, '')
  // 去掉（高清）（普）（209）这类括号内容
  x = x.replace(/[（(][^（()）]*[）)]/g, '')
  // 去掉清晰度/画质后缀
  x = x.replace(/(高清|超清|标清|蓝光|uhd|fhd|hd|sd|4k|8k|超|高码)/g, '')
  return x.replace(/[^\u4e00-\u9fa5a-z0-9+]/g, '')
}

/**
 * 宽松归一化：在 normName 基础上再去掉「台标前缀」和「频道性质后缀」。
 *
 * 治的是这类同台异名（左边我们、右边 m3u）：
 *   翡翠台        vs TVB翡翠
 *   明珠台        vs TVB明珠
 *   無綫新聞台    vs TVB无线新闻
 *   鳳凰衛視香港台 vs 凤凰香港
 *   鳳凰衛視中文台 vs 凤凰中文
 *   三立台灣台    vs 三立台湾
 *
 * 因为放宽了，必须靠「两侧都唯一」来兜底，否则会串台。
 */
export function normNameLoose(s) {
  let x = normName(s)
  if (!x) return ''
  // 去频道性质词（卫视/电视/频道）
  x = x.replace(/卫视|电视|频道/g, '')
  // 去台标前缀 TVB / CCTV，但要求剩下部分含汉字，避免 TVBS → s、CCTV5+ → 5+ 这种荒谬结果。
  // 注意：只剥 tvb/cctv，不剥「无线」——否则 无线新闻台 会一路塌成「新闻」，太宽。
  // 无线新闻台 靠「去尾部台」就能变成 无线新闻，正好对上 m3u 的 TVB无线新闻。
  const p = x.replace(/^(tvb|cctv)/, '')
  if (p !== x && /[\u4e00-\u9fa5]/.test(p)) x = p
  // 去尾部「台」：翡翠台 → 翡翠、凤凰香港台 → 凤凰香港
  x = x.replace(/台$/, '')
  return x
}

/** 去掉 iptv-org 的国家/地区后缀：CCTV1.cn → CCTV1 */
export function stripCountrySuffix(id) {
  return String(id || '').replace(/\.(cn|hk|tw|mo|jp|kr|us|uk|sg|my)$/i, '')
}

/**
 * 解析 m3u（支持 #EXTINF 带 tvg-id / tvg-name / group-title）
 * @returns {{items: Array<{tvgId:string,name:string,group:string,url:string}>, byId: Map, byName: Map, total:number}}
 */
export function parseM3u(text) {
  const items = []
  const lines = String(text || '').split(/\r?\n/)
  let cur = null
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#EXTINF')) {
      const attr = line.slice(0, line.lastIndexOf(','))
      const name = line.slice(line.lastIndexOf(',') + 1).trim()
      cur = {
        tvgId: (attr.match(/tvg-id="([^"]*)"/) || [])[1] || '',
        tvgName: (attr.match(/tvg-name="([^"]*)"/) || [])[1] || '',
        group: (attr.match(/group-title="([^"]*)"/) || [])[1] || '',
        name,
        url: '',
      }
      continue
    }
    if (line.startsWith('#')) continue
    if (cur) {
      cur.url = line
      items.push(cur)
      cur = null
    }
  }

  // tvg-id 去重，保留出现次数（用于判断哪个源更主流）
  const byId = new Map()
  for (const it of items) {
    const id = (it.tvgId || '').trim()
    if (!id) continue
    if (!byId.has(id)) byId.set(id, { ...it, id, count: 0 })
    byId.get(id).count++
  }

  // 名字索引：一个归一化名可能对应多个 tvg-id → 记下来，匹配时要求唯一
  const byName = new Map()
  const byLoose = new Map() // 宽松名索引，只在 ③ 落空时才用
  for (const [id, v] of byId) {
    for (const nm of [v.tvgName, v.name]) {
      const k = normName(nm)
      if (!k) continue
      if (!byName.has(k)) byName.set(k, new Set())
      byName.get(k).add(id)

      const kl = normNameLoose(nm)
      if (kl.length < 2) continue
      if (!byLoose.has(kl)) byLoose.set(kl, new Set())
      byLoose.get(kl).add(id)
    }
  }

  log.info(
    `[m3u] 解析 ${items.length} 条 / 去重 ${byId.size} 个 tvg-id / ` +
      `名字索引 ${byName.size} / 宽松索引 ${byLoose.size}`
  )
  return { items, byId, byName, byLoose, total: items.length }
}

/**
 * 把我们的频道映射到 m3u 的 tvg-id
 *
 * @param channels  channels.json 里的频道（id/name/aliases）
 * @param parsed    parseM3u 的返回值
 * @param manual    手工映射表 { 我们的id: m3u的tvg-id }，优先级最高
 * @returns {{mapping: Object, detail: Array, stats: Object}}
 */
export function alignToM3u(channels, parsed, manual = {}) {
  const { byId, byName, byLoose = new Map() } = parsed
  const mapping = {} // 我们的 id → m3u tvg-id
  const detail = []
  const usedM3uIds = new Set()

  // 我方侧的宽松名 → 我方频道集合。
  // 用途：宽松匹配必须「两侧都唯一」才算数，否则 湖南卫视/湖南国际 都塌成 湖南 就会串台。
  const ourLoose = new Map()
  for (const c of channels) {
    for (const nm of [c.name, ...(c.aliases || [])]) {
      const k = normNameLoose(nm)
      if (k.length < 2) continue
      if (!ourLoose.has(k)) ourLoose.set(k, new Set())
      ourLoose.get(k).add(c.id)
    }
  }

  // 先落手工映射，避免自动逻辑抢走
  for (const c of channels) {
    const m = manual[c.id]
    if (m && byId.has(m)) {
      mapping[c.id] = m
      usedM3uIds.add(m)
      detail.push({ epgId: c.id, epgName: c.name, m3uId: m, how: 'manual' })
    }
  }

  for (const c of channels) {
    if (mapping[c.id]) continue

    let hit = null
    let how = ''

    // ① id 完全相等
    if (byId.has(c.id)) {
      hit = c.id
      how = 'id-exact'
    }

    // ② 去掉国家后缀后相等
    if (!hit) {
      const k = stripCountrySuffix(c.id)
      if (byId.has(k)) {
        hit = k
        how = 'id-stripped'
      }
    }

    // ③ 名字/别名归一化相等，且该名在 m3u 里唯一
    if (!hit) {
      const cands = [c.name, ...(c.aliases || [])]
      for (const nm of cands) {
        const k = normName(nm)
        if (!k) continue
        const set = byName.get(k)
        if (set && set.size === 1) {
          const id = [...set][0]
          if (!usedM3uIds.has(id)) {
            hit = id
            how = 'name-unique'
            break
          }
        }
      }
    }

    // ④ 宽松归一化后相等，且 m3u 侧与我方侧都唯一
    if (!hit) {
      const cands = [c.name, ...(c.aliases || [])]
      for (const nm of cands) {
        const k = normNameLoose(nm)
        if (k.length < 2) continue
        const set = byLoose.get(k)
        if (!set || set.size !== 1) continue
        // 我方侧也必须是「一个名字只对应一个频道」，否则这个 key 太泛，宁可不匹配
        if (!ourLoose.get(k) || ourLoose.get(k).size !== 1) continue
        const id = [...set][0]
        if (!usedM3uIds.has(id)) {
          hit = id
          how = 'name-loose'
          break
        }
      }
    }

    if (hit) {
      mapping[c.id] = hit
      usedM3uIds.add(hit)
      detail.push({ epgId: c.id, epgName: c.name, m3uId: hit, how })
    }
  }

  const matched = Object.keys(mapping).length
  const stats = {
    epgChannels: channels.length,
    m3uIds: byId.size,
    matched,
    matchedWithEpg: channels.filter((c) => mapping[c.id] && c.hasEpg).length,
    m3uCovered: usedM3uIds.size,
    m3uCoverage: +(usedM3uIds.size / byId.size * 100).toFixed(1),
  }

  log.info(
    `[m3u] 对齐：我们 ${matched}/${channels.length} 个频道能对上 m3u；` +
      `覆盖 m3u ${usedM3uIds.size}/${byId.size} 个 tvg-id（${stats.m3uCoverage}%）`
  )

  return { mapping, detail, stats }
}

/** 读出 m3u 里我们完全没覆盖的频道（按分组归拢），给人工补频道用 */
export function listUnmatched(parsed, mapping) {
  const used = new Set(Object.values(mapping))
  const byGroup = new Map()
  const out = []
  for (const [id, v] of parsed.byId) {
    if (used.has(id)) continue
    out.push({ id, name: v.tvgName || v.name, group: v.group, count: v.count })
    const g = v.group || '(无分组)'
    if (!byGroup.has(g)) byGroup.set(g, [])
    byGroup.get(g).push(v.tvgName || v.name)
  }
  return { list: out, byGroup }
}

export function readM3uFile(p) {
  const text = fs.readFileSync(p, 'utf8')
  return parseM3u(text)
}
