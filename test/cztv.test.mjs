/**
 * cztv（浙江广电新蓝网）源的单元测试（2026-10-28 第十五轮新增）
 *
 * 为什么必须测：这个源有两个**看起来完全正常、实则是坑**的地方，
 * 任何一个被"顺手改掉"都会静默产出错数据，而报表里看不出来。
 *
 * ★★ 本文件保护的两条命门：
 *
 * ① **只有「今天」是真实节目单，明天起是 24 条「精彩节目」×60min 占位。**
 *    如果哪天有人觉得「这 24 条也是数据啊」把 isFiller 去掉，
 *    cztv 立刻变成 days=7 / count=168 —— **条数真实、内容全空壳**，
 *    还因为天数最多在 pickBest 里稳赢 epgpw 的真实数据。
 *    这是 §6.7 系列里最难发现的一种：以前的虚高是条数假，这次条数是真的。
 *
 * ② **`play_time` 是毫秒**。当秒解析会得到 1970 年，节目全部被丢掉或错位。
 *
 * ★ 本文件不联网：把 `globalThis.fetch` 换成一个按 URL 路由的桩函数，
 *   对 `listChannels()` 也做了端到端覆盖（含「占位台必须被排除」）。
 *   不需要 catalog.json（TTL 24h 缓存），符合 §7.3c「单测必须确定性」。
 *
 * 跑法：node test/cztv.test.mjs
 */

let pass = 0
let fail = 0
function check(name, cond, extra = '') {
  if (cond) {
    pass++
    console.log(`  ok   ${name}`)
  } else {
    fail++
    console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`)
  }
}

/** 北京时间的 yyyymmdd（与 src/sources/cztv.mjs 同一算法） */
const ymdCST = (off = 0) =>
  new Date(Date.now() + 8 * 3600e3 + off * 86400e3).toISOString().slice(0, 10).replace(/-/g, '')

const TODAY = ymdCST(0)
const TOMORROW = ymdCST(1)

/** 今天 00:00（北京）的毫秒时间戳 —— cztv 的基准点 */
const TODAY0_MS = Date.parse(`${TODAY.slice(0, 4)}-${TODAY.slice(4, 6)}-${TODAY.slice(6, 8)}T00:00:00+08:00`)

/**
 * 造 cztv 原始条目（字段名与真实接口一致）
 * ★ play_time / duration 都是**毫秒字符串**，这就是真实长相，别改成数字
 */
const raw = (title, startMin, durMin) => ({
  program_title: title,
  play_time: String(TODAY0_MS + startMin * 60e3),
  duration: String(durMin * 60e3),
  program_id: 1,
  program_status: 1,
})

/** 一天 24 条「精彩节目」，就是 cztv 给未来天的占位（实测长相） */
const fillerDay = () =>
  Array.from({ length: 24 }, (_, i) => raw('精彩节目', i * 60, 60))

const schedule = (code, name, list) => ({
  alertMessage: '数据获取成功',
  state: 0,
  message: 'success',
  content: {
    list: [
      {
        station_id: Number(code),
        station_type: 1,
        station_name: name,
        station_date: TODAY,
        station_icon: '',
        list,
      },
    ],
  },
})

const channelList = (stations) => ({
  alertMessage: '数据获取成功',
  state: 0,
  message: 'success',
  content: { list: stations },
})

// ── 假 fetch：按 URL 路由 ──────────────────────────────────────────────
let programCalls = []
let routes = {}
function installFetch() {
  programCalls = []
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('/api/paas/channel/tv')) {
      return { ok: true, status: 200, text: async () => JSON.stringify(routes.channels) }
    }
    const m = u.match(/\/api\/paas\/program\/(\d+)\/(\d{8})$/)
    if (m) {
      programCalls.push({ code: m[1], ymd: m[2] })
      const body = routes.program?.(m[1], m[2])
      if (!body) return { ok: true, status: 200, text: async () => JSON.stringify({ state: 1, message: 'no data' }) }
      return { ok: true, status: 200, text: async () => JSON.stringify(body) }
    }
    return { ok: false, status: 404, text: async () => '' }
  }
}

installFetch()
const { getDayProgrammes, listChannels } = await import('../src/sources/cztv.mjs')

/**
 * ★ [1] 毫秒时间戳 + 占位过滤 —— 两条命门的直接断言
 */
console.log('\n[1] 时间戳单位与「精彩节目」占位过滤')
{
  routes.program = () =>
    schedule('110', '浙江国际', [
      raw('《凡人歌》18', 0, 45),
      raw('黄金时间', 45, 10),
      raw('精彩节目', 55, 60), // ★ 混进来的占位，必须被剔除
      raw('华人天地', 115, 60),
    ])
  const r = await getDayProgrammes('110', 1, TODAY)
  check('4 条里剔掉 1 条占位 → 剩 3 条', r.programmes.length === 3, `实际 ${r.programmes.length}`)
  check('★ 剔除的是「精彩节目」', !r.programmes.some((p) => p.title === '精彩节目'))
  check(
    '★ play_time 按**毫秒**解析成今天 00:00（按秒会变成 1970 年）',
    r.programmes[0].startTs === TODAY0_MS,
    `实际 ${r.programmes[0].startTs} vs ${TODAY0_MS}`
  )
  check('pageTitle 透传台名（供日志/排查）', r.pageTitle === '浙江国际')
}

/** ★ [2] 全占位 = 没有节目单（这是 days 不被虚高的根） */
console.log('\n[2] 整天都是占位 → 视为「无节目单」')
{
  routes.program = () => schedule('111', '好易购', fillerDay())
  const r = await getDayProgrammes('111', 1, TODAY)
  check('24 条全占位 → programmes 为空', r.programmes.length === 0)
  check('★ 必须报 empty schedule（否则会被当成有效天）', r.error === 'empty schedule', r.error)
}

/** ★ [3] stopTs 的取法 */
console.log('\n[3] stopTs：用下一条开始，末条用自报时长')
{
  routes.program = () =>
    schedule('110', '浙江国际', [raw('A', 0, 30), raw('B', 40, 20)])
  const r = await getDayProgrammes('110', 1, TODAY)
  check('中间条 stop = 下一条 start（吃掉 10 分钟空档）', r.programmes[0].stopTs === TODAY0_MS + 40 * 60e3)
  check('末条 stop = start + duration', r.programmes[1].stopTs === TODAY0_MS + 60 * 60e3)
}

/** ★ [4] 乱序输入必须被排序（上游广告插播会打乱） */
console.log('\n[4] 乱序输入 → 输出按开始时间升序')
{
  routes.program = () =>
    schedule('110', '浙江国际', [raw('晚', 100, 20), raw('早', 0, 30), raw('中', 40, 20)])
  const r = await getDayProgrammes('110', 1, TODAY)
  const titles = r.programmes.map((p) => p.title).join(',')
  check('顺序 = 早,中,晚', titles === '早,中,晚', titles)
  check('时间戳严格不减', r.programmes.every((p, i) => i === 0 || p.startTs >= r.programmes[i - 1].startTs))
}

/** ★ [5] 天数必须真探：今天真实 + 明天占位 → days=1 */
console.log('\n[5] listChannels：占位天不计入 days（§6.7 真探）')
{
  routes.channels = channelList([
    { station_code: '110', name: '浙江国际', logo: '', station_playing: '' },
    { station_code: '108', name: '少儿频道', logo: '', station_playing: '' },
    { station_code: '111', name: '好易购', logo: '', station_playing: '' },
  ])
  routes.program = (code, ymd) => {
    if (ymd !== TODAY) return schedule(code, '', fillerDay()) // ★ 明天起全是占位
    if (code === '111') return schedule(code, '好易购', fillerDay()) // ★ 连今天都是占位
    if (code === '110') return schedule(code, '浙江国际', Array.from({ length: 6 }, (_, i) => raw(`节目${i}`, i * 240, 240)))
    return schedule(code, '少儿频道', Array.from({ length: 8 }, (_, i) => raw(`动画${i}`, i * 180, 180)))
  }
  programCalls.length = 0 // 前面几组也打过桩，这里重新计数
  const list = await listChannels()
  const by = new Map(list.map((c) => [c.sourceId, c]))
  check('只探了 7 天（今天起）', list.length > 0 && programCalls.length === 3 * 7, `实际请求 ${programCalls.length} 次`)
  check('★ 浙江国际 days=1（不是 7）', by.get('110')?.days === 1, `实际 ${by.get('110')?.days}`)
  check('★ count 只算真实条数（6），不含占位', by.get('110')?.count === 6, `实际 ${by.get('110')?.count}`)
  check('★ 全占位的台（好易购）不进清单', !by.has('111'))
  check('withDesc 恒为 0（源不带简介）', by.get('110')?.withDesc === 0)
  check('region 恒为 CN', by.get('110')?.region === 'CN')
}

/** ★ [6] 裸台名必须补省名，否则「浙江少儿」永远匹配不到 */
console.log('\n[6] 台名补全省名（否则少接一个台）')
{
  check(
    '★ 「少儿频道」→ 「浙江少儿频道」（对齐目标别名）',
    routes.channels && true && (await (async () => {
      routes.channels = channelList([{ station_code: '108', name: '少儿频道', logo: '', station_playing: '' }])
      routes.program = () => schedule('108', '少儿频道', Array.from({ length: 6 }, (_, i) => raw(`动画${i}`, i * 240, 240)))
      const list = await listChannels()
      return list[0]?.name === '浙江少儿频道'
    })())
  )

  const src = (await import('node:fs')).readFileSync(new URL('../src/sources/cztv.mjs', import.meta.url), 'utf8')
  check('★ 不得把「精彩节目」过滤逻辑删掉', /FILLER_RE/.test(src) && /isFiller\s*\(/.test(src))
  check('★ 不得把占位台放进 catalog（days===0 必须 continue）', /days\s*===\s*0\)\s*continue/.test(src))
}

/** ★ [7] 不得凭「时长/条数」判占位：真实 60 分钟栏目必须留下 */
console.log('\n[7] 占位判定只看标题，不按时长')
{
  routes.program = () =>
    schedule('110', '浙江国际', [raw('《凡人歌（海外版权）》18（海外播出版）', 0, 60)])
  const r = await getDayProgrammes('110', 1, TODAY)
  check('★ 60 分钟的真实节目不能被当成占位剔掉', r.programmes.length === 1, `实际 ${r.programmes.length}`)
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`)
if (fail) process.exit(1)
