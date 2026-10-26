/**
 * epg.pw 数据源
 *
 * 实测（2026-10-26）：
 *   epg_CN.xml.gz  456 KB → 611 频道 / 37812 节目 / 7 天
 *   epg_HK.xml.gz  1.7 MB → 230 频道（含 TVB 翡翠台、明珠台、ViuTV、NowTV、港台）
 *   epg_TW.xml.gz  2.1 MB → 519 频道 / 90219 节目 / 8 天
 *
 * 优点：标准 XMLTV，start/stop 齐全，港澳台覆盖是免费源里最好的
 * 缺点：服务器慢（单文件 40s~3min），必须走 gz + 长超时 + 断点校验
 *
 * 注意：频道 id 是纯数字（如 545932），不通用，
 *      所以本适配器同时导出频道名，由 match 模块按名字对齐到 tvg-id。
 *
 * ⚠️ 时区坑（2026-10-26 实测确认）：
 *     epg.pw 所有 start/stop 都标 `+0000`，但时间数字实际已是当地时区（UTC+8）。
 *     证据（CCTV-1综合）：06:00 朝闻天下 / 12:00 新闻30分 / 19:00 新闻联播 /
 *     19:31 天气预报 / 19:38 焦点访谈 / 22:00 晚间新闻 —— 四个锚点全部命中北京时间。
 *     港澳台同样规律：明珠台 09:30「交易直播室」对港股开盘，台视 07:00「早安您好台视新闻」。
 *     所以解析时必须忽略源标注的 +0000，强制按 +0800 解读，否则整体会偏 8 小时。
 */
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fetchBuffer, log } from '../utils.mjs'
import { PATHS, ensureCacheDir } from '../config.mjs'

const BASE = 'https://epg.pw/xmltv'
const REGIONS = ['CN', 'HK', 'TW']

/**
 * 缓存有效期（毫秒）。
 * 一次 build 内复用，避免重复下载；CI 上每次都是新环境所以必然重新下载。
 * 调试时可设 EPGPW_CACHE_TTL=86400000 跳过下载，直接用本地已下载的包。
 */
const CACHE_TTL = Number(process.env.EPGPW_CACHE_TTL || 30 * 60 * 1000)

function cachePath(region) {
  return path.join(PATHS.cache, `epgpw_${region}.xml`)
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
 * 进行中的下载任务（region → Promise）。
 *
 * ⚠️ 2026-10-27 实测踩坑：同一 region 会被并发调用多次（主流程预热 + 多个频道并行解析），
 *    每次都看到"缓存不存在/已过期"就各自去下载，多个请求同时写同一个缓存文件。
 *    结果：HK 包（19.7MB）被写了三四份，后到的写入覆盖前面的，
 *    中途有读者读到 14.9MB 的半成品 → gunzip 报 "unexpected end of file"，
 *    表现成"epg.pw HK 解压失败"，直接导致翡翠台/港台33 等 6 个香港频道变空。
 *
 *    修法：同 region 的下载收敛成一个 Promise，后来的调用 await 同一个任务。
 */
const inflight = new Map()

/** 下载并解压某个地区的 XMLTV，返回本地文件路径 */
async function ensureFile(region) {
  ensureCacheDir()
  const out = cachePath(region)
  if (isFresh(out)) return out

  // 已有同 region 的下载在跑 → 等它，别再开一份
  if (inflight.has(region)) return inflight.get(region)

  const task = (async () => {
    const url = `${BASE}/epg_${region}.xml.gz`
    log.info(`[epg.pw] 下载 ${region} ...`)
    // fetch 给 90s 先探路（CI 直连通常够），失败立刻降级到 curl（本地走代理时 curl 才通）
    const { ok, buf, bytes, error } = await fetchBuffer(url, {
      timeout: 600000,
      fetchTimeout: 90000,
      retries: 1,
    })

    if (!ok || !buf || bytes < 1024) {
      // 下载失败时若存在旧缓存则降级使用
      if (fs.existsSync(out)) {
        log.warn(`[epg.pw] ${region} 下载失败(${error || 'empty'})，沿用旧缓存`)
        return out
      }
      throw new Error(`epg.pw ${region} 下载失败: ${error || 'empty'}`)
    }

    let xml
    try {
      xml = zlib.gunzipSync(buf).toString('utf8')
    } catch (e) {
      throw new Error(`epg.pw ${region} 解压失败: ${e.message} (${bytes} bytes)`)
    }

    if (!xml.includes('<tv')) throw new Error(`epg.pw ${region} 内容不是合法 XMLTV`)
    // 先写临时文件再 rename，保证任何时刻读到的都是完整文件
    const tmp = `${out}.tmp`
    fs.writeFileSync(tmp, xml, 'utf8')
    fs.renameSync(tmp, out)
    log.ok(`[epg.pw] ${region} 就绪 ${(xml.length / 1024 / 1024).toFixed(1)} MB`)
    return out
  })()

  inflight.set(region, task)
  try {
    return await task
  } finally {
    inflight.delete(region)
  }
}

/**
 * 解析 epg.pw 的时间串 → 毫秒时间戳
 *
 * 输入形如 `20261026010400 +0000`。
 * 源标注的偏移不可信（见文件头「时区坑」），这里一律按 +0800 解读。
 */
export function parseTimeCST(s) {
  if (!s) return null
  const m = String(s).trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?/)
  if (!m) return null
  const [, y, mo, d, hh, mi = '00', ss = '00'] = m
  const ts = Date.parse(`${y}-${mo}-${d}T${hh}:${mi}:${ss}+08:00`)
  return Number.isNaN(ts) ? null : ts
}

/** 解析结果缓存：region → { mtimeMs, channels, byChannel } */
const parsedCache = new Map()

/**
 * 解析 XMLTV 文本（带进程内缓存）
 * 返回 { channels: [{id, name, icon}], programmes: [...], byChannel: Map<id, programme[]> }
 * 用正则分段解析，避免引入 XML 库依赖；epg.pw 输出格式稳定。
 */
export function parseXmltv(xml) {
  const channels = []
  const programmes = []
  const byChannel = new Map()

  const chRe = /<channel\s+id="([^"]*)"[^>]*>([\s\S]*?)<\/channel>/g
  let m
  while ((m = chRe.exec(xml))) {
    const id = m[1]
    const body = m[2]
    const name = (body.match(/<display-name[^>]*>([\s\S]*?)<\/display-name>/) || [])[1] || ''
    const icon = (body.match(/<icon\s+src="([^"]*)"/) || [])[1] || ''
    channels.push({ id, name: decodeEntities(name).trim(), icon })
  }

  const prRe = /<programme\s+([^>]*)>([\s\S]*?)<\/programme>/g
  while ((m = prRe.exec(xml))) {
    const attrs = m[1]
    const body = m[2]
    const channel = (attrs.match(/channel="([^"]*)"/) || [])[1]
    const start = (attrs.match(/start="([^"]*)"/) || [])[1]
    const stop = (attrs.match(/stop="([^"]*)"/) || [])[1]
    const title = (body.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1] || ''
    const desc = (body.match(/<desc[^>]*>([\s\S]*?)<\/desc>/) || [])[1] || ''
    const category = (body.match(/<category[^>]*>([\s\S]*?)<\/category>/) || [])[1] || ''
    if (!channel || !start) continue
    const p = {
      channel,
      start,
      stop: stop || null,
      startTs: parseTimeCST(start),
      stopTs: stop ? parseTimeCST(stop) : null,
      title: decodeEntities(title).trim(),
      desc: decodeEntities(desc).trim(),
      category: decodeEntities(category).trim(),
    }
    programmes.push(p)
    if (!byChannel.has(channel)) byChannel.set(channel, [])
    byChannel.get(channel).push(p)
  }

  return { channels, programmes, byChannel }
}

/** 读取并解析某地区缓存文件（解析结果按 mtime 复用，避免每个频道重解析几十 MB） */
function loadRegion(region) {
  const file = cachePath(region)
  const st = fs.statSync(file)
  const cached = parsedCache.get(region)
  if (cached && cached.mtimeMs === st.mtimeMs) return cached

  const xml = fs.readFileSync(file, 'utf8')
  const parsed = parseXmltv(xml)
  const entry = { mtimeMs: st.mtimeMs, ...parsed }
  parsedCache.set(region, entry)
  return entry
}


function decodeEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&amp;/g, '&')
}

/** 加载所有地区的频道清单（用于自动匹配） */
export async function listChannels() {
  const out = []
  for (const region of REGIONS) {
    try {
      await ensureFile(region)
      const { channels, byChannel } = loadRegion(region)
      for (const c of channels) {
        const list = byChannel.get(c.id) || []
        // 覆盖率：epg.pw 同一频道名常有多个 id（对应不同上游），
        // 有的只给当天 1 天，有的给满 7 天。必须把这个信息带出去，
        // 让 match 模块优先挑数据最全的那个 id，否则卫视会只剩 1 天。
        const days = new Set()
        for (const p of list) if (p.startTs) days.add(new Date(p.startTs + 8 * 3600e3).toISOString().slice(0, 10))
        out.push({
          source: 'epgpw',
          region,
          sourceId: c.id,
          name: c.name,
          logo: c.icon,
          days: days.size,
          count: list.length,
        })
      }
    } catch (e) {
      log.warn(`[epg.pw] ${region} 读取失败: ${e.message}`)
    }
  }
  return out
}

/** 取指定频道的节目（sourceId 为 epg.pw 的数字 id），已带 startTs/stopTs */
export async function getProgrammes(sourceId, region) {
  await ensureFile(region)
  const { byChannel } = loadRegion(region)
  return byChannel.get(String(sourceId)) || []
}

export const meta = {
  id: 'epgpw',
  label: 'epg.pw',
  regions: REGIONS,
  /** 该源的节目是否自带真实 stop 时间 */
  hasStop: true,
  /** 该源是否带节目简介 */
  hasDesc: true,
}
