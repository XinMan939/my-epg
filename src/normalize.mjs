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

  // 4) 丢弃无效时长 + 截断超长
  //
  // ★ 这里只做「不可能的时长」，不碰「太短」的。
  //   太短的放到第 6 步（重叠修完之后）再拉长，否则会和第 5 步打架 ——
  //   踩过的坑（2026-10-27 线上产物实测 632 条短节目一条都没修好）：
  //     第 4 步把 30 秒的「8K标识演绎-宣传片」拉到 60 秒，
  //     第 5 步发现它挤到了下一条（下一条正好 30 秒后开始），
  //     于是 prev.stopTs = cur.startTs 又把它截回 30 秒 —— 两步互相抵消，
  //     CCTV-8K 的 492 条、CCTV-4K 的 140 条 30 秒垫片全部维持原样。
  //
  // ★ 关于「末条被截成恰好 12 小时」（2026-10-27 实测 55 条）：
  //   epg.pw 把每个频道最后一条节目的 stop 直接写成「数据窗口末尾」（如 11-03 00:00），
  //   CCTV1「宗师列传·大唐诗人传-杜牧」上游是 02:49→次日 00:00 = 21.2 小时。
  //   截断后变成整齐的 12.00 小时，看起来像「真有一个节目播了 12 小时」。
  //
  //   ★ 试过把上限压到 10.8h（不留整数，一眼看出是占位），**已放弃**：
  //     那样 55 个频道在窗口末尾会留下约 11 小时空白，播放器显示「暂无节目」，
  //     比「一条长节目」更糟 —— 用户会以为节目单断了。
  //   保持截到 maxDurationHours 是当前最优：末条覆盖到窗口边界，中间不留空洞。
  //   代价是「12 小时」这个数字不真实，已记在 README 的已知限制里。
  const minMs = CONFIG.minDurationMin * 60 * 1000
  const maxMs = CONFIG.maxDurationHours * 3600 * 1000
  list = list.filter((r) => {
    const dur = r.stopTs - r.startTs
    if (dur <= 0) return false
    if (dur > maxMs) {
      // 太长：截断（末条 stop 写成窗口末尾、或"全天候"占位节目）
      r.stopTs = r.startTs + maxMs
    }
    return true
  })

  // 5) 重叠修正：**只截前一条的 stop，绝不改任何一条的 start**
  //
  // ★ 为什么不能改 start（2026-10-27 线上产物实测，CCTV兵器科技 / 五星体育 乱序）：
  //   旧实现在「后一条被前一条完全包住」时走这个分支：
  //     cur.startTs = prev.stopTs     // ← 把真实开始时间改掉了
  //   真实数据是电视猫给的：
  //     大家谈    23:22 → 次日 02:00   （158 分钟，明显吞掉了后面的档）
  //     讲武堂    00:03 → 00:57        （真实开始是 00:03）
  //   旧代码把「讲武堂」的开始推成 02:00，于是产物里出现
  //     23:22 大家谈 → 02:00 讲武堂 → 00:58 影视背景
  //   —— 时间轴倒回去了。用户按时间翻节目单，会看到「02:00 讲武堂」然后
  //   下面接着「00:58 影视背景」，播放器渲染出来的顺序是乱的。
  //
  //   正确做法：错的是前一条的 stop（它吞掉了后一条），把它截到后一条的开始。
  //   两条都保留，时间轴连续，且没有编造任何时间：
  //     大家谈 23:22→00:03 / 讲武堂 00:03→00:57 / 包装 00:57→00:58 / 影视背景 00:58→…
  for (let i = 1; i < list.length; i++) {
    const prev = list[i - 1]
    const cur = list[i]
    if (cur.startTs < prev.stopTs) {
      prev.stopTs = cur.startTs
    }
  }
  // 被截成零长度/负长度的（与前一条同 start 的重复档）直接丢掉
  list = list.filter((r) => r.stopTs > r.startTs)

  // 6) 太短的拉到最小值 —— 但只在下一条开始之前有空位时拉
  //
  //   为什么不能无条件拉：30 秒垫片后面紧跟的就是 30 秒后的下一条，
  //   强行拉到 60 秒会压住下一条，又制造出新的重叠。
  //   没空间就保留真实时长（宁可显示 30 秒，也不编一个 1 分钟）。
  for (let i = 0; i < list.length; i++) {
    const cur = list[i]
    const dur = cur.stopTs - cur.startTs
    if (dur >= minMs) continue
    const limit = i + 1 < list.length ? list[i + 1].startTs : Infinity
    const want = Math.min(cur.startTs + minMs, limit)
    if (want > cur.stopTs) cur.stopTs = want
  }
  list = list.filter((r) => r.stopTs > r.startTs)

  // 7) 裁剪到目标日期范围
  if (dayStartTs != null) list = list.filter((r) => r.stopTs > dayStartTs)
  if (dayEndTs != null) list = list.filter((r) => r.startTs < dayEndTs)

  // 8) 数量上限保护
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
