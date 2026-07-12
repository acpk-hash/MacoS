// 跨境电商 · 产品图模板库（内置常量，纯前端）。
// 方法论来源：8 图型分类与 25 个场景模板的「结构思路」参考了公开的电商套图
// 方法论资料，本文件所有分类命名、提示词文案与反 AI 味技巧均为自研改写，
// 不含任何来源仓库的原文。
//
// 结构：8 个「图型」（listing 里的图片职责分类）× 25 个「场景模板」
// （具体出图配方，每个模板归属一个图型）。模板 prompt 为英文（图像模型
// 对英文提示词响应最稳定），变量槽用 {slot} 占位，UI 填槽后合成。

// ── 变量槽 ────────────────────────────────────────────────────────────────────

export type SlotKey = 'product' | 'selling_points' | 'color' | 'style' | 'scene'

export const SLOT_DEFS: Record<
  SlotKey,
  { label: string; placeholder: string; required: boolean }
> = {
  product: {
    label: '产品描述',
    placeholder: '例：ceramic coffee dripper, matte white（建议英文，品类+材质+特征）',
    required: true,
  },
  selling_points: {
    label: '核心卖点',
    placeholder: '例：double-wall insulation, drip-free spout（1~3 个，逗号分隔）',
    required: false,
  },
  color: {
    label: '主色 / 色值',
    placeholder: '例：sage green / #9CAF88',
    required: false,
  },
  style: {
    label: '风格关键词',
    placeholder: '例：minimalist, scandinavian, premium',
    required: false,
  },
  scene: {
    label: '场景补充',
    placeholder: '例：on a walnut kitchen counter, morning light',
    required: false,
  },
}

// ── 8 图型分类 ────────────────────────────────────────────────────────────────

export interface ImageType {
  id: string
  name: string
  /** 在 listing 中承担的职责，一句话。 */
  role: string
}

export const IMAGE_TYPES: ImageType[] = [
  { id: 'hero', name: '主图（白底/纯色）', role: '搜索结果第一眼，产品占满画面、零干扰' },
  { id: 'feature-icons', name: '卖点信息图', role: '产品 + 图标化卖点标注，回答「为什么选它」' },
  { id: 'feature-highlight', name: '单卖点特写', role: '一张图只讲透一个卖点或使用效果' },
  { id: 'material', name: '材质/结构细节', role: '微距与拆解视角，建立质感与工艺信任' },
  { id: 'lifestyle', name: '场景生活图', role: '把产品放进真实生活场景，唤起代入感' },
  { id: 'model', name: '模特/人台展示', role: '穿戴类与持握类产品的上身/上手效果' },
  { id: 'multi', name: '多格/全家福', role: '多角度、多件套、包装清单一图看全' },
  { id: 'campaign', name: '海报/氛围营销图', role: '促销海报、社媒素材与品牌氛围大片' },
]

// ── 25 场景模板 ───────────────────────────────────────────────────────────────

export interface ScenarioTemplate {
  id: string
  name: string
  /** 归属图型（IMAGE_TYPES.id）。 */
  typeId: string
  /** 适用品类提示（展示用）。 */
  categories: string
  /** 英文 prompt 模板，{slot} 为变量槽。 */
  template: string
  /** 本模板用到的变量槽。 */
  uses: SlotKey[]
  /** 反 AI 味技巧（有真人/手部/实拍感时才有内容）。 */
  antiAiTips: string
}

/** 所有模板共用的收尾约束（保持商品一致性）。 */
export const PROMPT_TAIL =
  'CRITICAL: render the product exactly as described - same shape, same color, same proportions, no invented logos or extra text unless specified.'

export const SCENARIO_TEMPLATES: ScenarioTemplate[] = [
  // ── hero ──
  {
    id: 'white-hero',
    name: '经典白底主图',
    typeId: 'hero',
    categories: '全品类（平台主图硬要求）',
    template:
      '{product}, centered on a seamless pure white background (RGB 255,255,255), product fills about 85-90% of the frame, front view or slight three-quarter angle, even softbox studio lighting, faint natural contact shadow only, no props, no text, photorealistic commercial product photography, 8k detail.',
    uses: ['product'],
    antiAiTips: '',
  },
  {
    id: 'gradient-hero',
    name: '纯色渐变底主图',
    typeId: 'hero',
    categories: '美妆 / 3C / 家居小件',
    template:
      '{product}, centered on a smooth {color} gradient studio backdrop, soft key light from upper left with a subtle rim light tracing the product edge, gentle reflection on a glossy surface below, premium {style} mood, no props, no text, commercial product photography, 8k.',
    uses: ['product', 'color', 'style'],
    antiAiTips: '',
  },
  {
    id: 'floating-hero',
    name: '悬浮动感主图',
    typeId: 'hero',
    categories: '3C / 运动 / 个护',
    template:
      '{product} floating in mid-air above a minimal {color} surface, slight dynamic tilt, crisp studio lighting with a sharp edge light, soft shadow cast below to ground the composition, clean negative space around the product, {style} energy, photorealistic, 8k.',
    uses: ['product', 'color', 'style'],
    antiAiTips: '',
  },
  // ── feature-icons ──
  {
    id: 'selling-point-icons',
    name: '三卖点图标信息图',
    typeId: 'feature-icons',
    categories: '全品类第二张图',
    template:
      'Clean e-commerce infographic on a light neutral background: full front view of {product} occupying the left 45% of the frame, right side shows three thin-line minimalist icons stacked vertically, each icon paired with a short English label for one benefit: {selling_points}. Modern sans-serif typography, generous whitespace, restrained {style} palette. Render the labels legibly into the image.',
    uses: ['product', 'selling_points', 'style'],
    antiAiTips: '',
  },
  {
    id: 'size-spec',
    name: '尺寸规格标注图',
    typeId: 'feature-icons',
    categories: '家居 / 收纳 / 家具 / 箱包',
    template:
      'Technical size-guide image: {product} shown in clean side or front elevation on a white background, thin measurement lines with arrows marking width, height and depth, dimension labels in a neat monospace font, small human-scale silhouette for reference if relevant, engineering-catalog clarity, no clutter.',
    uses: ['product'],
    antiAiTips: '',
  },
  {
    id: 'data-infographic',
    name: '参数数据信息图',
    typeId: 'feature-icons',
    categories: '3C / 家电 / 户外装备',
    template:
      'Spec-sheet style product infographic: {product} at center on a soft grey studio background, four callout lines pointing to key components, each callout ending in a small pill-shaped badge containing a short spec label derived from: {selling_points}. Precise, data-driven aesthetic, thin lines, high legibility, commercial catalog quality.',
    uses: ['product', 'selling_points'],
    antiAiTips: '',
  },
  // ── feature-highlight ──
  {
    id: 'single-feature',
    name: '单卖点特写',
    typeId: 'feature-highlight',
    categories: '全品类卖点深挖',
    template:
      'Close-up commercial shot of {product} dramatizing one benefit: {selling_points}. Tight crop on the exact part that delivers the benefit, shallow depth of field, directional lighting that sculpts the surface, background softly blurred {scene}, one short English headline rendered in the upper third, photorealistic, 8k.',
    uses: ['product', 'selling_points', 'scene'],
    antiAiTips: '',
  },
  {
    id: 'before-after',
    name: '前后对比图',
    typeId: 'feature-highlight',
    categories: '清洁 / 个护 / 收纳 / 修复类',
    template:
      'Split-frame before-and-after comparison: left half shows the problem state without the product (dull, messy or damaged as appropriate), right half shows the improved result achieved with {product}, identical camera angle and lighting on both halves for honest comparison, thin divider line, small BEFORE and AFTER labels, realistic photography, no exaggeration.',
    uses: ['product'],
    antiAiTips: '避免夸张失真的「奇迹级」效果，两侧光照与角度必须一致，否则一眼假。',
  },
  {
    id: 'usage-steps',
    name: '使用步骤演示图',
    typeId: 'feature-highlight',
    categories: '工具 / 厨房 / 美妆个护',
    template:
      'Three-step usage demonstration in one horizontal frame: three sequential vignettes showing hands using {product} from setup to result, numbered 1-2-3 with small circular badges, consistent lighting and background across steps, clean instructional layout, real human hands with natural skin texture, photorealistic.',
    uses: ['product'],
    antiAiTips: '手部要写实：指定 natural skin texture、visible knuckle lines，避免过度光滑的「塑料手」。',
  },
  // ── material ──
  {
    id: 'macro-texture',
    name: '材质微距特写',
    typeId: 'material',
    categories: '服饰 / 家纺 / 皮具 / 木制品',
    template:
      'Extreme macro photography of the surface of {product}, filling the frame with authentic material texture - weave, grain or finish clearly resolved, raking side light to reveal micro relief, shallow depth of field, natural color rendition, shot as if on a 100mm macro lens, tack-sharp focus plane, 8k.',
    uses: ['product'],
    antiAiTips: '',
  },
  {
    id: 'exploded-view',
    name: '结构分解图',
    typeId: 'material',
    categories: '3C / 小家电 / 机械结构产品',
    template:
      'Technical exploded view of {product}: components separated vertically along an invisible axis with even spacing, each layer crisply lit on a dark graphite background, thin leader lines to short component labels, precision engineering-render aesthetic, clean and premium, no clutter.',
    uses: ['product'],
    antiAiTips: '',
  },
  {
    id: 'craftsmanship',
    name: '工艺细节图',
    typeId: 'material',
    categories: '皮具 / 珠宝 / 手工 / 高单价',
    template:
      'Detail shot celebrating craftsmanship of {product}: tight crop on stitching, joinery, polishing or edge finishing, warm directional light, dark elegant background, subtle dust-free studio atmosphere, {style} luxury tone, macro-level sharpness on the craft detail, 8k.',
    uses: ['product', 'style'],
    antiAiTips: '',
  },
  // ── lifestyle ──
  {
    id: 'home-scene',
    name: '居家使用场景',
    typeId: 'lifestyle',
    categories: '家居 / 厨房 / 母婴 / 家纺',
    template:
      '{product} naturally placed in a lived-in home setting: {scene}. Soft window daylight, warm and inviting atmosphere, a few authentic supporting props that do not compete with the product, rule-of-thirds composition with the product as the clear focal point, editorial lifestyle photography, 8k.',
    uses: ['product', 'scene'],
    antiAiTips: '场景要「有人生活过」：允许轻微凌乱与真实道具，避免样板房般的完美感。',
  },
  {
    id: 'outdoor-scene',
    name: '户外场景图',
    typeId: 'lifestyle',
    categories: '户外 / 运动 / 园艺 / 车品',
    template:
      '{product} in an authentic outdoor environment: {scene}. Golden-hour natural sunlight, believable terrain and weather details, slight environmental wear like dust or dew for realism, product clearly readable against the landscape, adventurous {style} mood, photorealistic, 8k.',
    uses: ['product', 'scene', 'style'],
    antiAiTips: '加入尘土/露水/风吹痕迹等环境细节，避免棚拍感的「假户外」。',
  },
  {
    id: 'seasonal-festive',
    name: '节日季节氛围图',
    typeId: 'lifestyle',
    categories: '礼品 / 家居装饰 / 节日选品',
    template:
      '{product} styled for a seasonal campaign: {scene}. Holiday-appropriate props and palette with {color} accents, cozy bokeh lights in the background, festive but tasteful styling that keeps the product dominant, warm cinematic grading, commercial lifestyle photography, 8k.',
    uses: ['product', 'scene', 'color'],
    antiAiTips: '',
  },
  {
    id: 'luxury-ambience',
    name: '高端氛围大片',
    typeId: 'lifestyle',
    categories: '美妆 / 香氛 / 珠宝 / 高客单',
    template:
      'Cinematic luxury still life: {product} on a marble or dark stone surface, dramatic chiaroscuro lighting with a single warm key light, delicate atmosphere elements like silk fabric, water ripple or smoke wisp, deep shadows and rich {color} tones, high-end fragrance-ad aesthetic, ultra-detailed, 8k.',
    uses: ['product', 'color'],
    antiAiTips: '',
  },
  // ── model ──
  {
    id: 'model-wearing',
    name: '模特穿戴展示',
    typeId: 'model',
    categories: '服装 / 配饰 / 穿戴设备',
    template:
      'Fashion e-commerce shot of a model wearing {product}, three-quarter body framing that keeps the product fully visible, natural relaxed pose, neutral studio or softly blurred urban background {scene}, daylight-balanced lighting, realistic skin with visible pores and natural asymmetry, not retouched to plastic smoothness, photorealistic, 8k.',
    uses: ['product', 'scene'],
    antiAiTips: '必写真实皮肤质感（pores、uneven tone）、自然表情不对称、真实相机语言（85mm portrait lens），并显式加 not an AI-smooth face。',
  },
  {
    id: 'ghost-mannequin',
    name: '隐形人台图',
    typeId: 'model',
    categories: '服装（展示版型无干扰）',
    template:
      'Ghost mannequin photography of {product}: the garment holds a natural worn shape with an invisible form inside, hollow neck effect showing the inner back label area, pure white background, even wraparound lighting with soft fabric shadows, true-to-color fabric rendering, catalog-grade cleanliness, 8k.',
    uses: ['product'],
    antiAiTips: '',
  },
  {
    id: 'hand-held',
    name: '真实手持特写',
    typeId: 'model',
    categories: '小件 / 3C / 美妆（尺寸感+信任）',
    template:
      'A real human hand holding {product} at a natural angle to convey true scale, casual everyday setting softly blurred behind {scene}, warm ambient light, authentic skin with knuckle lines and slight dryness, slight handheld-camera imperfection, candid product-in-use feel, photorealistic.',
    uses: ['product', 'scene'],
    antiAiTips: '手是 AI 味重灾区：明确 five fingers、natural knuckle lines、real skin warmth，禁止完美无瑕的「橡胶手」。',
  },
  // ── multi ──
  {
    id: 'multi-angle-grid',
    name: '多角度四宫格',
    typeId: 'multi',
    categories: '3C / 工具 / 家居（结构复杂产品）',
    template:
      'A clean 2x2 grid presenting {product} from four angles: front, back, side and a 45-degree detail view, identical white background and lighting in every cell, thin light-grey dividers, consistent product scale across cells, catalog reference style, sharp and clinical, 8k.',
    uses: ['product'],
    antiAiTips: '',
  },
  {
    id: 'flat-lay-set',
    name: '俯拍平铺全家福',
    typeId: 'multi',
    categories: '套装 / 礼盒 / 服饰搭配',
    template:
      'Top-down flat lay of {product} with all included pieces arranged in a tidy geometric layout on a {color} matte background, even diffused overhead lighting with minimal shadows, balanced negative space, small styling props allowed at the edges only, {style} art direction, shot directly from above, 8k.',
    uses: ['product', 'color', 'style'],
    antiAiTips: '',
  },
  {
    id: 'packaging-set',
    name: '包装与开箱图',
    typeId: 'multi',
    categories: '礼品 / 美妆 / 订阅盒 / 品牌感建设',
    template:
      '{product} presented beside its retail packaging, box slightly open to suggest an unboxing moment, tissue paper and inserts arranged naturally, soft premium lighting on a neutral tabletop, brand-color {color} accents, gift-worthy first impression, commercial photography, 8k.',
    uses: ['product', 'color'],
    antiAiTips: '',
  },
  // ── campaign ──
  {
    id: 'promo-poster',
    name: '促销海报图',
    typeId: 'campaign',
    categories: '站外引流 / 活动 banner',
    template:
      'Bold e-commerce promotion poster: {product} as the hero object with dynamic composition, energetic {color} background with geometric shapes or light streaks, a short punchy English headline area in the upper portion, strong contrast and clear visual hierarchy, retail campaign energy, {style} typography flavor, 8k.',
    uses: ['product', 'color', 'style'],
    antiAiTips: '',
  },
  {
    id: 'social-ugc',
    name: '社媒实拍风',
    typeId: 'campaign',
    categories: '种草内容 / 评论区图 / 信息流素材',
    template:
      'Casual smartphone-style photo of {product} in an everyday moment: {scene}. Slightly off-center framing, natural imperfect lighting with a warm cast, mild sensor noise and soft focus falloff, lived-in authentic environment, looks like a genuine customer snapshot, definitely not a studio advertisement.',
    uses: ['product', 'scene'],
    antiAiTips: '核心是「不完美」：指定手机拍摄、轻微噪点、暖色偏、非居中构图，并显式声明 not AI-generated look、no studio perfection。',
  },
  {
    id: 'storefront-display',
    name: '品牌陈列形象图',
    typeId: 'campaign',
    categories: '品牌旗舰店头图 / A+ 品牌板块',
    template:
      'Premium brand display scene: multiple units of {product} arranged on minimalist retail shelving or a gallery pedestal, cohesive {color} brand environment, architectural lighting with soft spotlights, depth created by foreground and background staging, flagship-store atmosphere, {style} brand identity, 8k.',
    uses: ['product', 'color', 'style'],
    antiAiTips: '',
  },
  {
    id: 'sports-action',
    name: '运动动感大片',
    typeId: 'campaign',
    categories: '运动户外 / 健身器材 / 功能服饰',
    template:
      'High-energy sports campaign image featuring {product} in action: motion blur on the background while the product stays tack sharp, dramatic low-angle perspective, gym or track environment {scene}, sweat and chalk-dust atmosphere for realism, powerful directional lighting, athletic {style} intensity, 8k.',
    uses: ['product', 'scene', 'style'],
    antiAiTips: '若出现运动员，写明真实肌肉线条与汗水质感，避免过度完美的合成人。',
  },
]

// ── prompt 合成 ───────────────────────────────────────────────────────────────

/** 用变量槽填充模板并附加统一收尾约束；空槽残留的标点尽量收敛。 */
export function buildScenarioPrompt(
  tpl: ScenarioTemplate,
  vars: Partial<Record<SlotKey, string>>,
): string {
  let out = tpl.template
  for (const key of Object.keys(SLOT_DEFS) as SlotKey[]) {
    const v = (vars[key] ?? '').trim()
    out = out.split('{' + key + '}').join(v)
  }
  out = out
    .replace(/\(\s*\)/g, '')
    .replace(/\s+,/g, ',')
    .replace(/,\s*(?=[,.])/g, '')
    .replace(/:\s*\./g, '.')
    .replace(/\s{2,}/g, ' ')
    .trim()
  const anti = tpl.antiAiTips
    ? ' Avoid the typical AI-generated look: keep textures, lighting and human details authentic.'
    : ''
  return out + anti + ' ' + PROMPT_TAIL
}
