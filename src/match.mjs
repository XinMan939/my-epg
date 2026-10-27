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
 * @param opts     { overrides } 可注入 overrides（测试用，不给就现读文件）
 * @returns {Map<tvgId, {source, sourceId, sourceName, confidence}>}
 */
export function matchChannels(targets, catalog, opts = {}) {
  const overrides = opts.overrides || loadOverrides()

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
          // ★ 手工指定也要有备选：主源常常是「注册了但零节目」的空壳
          //   （epg.pw 有 19 个这样的频道），没有备选就只能留空。
          //   优先级：overrides 里显式写的 tvmaoSourceId / z51SourceId
          //   （这两个是「台名对不上但确实是同一个台」，自动匹配永远找不到）
          //   → 再拼上自动排名出来的同名备选。
          alternatives: buildOverrideAlternatives(ov, hit, cands, t),
        })
        stats.override++
        continue
      }

      // ★★★ 2026-10-27 第七轮：override 指定了 catalog 里没有的 sourceId 时，不能整条丢掉
      //
      // 踩到的实例：嘉佳卡通 / 大湾区卫视 用户给的 tvmao id（GDTV-GDTV7 / NANFANG-NANFANG6）
      //   都不在 catalog 里（catalog 只收频道清单页的链接，这两个不在清单页）。
      //   旧代码在这里 log.warn 一句就 continue → 该频道变成「无匹配」→
      //   走 z51 兜底 → 永远 2 天，而且日志看起来「正常跳过」。
      //
      // 为什么可以放心用：tvmao 的 getDayProgrammes 会真去抓，
      //   抓不到就自然返回空；而且现在有 title 校验兜底，串台会被拦。
      //   「清单页没有」≠「站点没有」，这一点农林卫视（SHXITV/SHXITV9）已经验证过。
      if (
        ov.source === 'tvmao' ||
        ov.source === 'tvsou' ||
        ov.source === 'fengshows' ||
        ov.source === 'webncode' ||
        ov.source === 'litv' ||
        ov.source === 'tdm'
      ) {
        log.warn(
          `[match] ${t.id} 的 overrides 源 ${ov.source}:${ov.sourceId} 不在清单中，按手工指定直接使用（抓不到会自然留空）`
        )
        result.set(t.id, {
          source: ov.source,
          sourceId: String(ov.sourceId),
          sourceName: ov.sourceName || t.name,
          region: ov.region || '',
          logo: '',
          confidence: 'override-unlisted',
          alternatives: buildOverrideAlternatives(ov, { source: ov.source, sourceId: ov.sourceId }, cands, t),
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
 *   2. ★ 真简介条数（withDesc 大者优先）—— 2026-10-28 新增
 *   3. 节目条数（count 大者优先）
 *   4. 名字长度最接近目标名
 *
 * ★ 为什么必须加 withDesc（2026-10-28 实测，别删）：
 *   Now財經台 原本选 epgpw「6天291条286简介」，接了 webncode 后被换成
 *   「6天306条136简介」—— 只多 15 条节目，却丢掉 150 条简介，简介率从 98% 掉到 44%。
 *   Now新聞台 更惨：323 → 133。
 *   只看天数+条数时，**条数多但简介全空的源会稳定赢**，
 *   而简介恰恰是这个项目最稀缺的资源（整体才 60%）。
 *
 *   放在天数之后、条数之前：天数不够是硬伤（订阅 7 天就缺天），
 *   简介和条数之间则简介更重要。
 *
 *   注意 withDesc 缺失（旧 catalog 缓存）时按 0 处理，
 *   等价于退回旧行为，不会误伤——但要记得 catalog 有 TTL，会自己重扫。
 */
function pickBest(list, target) {
  if (list.length === 1) return list[0]
  const tn = normalizeName(target.name)
  const sorted = [...list].sort((a, b) => {
    const da = a.days || 0
    const db = b.days || 0
    if (da !== db) return db - da
    const wa = a.withDesc || 0
    const wb = b.withDesc || 0
    if (wa !== wb) return wb - wa
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
    .sort(
      (a, b) =>
        (b.days || 0) - (a.days || 0) ||
        (b.withDesc || 0) - (a.withDesc || 0) ||
        (b.count || 0) - (a.count || 0)
    )
    .map((c) => ({
      source: c.source,
      sourceId: String(c.sourceId),
      sourceName: c.name,
      region: c.region,
      logo: c.logo || '',
      // ★ 带上完整度指标，供 build 降级时比较（不然只能靠天数盲选）
      days: c.days || 0,
      count: c.count || 0,
      withDesc: c.withDesc || 0,
    }))
}

/**
 * 手工指定频道（overrides）的备选链
 *
 * 为什么需要：overrides 指定的主源经常是空壳——
 *   epg.pw 有 19 个「注册了 id 但零节目」的频道（农林卫视 570491、汕头经济 544379 都是），
 *   光写主源等于给自己挖坑：匹配成功、节目 0 条，日志看起来一切正常。
 *
 * 顺序（前面的优先，空节目才往后走）：
 *   ① overrides.tvmaoSourceId —— 电视猫 id，用于「台名对不上但确实是同一个台」
 *      且频道清单页没收录的（如农林卫视 SHXITV/SHXITV9，清单页只收陕西台主频道）
 *   ② overrides.z51SourceId   —— 51zmt 的 e1:N / e2:N
 *   ③ 自动排名出来的同名备选    —— 同 rankAlternatives
 *
 * @returns 备选数组（不含主源自身）
 */
function buildOverrideAlternatives(ov, chosen, cands, target) {
  const out = []
  const seen = new Set([`${chosen.source}:${chosen.sourceId}`])

  const push = (source, sourceId, sourceName, region, logo) => {
    const key = `${source}:${sourceId}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ source, sourceId: String(sourceId), sourceName: sourceName || '', region: region || '', logo: logo || '' })
  }

  if (ov.tvmaoSourceId) {
    // 两段式 id（SHXITV/SHXITV9）不会出现在 catalog 里，所以这里不校验存在性，
    // 直接当候选用；build 时 getDayProgrammes 会真去抓，抓不到就自然跳过。
    const hit = cands.find((c) => c.source === 'tvmao' && String(c.sourceId) === String(ov.tvmaoSourceId))
    push('tvmao', ov.tvmaoSourceId, hit?.name || ov.tvmaoSourceId, hit?.region, hit?.logo)
  }

  // ⚠️ 注意：z51SourceId 不放在这里。
  //    z51 是独立兜底源，不在 SOURCES/catalog 里，走的是 fillEmptyChannels()，
  //    那条路自己会读 overrides[t.id].z51SourceId。放进来反而会命中 unknown source。
  for (const a of rankAlternatives(cands, chosen, target)) push(a.source, a.sourceId, a.sourceName, a.region, a.logo)

  return out
}

/** 明显类别错配的排除规则（防止"东方卫视"配到"东方电影台"） */const CATEGORY_WORDS = ['电影', '购物', '纪录', '卡通', '少儿', '体育', '戏曲', '音乐', '财经', '新闻']

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
