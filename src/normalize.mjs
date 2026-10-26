/**
 * 节目后处理：清洗、补全 stop、去重、排序、裁剪日期范围
 */
import { CONFIG } from './config.mjs'
import { cleanTitle, tsToXmltv } from './utils.mjs'

const DAY = 24 * 3600 * 1000

/**
 * 把原始节目行规整为标准节目对象
 * @param rows [{startTs, stopTs, title, desc, category}]
 * @returns [{start, stop, title, desc, category}]  start/stop 为 XMLTV 字符串
 */
export function normalizeProgrammes(rows, opts = {}) {
  const { dayStartTs = null, dayEndTs = null } = opts

  // 1) 过滤无效 + 清洗标题
  let list = rows
    .filter((r) => r && r.startTs && r.title)
    .map((r) => ({
      startTs: r.startTs,
      stopTs: r.stopTs || null,
      title: cleanTitle(r.title),
      desc: (r.desc || '').trim(),
      category: (r.category || '').trim(),
    }))
    .filter((r) => r.title)

  // 2) 按开始时间排序 + 同时间去重（保留第一条）
  list.sort((a, b) => a.startTs - b.startTs)
  const seen = new Set()
  list = list.filter((r) => {
    const key = `${r.startTs}|${r.title}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })

  // 3) 补全 stop：优先用源给的，否则用下一条的开始时间
  for (let i = 0; i < list.length; i++) {
    const cur = list[i]
    if (!cur.stopTs) {
      const next = list[i + 1]
      if (next) {
        cur.stopTs = next.startTs
      } else if (dayEndTs) {
        cur.stopTs = dayEndTs
      } else {
        // 最后一条且无边界：给 30 分钟兜底
        cur.stopTs = cur.startTs + 30 * 60 * 1000
      }
    }
  }

  // 4) 修正异常时长
  const minMs = CONFIG.minDurationMin * 60 * 1000
  const maxMs = CONFIG.maxDurationHours * 3600 * 1000
  list = list.filter((r) => {
    const dur = r.stopTs - r.startTs
    if (dur <= 0) return false
    if (dur < minMs) {
      // 太短：拉到最小值，避免播放器显示 0 分钟
      r.stopTs = r.startTs + minMs
    }
    if (dur > maxMs) {
      // 太长：截断（常见于"全天候"类占位节目）
      r.stopTs = r.startTs + maxMs
    }
    return true
  })

  // 5) 重叠修正：后一条的开始不得早于前一条的结束
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1]
    const cur = list[i]
    if (cur.startTs < prev.stopTs) {
      // 若完全被包含，丢弃；否则截断前一条
      if (cur.stopTs <= prev.stopTs) {
        cur.startTs = prev.stopTs
        if (cur.stopTs <= cur.startTs) cur.stopTs = cur.startTs + minMs
      } else {
        prev.stopTs = cur.startTs
      }
    }
  }
  list = list.filter((r) => r.stopTs > r.startTs)

  // 6) 裁剪到目标日期范围
  if (dayStartTs != null) list = list.filter((r) => r.stopTs > dayStartTs)
  if (dayEndTs != null) list = list.filter((r) => r.startTs < dayEndTs)

  // 7) 数量上限保护
  if (list.length > CONFIG.maxProgrammesPerChannel) {
    list = list.slice(0, CONFIG.maxProgrammesPerChannel)
  }

  return list.map((r) => ({
    start: tsToXmltv(r.startTs, CONFIG.tzOffset),
    stop: tsToXmltv(r.stopTs, CONFIG.tzOffset),
    title: r.title,
    desc: r.desc,
    category: r.category,
  }))
}

/** 计算某日 YYYYMMDD 的 00:00:00 (UTC+8) 时间戳 */
export function dayStartTs(ymd) {
  return Date.parse(
    `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00+08:00`
  )
}

/** 生成从今天开始的 N 天日期数组 [{ymd, weekday(1-7), ts0, ts1}] */
export function buildDateRange(days = CONFIG.days, baseDate = new Date()) {
  const out = []
  // 以 UTC+8 的今天 0 点为基准
  const nowCst = new Date(baseDate.getTime() + 8 * 3600 * 1000)
  const y = nowCst.getUTCFullYear()
  const mo = nowCst.getUTCMonth()
  const d = nowCst.getUTCDate()

  for (let i = 0; i < days; i++) {
    const dt = new Date(Date.UTC(y, mo, d + i))
    const ymd = dt.toISOString().slice(0, 10).replace(/-/g, '')
    const jsDay = dt.getUTCDay() // 0=周日
    const weekday = jsDay === 0 ? 7 : jsDay
    const ts0 = Date.parse(
      `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T00:00:00+08:00`
    )
    out.push({ ymd, weekday, ts0, ts1: ts0 + DAY })
  }
  return out
}

/** 把多天结果按开始时间合并去重 */
export function mergeDays(dayResults) {
  const all = []
  const seen = new Set()
  for (const rows of dayResults) {
    for (const r of rows) {
      if (!r.startTs || !r.title) continue
      const key = `${r.startTs}|${r.title}`
      if (seen.has(key)) continue
      seen.add(key)
      all.push(r)
    }
  }
  all.sort((a, b) => a.startTs - b.startTs)
  return all
}
