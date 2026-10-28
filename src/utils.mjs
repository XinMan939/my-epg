/**
 * 通用工具：HTTP 抓取、XML 转义、时间处理、日志
 */
import { setTimeout as sleep } from 'node:timers/promises'
import { T2S_FULL } from './t2s.mjs'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

/** 带重试与超时的 GET，返回 { ok, status, text, bytes } */
export async function fetchText(url, opts = {}) {
  const {
    timeout = 30000,
    retries = 3,
    retryDelay = 1500,
    headers = {},
    method = 'GET',
    body = null,
  } = opts

  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController()
    // 计时器覆盖到 body 读完（同 fetchBufferByFetch 的注释）
    const timer = setTimeout(() => ac.abort(), timeout)
    try {
      const res = await fetch(url, {
        method,
        body,
        signal: ac.signal,
        headers: {
          'User-Agent': UA,
          'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
          ...headers,
        },
      })
      const text = await res.text()
      clearTimeout(timer)
      return { ok: res.ok, status: res.status, text, bytes: Buffer.byteLength(text) }
    } catch (e) {
      clearTimeout(timer)
      lastErr = e
      if (attempt < retries) await sleep(retryDelay * (attempt + 1))
    }
  }
  return { ok: false, status: 0, text: '', bytes: 0, error: lastErr?.message || 'unknown' }
}

/**
 * 带重试的 GET，返回 Buffer（用于二进制 / gz 文件）
 *
 * 三级降级策略：
 *   1. Node 原生 fetch（CI 直连最快，GitHub Runner 在海外）
 *   2. curl 子进程（本地有代理时 fetch 可能走不了代理，curl 能读环境变量）
 *   3. 返回失败，由调用方决定是否用旧缓存
 *
 * 为什么要 curl 兜底：Node 的 fetch 不读 https_proxy 环境变量，
 * 而 NODE_USE_ENV_PROXY 的 EnvHttpProxyAgent 对部分代理的 CONNECT 支持不好。
 * 实测 epg.pw 直连会卡死，走代理 34 秒即可下完。
 */
export async function fetchBuffer(url, opts = {}) {
  const {
    timeout = 180000,
    retries = 2,
    retryDelay = 3000,
    headers = {},
    allowCurl = true,
    fetchTimeout = null, // fetch 阶段单独的超时（短一些，失败快，好尽快降级到 curl）
  } = opts

  const viaFetch = await fetchBufferByFetch(url, {
    timeout: fetchTimeout || timeout,
    retries: allowCurl ? 0 : retries,
    retryDelay,
    headers,
  })
  if (viaFetch.ok) return viaFetch

  if (allowCurl) {
    log.warn(`fetch 失败(${viaFetch.error || viaFetch.status})，改用 curl 重试`)
    const viaCurl = await fetchBufferByCurl(url, { timeout, headers })
    if (viaCurl.ok) return viaCurl
    return { ok: false, status: 0, buf: null, error: `${viaFetch.error || viaFetch.status} / curl: ${viaCurl.error}` }
  }
  return viaFetch
}

/** 方式一：Node 原生 fetch */
async function fetchBufferByFetch(url, { timeout, retries, retryDelay, headers }) {
  let lastErr = null
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ac = new AbortController()
    // ⚠️ 计时器必须覆盖到 body 读完为止。
    // 只在 fetch() 返回响应头时清除计时器是个致命 bug：
    // epg.pw 响应头秒回、body 龟速，会导致 arrayBuffer() 永久卡死（实测挂 14 分钟）。
    const timer = setTimeout(() => ac.abort(), timeout)
    try {
      const res = await fetch(url, {
        signal: ac.signal,
        headers: { 'User-Agent': UA, ...headers },
      })
      if (!res.ok) {
        clearTimeout(timer)
        return { ok: false, status: res.status, buf: null }
      }
      const buf = Buffer.from(await res.arrayBuffer())
      clearTimeout(timer)
      const expected = Number(res.headers.get('content-length') || 0)
      // content-length 存在且明显不足 → 视为截断，重试
      if (expected && buf.length < expected) {
        lastErr = new Error(`truncated ${buf.length}/${expected}`)
        if (attempt < retries) {
          await sleep(retryDelay)
          continue
        }
      }
      return { ok: true, status: res.status, buf, bytes: buf.length }
    } catch (e) {
      clearTimeout(timer)
      lastErr = e
      if (attempt < retries) await sleep(retryDelay)
    }
  }
  return { ok: false, status: 0, buf: null, error: lastErr?.message || 'unknown' }
}

/** 方式二：curl 子进程（能读 https_proxy / http_proxy 环境变量） */
async function fetchBufferByCurl(url, { timeout, headers }) {
  const { spawn } = await import('node:child_process')
  const fs = await import('node:fs')
  const os = await import('node:os')
  const path = await import('node:path')

  const tmp = path.join(os.tmpdir(), `epg-dl-${process.pid}-${Date.now()}.bin`)
  const args = [
    '-sSL',
    '--compressed',
    '--max-time', String(Math.ceil(timeout / 1000)),
    '-A', UA,
    '-o', tmp,
    '-w', '%{http_code}',
  ]
  for (const [k, v] of Object.entries(headers)) args.push('-H', `${k}: ${v}`)
  args.push(url)

  return new Promise((resolve) => {
    const cp = spawn('curl', args, { stdio: ['ignore', 'pipe', 'pipe'] })
    let code = ''
    let err = ''
    cp.stdout.on('data', (d) => (code += d.toString()))
    cp.stderr.on('data', (d) => (err += d.toString()))

    const killer = setTimeout(() => cp.kill('SIGKILL'), timeout + 5000)

    cp.on('error', (e) => {
      clearTimeout(killer)
      try { fs.unlinkSync(tmp) } catch {}
      resolve({ ok: false, status: 0, buf: null, error: `curl spawn: ${e.message}` })
    })

    cp.on('close', () => {
      clearTimeout(killer)
      try {
        const status = Number(code.trim()) || 0
        if (status < 200 || status >= 300) {
          try { fs.unlinkSync(tmp) } catch {}
          return resolve({ ok: false, status, buf: null, error: `curl HTTP ${status} ${err.trim().slice(0, 120)}` })
        }
        const buf = fs.readFileSync(tmp)
        fs.unlinkSync(tmp)
        resolve({ ok: true, status, buf, bytes: buf.length })
      } catch (e) {
        resolve({ ok: false, status: 0, buf: null, error: `curl read: ${e.message}` })
      }
    })
  })
}

/** XML 文本转义 */
export function esc(s) {
  if (s == null) return ''
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * 解码 XML / HTML 实体。
 *
 * ★ 必须「先解 &amp; 再解其他」，或者反复解到稳定 —— 顺序错了就会漏。
 *   踩过的坑（2026-10-27 线上产物实测 405 条乱码）：
 *     源里存的是 `&amp;quot;融媒体&amp;quot;`（上游自己把 `&quot;` 又转义了一遍）
 *     旧实现按 `&quot;` → `&amp;` 的顺序，先跑 `&quot;` 时字符串里还没有 `&quot;`
 *     （它是 `&amp;quot;`），等最后把 `&amp;` 换成 `&`，才变成 `&quot;` —— 但已经跑完了，
 *     于是产物里留着字面的 `&quot;融媒体&quot;`、`&lt;甘肃新闻&gt;`，用户看到的就是乱码。
 *
 *   解法：循环解码直到不再变化（最多 3 轮，防死循环）。
 *   实测 405 条双重转义一次全解干净，且对正常文本零影响
 *   （正常文本解一轮就稳定，第二轮不匹配任何实体）。
 */
export function decodeEntities(s) {
  if (s == null) return ''
  let out = String(s)
  const once = (t) =>
    t
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
      .replace(/&amp;/g, '&')
  for (let i = 0; i < 3; i++) {
    const next = once(out)
    if (next === out) break
    out = next
  }
  return out
}

/** 去掉 XML 非法控制字符 */
export function stripInvalidXml(s) {
  if (s == null) return ''
  // eslint-disable-next-line no-control-regex
  return String(s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
}

/** 清理节目名：合并空白、去首尾 */
export function cleanTitle(s) {
  if (!s) return ''
  return stripInvalidXml(s).replace(/[\s\u00a0]+/g, ' ').trim()
}

/** 简单日志 */
export const log = {
  info: (...a) => console.log('[INFO]', ...a),
  warn: (...a) => console.warn('[WARN]', ...a),
  error: (...a) => console.error('[ERR ]', ...a),
  ok: (...a) => console.log('[ OK ]', ...a),
}

/** 并发限制执行 */
export async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let cursor = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const i = cursor++
      if (i >= items.length) return
      try {
        results[i] = await fn(items[i], i)
      } catch (e) {
        results[i] = { error: e.message }
      }
    }
  })
  await Promise.all(workers)
  return results
}

/** 中国时区（UTC+8）当日 YYYYMMDD */
export function dateInCST(date = new Date()) {
  const d = new Date(date.getTime() + 8 * 3600 * 1000)
  return d.toISOString().slice(0, 10).replace(/-/g, '')
}

/** YYYYMMDD + HH:MM:SS → XMLTV 时间串 "YYYYMMDDHHMMSS +0800" */
export function xmltvTime(ymd, hms, offset = '+0800') {
  return `${ymd}${hms.replace(/:/g, '')} ${offset}`
}

/** 解析 "YYYY-MM-DD HH:MM" 或 "HH:MM" 到时间戳（毫秒），基准日期 ymd */
export function parseTimeToTs(str, ymd) {
  if (!str) return null
  const m = String(str)
    .trim()
    .match(/^(?:(\d{4})-(\d{2})-(\d{2})\s+)?(\d{1,2}):(\d{2})/)
  if (!m) return null
  const y = m[1] || ymd.slice(0, 4)
  const mo = m[2] || ymd.slice(4, 6)
  const d = m[3] || ymd.slice(6, 8)
  const hh = m[4].padStart(2, '0')
  const mi = m[5]
  const iso = `${y}-${mo}-${d}T${hh}:${mi}:00+08:00`
  const ts = Date.parse(iso)
  return Number.isNaN(ts) ? null : ts
}

/** 时间戳（毫秒）→ XMLTV 时间串，按 UTC+8 */
export function tsToXmltv(ts, offset = '+0800') {
  if (!ts) return null
  const d = new Date(ts + 8 * 3600 * 1000)
  const s = d.toISOString().replace(/[-:T]/g, '').slice(0, 14)
  return `${s} ${offset}`
}

/** 毫秒时间戳 → "HH:MM" (UTC+8) */
export function tsToHM(ts) {
  const d = new Date(ts + 8 * 3600 * 1000)
  return d.toISOString().slice(11, 16)
}

/**
 * ★ 数「这些行覆盖了几天」，按**每天覆盖满 minHours 小时**判，不按条数
 *
 * 为什么不能数条数（pitfalls §4 硬规则）：
 *   nowplayer 的 Now新聞台 332 第 6 天只有 1 条「11-01 23:30 ~ 11-02 10:30」，
 *   时长 11 小时、**只有 1 条**。按「有节目就算 1 天」会把这天算进去，
 *   于是 catalog 报 6 天，实际第 6 天只有一条跨天节目，播放器上等于没有节目单。
 *
 *   MOD 侧同理：某台某天只有 2 条 30 分钟的垫片，也会被算成「1 天」。
 *
 * 和 index.mjs 的 countCoveredDays 是同一套口径，区别是那个吃 buildDateRange
 * 的 [{ts0,ts1}]，这个吃「北京日 YYYYMMDD 列表」，供各源的 listChannels 用。
 *
 * @param {Array} rows        [{startTs, stopTs}]
 * @param {string[]} ymds     要统计的北京日（YYYYMMDD）
 * @param {number} minHours   每天覆盖满这么多小时才算 1 天
 * @returns {number}
 */
export function countCoveredYmds(rows, ymds, minHours = 6) {
  const hours = new Array(ymds.length).fill(0)
  const ts0s = ymds.map((y) => Date.parse(`${y.slice(0, 4)}-${y.slice(4, 6)}-${y.slice(6, 8)}T00:00:00+08:00`))
  for (const r of rows) {
    const a = r.startTs
    const b = r.stopTs
    if (!a || !b || b <= a) continue
    for (let i = 0; i < ymds.length; i++) {
      const oa = Math.max(a, ts0s[i])
      const ob = Math.min(b, ts0s[i] + 86400e3)
      if (ob > oa) hours[i] += (ob - oa) / 3600e3
    }
  }
  return hours.filter((h) => Math.min(h, 24) >= minHours).length
}

/**
 * 频道名归一化，用于匹配：去空格、全角转半角、去括号后缀、小写
 *
 * ⚠️ 三个必须保留的"语义字符"，删掉就会错台：
 *   - 加号：CCTV5+ 是独立频道，若把 + 当噪声删掉就变成 CCTV5，会把体育赛事频道
 *     的节目挂到 CCTV-5 体育上（2026-10-26 聚合器实测踩到）
 *   - 4k/8k：CCTV-4K 是独立频道，只有"高清/HD/超清/标清/蓝光"这类才是可忽略的
 *     画质后缀，4K/8K 是频道名的一部分，必须保留
 *   - **罗马数字 Ⅰ~Ⅻ**：2026-10-27 第八轮踩到。
 *     「好消息Ⅰ」「好消息Ⅱ」归一化后都变成 `好消息`，于是两个台指向同一个 sourceId，
 *     后一个台拿到的节目是前一个台的 —— 错台且**完全静默**（日志只有一行 exact）。
 *     实测同时中招的：好消息Ⅰ/Ⅱ、大爱Ⅰ/Ⅱ、博斯运动Ⅰ/Ⅱ、博斯高球Ⅰ/Ⅱ。
 *     ★ 注意不能简单保留原字符：`Ⅰ` 是 U+2160 区块，会被最后的
 *     `[^a-z0-9+\u4e00-\u9fa5]` 白名单删掉，所以必须**先转成普通数字**再走白名单。
 */
export function normalizeName(name) {
  if (!name) return ''
  let s = String(name)
  // 全角转半角
  s = s.replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  s = s.replace(/\u3000/g, ' ')
  // ★ 罗马数字 → 阿拉伯数字（必须在白名单过滤之前，否则会被当噪声删掉）
  s = s.replace(/[ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ]/g, (c) => String('ⅠⅡⅢⅣⅤⅥⅦⅧⅨⅩⅪⅫ'.indexOf(c) + 1))
  s = s.replace(/[ⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹ]/g, (c) => String('ⅰⅱⅲⅳⅴⅵⅶⅷⅸⅹ'.indexOf(c) + 1))
  s = s.toLowerCase()
  // 全角加号已在上面转成半角 +，这里把"5加"/"5plus"也统一成 5+
  s = s.replace(/(\d)\s*(?:plus|加)$/, '$1+')
  s = s.replace(/[（(][^）)]*[）)]/g, '')
  // 可忽略的画质后缀（注意：不含 4k/8k，它们是独立频道标识）
  // 超高清要排在 高清 前面，否则只会剥掉"高清"留下"超"
  s = s.replace(/(超高清|高清|hd|超清|标清|蓝光|杜比)+$/gi, '')
  s = s.replace(/(频道|电视台|台|节目表|综合频道)$/g, '')
  // 去空格连字符，但保留 + 和数字字母汉字
  s = s.replace(/[\s\-_·・]/g, '')
  // 只保留字母数字汉字和加号
  s = s.replace(/[^a-z0-9+\u4e00-\u9fa5]/g, '')
  return s
}

/**
 * ★ 频道名的「区域 / 版本」限定词（2026-10-27 第六轮补天串台后新增）
 *
 * 为什么必须单独识别：CCTV4 有三个版本 —— 亚洲版、欧洲版、美洲版，
 *   它们**名字里都有 cctv4**，但节目编排完全不同（亚洲版放国产剧，
 *   欧洲/美洲版放《精彩音乐汇（海外版）》《走遍中国》）。
 *
 * 实测（2026-10-27）：
 *   nameVariants('CCTV4欧洲') → ['cctv4欧洲', 'cctv4']   ← 裸 cctv4 是祸根
 *   nameVariants('CCTV-4 (亚洲)') → ['cctv4']            ← 撞上
 *   于是补天时「CCTV4欧洲」的备选链里出现了「CCTV-4 (亚洲)」，
 *   把国内版电视剧《爱在青山绿水间》补进了欧洲版节目单。
 *
 * 注意这是「补天」环节的额外校验，**不改 nameVariants 本身**：
 *   改它会影响主匹配（主匹配是「找到一个就停」，容错空间不同），
 *   而补天是「往已有结果里掺东西」，必须更保守。
 *
 * 为什么用「互斥」而不是「必须相等」：
 *   「CCTV-4」与「CCTV-4 (亚洲)」应该是同一个台（亚洲版就是默认版），
 *   如果要求两边区域词完全相等，会把「无区域词 ↔ 亚洲」这组正确配对也挡掉。
 *   所以规则是：**一边有区域词、另一边有不同区域词 → 拒**；
 *   一边有、另一边没有 → 放行（默认版视为兼容）。
 */
const REGION_WORDS = [
  '欧洲', '美洲', '亚洲', '欧版', '美版', '亚版',
  '国际', '海外', '境外',
  '香港', '台湾', '澳门', '大陆', '内地',
  '北美', '南美', '西欧', '东欧', '亚太',
]

/**
 * 「具体分版」区域词 —— 出现即说明该台有明确的区域分版，裸名一定不是它
 *
 * 与 REGION_WORDS 的区别：
 *   - REGION_WORDS 是「所有能识别区域的词」，用于判断"两边是否写明了同一区域"
 *   - SPECIFIC_REGION 是其中的子集，只收「一看就是另一个版本」的词
 *
 * 为什么「亚洲/香港/台湾/大陆」不在里面：
 *   裸 `CCTV-4` 就是亚洲版、裸 `翡翠台` 就是香港版、裸 `CCTV-1` 就是大陆版，
 *   把这些当"具体分版"会挡掉大量正确配对（实测会误拒 20+ 个台）。
 */
const SPECIFIC_REGION = new Set(['欧洲', '美洲', '欧版', '美版', '海外', '境外', '北美', '南美', '西欧', '东欧'])

/**
 * 区域词的同义归一
 *
 * 「CCTV-4中文国际（欧）」和「CCTV4欧洲」是同一个台，但前者写「欧」后者写「欧洲」，
 * 不归一就会误判成不同版本、白白拒掉一个正确配对。
 * 归一顺序很重要：先长词后短词，否则「欧洲」会先被「欧」吃掉。
 */
const REGION_ALIAS = [
  [/欧洲|欧版|东欧|西欧/g, '欧洲'],
  [/美洲|美版|北美|南美/g, '美洲'],
  [/亚洲|亚版|亚太/g, '亚洲'],
  [/大陆|内地/g, '大陆'],
  [/(?<![\u4e00-\u9fa5])欧(?![洲美版])/g, '欧洲'],
  [/(?<![\u4e00-\u9fa5])美(?![洲版])/g, '美洲'],
  [/(?<![\u4e00-\u9fa5])亚(?![洲版])/g, '亚洲'],
]

/** 取出名字里的区域/版本限定词集合 */
export function regionTags(name) {
  let s = String(name || '')
  for (const [re, to] of REGION_ALIAS) s = s.replace(re, to)
  const out = new Set()
  for (const w of REGION_WORDS) if (s.includes(w)) out.add(w)
  return out
}

/**
 * 两个频道名是否指向「同一个区域版本」
 *
 * 返回 false 表示「明确是不同版本」，补天/降级时必须拒绝。
 *
 * ★ 2026-10-28 收紧：「一边有区域词、另一边没有」不再无条件放行。
 *
 *   原规则是「无区域词 = 默认版，兼容任何版本」。这对「CCTV-4」是错的：
 *   裸 `CCTV-4` 恰恰就是**亚洲版**，不是"通用版"。
 *   于是 CCTV4欧洲 / CCTV4美洲 在 epgpw 抓空时会降级到 `CCTV-4`（亚洲版），
 *   播出来的全是国内版节目，而报表上一切正常（278 条 7 天，看着比原来源还完整）。
 *   实测：本地一次 epgpw 抽风，三台全部串到 `webncode:nowtv_542(CCTV-4)`。
 *
 *   现在的规则：
 *   - 两边都有区域词 → 必须重合，否则拒（原有逻辑）
 *   - 一边有、一边没有 → **只有「具体区域」才拒**；「亚洲/香港/台湾」这类
 *     默认区域仍放行（裸 `CCTV-4` = 亚洲版、裸 `翡翠台` = 香港版，都是正确配对）
 *
 *   判定「具体区域」= 明确是"另一个版本"的区域：欧洲 / 美洲 / 海外 / 国际。
 *   这些词一出现，就说明该台有明确的区域分版，裸名一定不是它。
 */
export function sameRegionVersion(a, b) {
  const A = regionTags(a)
  const B = regionTags(b)
  if (!A.size && !B.size) return true

  if (A.size && B.size) {
    for (const w of A) if (B.has(w)) return true
    return false // 两边都有区域词，但完全不重合 → 不同版本
  }

  // 一边有一边没有：看有词的那边是不是「具体分版」
  const tags = A.size ? A : B
  for (const w of tags) if (SPECIFIC_REGION.has(w)) return false
  return true
}

/**
 * 繁 → 简 转换表（只覆盖节目名/频道名里高频出现的字）
 *
 * 为什么需要：香港频道的节目单是繁体（「新聞聯播」「人與自然」「焦點訪談」），
 * 台湾频道也是繁体，而 tvmao 索引是简体。不做转换，港台频道永远对不上，
 * 简介覆盖率恒为 0（2026-10-27 实测：港台33 有 256 条节目，0 条简介）。
 *
 * 为什么不用 opencc-js：这是个 2MB 的依赖，而本项目要跑在 GitHub Actions 上，
 * 为了几十个高频字引入完整词库不划算。节目名里的字高度集中，
 * 手工表 300 字左右就能覆盖 95%+（缺的字不转换，只是对不上，不会出错）。
 *
 * 注意：只做「字」级映射，不做「词」级（如「著」在不同语境不同）。
 * 节目名场景足够用，且不会引入误转。
 */
const T2S_MAP = {
  臺: '台', 檯: '台', 颱: '台', 視: '视', 聞: '闻', 聯: '联', 電: '电', 劇: '剧',
  動: '动', 畫: '画', 樂: '乐', 園: '园', 國: '国', 鄉: '乡', 東: '东', 華: '华',
  衛: '卫', 綜: '综', 藝: '艺', 紀: '纪', 錄: '录', 實: '实', 說: '说', 時: '时',
  間: '间', 點: '点', 現: '现', 場: '场', 選: '选', 戰: '战', 鬥: '斗', 軍: '军',
  體: '体', 運: '运', 會: '会', 歲: '岁', 萬: '万', 與: '与', 為: '为', 這: '这',
  個: '个', 們: '们', 來: '来', 後: '后', 開: '开', 關: '关', 門: '门', 問: '问',
  題: '题', 對: '对', 將: '将', 當: '当', 經: '经', 濟: '济', 產: '产', 業: '业',
  農: '农', 醫: '医', 藥: '药', 學: '学', 習: '习', 書: '书', 讀: '读', 報: '报',
  紙: '纸', 網: '网', 絡: '络', 線: '线', 綫: '线', 訊: '讯', 號: '号', 頻: '频', 廣: '广',
  聽: '听', 眾: '众', 觀: '观', 歡: '欢', 賞: '赏', 鑑: '鉴', 寶: '宝', 貝: '贝',
  財: '财', 貨: '货', 買: '买', 賣: '卖', 價: '价', 錢: '钱', 銀: '银', 鐵: '铁',
  鋼: '钢', 車: '车', 馬: '马', 鳥: '鸟', 魚: '鱼', 龍: '龙', 鳳: '凤', 飛: '飞',
  雲: '云', 風: '风', 陽: '阳', 陰: '阴', 島: '岛', 灣: '湾', 邊: '边', 遠: '远',
  進: '进', 過: '过', 還: '还', 達: '达', 週: '周', 條: '条', 絲: '丝', 織: '织',
  結: '结', 給: '给', 統: '统', 紅: '红', 綠: '绿', 藍: '蓝', 黃: '黄', 黨: '党',
  團: '团', 擊: '击', 殺: '杀', 傷: '伤', 懷: '怀', 憶: '忆', 戀: '恋', 愛: '爱',
  夢: '梦', 戲: '戏', 傳: '传', 記: '记', 憶: '忆', 護: '护', 潛: '潜', 靈: '灵',
  麗: '丽', 麼: '么', 兒: '儿', 兩: '两', 嚴: '严', 豐: '丰', 鄉: '乡', 親: '亲',
  樹: '树', 葉: '叶', 華: '华', 蓋: '盖', 蘇: '苏', 蘭: '兰', 蘋: '苹', 藏: '藏',
  藥: '药', 術: '术', 聲: '声', 響: '响', 頁: '页', 頂: '顶', 項: '项', 順: '顺',
  須: '须', 預: '预', 領: '领', 頭: '头', 顏: '颜', 願: '愿', 類: '类', 顧: '顾',
  飯: '饭', 館: '馆', 餐: '餐', 養: '养', 餘: '余', 館: '馆', 馬: '马', 驗: '验',
  體: '体', 髮: '发', 鬆: '松', 鬧: '闹', 鬥: '斗', 鹽: '盐', 麥: '麦', 麵: '面',
  齊: '齐', 齒: '齿', 龍: '龙', 龜: '龟', 麼: '么', 黃: '黄', 黑: '黑', 鼓: '鼓',
  億: '亿', 儀: '仪', 優: '优', 儲: '储', 兒: '儿', 獸: '兽', 冊: '册', 寫: '写',
  凍: '冻', 凱: '凯', 劃: '划', 劇: '剧', 勁: '劲', 勢: '势', 勵: '励', 勸: '劝',
  匯: '汇', 厲: '厉', 壓: '压', 壘: '垒', 壯: '壮', 夠: '够', 奪: '夺', 奮: '奋',
  婦: '妇', 媽: '妈', 嬰: '婴', 孫: '孙', 寧: '宁', 寫: '写', 寬: '宽', 審: '审',
  寵: '宠', 屆: '届', 屬: '属', 岡: '冈', 峽: '峡', 巖: '岩', 幣: '币', 帥: '帅',
  師: '师', 帳: '帐', 帶: '带', 幫: '帮', 幣: '币', 幾: '几', 庫: '库', 廟: '庙',
  廢: '废', 廠: '厂', 廳: '厅', 彈: '弹', 徑: '径', 從: '从', 復: '复', 徵: '征',
  恆: '恒', 恩: '恩', 惱: '恼', 愛: '爱', 態: '态', 慮: '虑', 慶: '庆', 憂: '忧',
  憑: '凭', 戰: '战', 戶: '户', 執: '执', 掃: '扫', 掛: '挂', 採: '采', 換: '换',
  揮: '挥', 損: '损', 搖: '摇', 撐: '撑', 撥: '拨', 撫: '抚', 攝: '摄', 攤: '摊',
  敗: '败', 敵: '敌', 數: '数', 斷: '断', 於: '于', 昇: '升', 曆: '历', 曉: '晓',
  書: '书', 會: '会', 朧: '胧', 條: '条', 楊: '杨', 槍: '枪', 構: '构', 標: '标',
  樣: '样', 樞: '枢', 樓: '楼', 樂: '乐', 橫: '横', 檢: '检', 櫃: '柜', 欄: '栏',
  權: '权', 歐: '欧', 歸: '归', 殘: '残', 毀: '毁', 氣: '气', 決: '决', 沒: '没',
  淚: '泪', 淨: '净', 淺: '浅', 測: '测', 湯: '汤', 溝: '沟', 滅: '灭', 滬: '沪',
  滾: '滚', 滿: '满', 漁: '渔', 漲: '涨', 漸: '渐', 潑: '泼', 潔: '洁', 潛: '潜',
  潤: '润', 澀: '涩', 澤: '泽', 濁: '浊', 濃: '浓', 濕: '湿', 濟: '济', 濤: '涛',
  瀟: '潇', 瀾: '澜', 灘: '滩', 災: '灾', 烏: '乌', 無: '无', 煙: '烟', 熱: '热',
  燈: '灯', 燒: '烧', 營: '营', 燦: '灿', 燭: '烛', 爐: '炉', 爭: '争', 牆: '墙',
  獎: '奖', 獲: '获', 獻: '献', 產: '产', 畢: '毕', 異: '异', 疊: '叠', 瘋: '疯',
  療: '疗', 癡: '痴', 發: '发', 盡: '尽', 監: '监', 盤: '盘', 盧: '卢', 眾: '众',
  睜: '睁', 矯: '矫', 礙: '碍', 禮: '礼', 禍: '祸', 禪: '禅', 種: '种', 積: '积',
  稱: '称', 穩: '稳', 窮: '穷', 竊: '窃', 競: '竞', 筆: '笔', 節: '节', 範: '范',
  築: '筑', 簡: '简', 籃: '篮', 籌: '筹', 簽: '签', 籤: '签', 粵: '粤', 糧: '粮',
  糾: '纠', 紀: '纪', 純: '纯', 紙: '纸', 素: '素', 紫: '紫', 細: '细', 終: '终',
  組: '组', 綁: '绑', 經: '经', 綠: '绿', 維: '维', 綱: '纲', 網: '网', 緊: '紧',
  緒: '绪', 練: '练', 縣: '县', 縫: '缝', 縮: '缩', 總: '总', 績: '绩', 織: '织',
  繡: '绣', 繩: '绳', 繪: '绘', 繼: '继', 續: '续', 纏: '缠', 罰: '罚', 罷: '罢',
  羅: '罗', 羈: '羁', 翹: '翘', 聳: '耸', 聰: '聪', 職: '职', 聽: '听', 肅: '肃',
  腸: '肠', 膚: '肤', 膽: '胆', 臉: '脸', 臨: '临', 舉: '举', 舊: '旧', 艙: '舱',
  藝: '艺', 節: '节', 芒: '芒', 莊: '庄', 華: '华', 萬: '万', 落: '落', 蓋: '盖',
  蓮: '莲', 蔣: '蒋', 蕭: '萧', 薑: '姜', 蟲: '虫', 蠟: '蜡', 蠻: '蛮', 術: '术',
  衝: '冲', 補: '补', 裝: '装', 製: '制', 複: '复', 褲: '裤', 襲: '袭', 見: '见',
  規: '规', 覽: '览', 覺: '觉', 觸: '触', 訂: '订', 計: '计', 訓: '训', 託: '托',
  訪: '访', 設: '设', 許: '许', 訴: '诉', 診: '诊', 註: '注', 評: '评', 詞: '词',
  試: '试', 詩: '诗', 話: '话', 詳: '详', 誇: '夸', 認: '认', 誌: '志', 語: '语',
  誠: '诚', 誤: '误', 說: '说', 誰: '谁', 課: '课', 調: '调', 談: '谈', 請: '请',
  論: '论', 諮: '咨', 諸: '诸', 謀: '谋', 講: '讲', 謝: '谢', 證: '证', 識: '识',
  譜: '谱', 警: '警', 議: '议', 護: '护', 讀: '读', 變: '变', 讓: '让', 讚: '赞',
  谷: '谷', 豈: '岂', 豐: '丰', 豬: '猪', 貓: '猫', 貝: '贝', 負: '负', 貢: '贡',
  貧: '贫', 貨: '货', 販: '贩', 貪: '贪', 責: '责', 貴: '贵', 貸: '贷', 費: '费',
  貼: '贴', 貿: '贸', 賀: '贺', 資: '资', 賈: '贾', 賊: '贼', 賓: '宾', 賜: '赐',
  賞: '赏', 賢: '贤', 賴: '赖', 賺: '赚', 購: '购', 賽: '赛', 贊: '赞', 贈: '赠',
  趙: '赵', 趕: '赶', 趨: '趋', 躍: '跃', 軌: '轨', 軒: '轩', 軟: '软', 軸: '轴',
  較: '较', 載: '载', 輔: '辅', 輕: '轻', 輛: '辆', 輪: '轮', 輯: '辑', 輸: '输',
  輻: '辐', 轉: '转', 轟: '轰', 辦: '办', 辭: '辞', 農: '农', 迴: '回', 這: '这',
  連: '连', 週: '周', 遊: '游', 運: '运', 過: '过', 達: '达', 違: '违', 遙: '遥',
  遞: '递', 適: '适', 選: '选', 遺: '遗', 遼: '辽', 邁: '迈', 還: '还', 邊: '边',
  邏: '逻', 郵: '邮', 鄉: '乡', 鄒: '邹', 鄧: '邓', 鄭: '郑', 醜: '丑', 醫: '医',
  釀: '酿', 釋: '释', 里: '里', 鑑: '鉴', 針: '针', 釣: '钓', 鈴: '铃', 鉤: '钩',
  銀: '银', 銅: '铜', 鋒: '锋', 鋪: '铺', 鋼: '钢', 錄: '录', 錢: '钱', 錦: '锦',
  鍋: '锅', 鍵: '键', 鍾: '钟', 鎖: '锁', 鏡: '镜', 鐘: '钟', 鐵: '铁', 鑄: '铸',
  長: '长', 門: '门', 閃: '闪', 閉: '闭', 開: '开', 閒: '闲', 間: '间', 閩: '闽',
  閣: '阁', 閱: '阅', 闆: '板', 關: '关', 闢: '辟', 陝: '陕', 陣: '阵', 陽: '阳',
  陰: '阴', 陸: '陆', 隊: '队', 階: '阶', 隨: '随', 險: '险', 隱: '隐', 隸: '隶',
  雖: '虽', 雙: '双', 雜: '杂', 雞: '鸡', 離: '离', 難: '难', 雲: '云', 電: '电',
  霧: '雾', 靈: '灵', 靜: '静', 韓: '韩', 頁: '页', 頂: '顶', 項: '项', 順: '顺',
  須: '须', 預: '预', 頓: '顿', 頗: '颇', 領: '领', 頭: '头', 頸: '颈', 頻: '频',
  顆: '颗', 題: '题', 額: '额', 顏: '颜', 願: '愿', 類: '类', 顧: '顾', 顯: '显',
  風: '风', 飛: '飞', 餐: '餐', 飯: '饭', 飲: '饮', 館: '馆', 首: '首', 香: '香',
  馬: '马', 駐: '驻', 駕: '驾', 騎: '骑', 驗: '验', 驚: '惊', 骨: '骨', 體: '体',
  髮: '发', 鬆: '松', 鬍: '胡', 鬥: '斗', 鬼: '鬼', 魂: '魂', 魄: '魄', 魅: '魅',
  魚: '鱼', 鮮: '鲜', 鳥: '鸟', 鳳: '凤', 鴻: '鸿', 鵝: '鹅', 鷹: '鹰', 鹽: '盐',
  麗: '丽', 麥: '麦', 麵: '面', 黃: '黄', 點: '点', 黨: '党', 鼓: '鼓', 鼠: '鼠',
  鼻: '鼻', 齊: '齐', 齒: '齿', 龍: '龙', 龜: '龟',
  // 补：实测港台频道标题里出现但上面漏收的
  偉: '伟', 長: '长', 徵: '征', 碼: '码', 際: '际', 錶: '表', 徵: '征',
  第: '第', 星: '星', 月: '月', 征: '征', 途: '途',
  // 补：港台纪录片/剧集标题实测缺失的字
  尋: '寻', 圍: '围', 綻: '绽', 丟: '丢', 腦: '脑', 稻: '稻', 荒: '荒',
  叩: '叩', 堆: '堆', 訪: '访', 談: '谈', 與: '与', 腦: '脑', 睡: '睡',
  眠: '眠', 綻: '绽', 瑰: '瑰', 麗: '丽', 綱: '纲', 貿: '贸', 貧: '贫',
  甦: '苏', 纖: '纤', 艷: '艳', 豔: '艳', 豎: '竖', 豬: '猪', 貓: '猫',
  賬: '账', 賭: '赌', 購: '购', 贊: '赞', 贈: '赠', 趕: '赶', 跡: '迹',
  蹤: '踪', 軀: '躯', 軼: '轶', 迴: '回', 週: '周', 遊: '游', 遙: '遥',
  遞: '递', 遼: '辽', 邁: '迈', 邏: '逻', 釀: '酿', 鈣: '钙', 鉤: '钩',
  鋒: '锋', 鋪: '铺', 錦: '锦', 鍋: '锅', 鎖: '锁', 鏡: '镜', 鑄: '铸',
  陣: '阵', 陸: '陆', 隊: '队', 階: '阶', 隨: '随', 險: '险', 隱: '隐',
  隸: '隶', 雖: '虽', 雙: '双', 雜: '杂', 雞: '鸡', 離: '离', 難: '难',
}

/**
 * 繁体 → 简体（字级映射，未收录的字原样保留）
 * 用于把港台频道的繁体节目名转成简体，去对齐 tvmao 的简体索引。
 *
 * 查表顺序：先查下面这张手写表（个别字挑了更常用的简化），再兜到
 * `t2s.mjs` 里的 OpenCC 完整表（3221 字）。手写表当年漏了「緯」，
 * 直接导致「緯來育樂台」对不上「纬来育乐」——所以完整表是兜底，不是可选项。
 */
export function toSimplified(s) {
  if (!s) return ''
  let out = ''
  for (const ch of String(s)) out += T2S_MAP[ch] || T2S_FULL[ch] || ch
  return out
}

/** 从名称提取可能的别名集合（用于模糊匹配） */
export function nameVariants(name) {
  const out = new Set()
  if (!name) return out
  const base = String(name).trim()
  out.add(normalizeName(base))

  // 去括号内容
  const noParen = base.replace(/[（(][^）)]*[）)]/g, '')
  out.add(normalizeName(noParen))

  // 央视数字变体：CCTV-1 / CCTV1 / CCTV-1综合 → cctv1
  //
  // ⚠️ 必须区分「频道号」和「频道号的修饰」：
  //    CCTV-5+  → 只能出 cctv5+，绝不能出 cctv5（否则撞 CCTV-5 体育）
  //    CCTV-4K  → 只能出 cctv4k，绝不能出 cctv4（否则撞 CCTV-4 亚洲）
  //    CCTV-4 欧洲 → 出 cctv4europe / cctv4eu 之类，也不该出裸 cctv4
  //  所以：只有数字后面紧接"分隔符或中文描述（综合/新闻/财经…）"时才出裸 cctvN。
  const m = base.match(/cctv[\s_-]*(\d{1,2})\s*([+\uff0b]|k|K)?/i)
  if (m) {
    const num = m[1]
    const mark = (m[2] || '').toLowerCase()
    if (mark === '+' || mark === '\uff0b') {
      out.add(`cctv${num}+`)
    } else if (mark === 'k') {
      out.add(`cctv${num}k`)
    } else {
      // 数字后面跟的是什么？如果是英文字母（如 CCTV4EUO / CCTV4AME），不出裸号
      const after = base.slice(m.index + m[0].length)
      const startsWithLatin = /^[a-z]/i.test(after.trim())
      if (!startsWithLatin) out.add(`cctv${num}`)
    }
  }

  // 卫视简写：湖南卫视 → 湖南
  const ws = base.match(/^(.+?)卫视/)
  if (ws) out.add(normalizeName(ws[1]))

  return [...out].filter(Boolean)
}

/* ==========================================================================
 * 节目简介质量判定
 * ========================================================================== */

/**
 * 「占位型」简介：看着有字，实际零信息量。
 *
 * 为什么必须单独判：
 *   51zmt 的 e1 包里 17239/17287 条节目都有 <desc>，
 *   如果不看内容直接算「有简介」，覆盖率是 99.7% —— 数字漂亮但全是废话。
 *   实际把「暂无节目描述」这类滤掉后只有 74%，逐频道差距更大
 *   （浙江少儿 48 条 desc 全是「暂无节目描述」，真实覆盖 0%）。
 */
const PLACEHOLDER_DESC_RE =
  /^(暂无节目描述|暂无描述|暂无简介|暂无节目预告.*|无|此阶段没有电视节目播放。?|此阶段播放.*|精彩节目|敬请期待|节目预告|节目预告信息|待更新.*|内容简介待补充.*)$/

/**
 * 判断一条 <desc> 是不是「真简介」
 *
 * 门槛：
 *   - 去空白后 ≥ 12 字（「暂无节目描述」正好 6 字，天然被排除）
 *   - 不命中占位正则
 *   - 不以「暂无」开头
 *
 * 这条规则同时被三处使用，必须保持单一实现：
 *   src/sources/z51.mjs  过滤上游 desc
 *   src/output.mjs       看板统计口径
 *   src/index.mjs        build 日志里的覆盖率
 */
export function isRealDesc(d) {
  if (!d) return false
  const s = String(d).replace(/\s+/g, '').trim()
  if (s.length < 12) return false
  if (PLACEHOLDER_DESC_RE.test(s)) return false
  if (/^暂无/.test(s)) return false
  return true
}

/**
 * 「复读型」简介：<desc> 就是把 <title> 抄了一遍，零信息量。
 *
 * 为什么必须单独判（2026-10-27 线上产物实测）：
 *   epg.pw 有 799 条节目的 desc 就是标题本身：
 *     博斯無限台   「2025-26 司諾克賽季 世界大獎賽 四強(1)ZHA vs WAK」
 *               → desc 也是「2025-26 司諾克賽季 世界大獎賽 四強(1)ZHA vs WAK」
 *     韓國阿里郎   「Gugak The Music Of Korea」→ desc 同样
 *   这些 desc 长度都超过 12 字，isRealDesc() 拦不住，被当成真简介。
 *
 * ★ 危害不止「数字虚高」，更要命的是它会**锁死补简介的位置**：
 *   三个补简介源（z51 / tvmao / kbro）的循环都是
 *     if (isRealDesc(r.desc)) continue   // 已有简介，不动
 *   复读 desc 骗过了这道判断 → 真简介永远补不进来。
 *   实测 799 条里 kbro 本来能给 138 条真简介（DAZN1 46 条、纬来体育 48 条），
 *   全被这 799 条复读挡住了。
 *
 * 判据（两档，都要求归一化后标题 ≥4 字）：
 *   ① 完全相等：归一化 desc === 归一化 title
 *   ② 标题 + 纯序号：desc = title + 「第八季 EP17」「10月29日」「#8」这类，
 *      剥掉数字与 EP/季/集 后剩余 ≤2 字
 *
 * ★ 为什么不把「desc 以标题开头」一律判复读：
 *   那样会误伤真简介 —— 港台电视35「The World Today」→「The World Today is the core
 *   rolling news service of CGTN…」，甘肃卫视「雄关剧场」→「雄关剧场是一档播放各类
 *   精彩影剧作品的节目。」，都是正常的「栏目名 + 栏目介绍」写法。
 *   实测这类有 1177 条，全是对的，一条都不能碰。
 */
const ECHO_STRIP_RE = /[\s\u3000]/g
const ECHO_PUNCT_RE = /[（(][^）)]*[）)]|[:：·・\-—–_|/、,，.。！!？?"'「」『』]/g
const ECHO_TAIL_RE = /[0-9]/g
const ECHO_WORD_RE = /ep|s[0-9]|第|季|集|集数|回|話|话/gi

/** 归一化：去空白、去括号内容、去标点、小写 */
function echoNorm(s) {
  return String(s || '').replace(ECHO_STRIP_RE, '').replace(ECHO_PUNCT_RE, '').toLowerCase()
}

/**
 * @param desc   <desc> 内容
 * @param title  <title> 内容
 * @returns {boolean} true = 这是标题复读，不是简介
 */
export function isEchoDesc(desc, title) {
  if (!desc || !title) return false
  const nd = echoNorm(desc)
  const nt = echoNorm(title)
  if (!nt || nt.length < 4) return false
  if (nd === nt) return true
  // 标题 + 纯序号（前或后）
  const tail = nd.startsWith(nt) ? nd.slice(nt.length) : nd.endsWith(nt) ? nd.slice(0, nd.length - nt.length) : null
  if (tail === null) return false
  const rest = tail.replace(ECHO_TAIL_RE, '').replace(ECHO_WORD_RE, '')
  return rest.length <= 2
}

/**
 * 「真简介」的完整判据 = 非占位 且 非标题复读。
 *
 * ★ 统计口径、补简介前的「是否已有简介」判断，都应该用这个而不是 isRealDesc。
 *   只传 desc 的老接口（isRealDesc）保留，用于确实拿不到标题的场合。
 */
export function hasRealDesc(desc, title) {
  return isRealDesc(desc) && !isEchoDesc(desc, title)
}
