/**
 * 台湾大宽频（kbro / TWM Broadband）EPG 数据源
 *
 * 入口：https://www.twmbroadband.com/T01/catv-table_18_2801_3536.html
 *   页面本身是 JS 动态渲染的空壳（71KB HTML 里一条节目都没有），
 *   真正的数据在 js/v2/program.js 里硬编码的两个接口。
 *
 * 接口（2026-10-27 实测）：
 *   GET https://epg.kbro.com.tw:2543/epg/epg_channel.php?appid=WEB
 *       → 827KB，DATA 按「经营区 so」分组，共 4884 条 / 296 个唯一 channelid
 *         结构：{UNIQUE_ID, CHANNELID, SERVICEID, CHANNELNUMBER, CHANNELNAME, CHANNELTYPE[], CH_CODENAME}
 *
 *   GET https://epg.kbro.com.tw:2543/epg/epg_program.php?appid=TFM&date=YYYYMMDD
 *       → 4.7MB，PROG 数组 7593 条
 *         结构：{channelid, programname, programdescr, starttime, endtime, duration,
 *                progtype, quality, actors, host, img, ...}
 *
 * ★ 日期格式是 YYYYMMDD（无横线）。传 `2026-10-27` 会返回 0 字节 —— 这个坑踩过。
 * ★ appid=TFM 与 KBRO 返回内容完全相同（差 1 字节），TFM 是台湾大宽频自己。
 * ★ 只给 3 天：今天 + 2 天。再往后（+3 天起）返回 0 字节，不是接口挂了。
 *
 * 定位（关键）：
 *   这个源**不是节目单主力**，而是**简介补充源**。
 *   它最大的价值是 programdescr 是真简介（电影剧情、节目内容），
 *   而且大量频道简介率是 100%——实测 78 个台湾/香港频道能对上我们的清单，
 *   其中「公視」1%→76%、「好消息Ⅰ」0%→98%、「亞洲美食頻道」16%→100%。
 *   所以它按「节目名 → 简介」建索引，跨天复用，和 desc.mjs 的思路一致。
 *
 * ★ 简介质量校验（必须做，否则会把垃圾灌进去）：
 *   programdescr 有时就是 programname 本身（如「收播」「再見」），
 *   这种要丢掉，不能当成简介。用 isRealDesc + 「与标题相同」双重过滤。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fetchText, log, isRealDesc, hasRealDesc, isEchoDesc, toSimplified } from '../utils.mjs'
import { PATHS } from '../config.mjs'

const BASE = 'https://epg.kbro.com.tw:2543/epg'
const APPID_CH = 'WEB'
const APPID_PG = 'TFM'

/** 该接口会校验 Referer，缺了直接 403 */
const HEADERS = {
  Referer: 'https://www.twmbroadband.com/',
  Accept: 'application/json, text/plain, */*',
}

/** 缓存有效期：包很大（4.7MB/天），一次 build 内复用即可 */
const CACHE_TTL = Number(process.env.KBRO_CACHE_TTL || 60 * 60 * 1000)

function cacheDir() {
  const d = path.join(PATHS.cache, 'kbro')
  fs.mkdirSync(d, { recursive: true })
  return d
}

function isFresh(p) {
  try {
    const st = fs.statSync(p)
    return Date.now() - st.mtimeMs < CACHE_TTL && st.size > 1024
  } catch {
    return false
  }
}

/**
 * 下载并缓存一个 JSON。
 * ⚠️ 先写 .tmp 再 rename —— 同 epg.pw 的教训：并发读到半成品会 JSON.parse 失败。
 */
async function loadJson(url, file, { force = false } = {}) {
  if (!force && isFresh(file)) {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      /* 缓存坏了，重新下 */
    }
  }
  const res = await fetchText(url, { timeout: 45000, retries: 2, retryDelay: 2000, headers: HEADERS })
  if (!res.ok || !res.text.trim()) {
    throw new Error(`HTTP ${res.status || 0} ${res.error || ''} 内容 ${res.bytes}B`)
  }
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, res.text)
  fs.renameSync(tmp, file)
  return JSON.parse(res.text)
}

/** 频道清单：合并所有 so 分组，同一 channelid 只留第一次出现的 */
export async function loadChannels({ force = false } = {}) {
  const file = path.join(cacheDir(), 'channels.json')
  const j = await loadJson(`${BASE}/epg_channel.php?appid=${APPID_CH}`, file, { force })
  const byId = new Map()
  for (const arr of Object.values(j.DATA || {})) {
    for (const c of arr) {
      if (byId.has(c.CHANNELID)) continue
      byId.set(c.CHANNELID, {
        channelId: c.CHANNELID,
        serviceId: c.SERVICEID,
        number: c.CHANNELNUMBER,
        name: c.CHANNELNAME,
        type: c.CH_CODENAME || (c.CHANNELTYPE || []).join('/'),
      })
    }
  }
  return { byId, updatedAt: j.UPDATETIME || '' }
}

/**
 * 某一天的节目包。返回按 channelid 分好组的数组。
 * @param ymd YYYYMMDD
 */
export async function loadProgrammes(ymd, { force = false } = {}) {
  const file = path.join(cacheDir(), `prog_${ymd}.json`)
  const j = await loadJson(`${BASE}/epg_program.php?appid=${APPID_PG}&date=${ymd}`, file, { force })
  const byCh = new Map()
  for (const p of j.PROG || []) {
    if (!byCh.has(p.channelid)) byCh.set(p.channelid, [])
    byCh.get(p.channelid).push(p)
  }
  // 按开始时间排序，否则 stopTs 推算会乱
  for (const list of byCh.values()) list.sort((a, b) => String(a.starttime).localeCompare(String(b.starttime)))
  return byCh
}

/** starttime/endtime 形如 20261027003000 → 时间戳 */
export function parseKbroTime(s) {
  const m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(String(s || '').trim())
  if (!m) return null
  const [, y, mo, d, h, mi, se] = m
  // 台湾是 UTC+8，直接按 +08:00 构造
  return Date.UTC(+y, +mo - 1, +d, +h - 8, +mi, +se)
}

/**
 * 列出全站频道（供 catalog 自动匹配）
 *
 * days 字段：kbro 只给 3 天，且这 3 天是「相对今天」的，
 * 所以这里固定写 3，由 build 侧按实际日期取。
 */
export async function listChannels() {
  const { byId } = await loadChannels()
  const out = []
  for (const c of byId.values()) {
    out.push({
      source: 'kbro',
      sourceId: c.channelId,
      name: c.name,
      logo: '',
      days: 3,
      // 节目条数未知（需要下载当日包才知道），写 0 让 match 优先挑别的源
      count: 0,
      number: c.number,
      type: c.type,
    })
  }
  return out
}

/**
 * 取某频道某天的节目（规整成 build 需要的形状）
 * @returns {Array<{startTs, stopTs, title, desc}>}
 */
export async function getProgrammes(sourceId, ymd) {
  const byCh = await loadProgrammes(ymd)
  const raw = byCh.get(String(sourceId)) || []
  return toRows(raw)
}

/** kbro 原始条目 → 统一节目行 */
export function toRows(raw) {
  const rows = []
  for (const p of raw) {
    const startTs = parseKbroTime(p.starttime)
    if (!startTs) continue
    let stopTs = parseKbroTime(p.endtime)
    // endtime 缺失时用 duration 补
    if (!stopTs && p.duration) stopTs = startTs + Number(p.duration) * 1000
    const title = (p.programname || '').trim()
    if (!title) continue
    rows.push({ startTs, stopTs: stopTs || null, title, desc: (p.programdescr || '').trim() })
  }
  return rows
}

/**
 * 扫描 kbro 的节目包，建「按频道」的标题/简介索引
 *
 * 为什么不直接用 getProgrammes 补节目单：
 *   kbro 只给 3 天，而我们输出 7 天。直接拿它当节目单源，
 *   第 4~7 天会是空的，反而把已有节目覆盖掉。
 *   所以走「标题查表」——同一个小节目（如「東張西望」）的简介跨天复用，
 *   这跟 desc.mjs 里 tvmao 详情页缓存的思路一样。
 *
 * ★ 为什么必须按频道分开存（踩过的坑）：
 *   第一版做的是「全局一张表」，结果「午間新聞」被套上了「鏡電視新聞台」的简介、
 *   所有台的午间新闻都变成同一句宣传语。这跟 z51 那边「晚间新闻有 8 种写法」
 *   是同一个问题——同名栏目在不同台内容完全不同。
 *   所以索引结构必须是 Map<channelId, Map<normTitle, desc>>，
 *   补的时候先对齐频道、再取该频道自己那份。
 *
 * @param dates  要抓的日期数组 [{ymd}]
 * @returns {{byChannel: Map<string, {name, titles:Set, descMap:Map}>, stats}}
 */
export async function buildChannelIndex(dates) {
  const byChannel = new Map()
  let scanned = 0
  let real = 0
  for (const d of dates) {
    let byCh
    try {
      byCh = await loadProgrammes(d.ymd)
    } catch (e) {
      log.warn(`[kbro] ${d.ymd} 节目包不可用: ${e.message}`)
      continue
    }
    for (const [chId, raw] of byCh) {
      if (!byChannel.has(chId)) byChannel.set(chId, { channelId: chId, name: '', titles: new Set(), descMap: new Map() })
      const slot = byChannel.get(chId)
      for (const p of raw) {
        scanned++
        const title = (p.programname || '').trim()
        const desc = (p.programdescr || '').trim()
        if (!title) continue
        const key = normKbroTitle(title)
        if (!key) continue
        slot.titles.add(key)
        if (!desc) continue
        // ★ 简介等于标题 = 没写简介（「收播」「再見」这类），丢掉
        //   isEchoDesc 比 desc === title 更严：连「标题 + 纯集数」也一并挡掉
        if (isEchoDesc(desc, title)) continue
        if (desc.length < 12) continue
        const old = slot.descMap.get(key)
        if (!old || desc.length > old.length) slot.descMap.set(key, desc)
        real++
      }
    }
  }
  // 补上频道名，日志和报告里要显示
  try {
    const { byId } = await loadChannels()
    for (const [chId, slot] of byChannel) slot.name = byId.get(chId)?.name || ''
  } catch {
    /* 名字只是装饰，拿不到不影响功能 */
  }

  // ★ 剔除「频道宣传语」：同一句 desc 被本台 ≥3 个不同标题复用
  //
  // 为什么必须剔（2026-10-27 线上产物实测翻车）：
  //   台湾有些台把「频道介绍」填进了每个节目的 programdescr：
  //     鏡電視新聞台HD → 13 个整点新闻共用「鏡電視新聞台，帶領台灣觀眾開啟不一樣的新聞視野…」
  //     彩虹頻道HD    → 41 个节目共用「彩虹成人數位頻道將家庭的成人娛樂享受高規格化…」
  //   这些不是节目简介，是频道宣传语。挂到节目上会让人以为每个节目都一样。
  //
  // ★ 更致命的是它会**跨地区传染**：全局兜底只认「标题唯一」，
  //   「晚間新聞」在 kbro 只有鏡電視新聞台有简介 → 被当成唯一答案 →
  //   灌进 CCTV-1 / 江苏卫视 / 香港各台的「晚間新聞」。实测污染 123 条（CN 72 + HK 51）。
  //
  // ★ 判据为什么是「本台 ≥3 个不同标题」而不是「跨台重复」：
  //   跨台重复会误伤真节目（「台視新聞部製作的專題深入報導」在 2 个台都有，那是同集团共用稿）。
  //   而本台内 3 个**不同节目**用同一句话，只可能是宣传语 —— 实测 40 组全是宣传语，零误伤。
  let promoRemoved = 0
  for (const [, slot] of byChannel) {
    const cnt = new Map()
    for (const [, d] of slot.descMap) cnt.set(d, (cnt.get(d) || 0) + 1)
    const promo = new Set()
    for (const [d, n] of cnt) if (n >= 3) promo.add(d)
    if (!promo.size) continue
    for (const [k, d] of [...slot.descMap]) {
      if (promo.has(d)) {
        slot.descMap.delete(k)
        promoRemoved++
      }
    }
  }

  const withDesc = [...byChannel.values()].filter((s) => s.descMap.size > 0).length
  log.ok(
    `[kbro] 频道索引 ${byChannel.size} 个频道 / ${withDesc} 个带简介` +
      `（扫描 ${scanned} 条节目，其中 ${real} 条带真简介；剔除频道宣传语 ${promoRemoved} 条）`
  )
  return { byChannel, stats: { channels: byChannel.size, scanned, real, promoRemoved } }
}

/**
 * 频道名归一化（**只用于「完全相等」判定，绝不做包含匹配**）
 *
 * 与 normKbroTitle 的区别：
 *   normKbroTitle 是给节目标题用的，会剥集数、剥方括号；
 *   这个是给频道名用的，只剥「HD / 頻道 / 台 / (免費)」这类后缀，
 *   剥完必须**完全相等**才算命中。
 *
 * ★ 绝不改成 includes：港台名字天生互相包含
 *   （「台視」⊂「台視新聞」、「中天綜合台」vs「中天新聞」、
 *    「博斯網球台」vs「博斯運動台」），包含匹配必串台。
 */
export function normChannelName(s) {
  let x = toSimplified(String(s || ''))
  x = x.replace(/[\s\u3000]+/g, '')
  x = x.replace(/[（(][^)）]{0,10}[)）]/g, '') // (免費) (HD)
  x = x.replace(/(高清|超清|標清|标清|HD|SD)$/gi, '')
  // ★ 剥「電視台 / 电视台 / 頻道 / 频道 / 台」等结尾后缀。
  //   ⚠️ 只剥**结尾**，不能全局替换：「台視」的「台」在开头，剥了就成「視」。
  //   实测靠这一条救回三个频道：
  //     緯來精采台HD  → 緯來精采  = 我方「纬来精采」✓
  //     靖天映畫台HD  → 靖天映畫  = 我方「靖天映画」✓
  //     德國之聲電視台HD → 德國之聲 = 我方「DW德国之声」✓
  x = x.replace(/(電視台|电视台|頻道|频道|台)$/g, '')
  x = x.replace(/[·・,，、:：\-—_]/g, '')
  return x.toLowerCase()
}

/**
 * 目标频道的名字（含别名）里，有没有和对方频道名完全相等的
 *
 * ★ 2026-10-28 导出给 litv.mjs 复用：litv 补简介走的是同一套对齐逻辑，
 *   复制一份实现必然漂移（改一边忘另一边），所以直接共用。
 */
export function targetNameMatches(t, otherName) {
  const k = normChannelName(otherName)
  if (!k || k.length < 3) return false
  for (const cand of [t.name, ...(t.aliases || [])]) {
    if (normChannelName(cand) === k) return true
  }
  return false
}

/**
 * ★★ 名字相关性护栏：完全相同，或一方完整包含另一方（各自长度 ≥3）
 *
 * 2026-10-28 第十三轮新增，专给 litv 补简介用。**不能省**。
 *
 * 为什么光靠标题交集不够（实测反例）：
 *   「爱尔达娱乐」被对到 litv「INULTRA」，交集 54 条、覆盖率 100%——
 *   数字上看是完美匹配，但那 54 条全是 INULTRA 的科普纪录片
 *   （扶手椅冒險家 / 不容敗北 / 纳米比亚野生动物保护区），跟娱乐台毫无关系。
 *   根因是 epgpw 的 `愛爾達娛樂台`（370149）本身挂的就是 INULTRA 的节目，
 *   我的通道只是**继承**了上游的错误。标题交集在这类「上游整台错挂」面前完全失效。
 *
 * ★ 为什么用「包含」而不是只用「完全相等」：
 *   实测有 3 个台必须靠包含才能对上，否则白丢 110 条：
 *     SETiNews.tw(三立财经新闻) ← 三立新聞iNEWS     +71
 *     阿里郎.tw                ← ARIRANG阿里郎頻道   +32
 *     我的欧洲电影.tw           ← My Cinema Europe HD 我的歐洲電影  +5
 *   这三个都是同一个台的不同叫法，包含关系是成立的。
 *
 * ★ 为什么包含不会误伤（对比真正的反例）：
 *   「爱尔达娱乐」与「INULTRA」归一化后毫无交集 → 包含判断为 false ✓
 *   而 kbro 那边之所以严禁包含匹配（见 normChannelName 注释），
 *   是因为它在做**主源选择**——选错就整台串台；这里只做**补简介**，
 *   且有标题交集门槛兜底，两者风险等级不同。即便如此，仍保留交集门槛。
 */
export function nameRelated(t, otherName) {
  if (targetNameMatches(t, otherName)) return true
  const y = normChannelName(otherName)
  if (!y) return false
  for (const cand of [t.name, ...(t.aliases || [])]) {
    const x = normChannelName(cand)
    if (!x) continue
    if (x.length >= 3 && y.includes(x)) return true
    if (y.length >= 3 && x.includes(y)) return true
  }
  return false
}

/**
 * 频道对齐：用「节目标题交集」把我们的频道对到 kbro 的频道
 *
 * 为什么不用名字匹配：
 *   名字匹配在台湾频道上必然串台——「公視」会被吸到「公視台語台」或「小公視」，
 *   「TVBS」会吸到「TVBS新聞台」，而它们的节目单完全不同。
 *   标题交集是内容级证据，串不了台。
 *
 * 阈值沿用 z51 那边调出来的值：
 *   交集 ≥ 5 条，且占我方该频道标题数的 ≥ 15%。
 *   低于这个就当没有对应，宁可漏补也不乱补。
 *
 * @param targets        目标频道（含 id）
 * @param titlesByTarget Map<tvgId, Set<normTitle>>
 * @param byChannel      buildChannelIndex 的产物
 */
export function alignByTitles(targets, titlesByTarget, byChannel) {
  const out = new Map()
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

    // 强度判定有两条通道：
    //   ① 标题交集够强（≥5 条且 ≥15%）—— 内容级证据，最可信
    //   ② 标题交集弱，但**频道名归一化后完全相等** —— 名字级证据
    //
    // ★ 为什么必须有 ②（2026-10-27 实测）：
    //   只认 ① 会丢掉一批明明就是同一个台的频道，因为 kbro 只给 3 天、
    //   而我方是 7 天，两边节目单本来就只重叠一部分，交集天然偏小：
    //     纬来精采   inter=4 rate=13%（差一点点就被丢）→ 但 kbro 就有「緯來精采台HD」
    //     Catchplay  inter=6 rate=11%（条数够、比例不够）
    //     博斯网球   inter=2 rate=6% → 但 kbro 就有「博斯網球台」，名字一模一样
    //
    // ★ 为什么 ② 不会串台：
    //   要求「名字完全相等」而不是「包含」。看弱匹配里的反面例子：
    //     Jade.hk（翡翠台）被算到「鏡電視新聞台HD」—— 名字完全不同，② 直接否掉
    //     GoodTV.tw（好消息Ⅰ）被算到「好消息HD」—— 差一个 Ⅰ，归一化后不等，也否掉
    //     博斯运动Ⅰ 被算到「博斯網球台」—— 不等，否掉
    //   这些恰好都是靠 ① 会漏、靠 ② 能挡住的情况，两条通道互补。
    const nameEq = targetNameMatches(t, best.name)
    const strong = (best.inter >= 5 && best.rate >= 0.15) || (nameEq && best.inter >= 2)
    if (!strong) {
      detail.push({ id: t.id, name: t.name, status: 'weak', mine: mine.size, nameEq, ...best })
      continue
    }

    const o = byChannel.get(best.channelId)
    out.set(t.id, { ...best, descCount: o.descMap.size, viaName: nameEq && !(best.inter >= 5 && best.rate >= 0.15) })
    detail.push({ id: t.id, name: t.name, status: 'ok', mine: mine.size, nameEq, ...best })
  }

  log.info(
    `[kbro] 频道对齐：${out.size} 个命中 / ${targets.length} 个目标` +
      `（弱匹配 ${detail.filter((d) => d.status === 'weak').length}，无对应 ${detail.filter((d) => d.status === 'none').length}）`
  )
  return { aligned: out, detail }
}

/**
 * 建全局标题索引（跨频道兜底）
 *
 * 频道级对齐依赖「整台节目单能对上」，但有些台对不上——
 * 不是同一个台，只是**有大量相同节目**（如通用的「新聞」「氣象」）。
 *
 * ★ 安全规则（不这么做必串台，第一版就是这么翻车的）：
 *   同一个标题在多个 kbro 频道出现时，desc 可能完全不同。
 *   只接受两类：
 *     ① 该标题在 kbro 全站只出现一次 → 无可争议
 *     ② 出现多次但 desc 完全一致 → 说明是通用栏目（天气预报这类）
 *   其余一律跳过，宁缺毋滥。
 *
 * ★ 第二个安全规则：**全局索引只能给同地区用**（见 enrichFromKbro 的 regionOf 判断）
 *   kbro 的 296 个频道**全部是台湾台**（实测：无 CCTV、无湖南/江苏/浙江、无香港翡翠台）。
 *   所以「全站唯一」这条规则对通用栏目名完全无效 ——
 *   「晚間新聞」在 kbro 恰好只有鏡電視新聞台给了简介，它就成了「唯一答案」，
 *   然后被灌进 CCTV-1、江苏卫视、香港各台的「晚間新聞」。
 *   实测跨区污染 123 条（大陆 72 + 香港 51）。
 */
export function buildGlobalIndex(byChannel) {
  const raw = new Map()
  for (const [, o] of byChannel) {
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
  log.info(`[kbro] 全局索引：${index.size} 个可用标题（跳过 ${skipped} 个 desc 冲突的）`)
  return index
}

/**
 * 标题归一化：只用于「同一个节目找简介」，不做跨台对齐。
 *
 * 必须处理：
 *   ① 繁简 —— kbro 是繁体（東張西望 / 綜藝大熱門），我们输出可能是简体
 *   ② 集数后缀 —— 「大愛地球村:5369」「驚喜假期第4季:6」要剥掉，
 *      否则每集一个 key，索引会碎成几千条
 *   ③ 全角括号、空白
 */
export function normKbroTitle(t) {
  let s = String(t || '')
  // ★ 繁简统一到简体——kbro 是繁体，「公視」vs「公视」、「我們的島」vs「我们的岛」
  //   不转的话两岸标题交集永远为零，频道没法对齐
  s = toSimplified(s)
  s = s.replace(/[\s\u3000]+/g, '')
  // 剥集数 / 分级 / 双语标记：结尾的 (209)(普) / #215 / 第N季:N / :123
  s = s.replace(/[（(]\d+[)）]/g, '')
  s = s.replace(/[（(][^\u4e00-\u9fa5A-Za-z]{1,4}[)）]$/g, '')
  s = s.replace(/[（(][^)）]{1,6}[)）]$/g, '')
  s = s.replace(/[:：]\s*\d+$/g, '')
  s = s.replace(/第\d+季[:：]?\d*$/g, '')
  s = s.replace(/#\d+$/g, '')
  // 剥粤语/双语/分级方括号：[粵] [粵/普] [PG] [HD]
  s = s.replace(/\[[^\]]{1,6}\]/g, '')
  s = s.replace(/[·・,，、]/g, '')
  return s.toLowerCase()
}

/**
 * 目标频道属于哪个地区
 *
 * 用来限制全局兜底的作用范围 —— kbro 全是台湾台，不能跨区套用。
 *
 * ★ 为什么不能只看 country：channels.json 里大陆频道（cctv/satellite/local）
 *   大部分没写 country 字段，只有港澳台和一部分大陆台写了。
 *   所以以 group 为主判据，country 兜底。
 */
function regionOf(t) {
  if (!t) return ''
  const g = t.group
  if (g === 'cctv' || g === 'satellite' || g === 'local' || g === 'pay') return 'CN'
  if (g === 'hk') return 'HK'
  if (g === 'mo') return 'MO'
  if (g === 'tw') return 'TW'
  return (t.country || '').toUpperCase()
}

/**
 * 端到端：给已抓到的节目补简介
 *
 * 两级策略，先频道级再全局级（与 z51 完全一致的思路）：
 *   ① 频道级（alignByTitles 命中的台）—— 同一个台的简介最可信，优先用
 *   ② 全局级（跨频道标题索引）—— 补那些「整台对不上但节目名对得上」的残余，
 *      且只接受全站唯一 / 全站一致的标题，防止串台
 *
 * ★ ② 有地区限制：只对台湾目标生效（kbro 全是台湾台）。
 *   实测不加这条会跨区污染 123 条：CCTV-1 的「晚间新闻」被套上
 *   「鏡電視新聞台，帶領台灣觀眾開啟不一樣的新聞視野…」，
 *   江苏卫视的「非诚勿扰」被套上冯小刚电影的剧情简介。
 *
 * ★ 只在节目还没有真实简介时才填，不覆盖已有内容。
 *
 * @param targets  目标频道
 * @param epgMap   Map<tvgId, programmes[]>
 * @param opts     {force, titleMap}
 * @returns {{stats, detail, report}}
 */
export async function enrichFromKbro(targets, epgMap, opts = {}) {
  const { force = false, titleMap = {} } = opts

  // 只用今天起 3 天——kbro 的硬上限，多请求也是 0 字节
  const today = new Date()
  const dates = []
  for (let i = 0; i < 3; i++) {
    const d = new Date(today.getTime() + i * 86400e3)
    // 用北京时间算日期，避免 UTC 偏移导致差一天
    const bj = new Date(d.getTime() + 8 * 3600e3)
    dates.push({ ymd: bj.toISOString().slice(0, 10).replace(/-/g, '') })
  }

  let built
  try {
    built = await buildChannelIndex(dates)
  } catch (e) {
    log.warn(`[kbro] 建索引失败，跳过: ${e.message}`)
    return { stats: null, detail: [], report: [] }
  }
  const { byChannel } = built
  if (!byChannel.size) {
    log.info('[kbro] 没有任何频道数据')
    return { stats: null, detail: [], report: [] }
  }

  // 我方每个频道已有的节目标题（归一化），用于标题交集对齐
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

  const { aligned, detail } = alignByTitles(targets, titlesByTarget, byChannel)
  const globalIndex = buildGlobalIndex(byChannel)

  // ---- 补简介 ----
  let filledByChannel = 0
  let filledByGlobal = 0
  let skippedCrossRegion = 0
  const report = []

  for (const t of targets) {
    const rows = epgMap.get(t.id)
    if (!rows || !rows.length) continue

    const a = aligned.get(t.id)
    const slot = a ? byChannel.get(a.channelId) : null
    // overrides 里的手工 titleMap：非中文标题（英文/朝鲜语）只能人工映射
    const manual = titleMap[t.id] || null
    // ★ 全局兜底只给台湾目标用 —— kbro 全是台湾台，跨区套用必串台
    const allowGlobal = regionOf(t) === 'TW'

    let filled = 0
    for (const r of rows) {
      if (hasRealDesc(r.desc, r.title)) continue // 已有真实简介，不动（复读标题的也算没有）
      const k = normKbroTitle(r.title)
      if (!k) continue

      // ① 频道级（对齐成功＝同一个台，跨区也无妨，比如 HBO电影.tw ↔ HBO HD頻道）
      let d = slot?.descMap.get(k)
      // ② 手工 titleMap（优先级在频道级之后：人工映射最准，但先让位给同台数据）
      if (!d && manual) {
        const mapKey = Object.keys(manual).find((x) => normKbroTitle(x) === k)
        if (mapKey) d = manual[mapKey]
      }
      // ③ 全局级（仅台湾目标）
      let fromGlobal = false
      if (!d) {
        if (!allowGlobal) {
          if (globalIndex.has(k)) skippedCrossRegion++
        } else {
          const g = globalIndex.get(k)
          if (g) {
            d = g.desc
            fromGlobal = true
          }
        }
      }
      if (!d) continue
      r.desc = d
      filled++
      if (fromGlobal) filledByGlobal++
      else filledByChannel++
    }

    if (filled) report.push({ id: t.id, name: t.name, channelId: a?.channelId || '', filled })
  }

  const stats = {
    channels: byChannel.size,
    aligned: aligned.size,
    globalTitles: globalIndex.size,
    filled: filledByChannel + filledByGlobal,
    filledByChannel,
    filledByGlobal,
    skippedCrossRegion,
    promoRemoved: built.stats?.promoRemoved || 0,
    dates,
  }
  log.ok(
    `[kbro] 补简介 ${stats.filled} 条（频道级 ${filledByChannel} / 全局级 ${filledByGlobal}），` +
      `对齐 ${aligned.size} 个频道` +
      (skippedCrossRegion ? `；挡掉跨区套用 ${skippedCrossRegion} 条` : '')
  )
  return { stats, detail, report }
}

export const meta = {
  id: 'kbro',
  label: '台湾大宽频 kbro',
  regions: ['TW'],
  /** 该源自带真实 stop 时间 */
  hasStop: true,
  /** 该源带节目简介（且质量高，是主要用途） */
  hasDesc: true,
  /** ★ 只覆盖 3 天，不能当 7 天节目单主力 */
  maxDays: 3,
  /** ★ 定位是简介补充源，不是节目单源 */
  role: 'desc',
}
