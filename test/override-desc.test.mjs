/**
 * overrides.json 的「强制不是择优」体检（2026-10-28 第十四轮新增）
 *
 * 起因（真实事故，别当理论）：
 *   AsianFood.tw 的 override 从很多轮之前就写死 sourceId=457281（epgpw TW 包）。
 *   而同一个台在 HK 包里还有一份 410370，catalog 记的是：
 *
 *     410370  region=HK  days=7  count=286  withDesc=286   ← 286 条真简介
 *     457281  region=TW  days=7  count=286  withDesc=0     ← 一条都没有
 *
 *   两者 days/count 完全相同，节目内容也逐条对得上（《巧克力皇后》第 6 季第 1 集
 *   是同一批），只是 withDesc 差了 286。override 一写死，pickBest 就永远没机会
 *   比较这两份 —— 因为 override 在 match.mjs 里是第一优先级，直接 continue。
 *
 *   ★ 这是 pitfalls §4.3「override 是强制不是择优，用前必须对比候选源」的第 2 次踩。
 *     第 1 次是 tvmao override 指向 catalog 外的 sourceId。
 *
 * ★★ 为什么本文件分两种断言（这个区分很重要，别合并）：
 *
 *   [1][2][3] 是**硬断言** —— 只读本仓库的 overrides.json / channels.json，
 *             同样的源码永远同样的结果，符合 §7.3c「单元测试必须确定性」。
 *
 *   [4] 只**报告不判失败** —— 它要读 catalog.json，而 catalog 是 TTL 24h 的**缓存**，
 *       内容取决于「上次重扫是什么时候」，跟代码对不对没有因果关系。
 *       我第十二轮就是在这里栽过一次：把 catalog 快照写进 assert，
 *       push 后 build 十秒失败（CI 40626398437），报的却是「缓存太旧」。
 *
 * 跑法：node test/override-desc.test.mjs
 */
import fs from 'node:fs'

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

const readJson = (rel) => JSON.parse(fs.readFileSync(new URL(rel, import.meta.url), 'utf8'))

const overrides = readJson('../channels/overrides.json')
const chansRaw = readJson('../channels/channels.json')
const chans = Array.isArray(chansRaw) ? chansRaw : chansRaw.channels || []
const chanIds = new Set(chans.map((c) => c.id))

console.log('\n[1] overrides.json 结构合法')
{
  const keys = Object.keys(overrides)
  // _comment_* / _notes_* 是给人和后续维护者看的说明，不是频道条目。
  // loadOverrides() 原样返回整个对象，只在 overrides[t.id] 处按频道 id 取，
  // 而频道 id 不以下划线开头 —— 所以这些键无害。但如果哪天有人写出一个
  // 非下划线开头、又不是真实频道 id 的键，就等于一条永远不生效的死配置。
  const noteKeys = keys.filter((k) => k.startsWith('_'))
  const realKeys = keys.filter((k) => !k.startsWith('_'))
  check('说明键一律用 _ 前缀（不会被当成频道）', noteKeys.length > 0)
  const orphans = realKeys.filter((k) => !chanIds.has(k))
  check(
    '非 _ 前缀的键必须都是真实频道 id',
    orphans.length === 0,
    orphans.length ? `找不到这些频道: ${orphans.join(', ')}` : ''
  )
  console.log(`       条目 ${realKeys.length} 条，说明键 ${noteKeys.length} 个`)
}

console.log('\n[2] 每个 override 的 source/sourceId 类型正确')
{
  const bad = []
  for (const [k, v] of Object.entries(overrides)) {
    if (k.startsWith('_')) continue
    if (v.source !== undefined) {
      if (typeof v.source !== 'string' || !v.source) bad.push(`${k}: source 不是非空字符串`)
      // ★ sourceId 必须是**字符串**。写成数字 410370 会在 match.mjs 的
      //   `String(c.sourceId) === String(ov.sourceId)` 里侥幸还能对上，
      //   但 alternatives 里拼 `source:sourceId` 时就会静默丢精度 / 变科学计数。
      if (typeof v.sourceId !== 'string' || !v.sourceId) bad.push(`${k}: sourceId 不是非空字符串`)
    }
  }
  check('全部 override 的 source/sourceId 都是字符串', bad.length === 0, bad.join('; '))
}

console.log('\n[3] ★ 回归锁：AsianFood.tw 的 override 必须指向 HK 那份（410370）')
{
  // 这一条是本次事故的**直接回归锁**。写死它比写「规则」可靠 ——
  // 规则会被绕过，一条明确期望值不会。
  //
  // 为什么是 410370 而不是 457281：
  //   catalog 实测 410370 = 7天/286条/286简介，457281 = 7天/286条/0简介。
  //   天数条数完全一致，只有简介差 286 条。若未来 410370 失效，
  //   这条会失败，提醒重新对比候选源，而不是悄悄退回 0 简介。
  const ov = overrides['AsianFood.tw']
  check('AsianFood.tw 有 override', !!ov)
  check('指向 epgpw:410370（HK 包，286 条简介那份）', ov && ov.source === 'epgpw' && ov.sourceId === '410370')
  check('没有把 457281（0 简介那份）写回去', !(ov && ov.sourceId === '457281'))
}

console.log('\n[4] catalog 快照体检（**只报告，不判失败**）')
{
  // ★★★ 这里绝不 assert（§7.3c）：catalog.json 是 TTL 24h 缓存，
  //   内容取决于「上次重扫是什么时候」。「测试是否通过」不能取决于「缓存新不新」。
  let cat = null
  try {
    cat = readJson('../channels/catalog.json')
  } catch {
    console.log('   （没有 catalog.json，跳过）')
  }
  if (cat && Array.isArray(cat.items)) {
    // 归一化频道名：只用来判断「同一个台的另一个源」，不追求精确
    const norm = (s) =>
      String(s || '')
        .replace(/[\s\u3000]+/g, '')
        .replace(/[（(][^)）]{0,10}[)）]/g, '')
        .replace(/(電視台|电视台|頻道|频道|台|HD|hd)$/g, '')
        .toLowerCase()

    const byId = new Map()
    for (const it of cat.items) byId.set(`${it.source}:${it.sourceId}`, it)

    const suspects = []
    for (const [k, v] of Object.entries(overrides)) {
      if (k.startsWith('_')) continue
      if (!v.source || !v.sourceId) continue
      const cur = byId.get(`${v.source}:${v.sourceId}`)
      if (!cur) continue
      // 只在「当前指向的源一条简介都没有」时才值得提醒
      if ((cur.withDesc || 0) > 0) continue
      const nk = norm(cur.name)
      if (!nk) continue
      // 找同名、天数不更少、简介更多的另一个源
      const better = cat.items.filter(
        (it) =>
          !(it.source === v.source && String(it.sourceId) === String(v.sourceId)) &&
          norm(it.name) === nk &&
          (it.withDesc || 0) > 0 &&
          (it.days || 0) >= (cur.days || 0)
      )
      if (better.length) {
        better.sort((a, b) => (b.withDesc || 0) - (a.withDesc || 0))
        suspects.push({ ch: k, cur, better: better[0] })
      }
    }

    if (suspects.length === 0) {
      console.log('   ✅ 没有「override 指向 0 简介源、而同名源简介更多」的条目')
    } else {
      for (const s of suspects) {
        console.log(`   ⚠️  warn ${s.ch} 的 override 指向 0 简介源：`)
        console.log(
          `       ${s.cur.source}:${s.cur.sourceId} 「${s.cur.name}」 ${s.cur.days}天 ` +
            `${s.cur.count}条 / 简介 ${s.cur.withDesc || 0}`
        )
        console.log(
          `     候选 ${s.better.source}:${s.better.sourceId} 「${s.better.name}」 ${s.better.days}天 ` +
            `${s.better.count}条 / 简介 ${s.better.withDesc}`
        )
      }
      console.log('   → 这不是失败，是提醒。确认能抓到后再改 overrides.json（改完重扫 catalog 复核）')
    }
  }
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`)
process.exit(fail ? 1 : 0)
