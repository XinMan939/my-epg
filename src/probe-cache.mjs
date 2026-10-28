/**
 * 源自报指标（days / count / withDesc）的探测缓存
 *
 * ★ 为什么需要缓存（2026-10-28 第十七轮）：
 *   给 tvsou 补真探天数是「逐 weekday 抓页面」，476 个频道哪怕只用早退也要
 *   ~800 个请求，实测墙上 8 秒/请求（本地走代理，10 并发也压不下来），一次要十几分钟。
 *   而 catalog 有 24h TTL —— 同一天里我经常连跑几次 catalog / init / build，
 *   每次都重探一遍纯属浪费，还容易被上游当成爬虫。
 *
 * ★ 为什么按「北京时间当天」而不是按小时过期：
 *   tvsou / tvmao 的节目表是**周栅格**（w1..w7 = 周一到周日），
 *   站点只发布「当周」，跨天会滚动，所以「今天探到的结果」今天内一定还算数，
 *   到了明天就必须重探（周栅格整体错位一天）。用 12h/24h 这种小时级 TTL
 *   会在「昨晚 23:50 探测、今天 08:00 复用」时把隔夜的周栅格当今天的用。
 *
 * ★ 缓存里必须带上 days / count 之外的「探测口径版本号」：
 *   改过 probeStat 的算法（比如从「抓 1 天」改成「抓满 7 天」）之后，
 *   旧缓存会让新算法完全不生效 —— 而日志里一切正常。
 *   这正是 catalog 缺 days 字段那次（2026-10-26）同一类错误，
 *   所以调用方要显式传 `ver`，改了算法就改版本号。
 */
import fs from 'node:fs'
import path from 'node:path'
import { PATHS } from './config.mjs'
import { dateInCST, log } from './utils.mjs'

/** 判断本源的探测是否被关掉（离线调试 / 上游挂了时用） */
export function probeDisabled(envName) {
  if (process.env.NO_SOURCE_PROBE === '1') return true
  return process.env[envName] === '0'
}

/**
 * 读缓存。命中条件：同一天 + 同版本 + 频道集包含所需 key
 *
 * @param name 缓存文件名（不含扩展名，如 'tvsou-probe'）
 * @param ver  探测口径版本号，改了算法必须改它
 * @returns {{ hit: boolean, ymd: string, stats: Record<string, object> }}
 */
export function readProbeCache(name, ver) {
  const file = path.join(PATHS.cache, `${name}.json`)
  try {
    const j = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (j.ver !== ver) return { hit: false, ymd: '', stats: {} }
    if (j.ymd !== dateInCST()) return { hit: false, ymd: '', stats: {} }
    return { hit: true, ymd: j.ymd, stats: j.stats || {} }
  } catch {
    return { hit: false, ymd: '', stats: {} }
  }
}

/** 写缓存（覆盖整份，stats 要带全量结果，不做增量合并） */
export function writeProbeCache(name, ver, stats) {
  const file = path.join(PATHS.cache, `${name}.json`)
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ ver, ymd: dateInCST(), stats }, null, 1) + '\n', 'utf8')
  } catch (e) {
    log.warn(`[probe-cache] 写 ${name} 失败：${e.message}`)
  }
}

/**
 * 分批上报进度 —— 几百个频道的探测会跑很久，没有进度条看起来像卡死
 *
 * @param label  日志前缀
 * @param total  总数
 * @param step   每多少条报一次
 */
export function makeProgress(label, total, step = 50) {
  let done = 0
  const t0 = Date.now()
  return () => {
    done++
    if (done % step === 0 || done === total) {
      const sec = ((Date.now() - t0) / 1000).toFixed(0)
      log.info(`[${label}] 探测进度 ${done}/${total}（${sec}s）`)
    }
  }
}
