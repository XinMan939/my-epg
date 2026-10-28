/**
 * 电视猫 m.tvmao.com 数据源
 *
 * 实测（2026-10-26）：
 *   - 移动端页面自带 data-endtime，是真实结束时间（比 tvsou 只有开始时间强）
 *   - 三类频道 ID 命名不同：
 *       央视   /program/CCTV-CCTV1-w{N}.html
 *       卫视   /program_satellite/HUNANTV1-w{N}.html
 *       数字   /program_digital/CCTVPAYFEE-CCTVPAYFEE1-w{N}.html
 *   - w1=周一 ... w7=周日, w8=下周一（下周只有周一半天有效）
 *   - 连发 12 请求未触发频控
 *
 * 坑：错误 ID 会 200 返回"串台"页面（如 SMG-SMG1 返回 CCTV-1 内容），
 *    所以必须校验返回页面的 <title> 是否与预期频道名一致。
 */
import { fetchText, parseTimeToTs, normalizeName, decodeEntities, dateInCST, log } from '../utils.mjs'
import { probeDisabled, readProbeCache, writeProbeCache, makeProgress } from '../probe-cache.mjs'

const BASE = 'https://m.tvmao.com'
const UA_MOBILE =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'

/** 探测缓存文件名 + 口径版本（改 probeWeek 的算法必须 +1，否则旧缓存会让改动静默失效） */
const PROBE_CACHE = 'tvmao-probe'
const PROBE_VER = 1

/** 探测并发（实测 tvmao 很快：40 个请求 2.8 秒，4 并发足够且不显眼） */
const PROBE_CONC = Number(process.env.TVMAO_PROBE_CONC || 4)

/** 三类频道页路径 */
export const PATHS = {
  cctv: '/program/',
  satellite: '/program_satellite/',
  digital: '/program_digital/',
}

/**
 * ★ 路径候选表（2026-10-27 第七轮全量实测后重写）
 *
 * 前几轮的错误：拿「sourceId 里有没有连字符」当路径判据。
 *   这条规则对 CCTV-/BAMC-/CCTVPAYFEE- 成立，但对 SITV-/DOX-/KAMBA-/DIGITAL- 是**错的**。
 *
 * 全量实测（2026-10-27，w2，按前缀分组各取代表）：
 *
 *   | 前缀组          | /program/            | /program_digital/   | /program_satellite/ |
 *   |-----------------|----------------------|---------------------|---------------------|
 *   | BAMC-   (14个)  | 200 54行 ✓优优宝贝   | 404                 | 404                 |
 *   | CCTV-   (26个)  | 200 42行 ✓CCTV-1综合 | 404                 | 404                 |
 *   | CCTVPAYFEE-(32) | 200 40行 ✓风云足球   | 404                 | 404                 |
 *   | CETV-   (4个)   | 200 92行 ✓中国教育   | 404                 | 404                 |
 *   | CHC-    (3个)   | 200 35行 ✓CHC动作    | 404                 | 404                 |
 *   | HSCM-   (9个)   | 200 26行 ✓HD探索纪录 | 404                 | 404                 |
 *   | SITV-   (9个)   | 200  9行 ✗DOX映画    | 200 22行 ✓劲爆体育  | 200 22行 ✓劲爆体育  |
 *   | DOX-    (1个)   | 200 20行 ✗CCTV-1综合 | 200 20行 ✓DOX院线   | 200 20行 ✓DOX院线   |
 *   | KAMBA-  (1个)   | 200 20行 ✗CCTV-1综合 | 200 48行 ✓康巴卫视  | 200 48行 ✓康巴卫视  |
 *   | DIGITAL-(1个)   | 200 20行 ✗CCTV-1综合 | 200 49行 ✓数码时代  | 200 49行 ✓数码时代  |
 *   | 无连字符(114个) | 200 20行 ✗CCTV-1综合 | 200 40行 ✓安徽卫视  | 200 40行 ✓安徽卫视  |
 *
 * 教训：**猜错路径不报 404，而是 200 + 别人的节目单**（串台）。
 *   生活时尚/动漫秀场补天拿到 0 条就是这个原因 —— 拿回来的是「DOX映画」的 9 条。
 *   所以路径表只能当「首选」，必须再用 title 校验兜底（见 titleMatchesChannel）。
 */
const PATH_BY_PREFIX = {
  'BAMC-': [PATHS.cctv],
  'CCTV-': [PATHS.cctv],
  'CCTVPAYFEE-': [PATHS.cctv],
  'CETV-': [PATHS.cctv],
  'CHC-': [PATHS.cctv],
  'HSCM-': [PATHS.cctv],
  'SITV-': [PATHS.digital, PATHS.satellite, PATHS.cctv],
  'DOX-': [PATHS.digital, PATHS.satellite],
  'KAMBA-': [PATHS.digital, PATHS.satellite],
  'DIGITAL-': [PATHS.digital, PATHS.satellite],
}

/**
 * 全部合法前缀。顺序即「未知分组」的探测顺序：
 *   先 /program/（CCTV-/BAMC-/CCTVPAYFEE-/CETV-/CHC-/HSCM- 共 88 个频道走这条），
 *   再 digital、再 satellite（无连字符的 114 个卫视走 satellite）。
 */
const ALL_PATHS = [PATHS.cctv, PATHS.digital, PATHS.satellite]
const PATHS_ALL = ALL_PATHS

/**
 * 返回该 sourceId 的路径候选（有序，第一个是首选）
 * 已解析成功的会记在 resolvedPath 里，后续 7 天直接复用，避免重复探测。
 *
 * @param sourceId 电视猫频道 id
 * @param forcePath 强制路径前缀（来自 overrides 的 tvmaoPath），给「探测也搞不定的」兜底
 */
export function inferPathCandidates(sourceId, forcePath) {
  // overrides 显式指定最优先（如 SITV-* 必须走 digital，但探测顺序被缓存污染时也能纠正）
  if (forcePath && PATHS_ALL.includes(forcePath)) return [forcePath]

  // 两段式写法：sourceId 里带 "/"，如 "SHXITV/SHXITV9"（陕西台/农林卫视）
  // 实测 /program/SHXITV/SHXITV9-w2.html 200 72987B ✓ title 农林卫视节目表
  if (sourceId.includes('/')) return [PATHS.cctv]

  const hit = resolvedPath.get(sourceId)
  if (hit) return [hit]

  if (sourceId.includes('-')) {
    const pre = sourceId.split('-')[0] + '-'
    const known = PATH_BY_PREFIX[pre]
    if (known) return known
    // 未知前缀：先试 /program/（多数分组走这条），失败再退到另外两条
    return ALL_PATHS
  }
  // 无连字符：形如 HUNANTV1 / ZJTV1 / BTV1，实测 /program/ 会串台到 CCTV-1综合
  return [PATHS.satellite, PATHS.digital, PATHS.cctv]
}

/** 首选路径（保留旧接口，给 listChannels 等调用方用） */
export function inferPath(sourceId) {
  return inferPathCandidates(sourceId)[0]
}

/** sourceId → 已验证可用的路径前缀（进程内缓存，避免每天重探） */
const resolvedPath = new Map()

/** 记住某个 sourceId 可用的前缀 */
export function rememberPath(sourceId, prefix) {
  resolvedPath.set(sourceId, prefix)
}

/** 清空路径缓存（测试用） */
export function resetPathCache() {
  resolvedPath.clear()
}

/**
 * 从页面 title 里取频道名
 *   "生活时尚节目表,生活时尚节目预告_电视猫"        → "生活时尚"
 *   "CCTV央视台球节目表,央视台球节目预告_电视猫"    → "CCTV央视台球"
 *   "DOX映画节目表_电视猫"                          → "DOX映画"
 */
export function titleChannelName(pageTitle) {
  const s = String(pageTitle || '').trim()
  if (!s) return ''
  return s.split(/节目表|节目预告|节目单|_电视猫|,/)[0].trim()
}

/**
 * ★ title 校验：抓回来的页面是不是这个频道
 *
 * 为什么必须校验：猜错路径时 tvmao 返回 **200 + 别的频道的节目单**，
 *   不校验就会把「DOX映画」的节目当成「生活时尚」入库，而且没有任何报错。
 *
 * @param pageTitle   页面 <title>
 * @param expectNames 可接受的频道名（可以是数组，任一命中即通过）
 *                    支持多名的原因：overrides 里的 sourceId 常常是原始 id
 *                    （如 NANFANG-NANFANG6 不在 catalog，拿不到中文名），
 *                    这时必须退到频道表里的 name / aliases 去比。
 *
 * 匹配规则（宽松，宁可放过不可错杀）：
 *   ① 任一期望名与页面名 normalize 后互相包含 → 通过
 *   ② 页面取不到名字 → 通过（上游改版时别一刀切全废掉）
 *   ③ 期望名为空 → 通过（调用方没给，无从校验）
 */
export function titleMatchesChannel(pageTitle, expectNames) {
  const got = titleChannelName(pageTitle)
  if (!got) return true

  const list = (Array.isArray(expectNames) ? expectNames : [expectNames])
    .filter(Boolean)
    .map((x) => normalizeName(String(x)))
    .filter(Boolean)
  if (!list.length) return true

  const a = normalizeName(got)
  if (!a) return true
  return list.some((b) => a.includes(b) || b.includes(a))
}

/**
 * 抓单频道单日节目
 * @param sourceId    电视猫频道 ID（不含 -wN）
 * @param weekday     1..7（周一..周日），可到 8（下周一）
 * @param ymd         该节目对应的实际日期 YYYYMMDD（用于把 HH:MM 补成时间戳）
 * @param expectNames 期望的频道名（字符串或数组），用于校验页面是否串台（强烈建议传）
 * @param forcePath   强制路径前缀（'tvmaoPath' override），跳过探测
 * @returns { programmes, pageTitle, error }
 */
export async function getDayProgrammes(sourceId, weekday, ymd, expectNames, forcePath) {
  const candidates = inferPathCandidates(sourceId, forcePath)

  let lastErr = null
  for (const prefix of candidates) {
    const url = `${BASE}${prefix}${sourceId}-w${weekday}.html`

    let res
    try {
      res = await fetchText(url, {
        timeout: 20000,
        retries: 2,
        headers: { 'User-Agent': UA_MOBILE },
      })
    } catch (e) {
      lastErr = e.message
      continue
    }

    if (!res.ok) {
      lastErr = `HTTP ${res.status}`
      continue
    }

    const html = res.text
    const pageTitle = ((html.match(/<title>([^<]*)<\/title>/) || [])[1] || '').trim()

    // ★ 串台校验：路径猜错时 tvmao 返回 200 + 别人的节目单，不校验就会静默污染
    if (!titleMatchesChannel(pageTitle, expectNames)) {
      lastErr = `wrong-channel(${titleChannelName(pageTitle) || pageTitle})`
      continue
    }

    const rows = parseRows(html, ymd)
    if (!rows.length) {
      lastErr = 'no-rows'
      continue
    }

    rememberPath(sourceId, prefix)
    return { programmes: rows, pageTitle, error: null }
  }

  return { programmes: [], pageTitle: '', error: lastErr || 'no-rows' }
}

/**
 * 解析节目行
 *
 * ★★ 2026-10-27 第七轮：旧正则漏掉了三分之二的行，是本轮最大的静默 bug。
 *
 * 页面里有 **两类** 时间标签，旧正则只认第一类：
 *   A) <span class="epg-row-time"    data-endtime="01:07" data-time="00:57">00:57</span>
 *   B) <span class="epg-row-playing" data-endtime="21:43" data-time="20:00">直播中</span>
 *      ↑ 正在播出的那一条，class 名不同、内文是「直播中」而不是时间
 *
 * 而 epg-row-link 里又有三种写法：
 *   ① <a>独占整行：  <span class="epg-row-link"><a ...>动画片</a></span>
 *   ② <a>夹在中间：  <span class="epg-row-link">实况录像-2024/2025赛季<a ...>斯诺克世界公开赛</a> 墨菲的147</span>
 *   ③ 纯文本：      <span class="epg-row-link">动画片</span>
 * 旧正则只吃 ①③，② 整行丢掉。
 *
 * 实测代价（2026-10-27，w2）：
 *   CCTV央视台球：28 行 → 旧正则 **0 条**（全是 ② 型）→ 表现成「上游没有」
 *   抽样 24 个 tvmao 频道：15 个在丢数据，共丢 84 条
 *     CCTV-5体育 6→22、CCTV5+ 4→16、CCTV-7国防军事 29→38、CCTV-12法制 24→30
 *
 * 修法：不再用「整行一个大正则」，改成两步 ——
 *   ① 按 <li class="epg-row"> 切块（块内结构再怎么变都不会漏）
 *   ② 块内分别取时间、取标题（剥掉 <a> 标签，保留前后文字）
 */
export function parseRows(html, ymd) {
  const rows = []

  const liRe = /<li class="epg-row[^"]*">([\s\S]*?)<\/li>/g
  let m
  while ((m = liRe.exec(html))) {
    const body = m[1]
    if (!body) continue

    // 时间：epg-row-time（普通）或 epg-row-playing（直播中）
    const t =
      body.match(/<span class="epg-row-(?:time|playing)"\s+data-endtime="([^"]*)"\s+data-time="([^"]*)"/) ||
      body.match(/<span class="epg-row-(?:time|playing)"\s+data-time="([^"]*)"\s+data-endtime="([^"]*)"/)
    if (!t) continue

    // 上面两种匹配的字段顺序不同，按实际捕获组取值
    const isEndFirst = /data-endtime="([^"]*)"\s+data-time=/.test(t[0])
    const endRaw = (isEndFirst ? t[1] : t[2] || '').trim()
    const startRaw = (isEndFirst ? t[2] : t[1] || '').trim()
    if (!startRaw) continue

    // 标题：epg-row-link 整块内容，剥掉所有标签但保留文字
    const lk = body.match(/<span class="epg-row-link">([\s\S]*?)<\/span>/)
    if (!lk) continue
    const full = decodeEntities(
      lk[1]
        .replace(/<a[^>]*>([\s\S]*?)<\/a>/g, '$1')
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
    ).trim()
    if (!full) continue

    const startTs = parseTimeToTs(startRaw, ymd)
    if (!Number.isFinite(startTs)) continue

    let stopTs = null
    if (endRaw) {
      stopTs = parseTimeToTs(endRaw, ymd)
      // 跨零点：结束时间小于开始时间 → 顺延一天
      if (stopTs && stopTs <= startTs) stopTs += 24 * 3600 * 1000
    }

    rows.push({ startTs, stopTs, title: full })
  }

  return rows
}

/**
 * 探测单个频道：w1..w7 里有几天有节目、一共多少条
 *
 * 必须逐天探（见 listChannels 上方「半月」实测，只探一天会稳定虚报）。
 * 路径探测 / 串台校验全部复用 getDayProgrammes，探完顺便预热 resolvedPath。
 *
 * @param sourceId 电视猫频道 id
 * @param name     频道名，用于 title 串台校验（缺了会把别人的节目当成自己的）
 * @returns {Promise<{days: number, count: number}>} 失败/空台一律 {days:0, count:0}
 */
export async function probeWeek(sourceId, name, opts = {}) {
  // 抓取函数可注入（单测里用假 getDay 打桩，见 test/tvsou-days.test.mjs）
  const getDay = opts.getDay || getDayProgrammes
  // ymd 只用来把 HH:MM 补成时间戳；探测只数条数，取今天即可
  const ymd = dateInCST()
  let days = 0
  let count = 0
  for (let w = 1; w <= 7; w++) {
    const r = await getDay(sourceId, w, ymd, name)
    if (r.programmes && r.programmes.length) {
      days++
      count += r.programmes.length
    }
  }
  return { days, count }
}

/** 简单并发限流 */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length)
  let i = 0
  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(n, items.length)) }, async () => {
      while (i < items.length) {
        const idx = i++
        out[idx] = await fn(items[idx], idx)
      }
    })
  )
  return out
}

/**
 * 列出电视猫频道（供自动匹配用）
 * 实测可用的三个入口页：
 *   /program/duration/satellite/w1-h16.html  卫星（43 个）
 *   /program/duration/digital/w1-h16.html    数字（83 个）
 *   /program/duration/cctv/w1-h16.html       央视
 *
 * ─── 2026-10-28 第十七轮：补真探 days / count ───────────────────────────────
 *
 * ★ 之前的缺陷：只从榜单页抓 id + 名字，214 条 catalog 全都没有 days 字段。
 *   match.mjs 的 pickBest 用 `a.days || 0`，「缺字段」= 0 天 → tvmao 永远垫底。
 *   后果和 tvsou 那次一样：报表里只有 `empty(tvmao:xxx=0)`，
 *   看不出「源本身没有」还是「路径猜错拿不到」。
 *
 * ★★ 为什么 tvmao 必须逐天探（不能只看一天）：
 *   它**真的有半月**。2026-10-28 实测：
 *     三沙卫视   w1:46 w2:46 w3:46 w4:0 w5:0 w6:0 w7:0  → 3 天
 *     快乐垂钓   w1:19 w2:19 w3:19 w4:22 w5:0 w6:0 w7:0 → 4 天
 *     湖南卫视   w1..w7 全有                              → 7 天
 *   跟 tvsou 的「全有 / 全无」不同，这里**只探一天会稳定虚报**，
 *   所以老老实实 7 个 weekday 各探一次（实测很快：40 个请求 2.8 秒）。
 *
 * ★ days 口径 = w1..w7 里有节目的 weekday 数，与 tvsou 一致：
 *   build 把 7 个目标日期映射成 7 个 weekday 去抓，所以「有节目的 weekday 数」
 *   就是产物里能覆盖的天数。w8（下周一）不探 —— build 从不请求 w8，
 *   探了会把 days 报高（三沙卫视 w8 有 46 条但 w4..w7 全空，正是这个坑）。
 *
 * ★ 探测时顺手把 resolvedPath 预热了（getDayProgrammes 内部 rememberPath），
 *   所以真正 build 的时候每个台第一次就命中正确路径，不再 3 条路径乱试。
 */
export async function listChannels() {
  const out = []
  const entries = [
    { path: '/program/duration/cctv/w1-h16.html', group: 'cctv' },
    { path: '/program/duration/satellite/w1-h16.html', group: 'satellite' },
    { path: '/program/duration/digital/w1-h16.html', group: 'digital' },
  ]

  for (const { path: p, group } of entries) {
    const res = await fetchText(`${BASE}${p}`, {
      timeout: 25000,
      retries: 2,
      headers: { 'User-Agent': UA_MOBILE },
    })
    if (!res.ok) {
      log.warn(`[tvmao] 频道列表 ${group} 抓取失败 HTTP ${res.status}`)
      continue
    }

    // ⚠️ 2026-10-27 站点改版，旧正则一条都匹配不上，tvmao 源整个消失（214 频道 → 0），
    //    连带简介率从 61.2% 掉到 60%。两处变化：
    //    ① 路径：央视/数字 → /program/<ID>-wN.html；卫视 → /program_satellite/<ID>-wN.html
    //       （旧正则写死 /program[a-z_]*/ 能同时吃两种，新写法反而只认 /program/，卫视全丢）
    //    ② ID：CCTV1 → CCTV-CCTV1，加了分组前缀
    //    所以这里把路径前缀做成捕获组，后面交给 inferPath 决定怎么拼。
    const re =
      /<a href="(\/program(?:_satellite|_digital)?\/([A-Za-z0-9\-]+)-w\d+\.html)"\s*\n?\s*title="([^"]+)"/g
    let m
    const seen = new Set()
    while ((m = re.exec(res.text))) {
      const sourceId = m[2]
      // 2026-10-27 改版后 title 变成了「CCTV-1综合节目单」，直接拿去匹配会把名字搞脏，
      // 剥掉结尾的「节目单」「节目预告」再入库。
      const name = m[3].trim().replace(/(?:节目单|节目预告|节目表)$/, '').trim()
      if (seen.has(sourceId)) continue
      seen.add(sourceId)
      out.push({
        source: 'tvmao',
        group,
        sourceId,
        name,
        logo: '',
        // 真探前先给 0：pickBest 里 0 是安全默认（垫底），不会骗排序
        days: 0,
        count: 0,
        withDesc: 0,
        // ★ 只做备选，不参与主源竞争（见 match.mjs pickBest 的第 0 条注释）
        fallbackOnly: true,
      })
    }
  }

  if (probeDisabled('TVMAO_PROBE')) {
    log.warn('[tvmao] 探测已关闭（TVMAO_PROBE=0 / NO_SOURCE_PROBE=1），days 全为 0')
    return out
  }

  const cache = readProbeCache(PROBE_CACHE, PROBE_VER)
  const stats = { ...cache.stats }
  const todo = out.filter((c) => !(c.sourceId in stats))

  if (cache.hit) {
    log.info(`[tvmao] 复用今日探测缓存：${out.length - todo.length}/${out.length} 个频道（${cache.ymd}）`)
  }
  if (todo.length) {
    const tick = makeProgress('tvmao', todo.length, 50)
    await mapLimit(todo, PROBE_CONC, async (c) => {
      try {
        stats[c.sourceId] = await probeWeek(c.sourceId, c.name)
      } catch {
        stats[c.sourceId] = { days: 0, count: 0 }
      }
      tick()
    })
    writeProbeCache(PROBE_CACHE, PROBE_VER, stats)
  }

  for (const c of out) {
    const st = stats[c.sourceId]
    if (st) {
      c.days = st.days || 0
      c.count = st.count || 0
    }
  }

  const live = out.filter((c) => c.days > 0)
  log.ok(
    `[tvmao] 探测真实覆盖：${live.length}/${out.length} 个台有节目，` +
      `最多 ${Math.max(0, ...out.map((c) => c.days))} 天，共 ${out.reduce((s, c) => s + c.count, 0)} 条` +
      `（无简介源，withDesc 恒 0）`
  )
  return out
}

export const meta = {
  id: 'tvmao',
  label: '电视猫',
  hasStop: true,
  hasDesc: false,
}
