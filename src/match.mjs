/**
 * 频道匹配：把目标频道（tvg-id + 名称 + 别名）对齐到各数据源的 sourceId
 *
 * 三级匹配策略（命中即止，逐级放宽）：
 *   1. 精确名（归一化后完全相等）
 *   2. 别名（用户配置的 aliases，或自动生成的名字变体）
 *   3. 包含匹配（目标名是源名的子串，或反之；长度差 ≤ 4 才接受）
 *
 * 匹配结果写入 channels/match-cache.json，人工可审查、可手工修正（overrides.json 优先级最高）。
 * 不追求 100% 自动命中——宁可留空，也不要把"东方卫视"错配到"东方电影台"。
 */
import { normalizeName, nameVariants, log } from './utils.mjs'
import { loadOverrides, saveJson, PATHS } from './config.mjs'

/**
 * @param targets  目标频道 [{id, name, aliases, country}]
 * @param catalog  源频道清单 [{source, sourceId, name, group, region}]
 * @returns {Map<tvgId, {source, sourceId, sourceName, confidence}>}
 */
export function matchChannels(targets, catalog) {
  const overrides = loadOverrides()

  // 预处理源清单：归一化名 → 候选
  const byNorm = new Map() // norm -> [cand]
  const cands = catalog.map((c) => {
    const norm = normalizeName(c.name)
    return { ...c, norm, variants: nameVariants(c.name) }
  })
  for (const c of cands) {
    if (!c.norm) continue
    if (!byNorm.has(c.norm)) byNorm.set(c.norm, [])
    byNorm.get(c.norm).push(c)
  }

  const result = new Map()
  const stats = { override: 0, exact: 0, alias: 0, contains: 0, miss: 0 }

  for (const t of targets) {
    // 0) 手工指定优先
    const ov = overrides[t.id]
    if (ov && ov.source && ov.sourceId) {
      const hit = cands.find((c) => c.source === ov.source && String(c.sourceId) === String(ov.sourceId))
      if (hit) {
        result.set(t.id, {
          source: hit.source,
          sourceId: String(hit.sourceId),
          sourceName: hit.name,
          region: hit.region,
          logo: hit.logo || '',
          confidence: 'override',
        })
        stats.override++
        continue
      }
      log.warn(`[match] overrides 指定的 ${t.id} → ${ov.source}:${ov.sourceId} 在源清单中不存在，忽略`)
    }

    const variants = nameVariants(t.name)
    for (const a of t.aliases || []) variants.push(...nameVariants(a))
    const uniqVariants = [...new Set(variants)].filter(Boolean)

    // 1) 精确名
    let hit = null
    let level = ''
    for (const v of uniqVariants) {
      const list = byNorm.get(v)
      if (list && list.length) {
        hit = pickBest(list, t)
        level = 'exact'
        break
      }
    }

    // 2) 别名（源频道自身的变体集合与目标变体有交集）
    if (!hit) {
      const pool = []
      for (const c of cands) {
        if (uniqVariants.some((v) => c.variants.includes(v))) pool.push(c)
      }
      if (pool.length) {
        hit = pickBest(pool, t)
        level = 'alias'
      }
    }

    // 3) 包含匹配（谨慎：要求长度接近）
    if (!hit) {
      const targetNorms = uniqVariants.filter((v) => v.length >= 3)
      let bestDiff = Infinity
      const pool = []
      for (const c of cands) {
        if (!c.norm || c.norm.length < 3) continue
        for (const v of targetNorms) {
          if (c.norm === v) continue
          const contains = c.norm.includes(v) || v.includes(c.norm)
          if (!contains) continue
          const diff = Math.abs(c.norm.length - v.length)
          if (diff > 4) continue
          // 排除明显的类别错配
          if (isCategoryMismatch(t.name, c.name)) continue
          if (diff < bestDiff) bestDiff = diff
          pool.push(c)
          break
        }
      }
      if (pool.length) {
        // 只保留名字长度差最小的一批，再按数据完整度挑
        const tight = pool.filter(
          (c) => targetNorms.some((v) => {
            const d = Math.abs(c.norm.length - v.length)
            return d <= bestDiff && (c.norm.includes(v) || v.includes(c.norm))
          })
        )
        hit = pickBest(tight.length ? tight : pool, t)
        level = 'contains'
      }
    }

    if (hit) {
      result.set(t.id, {
        source: hit.source,
        sourceId: String(hit.sourceId),
        sourceName: hit.name,
        region: hit.region,
        logo: hit.logo || '',
        confidence: level,
        // 备选：同名的其它源频道，按数据完整度排序。
        // 主源返回 0 条节目时，build 会按顺序继续试这些，
        // 避免"匹配到了但源里是空壳频道"导致整台没节目。
        alternatives: rankAlternatives(cands, hit, t),
      })
      stats[level]++
    } else {
      stats.miss++
    }
  }

  return { matched: result, stats }
}

/**
 * 多个候选取最优。
 *
 * 排序依据（依次比较）：
 *   1. 数据覆盖天数（days 大者优先）—— epg.pw 同一频道常有多个 id，
 *      有的只给当天 1 天、有的给满 7 天，不按这个选卫视就只剩 1 天
 *   2. 节目条数（count 大者优先）
 *   3. 名字长度最接近目标名
 */
function pickBest(list, target) {
  if (list.length === 1) return list[0]
  const tn = normalizeName(target.name)
  const sorted = [...list].sort((a, b) => {
    const da = a.days || 0
    const db = b.days || 0
    if (da !== db) return db - da
    const ca = a.count || 0
    const cb = b.count || 0
    if (ca !== cb) return cb - ca
    return Math.abs(a.norm.length - tn.length) - Math.abs(b.norm.length - tn.length)
  })
  return sorted[0]
}

/**
 * 生成备选源列表（排除已选中的那个）。
 *
 * 只收「归一化名完全相同」或「目标别名精确命中」的频道。
 * 不能用包含匹配：否则「湖南卫视」会把「湖南卫视国际」当备选，
 * 主源一空就降级到国际台，播出来的是另一个台。
 */
function rankAlternatives(cands, chosen, target) {
  const variants = new Set()
  for (const v of nameVariants(target.name)) variants.add(v)
  for (const a of target.aliases || []) for (const v of nameVariants(a)) variants.add(v)
  // 只保留归一化名与目标完全一致的变体，且要求长度 ≥ 3（避免"台"这类泛词）
  const exactNames = new Set([...variants].filter((v) => v && v.length >= 3))
  exactNames.add(chosen.norm)

  const pool = cands.filter(
    (c) =>
      !(c.source === chosen.source && String(c.sourceId) === String(chosen.sourceId)) &&
      exactNames.has(c.norm)
  )

  return pool
    .sort((a, b) => (b.days || 0) - (a.days || 0) || (b.count || 0) - (a.count || 0))
    .map((c) => ({
      source: c.source,
      sourceId: String(c.sourceId),
      sourceName: c.name,
      region: c.region,
      logo: c.logo || '',
    }))
}

/** 明显类别错配的排除规则（防止"东方卫视"配到"东方电影台"） */
const CATEGORY_WORDS = ['电影', '购物', '纪录', '卡通', '少儿', '体育', '戏曲', '音乐', '财经', '新闻']

function isCategoryMismatch(targetName, sourceName) {
  const t = targetName || ''
  const s = sourceName || ''
  // 如果目标名不含某类别词，但源名含，且两者核心名相同 → 视为错配
  for (const w of CATEGORY_WORDS) {
    if (s.includes(w) && !t.includes(w)) {
      const tCore = t.replace(/(卫视|频道|台|高清|HD)/g, '')
      const sCore = s.replace(/(卫视|频道|台|高清|HD)/g, '').replace(w, '')
      if (tCore && sCore && (sCore.includes(tCore) || tCore.includes(sCore))) return true
    }
  }
  return false
}

export function saveMatchCache(matched) {
  const obj = {}
  for (const [id, v] of matched) obj[id] = v
  saveJson(PATHS.matchCache, obj)
}
