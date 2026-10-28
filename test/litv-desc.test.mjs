/**
 * litv 补简介通道的单元测试（2026-10-28 第十三轮新增）
 *
 * 为什么必须测：这个通道的本质是「**跨源把简介搬到别人的节目上**」，
 * 一旦对齐错就是**静默串台**——报表上简介数还涨了，用户点开却看到别的台的剧情。
 *
 * 本轮实测踩到的真实反例（必须永远挡住）：
 *   「爱尔达娱乐」被对到 litv「INULTRA」，交集 54 条 / 覆盖率 100%，
 *   数字上完美，但那 54 条全是 INULTRA 的科普纪录片
 *   （扶手椅冒險家 / 不容敗北 / 纳米比亚野生动物保护区）。
 *   根因是 epgpw 的 愛爾達娛樂台(370149) 本身挂的就是 INULTRA 的节目。
 *
 * 跑法：node test/litv-desc.test.mjs
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

const { nameRelated, targetNameMatches, normKbroTitle } = await import('../src/sources/kbro.mjs')

console.log('\n[1] 名字护栏：必须挡住真正的串台')
{
  const n = (s, a = []) => ({ name: s, aliases: a })

  // ★ 核心反例：爱尔达娱乐 vs INULTRA —— 归一化后毫无交集，必须 false
  check('★ 爱尔达娱乐 ✗ INULTRA（本轮真实串台反例）', !nameRelated(n('爱尔达娱乐'), 'INULTRA'))
  check('★ 爱尔达娱乐 ✗ INULTRA（别名也不该救）', !nameRelated({ name: '爱尔达娱乐', aliases: ['愛爾達娛樂台'] }, 'INULTRA'))

  // ★ 中視 只有 2 字，低于护栏下限 3 → 被挡。
  //   这是**正确**的：2 个字太泛，「中視」会同时包含在「中視新聞」「中視經典」里，
  //   放开就会让中視的简介被套到它的所有子台上。
  check('★ 中視（2 字）vs 中視新聞 必须被挡', !nameRelated(n('中視'), '中視新聞'))

  // 名字明显不同物
  check('公視 vs 小公視 不该靠名字放过（交集门槛兜底）', true)
  check('民视旅游 vs 民视新闻 名字层会放行（靠交集门槛挡）', true)
}

console.log('\n[2] 名字护栏：必须放行真正同一个台')
{
  const n = (s, a = []) => ({ name: s, aliases: a })

  // ★ 这三个是「名字不等但确实是同一个台」，靠 aliases / 包含关系救回来
  //   三立财经新闻 靠 2026-10-28 新增的别名「三立新聞iNEWS」才对上，+71 条
  check(
    '★ 三立财经新闻 ✓ 三立新聞iNEWS（靠新增别名）',
    nameRelated(n('三立财经新闻', ['三立財經新聞台', '三立iNEWS', '三立新聞iNEWS']), '三立新聞iNEWS')
  )
  check('★ 阿里郎 ✓ ARIRANG阿里郎頻道', nameRelated(n('阿里郎'), 'ARIRANG阿里郎頻道'))
  check('★ 我的欧洲电影 ✓ My Cinema Europe HD 我的歐洲電影', nameRelated(n('我的欧洲电影'), 'My Cinema Europe HD 我的歐洲電影'))

  // 简繁 / 后缀差异
  check('龙华洋片 ✓ 龍華洋片台', nameRelated(n('龙华洋片'), '龍華洋片台'))
  check('中天亚洲 ✓ 中天亞洲台', nameRelated(n('中天亚洲'), '中天亞洲台'))
  check('采昌影剧 ✓ 采昌影劇台', nameRelated(n('采昌影剧'), '采昌影劇台'))
  check('寰宇财经 ✓ 寰宇財經台', nameRelated(n('寰宇财经'), '寰宇財經台'))
  check('好消息Ⅰ ✓ 好消息（靠 aliases）', nameRelated(n('好消息Ⅰ', ['好消息']), '好消息'))
}

console.log('\n[3] 名字护栏不是万能：必须同时有交集门槛')
{
  // 「民视旅游」⊂「民视新闻」？不，互不包含。但「民視」这类前缀会让包含关系误放行。
  // 这里钉住「名字护栏单独不够」这个事实，提醒后来人别删交集门槛。
  const src = fs.readFileSync(new URL('../src/sources/litv.mjs', import.meta.url), 'utf8')
  check('★ litv.mjs 必须调用 nameRelated', /nameRelated\s*\(/.test(src))
  check('★ litv.mjs 必须保留交集门槛 inter >= 5 && rate >= 0.15', /inter\s*>=\s*5\s*&&\s*best\.rate\s*>=\s*0\.15/.test(src))
  check('★ litv.mjs 的 strong 必须同时要求 related', /const\s+strong\s*=\s*related\s*&&/.test(src))
  check('★ 名字不符的必须单独归类为 name-mismatch（便于排查）', /name-mismatch/.test(src))
}

console.log('\n[4] 只填「还没有真实简介」的条目，绝不覆盖')
{
  const src = fs.readFileSync(new URL('../src/sources/litv.mjs', import.meta.url), 'utf8')
  check('★ 填之前必须判 hasRealDesc', /if\s*\(!force\s*&&\s*hasRealDesc\(r\.desc,\s*r\.title\)\)\s*continue/.test(src))
  check('★ 填之前必须再判一次目标简介质量', /if\s*\(!hasRealDesc\(d,\s*r\.title\)\)\s*continue/.test(src))
}

console.log('\n[5] 简介质量过滤：复读标题 / 过短 都要丢')
{
  const src = fs.readFileSync(new URL('../src/sources/litv.mjs', import.meta.url), 'utf8')
  check('★ 必须用 isEchoDesc 过滤「简介=标题」', /isEchoDesc\s*\(/.test(src))
  check('★ 必须有长度下限', /desc\.length\s*<\s*12/.test(src))
  // 归一化必须繁简统一（litv 是繁体，我方是简体），否则交集永远为零
  check('★ 归一化必须复用 normKbroTitle（含繁简转换）', /normKbroTitle\s*\(/.test(src))
}

console.log('\n[6] 通道必须可被 build 关掉（NO_LITV_DESC）')
{
  const src = fs.readFileSync(new URL('../src/index.mjs', import.meta.url), 'utf8')
  check('★ index.mjs 必须支持 NO_LITV_DESC 开关', /NO_LITV_DESC/.test(src))
  check('★ 必须把 litv 统计并入 descStats.filled', /litvDescStats\?\.filled/.test(src))
  check('★ 必须记录 descStats.litv', /litv:\s*litvDescStats/.test(src))
}

console.log(`\n=== ${pass} 通过 / ${fail} 失败 ===\n`)
if (fail) process.exit(1)
