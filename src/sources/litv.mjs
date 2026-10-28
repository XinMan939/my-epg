/**
 * 台湾 LiTV 数据源（litv.tv）—— 2026-10-27 第八轮新增
 *
 * ★ 为什么值得接（实测 2026-10-28 00:0x）：
 *   94 个台湾直播台 / 14073 条节目 / **6 天全覆盖** / 简介 6274 条 = 44.6%。
 *   现有 epgpw 台湾包虽然天数够，但**简介基本为 0**（34 个 0 简介频道里 25 个是台湾台），
 *   这个源正好补上：八大精彩/八大综艺/民视旅游/智林体育/龍華系列 等 100% 有简介。
 *
 * ★ 破解过程（三个坑，全部实测，别改回去）：
 *
 * ① **节目单不在页面 HTML 里，也不在 __NEXT_DATA__ 里**。
 *    `/channel/watch/{id}` 返回 1.1MB HTML，但 `\d\d:\d\d` 一个都没有、`__NEXT_DATA__` 里
 *    只有 lineup（频道清单）+ 两个 hash。节目单是**客户端 fetch 的静态 JSON**。
 *    我第一次看到"页面里没有时间"就下结论「纯 SPA 破不了」—— 错了，
 *    用户截图证明未登录就能看到节目单。教训：页面没数据 ≠ 站点没数据，
 *    要继续找 JS chunk 里的 URL（`_app-*.js` 里的 `t9` / `ne` 定义）。
 *
 * ② **有两个完全不同的节目单包，分别管两类频道**：
 *    - `vod_channel/schedule_pc.json.zlib.{schedule_hash}` → 317 个 **VOD 频道**（点播轮播台），
 *      按 `station3953` 这样的 station_id 分组，节目名在 `subtitle` 字段，`title` 恒为空。
 *    - `litvpc/ScheduleAllWithMediumPrograms.json.zlib` → 94 个 **真直播台**（4gtv-* / litv-*），
 *      结构是 `{Channels:[{Schedule:[...]}], Programs:{pid:{Title,Description}}}`。
 *    ★ 我们要的是后者。前者（VOD 频道）**没有台号、不是电视台**，接了也没意义。
 *
 * ③ **节目名要二次查表**：`Schedule[]` 里只有 `ProgramId`，
 *    名字和简介都在 `Programs[ProgramId]` 里。忘了这层就是「14073 条全无名」。
 *
 * ④ **两个包都是 gzip 但扩展名写 .zlib**，且 gzip 头 `1f8b` 会骗人：
 *    实际是标准 gzip（不是 raw deflate），直接 `gunzipSync` 即可。
 *    另外 `descriptionV2.json.zlib.{description_hash}` 是 `{descriptions:"a,b,c",contentIds:"..."}`
 *    两条平行逗号串的压缩格式，**不是**给直播台用的（直播台简介在 Programs 里），不要接。
 *
 * ★ 时间字段：`AirDateTime` 是 UTC（带 Z），`Duration` 是**秒**（不是分钟）。
 *   判断属于哪一天必须按 +08:00 换算 —— 跟 fengshows / webncode 同一类坑。
 */
import zlib from 'node:zlib'
import { fetchBuffer, log, hasRealDesc, isEchoDesc } from '../utils.mjs'
import { normKbroTitle, targetNameMatches, nameRelated } from './kbro.mjs'

const BASE = 'https://fino.svc.litv.tv'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

/** 直播台节目单包（94 台，固定地址，无 hash） */
const SCHEDULE_ALL = `${BASE}/litvpc/ScheduleAllWithMediumPrograms.json.zlib`

/**
 * 内存缓存：整个包 316KB / 解压 5.5MB，一次 build 里会被所有台湾台复用。
 * 不缓存的话 94 个台 = 94 次下载 316KB = 30MB 流量，且慢。
 */
let _cache = null
let _cacheAt = 0
const CACHE_TTL_MS = 30 * 60 * 1000

/** 下载 + 解 gzip + JSON.parse */
async function fetchZlibJson(url) {
  const res = await fetchBuffer(url, {
    timeout: 60000,
    retries: 2,
    headers: { 'User-Agent': UA, Referer: 'https://www.litv.tv/', Accept: 'application/json, text/plain, */*' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status || res.error}`)

  const buf = res.buf
  if (!buf || !buf.length) throw new Error('empty body')
  const out = buf[0] === 0x1f && buf[1] === 0x8b ? zlib.gunzipSync(buf) : zlib.inflateSync(buf)
  return JSON.parse(out.toString('utf8'))
}

/** 取整个直播台节目单包（带内存缓存） */
async function loadAll() {
  const now = Date.now()
  if (_cache && now - _cacheAt < CACHE_TTL_MS) return _cache
  const j = await fetchZlibJson(SCHEDULE_ALL)
  if (!j || !Array.isArray(j.Channels)) throw new Error('unexpected payload')
  _cache = j
  _cacheAt = now
  return j
}

/**
 * 抓某台某一天的节目
 *
 * @param sourceId  litv 的 CdnCode（如 4gtv-4gtv039 / litv-ftv07）
 * @param weekday   1..7 —— 不吃 weekday，只为对齐接口签名
 * @param ymd       YYYYMMDD
 * @returns { programmes, pageTitle, error }
 */
export async function getDayProgrammes(sourceId, weekday, ymd) {
  if (!sourceId) return { programmes: [], pageTitle: '', error: 'no sourceId' }

  let all
  try {
    all = await loadAll()
  } catch (e) {
    return { programmes: [], pageTitle: '', error: e.message }
  }

  const ch = all.Channels.find((c) => c.CdnCode === sourceId)
  if (!ch) return { programmes: [], pageTitle: '', error: `channel ${sourceId} not in pack` }

  const P = all.Programs || {}
  // 目标日 [00:00, 次日 00:00) 的 UTC 边界
  const y = Number(ymd.slice(0, 4))
  const mo = Number(ymd.slice(4, 6)) - 1
  const d = Number(ymd.slice(6, 8))
  const dayStart = Date.UTC(y, mo, d) - 8 * 3600e3
  const dayEnd = dayStart + 86400e3

  const rows = []
  for (const p of ch.Schedule || []) {
    const startTs = Date.parse(p.AirDateTime)
    if (!Number.isFinite(startTs)) continue
    const durSec = Number(p.Duration) || 0
    if (durSec <= 0) continue
    const stopTs = startTs + durSec * 1000

    // ★ 只收「开始时间落在目标日」的（跨天节目留给它开始的那天）
    if (startTs < dayStart || startTs >= dayEnd) continue

    const meta = P[p.ProgramId] || {}
    const title = String(meta.Title || '').trim()
    if (!title) continue

    const desc = String(meta.Description || '').trim()
    rows.push({
      startTs,
      stopTs,
      title,
      // ★ 不复读标题（pitfalls §5.1）
      desc: desc && desc !== title ? desc : '',
    })
  }

  rows.sort((a, b) => a.startTs - b.startTs)
  return { programmes: rows, pageTitle: ch.Name || sourceId }
}

/**
 * 频道清单
 *
 * 一次包就能列出全部 94 个直播台。region 给 TW。
 *
 * ★ days / count 必须按每台真实数据算，不能给个统一值（2026-10-28 踩过）：
 *   webncode 那次给了硬编码 days=7 + count=0，骗过 pickBest 把
 *   Now新聞台 从「6天325条323简介」换成「5天273条133简介」，简介掉一半还不报错。
 *   litv 这里包已经在内存里，算真实天数和条数**零额外成本**，没有理由不精确。
 *
 *   count 口径对齐 epgpw（全期总条数），这样 pickBest 比条数时才有意义。
 */
export async function listChannels() {
  let all
  try {
    all = await loadAll()
  } catch (e) {
    log.warn(`[litv] 扫描失败：${e.message}`)
    return []
  }

  const P = all.Programs || {}
  const out = []
  for (const c of all.Channels || []) {
    const id = c.CdnCode
    const name = String(c.Name || '').trim()
    if (!id || !name) continue

    // 真实统计：有节目名的条数 + 覆盖的北京天数 + 真简介数
    const dayset = new Set()
    let count = 0
    let withDesc = 0
    for (const p of c.Schedule || []) {
      const startTs = Date.parse(p.AirDateTime)
      if (!Number.isFinite(startTs)) continue
      if (!(Number(p.Duration) > 0)) continue
      const meta = P[p.ProgramId]
      const title = String(meta?.Title || '').trim()
      if (!title) continue
      count++
      dayset.add(new Date(startTs + 8 * 3600e3).toISOString().slice(0, 10))
      // ★ 用 hasRealDesc 统一口径（pitfalls §5.3），别只看非空
      if (hasRealDesc(String(meta.Description || ''), title)) withDesc++
    }

    out.push({
      source: 'litv',
      region: 'TW',
      sourceId: id,
      name,
      logo: '',
      days: dayset.size,
      count,
      withDesc,
    })
  }
  const tot = out.reduce((s, c) => s + c.count, 0)
  const totDesc = out.reduce((s, c) => s + c.withDesc, 0)
  log.ok(`[litv] ${out.length} 个直播台，共 ${tot} 条节目，其中 ${totDesc} 条有真简介`)
  return out
}

export { log }

/**
 * ★ 端到端：用 litv 给已抓到的节目补简介（2026-10-28 第十三轮新增）
 *
 * ── 为什么需要这个通道（实测数据，别删） ──────────────────────────
 *
 * litv 有 **33 个台简介率 ≥90%**，其中博斯全系列、龍華全系列、八大系列是 **100%**。
 * 但它们在 `pickBest` 里永远选不上，因为排序第一维是 `days`：
 *
 *   | 目标台   | 现状（epgpw）      | litv 候选              |
 *   |----------|--------------------|------------------------|
 *   | 龙华偶像 | 7天/106条/**0简介**  | 6天/139条/**139简介**  |
 *   | 博斯无限Ⅱ | 7天/74条/**1简介**   | 6天/67条/**67简介**    |
 *   | 采昌影剧 | 7天/119条/12简介    | 6天/94条/93简介        |
 *
 * litv 少 1 天就被第一维淘汰，**简介这一维根本没机会参与比较**。
 * 这和 §6.7g（webncode 天数虚高）是同一个结构，只是方向相反：
 * 那边是「天数虚高 → 坏源赢」，这里是「天数少 1 天 → 好源连比较资格都没有」。
 *
 * ★ 为什么不改 pickBest 的排序：
 *   天数确实是硬需求（订阅 7 天就不能缺天），把简介提到天数前面会让整台少一天。
 *   正确做法是**职责分离**——epgpw 出 7 天节目单，litv 只出简介，
 *   和 kbro 已有的定位完全一致（kbro 只给 3 天，也从不抢主源）。
 *
 * ── 两条安全规则（照抄 kbro，理由见 kbro.mjs 对应注释） ────────────
 *   ① 频道级：用**节目标题交集**对齐，不用名字匹配（台湾台名字天生互相包含）
 *   ② 全局级：只在「同名频道」内兜底，绝不跨频道套用
 *
 * ★ 只填「还没有真实简介」的条目，绝不覆盖已有内容。
 */
export async function enrichFromLitv(targets, epgMap, opts = {}) {
  const { force = false } = opts

  let all
  try {
    all = await loadAll()
  } catch (e) {
    log.warn(`[litv] 补简介：包不可用，跳过（${e.message}）`)
    return { stats: null, detail: [] }
  }

  const P = all.Programs || {}

  // ① 把 litv 的 94 个台建成 {channelId → {name, titles:Set, descMap:Map}}
  const byChannel = new Map()
  for (const c of all.Channels || []) {
    const id = c.CdnCode
    if (!id) continue
    const slot = { channelId: id, name: String(c.Name || '').trim(), titles: new Set(), descMap: new Map() }
    for (const p of c.Schedule || []) {
      const meta = P[p.ProgramId]
      if (!meta) continue
      const title = String(meta.Title || '').trim()
      if (!title) continue
      const key = normKbroTitle(title)
      if (!key) continue
      slot.titles.add(key)
      const desc = String(meta.Description || '').trim()
      if (!desc) continue
      // ★ 简介复读标题 = 没写简介（pitfalls §5.1）
      if (isEchoDesc(desc, title)) continue
      if (desc.length < 12) continue
      const old = slot.descMap.get(key)
      if (!old || desc.length > old.length) slot.descMap.set(key, desc)
    }
    if (slot.titles.size) byChannel.set(id, slot)
  }
  if (!byChannel.size) {
    log.info('[litv] 补简介：没有任何可用频道')
    return { stats: null, detail: [] }
  }

  // ② 我方每个频道已有的节目标题（归一化）
  const titlesByTarget = new Map()
  for (const t of targets) {
    const rows = epgMap.get(t.id) || []
    if (!rows.length) continue
    const set = new Set()
    for (const r of rows) {
      const k = normKbroTitle(r.title)
      if (k) set.add(k)
    }
    if (set.size) titlesByTarget.set(t.id, set)
  }

  // ③ 标题交集对齐（阈值与 kbro 一致：交集 ≥5 且 ≥15%，或名字完全相等且交集 ≥2）
  const aligned = new Map()
  const detail = []
  for (const t of targets) {
    const mine = titlesByTarget.get(t.id)
    if (!mine || !mine.size) continue

    let best = null
    for (const [chId, o] of byChannel) {
      if (!o.titles.size) continue
      let inter = 0
      for (const nt of mine) if (o.titles.has(nt)) inter++
      if (inter < 2) continue
      const rate = inter / mine.size
      if (!best || inter > best.inter || (inter === best.inter && rate > best.rate)) {
        best = { channelId: chId, name: o.name, inter, rate }
      }
    }
    if (!best) {
      detail.push({ id: t.id, name: t.name, status: 'none', mine: mine.size })
      continue
    }

    const nameEq = targetNameMatches(t, best.name)
    // ★★ 名字护栏（2026-10-28 实测必须加，理由见 kbro.mjs 的 nameRelated 注释）：
    //   光靠标题交集会把「爱尔达娱乐」对到「INULTRA」——交集 54 条、覆盖率 100%，
    //   数字上完美，但那 54 条全是 INULTRA 的科普纪录片。上游整台错挂时交集毫无意义。
    //   加护栏后：588 → 496 条，少 92 条但零串台，这个取舍值得。
    const related = nameRelated(t, best.name)
    const strong = related && (nameEq || (best.inter >= 5 && best.rate >= 0.15))
    if (!strong) {
      detail.push({
        id: t.id,
        name: t.name,
        status: nameEq || related ? 'weak' : 'name-mismatch',
        mine: mine.size,
        nameEq,
        related,
        ...best,
      })
      continue
    }
    const o = byChannel.get(best.channelId)
    aligned.set(t.id, { ...best, descCount: o.descMap.size })
    detail.push({ id: t.id, name: t.name, status: 'ok', mine: mine.size, nameEq, ...best, descCount: o.descMap.size })
  }

  log.info(
    `[litv] 补简介：频道对齐 ${aligned.size} 个命中 / ${targets.length} 个目标` +
      `（weak ${detail.filter((d) => d.status === 'weak').length}，` +
      `名字不符 ${detail.filter((d) => d.status === 'name-mismatch').length}，` +
      `none ${detail.filter((d) => d.status === 'none').length}）`
  )

  // ④ 填简介
  let filled = 0
  const stats = new Map()
  for (const t of targets) {
    const rows = epgMap.get(t.id)
    if (!rows || !rows.length) continue
    const a = aligned.get(t.id)
    if (!a) continue
    const slot = byChannel.get(a.channelId)
    if (!slot) continue

    let n = 0
    for (const r of rows) {
      if (!force && hasRealDesc(r.desc, r.title)) continue
      const k = normKbroTitle(r.title)
      if (!k) continue
      const d = slot.descMap.get(k)
      if (!d) continue
      if (!hasRealDesc(d, r.title)) continue
      r.desc = d
      n++
    }
    if (n) {
      filled += n
      stats.set(t.id, { filled: n, litvChannel: a.channelId, litvName: a.name, inter: a.inter, rate: a.rate })
    }
  }

  if (filled) log.ok(`[litv] 补简介：共补 ${filled} 条，涉及 ${stats.size} 个频道`)
  else log.info('[litv] 补简介：没有可补的条目')

  return { stats, detail }
}

