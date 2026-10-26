/**
 * 配置加载与频道清单管理
 *
 * 设计原则（参考 iptv-org/epg 的配置驱动模型）：
 *   - channels/channels.json  目标频道清单（用户要哪些台）
 *   - channels/overrides.json 手工指定某些频道在某个源里的 id（自动匹配失败时兜底）
 *
 * 每个目标频道只写"要什么"（id + 名字 + 别名），
 * 具体从哪个源、用哪个 id 抓，由 match 模块自动解析。
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

export const PATHS = {
  root: ROOT,
  channels: path.join(ROOT, 'channels', 'channels.json'),
  overrides: path.join(ROOT, 'channels', 'overrides.json'),
  matchCache: path.join(ROOT, 'channels', 'match-cache.json'),
  /** 外部 XMLTV 源清单（聚合别人现成的节目单） */
  epgSources: path.join(ROOT, 'channels', 'epg-sources.json'),
  /** 节目简介缓存表 */
  descCache: path.join(ROOT, '.cache', 'desc-cache.json'),
  output: path.join(ROOT, 'output'),
  cache: path.join(ROOT, '.cache'),
}

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true })
}

export function loadChannels() {
  const data = readJson(PATHS.channels, { channels: [] })
  const list = Array.isArray(data) ? data : data.channels || []
  return list.map((c, i) => ({
    id: c.id,
    name: c.name || c.id,
    aliases: c.aliases || [],
    logo: c.logo || '',
    group: c.group || '',
    country: c.country || 'CN',
    enabled: c.enabled !== false,
    order: i,
  }))
}

export function loadOverrides() {
  return readJson(PATHS.overrides, {})
}

export function saveJson(p, data) {
  ensureDir(path.dirname(p))
  fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n', 'utf8')
}

export function ensureOutputDir() {
  ensureDir(PATHS.output)
}

export function ensureCacheDir() {
  ensureDir(PATHS.cache)
}

export const CONFIG = {
  /** 输出节目表覆盖天数（含今天） */
  days: 7,
  /** 输出时区偏移 */
  tzOffset: '+0800',
  /** 时区名 */
  tzName: 'Asia/Shanghai',
  /** 并发抓取上限 */
  concurrency: 6,
  /** 单频道节目数上限，防止异常源刷爆 */
  maxProgrammesPerChannel: 3000,
  /** 节目最短时长（分钟），低于此值视为脏数据丢弃 */
  minDurationMin: 1,
  /** 节目最长时长（小时），超过视为脏数据 */
  maxDurationHours: 12,
}
