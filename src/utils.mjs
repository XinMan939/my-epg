/**
 * 通用工具：HTTP 抓取、XML 转义、时间处理、日志
 */
import { setTimeout as sleep } from 'node:timers/promises'

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

/** 频道名归一化，用于匹配：去空格、全角转半角、去括号后缀、小写 */
export function normalizeName(name) {
  if (!name) return ''
  let s = String(name)
  // 全角转半角
  s = s.replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  s = s.replace(/\u3000/g, ' ')
  s = s.toLowerCase()
  // 去常见后缀
  s = s.replace(/[\s\-_·・]/g, '')
  s = s.replace(/[（(][^）)]*[）)]/g, '')
  s = s.replace(/(高清|hd|超清|标清|4k|8k|蓝光|杜比)+$/gi, '')
  s = s.replace(/(频道|电视台|台|节目表|综合频道)$/g, '')
  s = s.replace(/^cctv(\d+)/, 'cctv$1')
  s = s.replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
  return s
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

  // 数字变体：CCTV-1 / CCTV1 / cctv-1综合
  const m = base.match(/cctv[\s-]*(\d+)/i)
  if (m) {
    out.add(`cctv${m[1]}`)
    out.add(`cctv-${m[1]}`)
  }

  // 卫视简写：湖南卫视 / 湖南 / 湖南卫视高清
  const ws = base.match(/^(.+?)卫视/)
  if (ws) out.add(normalizeName(ws[1]))
  const ws2 = base.match(/^(.+?)卫视/)
  if (ws2) out.add(normalizeName(ws2[1] + '卫视'))

  return [...out].filter(Boolean)
}
