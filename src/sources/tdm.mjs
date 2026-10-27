/**
 * 澳门 TDM 官方数据源（appapi.tdm.com.mo）—— 2026-10-28 第九轮新增
 *
 * 来源：用户手机里的 TDM 官方 App（com.tdm.macau）。用户明确说「要开 VPN 才能看到节目单」，
 * 但实测**不需要** —— 那是他手机 DNS 被污染（解析到 Facebook 的 31.13.85.53），
 * 而 GitHub Actions 解析到真实澳门 IP 103.233.191.143，直连 200。
 *
 * ★ 破解路径（供以后参考）：
 *   1. 手机开无线调试 → adb pull 拉 APK（67MB）—— 这一步不需要 VPN，只是拷文件
 *   2. APK 是 React Native（Hermes 字节码），但域名在字符串表里明文：
 *      grep 出 `https://appapi.tdm.com.mo`
 *   3. 站点是 Vue CLI 打包的 SPA，接口定义在 `/static/js/app.*.js` 里明文可读：
 *      ```js
 *      get("/api/v1.0/program-list/Channel", { params: t })
 *      get("/api/v1.0/program-list/" + t.date,   { params: t })   // ★ date 走路径
 *      ```
 *   4. 频道 id / slug 来自 `/api/v1.0/live/categories`
 *
 * 接口（全部实测 2026-10-28）：
 *   GET /api/v1.0/live/categories                      → 2 个分类（電視/電台），13 个频道
 *   GET /api/v1.0/program-list/{YYYY-MM-DD}?channelId=N → 该台该天的节目（43~47 条）
 *   GET /api/v1.0/program/{id}  或  /api/v1.0/program/{slug} → 节目详情，`content` 字段是简介
 *   GET /api/v1.0/program-list/categories              → 7 天日期列表
 *   GET /api/v1.0/common/get-domain                    → 按访问者 IP 返回 live/vod 域名
 *
 * ⚠️ 五个坑（全部实测，别改回去）：
 *
 * ① **`date` 只能走路径，不能走 query**。
 *    `/api/v1.0/program-list?date=2026-10-28` → `{"message":"The value is not valid for type."}`
 *    正确写法 `/api/v1.0/program-list/2026-10-28?channelId=1`。
 *    跟 webncode 是同一类坑（那个是 query 全被忽略，这个是直接报错，反而好一点）。
 *
 * ② **`program-list/Channel` 必须带 `type` 参数**，不带就报
 *    `"The value is not valid for type."`。带 `?type=1` 返回 `data: []`（空），
 *    所以这个接口对拿频道列表没用 —— 频道列表走 `live/categories`。
 *
 * ③ **`program-list/{id}` 的报错暴露了参数名**：
 *    `"The value is not valid for channelId."` —— 说明参数叫 channelId，
 *    但 `channelId=1` 放在**路径**里是错的，必须放 query。
 *
 * ④ **窗口是「今天 -2 天 ~ 今天 +5 天」共 8 天，越界静默返回 `data: []`**。
 *    ★★ 这一条我踩了两次，别再看错：
 *    10-28 手工探测时 10-26~11-02 全有数据（8 天），我就以为「固定给 8 天」。
 *    结果 CI 里 `listChannels` 从**今天**起算探 8 天（10-28~11-04），只探到 6 天
 *    （10-28~11-02），却仍然按 `MAX_DAYS=8` 自报 8 天 × 单日条数。
 *    自报 1520 条 / 实测 1177 条，虚高 29% —— 又一个「自报数据骗排序」（§6.7）。
 *    **窗口是跟着今天滚动的，不是固定的 8 天**，所以必须逐日真探，不能硬编码天数。
 *
 * ⑤ **简介要二次请求**：节目单里**没有**简介字段，只有 `programmeId` / `id` / `slug`。
 *    逐条请求 `/api/v1.0/program/{id}` 拿 `content`（HTML 片段）。
 *    一个台一天 40+ 条 = 40+ 次请求，所以：
 *      - 只在节目单条目的 `id` 非空时才请求（实测 47 条里只有 17 条有 id）
 *      - 按 `slug`/`id` 做进程内缓存，同一节目跨天复用
 *      - 用 `mapLimit` 限并发 5
 *
 * ★ 额外收获：节目单里每条都有 `onlineFeed`（直播 m3u8 地址），
 *   如 `https://live3.tdm.com.mo/ch1/ch1.live/playlist.m3u8`。
 *   以后做 m3u 对接时可以直接用。
 */
import { fetchText, log, hasRealDesc } from '../utils.mjs'

const BASE = 'https://appapi.tdm.com.mo'
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'

/**
 * 13 个频道（2026-10-28 从 /api/v1.0/live/categories 抓出，硬编码因为很少变）
 *
 * 为什么硬编码而不是每次扫：listChannels 要给出 days/count 供 pickBest 排序，
 * 而这两项必须真探（见 pitfalls §6.7）。频道清单本身变化极小，硬编码省一个请求。
 * 若 TDM 加台，跑一次 `node -e` 抓 categories 更新这里即可。
 */
export const CHANNELS = [
  { id: 1, slug: 'ctvp', name: '澳視澳門', number: '91', group: 'tv' },
  { id: 2, slug: 'ptvp', name: '澳視葡文', number: '92', group: 'tv' },
  { id: 6, slug: 'sports', name: '澳門體育', number: '93', group: 'tv' },
  { id: 5, slug: 'info', name: '澳門資訊', number: '94', group: 'tv' },
  { id: 7, slug: 'hdctvp', name: '澳門綜藝', number: '95', group: 'tv' },
  { id: 8, slug: 'satellite', name: '澳門-Macau', number: '96', group: 'tv' },
  { id: 52, slug: 'cgtn71', name: 'CCTV 綜合頻道', number: '71', group: 'tv' },
  { id: 49, slug: 'cgtn', name: 'CGTN', number: '73', group: 'tv' },
  { id: 46, slug: 'cgtn74', name: 'CGTN 紀錄頻道', number: '74', group: 'tv' },
  { id: 9, slug: 'legislativec', name: '立法會直播', number: '', group: 'tv' },
  { id: 11, slug: 'legislativep', name: 'Directo das Reuniões da Assembleia', number: '', group: 'tv' },
  { id: 3, slug: 'fm1007', name: '澳門電台 FM100.7', number: '', group: 'radio' },
  { id: 4, slug: 'fm98', name: 'Rádio Macau FM98', number: '', group: 'radio' },
]

/**
 * 有节目单的频道（实测 CCTV/CGTN 三个台 + 立法会/电台返回空）
 *
 * 只有这 6 个能拿到节目，其余不放进 listChannels —— 否则 match 会选中它们，
 * 然后每台每天都返回 `data: []`，白白浪费请求还污染日志。
 */
const WITH_EPG = new Set([1, 2, 5, 6, 7, 8])

/** 探测窗口上界：今天往后最多探几天（实测 +5 天有数据，+6 起空） */
const PROBE_AHEAD = 6
/** 探测窗口下界：今天往前最多探几天（实测 -2 天有数据，-3 起空） */
const PROBE_BACK = 3

/** 简介缓存：key = `${id}|${slug}`，value = 简介文本。跨天/跨频道复用。 */
const _descCache = new Map()

/** 简单并发限流（同 webncode） */
async function mapLimit(items, n, fn) {
  const out = new Array(items.length)
  let i = 0
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++
      out[idx] = await fn(items[idx], idx)
    }
  })
  await Promise.all(workers)
  return out
}

async function getJson(url) {
  const res = await fetchText(url, {
    timeout: 20000,
    retries: 2,
    headers: { 'User-Agent': UA, Referer: `${BASE}/`, Accept: 'application/json' },
  })
  if (!res.ok) throw new Error(`HTTP ${res.status || res.error}`)
  const j = JSON.parse(res.text)
  if (j.code !== 0) throw new Error(j.message || 'api error')
  return j
}

/** HTML 片段 → 纯文本（简介里全是 <p style=...> 和 <br>） */
function stripHtml(s) {
  return String(s || '')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * 抓某台某一天的节目
 *
 * @param sourceId  channelId（字符串或数字，如 '1'）
 * @param weekday   1..7 —— 不吃 weekday，只为对齐接口签名
 * @param ymd       YYYYMMDD
 * @returns { programmes, pageTitle, error }
 */
export async function getDayProgrammes(sourceId, weekday, ymd) {
  const cid = Number(sourceId)
  if (!cid) return { programmes: [], pageTitle: '', error: 'no sourceId' }

  // ★ date 必须走路径（见 ⚠️①）
  const d = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`
  const url = `${BASE}/api/v1.0/program-list/${d}?channelId=${cid}`

  let j
  try {
    j = await getJson(url)
  } catch (e) {
    return { programmes: [], pageTitle: '', error: e.message }
  }

  const arr = Array.isArray(j.data) ? j.data : []
  const ch = CHANNELS.find((c) => c.id === cid)
  const pageTitle = ch ? ch.name : ''

  if (!arr.length) return { programmes: [], pageTitle, error: 'empty schedule' }

  // 先把有效条目挑出来，再统一补简介
  const items = []
  for (const x of arr) {
    if (!x.date || !x.title) continue
    // "2026-10-28 07:00:00" → 当作北京时间解析
    const ts = Date.parse(String(x.date).replace(' ', 'T') + '+08:00')
    if (!Number.isFinite(ts)) continue
    items.push({ ...x, _ts: ts })
  }
  items.sort((a, b) => a._ts - b._ts)

  // ★ 逐条补简介（见 ⚠️⑤）：只有 id 或 slug 存在的才请求
  await mapLimit(items, 5, async (x) => {
    const key = x.id ? `id:${x.id}` : x.slug ? `slug:${x.slug}` : ''
    if (!key) return
    if (_descCache.has(key)) {
      x._desc = _descCache.get(key)
      return
    }
    // slug 更稳（id 为 null 时节目单里仍可能有 slug）
    const ref = x.slug || x.id
    try {
      const dj = await getJson(`${BASE}/api/v1.0/program/${encodeURIComponent(ref)}`)
      const content = stripHtml(dj.data && dj.data.content)
      const title = String(dj.data && dj.data.title ? dj.data.title : x.title)
      // ★ 不复读标题（pitfalls §5.1）
      const desc = hasRealDesc(content, title) ? content : ''
      _descCache.set(key, desc)
      x._desc = desc
    } catch {
      _descCache.set(key, '')
      x._desc = ''
    }
  })

  // 算 stopTs：用下一条的开始时间；最后一条给 +1 小时兜底
  const rows = []
  for (let i = 0; i < items.length; i++) {
    const x = items[i]
    const next = items[i + 1]
    const stopTs = next ? next._ts : x._ts + 3600e3
    rows.push({
      startTs: x._ts,
      stopTs,
      title: String(x.title).trim(),
      desc: x._desc || '',
    })
  }

  return { programmes: rows, pageTitle }
}

/**
 * 频道清单
 *
 * ★ days / count / withDesc 必须逐日真探（pitfalls §6.7），不能外推：
 *   - webncode 硬编码 days=7 + count=0，把 Now新聞台 从「6天325条323简介」
 *     换成「5天273条133简介」，简介掉一半还不报错。
 *   - tdm 第一版按「单日条数 × 8 天」外推，自报 1520 条 / 实测 1177 条，虚高 29%。
 *     根因是窗口跟着今天滚动（今天-2 ~ 今天+5），从今天起探 8 天只能探到 6 天。
 *
 * ★★ 但「真探」还有个口径陷阱（第二次踩，见 pitfalls §6.7c）：
 *   TDM 的窗口含**过去** 2~3 天（10-25 就有数据），如果把这些也数进 `days`，
 *   会得到 9 天 > epgpw 的 7 天，于是在 pickBest 里以「天数最多」稳赢所有源——
 *   可那 3 天是**已经过去**的，产物根本不会用（build 从今天起覆盖 7 天）。
 *
 *   口径必须对齐 epgpw：**只数「今天及以后」的天数**。
 *   过去的天探还是要探（防止上游把今天的数据挂到昨天的 key 上时漏判），但不计入 days/count。
 *
 * 所以这里**逐日真探** 6 台 × 9 个日期，条数和简介数都是真数，但只累计未来部分。
 * 简介请求靠 `_descCache` 跨天复用（同一节目跨天只请求一次），实际开销远小于 9×40。
 */
export async function listChannels() {
  const out = []
  // 北京时间「今天」的 0 点，用来切「未来 / 过去」
  const todayYmd = new Date(Date.now() + 8 * 3600e3).toISOString().slice(0, 10).replace(/-/g, '')
  const dayList = []
  for (let i = -PROBE_BACK; i <= PROBE_AHEAD; i++) {
    const ts = Date.now() + 8 * 3600e3 + i * 86400e3
    dayList.push(new Date(ts).toISOString().slice(0, 10).replace(/-/g, ''))
  }

  for (const ch of CHANNELS) {
    if (!WITH_EPG.has(ch.id)) continue
    const dayset = new Set()
    let count = 0
    let withDesc = 0
    for (const ymd of dayList) {
      const isFuture = ymd >= todayYmd
      let r
      try {
        r = await getDayProgrammes(String(ch.id), 1, ymd)
      } catch (e) {
        log.warn(`[tdm] 探测 ${ch.name} ${ymd} 失败：${e.message}`)
        continue
      }
      if (!r.programmes.length) continue
      // ★ 过去的天只探不计数（口径对齐 epgpw，见上方 §6.7c）
      if (!isFuture) continue
      dayset.add(ymd)
      for (const p of r.programmes) {
        count++
        if (hasRealDesc(p.desc, p.title)) withDesc++
      }
    }
    out.push({
      source: 'tdm',
      region: 'MO',
      sourceId: String(ch.id),
      name: ch.name,
      logo: '',
      days: dayset.size,
      count,
      withDesc,
    })
  }

  const ok = out.filter((c) => c.days > 0).length
  const tot = out.reduce((s, c) => s + c.count, 0)
  const totD = out.reduce((s, c) => s + c.withDesc, 0)
  log.ok(`[tdm] ${ok}/${out.length} 个台有节目，共 ${tot} 条，其中 ${totD} 条有真简介（逐日真探，只计今天及以后）`)
  return out
}

export { log }
