// 跨境电商 · 内置提示词库（全部自研改写；方法论骨架参考公开选品/评论分析/
// listing 构建资料，未复制任何来源原文）。
// 覆盖：①选品分析（5 维评分 + Go/No-Go 记分卡）、③评论痛点 6 维分析、
// ③搜索词洞察摘要、⑤Listing 8 步构建 + 迭代改写。

// ── ① 选品分析 ────────────────────────────────────────────────────────────────

export function buildResearchPrompt(args: {
  category: string
  competitorNotes: string
  extraNotes: string
}): string {
  const parts: string[] = []
  parts.push(
    `你是资深跨境电商选品分析顾问。请基于下面用户提供的信息与你的行业常识，输出一份结构化选品分析报告。

重要诚实性约束：
- 你没有实时市场数据。所有未由用户提供的数字都是推断估计，必须在其后标注「[推断]」；引用用户给的信息标注「[用户数据]」。
- 不确定就写不确定，禁止编造精确到个位的销量/销售额。

# 分析框架（自研五维评分，总分 100）
| 维度 | 满分 | 看什么 |
|---|---|---|
| 市场规模 | 20 | 品类整体需求量级与月销体量 |
| 增长潜力 | 25 | 新品/低评论数产品能否分到销量（新玩家空间） |
| 竞争烈度 | 20 | 头部品牌集中度，越分散得分越高 |
| 进入壁垒 | 20 | 平台自营挤压、认证/专利/资金门槛，越低得分越高 |
| 利润空间 | 15 | 客单价与成本结构支撑的毛利想象力 |

每个维度给出：得分、评分依据（引用用户数据或标注推断）、一句风险提示。

# Go/No-Go 记分卡（加权 1-10 分制）
| 维度 | 权重 |
|---|---|
| 市场规模 | 20% |
| 竞争格局 | 25% |
| 需求清晰度 | 15% |
| 进入壁垒（反向计分） | 20% |
| 盈利能力 | 20% |

加权总分判定：>=7.5 GO（建议进入）；6.0~7.4 CONDITIONAL GO（有条件进入，列出前提条件）；4.0~5.9 HOLD（暂缓，说明还缺什么数据）；<4.0 NO-GO（不建议进入）。

# 输出格式（严格 Markdown）
1. **一句话结论**（GO/CONDITIONAL GO/HOLD/NO-GO + 核心理由）
2. **五维评分表**（表格：维度/得分/依据/风险）
3. **Go/No-Go 记分卡**（表格：维度/权重/评分/加权分 + 总分行）
4. **Top3 机会 与 Top3 风险**（各配一条缓解/抓手）
5. **战术建议**（3~5 条，从以下方向中选贴合的：差异化改良、规格与组合变体、场景细分切入、价格带卡位、内容与图片差异化、供应链与合规壁垒构建；每条必须落到具体动作，禁止空话）
6. **待补数据清单**（哪些数据拿到后能显著提高判断置信度）`,
  )
  parts.push(`## 用户输入\n### 类目 / 产品思路\n${args.category}`)
  if (args.competitorNotes.trim()) {
    parts.push(`### 竞品信息（用户粘贴）\n${args.competitorNotes}`)
  }
  if (args.extraNotes.trim()) {
    parts.push(`### 补充信息\n${args.extraNotes}`)
  }
  return parts.join('\n\n')
}

// ── ③ 评论痛点 6 维分析 ──────────────────────────────────────────────────────

export function buildReviewPrompt(reviews: string, productHint: string): string {
  return `你是跨境电商 VOC（用户之声）分析师。请对下面粘贴的买家评论做六维痛点分析。

# 六维痛点分类（自研税目）
1. 结构与安装：孔位错位、松动摇晃、缺件、说明书看不懂等
2. 功能与性能：核心功能失效、电子模块故障、续航/功率/连接问题等
3. 设计与易用体验：容量不够、操作反直觉、噪音刺眼、收纳困难等
4. 材质与外观：异味、掉漆生锈、色差、运输磕碰、廉价感等
5. 描述与预期落差：尺寸比想象小、与图不符、宣传功能名不副实等
6. 包装物流与售后：包装破损、发错漏发、退换困难、客服失联等

# 分析要求
- 每条痛点标注：所属维度、严重度（高=不可用或安全隐患 / 中=可用但体验差 / 低=轻微瑕疵）、出现频次（在给定评论里数出来）、1 条原文摘录佐证。
- 只统计给定评论，不要虚构；样本太少的维度写「样本不足」。
- 严重度相同看频次，频次相同看是否影响复购。

# 输出格式（严格 Markdown）
1. **样本概况**（评论条数、正/负面大致占比）
2. **六维痛点汇总表**（维度/痛点/严重度/频次/原文摘录）
3. **Top3 优先改进项**（每条给：根因猜想 + 产品或 listing 侧的具体改进动作）
4. **可写进 listing 的反向卖点**（把竞品痛点转成我方卖点句，中英各一版）
${productHint.trim() ? `\n## 产品背景\n${productHint}` : ''}

## 评论原文
${reviews}`
}

// ── ③ 搜索词洞察摘要 ─────────────────────────────────────────────────────────

export function buildTermSummaryPrompt(args: {
  fileName: string
  baselineCvr: number | null
  totalRow: string
  decisionsBrief: string
}): string {
  return `你是亚马逊广告优化师。下面是一份搜索词报告经本地规则引擎聚合与初判后的结果，请写一份人话版洞察摘要。

数据背景：文件 ${args.fileName}；整体基准 CVR（该报告总订单/总点击）= ${
    args.baselineCvr != null ? (args.baselineCvr * 100).toFixed(2) + '%' : '缺少订单或点击数据'
  }。
${args.totalRow}

规则引擎初判结果（动作标签由本地硬计算得出，你不要改判，只做解释与补充视角）：
${args.decisionsBrief}

# 输出要求（严格 Markdown，500 字内）
1. **花费去哪了**：花费最集中的词与是否值得
2. **立即行动**：否词候选与放量候选各挑最重要的 3 个，说明为什么
3. **结构性信号**：属性词/场景词里是否藏着 listing 未覆盖的需求
4. **提醒**：数据窗口/样本量导致的判断局限
引用具体搜索词时用反引号包裹。不要复述整张表。`
}

// ── ⑤ Listing 构建器（8 步方法论，自研版） ───────────────────────────────────

export function buildListingPrompt(args: {
  productInfo: string
  keywords: string
  audience: string
  marketplace: string
  researchExcerpt: string
  insightExcerpt: string
  imageExcerpt: string
}): string {
  const refs: string[] = []
  if (args.researchExcerpt) refs.push(`### 选品分析结论（模块①产出节选）\n${args.researchExcerpt}`)
  if (args.insightExcerpt) refs.push(`### 评论/搜索词洞察（模块③产出节选）\n${args.insightExcerpt}`)
  if (args.imageExcerpt) refs.push(`### 已生成产品图的卖点方向（模块④）\n${args.imageExcerpt}`)
  return `你是亚马逊 Listing 撰写专家。请按下面的 8 步方法论（内部推演，除第 1、2 步外不必展示过程）为产品生成完整 listing 文案。

# 8 步方法论（自研版）
1. 关键词分层：把词按意图分 5 层——核心品类词 / 功能属性词 / 场景用途词 / 问题解决词 / 规格修饰词。标题只放高优先级词，禁止堆砌。
2. 用户疑虑库：推演买家下单前最担心的 5 个问题（尺寸？耐用？兼容？清洗？售后？）。
3. 卖点证据化：每个卖点配一句可信的证据式表述（材质/工艺/数据/场景验证），禁用 premium quality、perfect for any occasion 这类空泛词。
4. 标题设计：结构 = 品牌位 + 核心品类词（前 5 词内出现）+ 关键差异化属性 + 主场景 + 规格数量。给 3 版（关键词覆盖优先 / 转化文案优先 / 平衡版）并标注推荐哪版。
5. 五点描述：五点各承担一个决策环节——①核心价值 ②痛点解决 ③适用场景 ④规格与用法 ⑤信任与售后。每点 = 全大写短标题 + 承诺句 + 证据句，自然埋词。
6. 产品描述 / A+ 段落：3~4 个模块（品牌故事 / 深挖场景 / 参数表建议 / 对比优势），每模块给标题 + 正文 + 建议配图方向。
7. 后台 Search Terms：只放前台（标题+五点）没出现过的词，做差集；不重复、不放品牌词、逗号或空格分隔、249 字节内。
8. QA 预埋：从第 2 步疑虑库挑 3 个高频疑虑，写出 Q + 卖家口吻的 A。

# 输出格式（严格 Markdown，文案主体用${args.marketplace.includes('美') || args.marketplace.toLowerCase().includes('us') ? '英文（面向美国站买家）' : '目标站点语言（默认英文）'}，解释性文字用中文）
## 1. 关键词分层表
## 2. 买家疑虑 Top5
## 3. 标题（3 版 + 推荐）
## 4. 五点描述
## 5. 产品描述 / A+ 段落
## 6. 后台 Search Terms
## 7. QA 预埋（3 条）

## 产品信息
${args.productInfo}
${args.keywords.trim() ? `\n## 已有关键词素材\n${args.keywords}` : ''}
${args.audience.trim() ? `\n## 目标人群\n${args.audience}` : ''}
${refs.length ? '\n' + refs.join('\n\n') : ''}`
}

export function buildListingRefinePrompt(previous: string, instruction: string): string {
  return `下面是你此前生成的 listing 文案，请按用户的修改要求输出修订后的完整版本（保持原有的 7 段 Markdown 结构，未被要求修改的部分原样保留）。

## 修改要求
${instruction}

## 当前版本
${previous}`
}
