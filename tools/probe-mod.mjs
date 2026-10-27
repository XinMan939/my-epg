/**
 * MOD 探测脚本（临时）—— 全部用 Node，避开 shell 引号地狱
 */
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36'
const M = 'https://modp.cht.com.tw/modinfo/epginfob.php'

async function get(url, timeout = 25000) {
  const ac = new AbortController()
  const t = setTimeout(() => ac.abort(), timeout)
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': UA } })
    const txt = await r.text()
    return { status: r.status, txt }
  } catch (e) {
    return { status: 0, txt: '', err: e.message }
  } finally {
    clearTimeout(t)
  }
}

function parseDays(html) {
  const blocks = html.split("<div class='epgdays'>").slice(1)
  return blocks.map((b) => {
    const d = (b.match(/background-color:#ccc;padding:5px;'>([^<]+)</) || [])[1] || '?'
    const progs = [...b.matchAll(/<div class='(past|now|future)'[^>]*><div class='time'>\s*([\d:]+)<\/div><div class='channelTitle'>\s*([^<]+?)\s*<\/div>/g)]
    return { date: d, n: progs.length }
  })
}

function parseChannel(html) {
  return (html.match(/<h3 class="heading-area__title--regular">([^<]+)</) || [])[1] || ''
}

console.log('########## A. 周末缺失：w=0 日期块明细 ##########')
{
  const r = await get(`${M}?id=6&w=0`)
  console.log(`  状态 ${r.status} 大小 ${r.txt.length}`)
  const days = parseDays(r.txt)
  console.log(`  epgdays 块数 ${days.length}`)
  for (const d of days) console.log(`    ${d.date} -> ${d.n} 条`)
  console.log(`  页面含 2026-10-31: ${r.txt.includes('2026-10-31')}`)
  console.log(`  页面含 2026-11-01: ${r.txt.includes('2026-11-01')}`)
  const dm = r.txt.match(/<div class='datemenu'>[\s\S]{0,600}?<\/div>/)
  console.log(`  datemenu: ${dm ? dm[0].replace(/\s+/g, ' ') : '(未匹配)'}`)
}

console.log('\n########## B. 不同频道 w=0 的日期 ##########')
for (const id of [8, 200, 15, 730]) {
  const r = await get(`${M}?id=${id}&w=0`)
  const days = parseDays(r.txt)
  console.log(`  id=${id} | ${parseChannel(r.txt)} | ${days.map((d) => d.date.slice(0, 10)).join(', ')}`)
}

console.log('\n########## C. w=1 是否接续 ##########')
for (const w of [0, 1, 2]) {
  const r = await get(`${M}?id=8&w=${w}`)
  const days = parseDays(r.txt)
  console.log(`  id=8 w=${w} -> ${days.length} 天: ${days.map((d) => d.date.slice(0, 10)).join(', ')}`)
}

console.log('\n########## D. 频道清单完整性 ##########')
{
  const r = await get('https://mod.cht.com.tw/%E9%A0%BB%E9%81%93TV/%E5%85%A8%E9%83%A8.do', 30000)
  console.log(`  状态 ${r.status} 大小 ${r.txt.length}`)
  const nums = [...r.txt.matchAll(/<div class="number">(\d+)<\/div>/g)].map((m) => m[1])
  console.log(`  number 元素 ${nums.length}，唯一 ${new Set(nums).size}`)
  const names = [...r.txt.matchAll(/<h3><a[^>]*>([^<]+)<\/a><\/h3>/g)].map((m) => m[1].trim())
  console.log(`  h3 名字 ${names.length}`)
  const re = /<div class="number">(\d+)<\/div>[\s\S]{0,900}?<h3><a[^>]*>([^<]+)<\/a><\/h3>/g
  const list = []
  let m
  while ((m = re.exec(r.txt))) list.push({ id: m[1], name: m[2].trim() })
  console.log(`  配对成功 ${list.length}`)
  const seg = {}
  for (const c of list) {
    const k = Math.floor(Number(c.id) / 50) * 50
    seg[k] = (seg[k] || 0) + 1
  }
  console.log(`  按号段 ${JSON.stringify(seg)}`)
  const fs = await import('fs')
  fs.writeFileSync('mod-channels.json', JSON.stringify(list, null, 1))

  console.log('\n########## E. 抽样 15 台验证能抓到节目 ##########')
  for (let i = 0; i < 15; i++) {
    const c = list[Math.floor((i * list.length) / 15)]
    const rr = await get(`${M}?id=${c.id}&w=0`, 20000)
    const days = parseDays(rr.txt)
    const tot = days.reduce((s, d) => s + d.n, 0)
    console.log(`  ${c.id} | ${c.name} | ${days.length}天/${tot}条 | 标题="${parseChannel(rr.txt)}"`)
  }
}

console.log('\n########## F. 并发限速 ##########')
for (const P of [1, 3, 5]) {
  const t0 = Date.now()
  const ids = []
  for (let i = 6; i <= 15; i++) ids.push(i)
  const res = []
  let cur = 0
  const worker = async () => {
    while (true) {
      const i = cur++
      if (i >= ids.length) return
      const r = await get(`${M}?id=${ids[i]}&w=0`, 25000)
      res.push(r.status)
    }
  }
  await Promise.all(Array.from({ length: P }, worker))
  const dist = res.reduce((o, s) => {
    o[s] = (o[s] || 0) + 1
    return o
  }, {})
  console.log(`  P=${P} -> ${JSON.stringify(dist)} | ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

console.log('\n########## G. 500 错误是否重试能成功 ##########')
{
  let ok = 0
  let fail = 0
  for (let i = 0; i < 10; i++) {
    const r = await get(`${M}?id=6&w=0`, 20000)
    if (r.status === 200) ok++
    else fail++
  }
  console.log(`  串行 10 次: 200=${ok} 其他=${fail}`)
}
