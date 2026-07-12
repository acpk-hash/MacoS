import { useState } from 'react'

// ── Preset data ───────────────────────────────────────────────────────────────

const STYLE_CHIPS = [
  '水彩', '油画', '赛博朋克', '动漫', '写实摄影',
  '3D 渲染', '极简', '国风水墨', '像素艺术', '蒸汽波',
]

const COMPOSITION_CHIPS = [
  '特写', '广角', '俯视', '等距视角', '居中构图',
  '黄金比例', '对角线构图', '全身', '半身', '侧面',
]

const LIGHTING_CHIPS = [
  '柔光', '逆光', '黄金时刻', '霓虹光', '影棚光',
  '自然光', '夜光', '戏剧性侧光', '丁达尔光', '月光',
]

const COLOR_CHIPS = [
  '暖色调', '冷色调', '高对比', '莫兰迪', '单色',
  '渐变', '马卡龙', '深邃暗调', '明亮饱和', '复古滤镜',
]

const QUALITY_CHIPS = [
  '高细节', '8k', '大师作品', '锐利对焦', '超现实',
  '精致纹理', '电影质感', '商业摄影', '获奖作品', 'HDR',
]

// ── Types ─────────────────────────────────────────────────────────────────────

interface ChipGroupProps {
  label: string
  chips: string[]
  selected: Set<string>
  onToggle: (chip: string) => void
}

// ── Sub-components ────────────────────────────────────────────────────────────

function ChipGroup({ label, chips, selected, onToggle }: ChipGroupProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-[11px] font-medium text-ink-dim tracking-wide">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {chips.map((chip) => {
          const active = selected.has(chip)
          return (
            <button
              key={chip}
              type="button"
              onClick={() => onToggle(chip)}
              className={[
                'px-2.5 py-1 rounded-lg text-xs border transition-all duration-100',
                active
                  ? 'bg-sakura/20 border-sakura/60 text-ink font-medium'
                  : 'bg-surface-2 border-line text-ink-muted hover:border-line-strong hover:text-ink',
              ].join(' ')}
            >
              {chip}
            </button>
          )
        })}
      </div>
    </div>
  )
}

// ── Main component ────────────────────────────────────────────────────────────

export interface PromptBuilderProps {
  onApply: (prompt: string) => void
}

export default function PromptBuilder({ onApply }: PromptBuilderProps) {
  const [open, setOpen] = useState(false)
  const [subject, setSubject] = useState('')
  const [styles, setStyles] = useState<Set<string>>(new Set())
  const [compositions, setCompositions] = useState<Set<string>>(new Set())
  const [lightings, setLightings] = useState<Set<string>>(new Set())
  const [colors, setColors] = useState<Set<string>>(new Set())
  const [qualities, setQualities] = useState<Set<string>>(new Set())

  const toggle =
    (setter: React.Dispatch<React.SetStateAction<Set<string>>>) =>
    (chip: string) => {
      setter((prev) => {
        const next = new Set(prev)
        if (next.has(chip)) next.delete(chip)
        else next.add(chip)
        return next
      })
    }

  const buildPrompt = (): string => {
    const parts: string[] = []
    if (subject.trim()) parts.push(subject.trim())
    if (styles.size > 0) parts.push([...styles].join('、'))
    if (compositions.size > 0) parts.push([...compositions].join('、'))
    if (lightings.size > 0) parts.push([...lightings].join('、'))
    if (colors.size > 0) parts.push([...colors].join('、'))
    if (qualities.size > 0) parts.push([...qualities].join('、'))
    return parts.join('，')
  }

  const preview = buildPrompt()
  const hasAny =
    !!subject.trim() ||
    styles.size > 0 ||
    compositions.size > 0 ||
    lightings.size > 0 ||
    colors.size > 0 ||
    qualities.size > 0

  const handleApply = () => {
    const p = buildPrompt()
    if (p) onApply(p)
  }

  const handleClear = () => {
    setSubject('')
    setStyles(new Set())
    setCompositions(new Set())
    setLightings(new Set())
    setColors(new Set())
    setQualities(new Set())
  }

  return (
    <div className="max-w-3xl mx-auto mb-2 rounded-xl border border-line bg-surface overflow-hidden">
      {/* Header / toggle */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="w-full flex items-center justify-between px-3.5 py-2.5 text-xs text-ink-muted hover:bg-surface-2 transition-colors"
      >
        <span className="flex items-center gap-1.5 font-medium">
          <span className="text-ink-dim text-[13px]">✦</span>
          结构化 Prompt 构建器
        </span>
        <span
          className={[
            'text-ink-dim transition-transform duration-200',
            open ? 'rotate-180' : '',
          ].join(' ')}
        >
          ▾
        </span>
      </button>

      {/* Body (collapsible) */}
      {open && (
        <div className="border-t border-line/60 px-3.5 py-3 flex flex-col gap-3">
          {/* Subject */}
          <div className="flex flex-col gap-1.5">
            <span className="text-[11px] font-medium text-ink-dim tracking-wide">
              主体 / 内容
            </span>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="描述图像的主要内容，例：一只戴帽子的猫…"
              className="w-full bg-surface-2 border border-line rounded-lg px-3 py-1.5 text-xs text-ink placeholder-ink-dim focus:outline-none focus:border-lavender transition-colors"
            />
          </div>

          <ChipGroup
            label="风格"
            chips={STYLE_CHIPS}
            selected={styles}
            onToggle={toggle(setStyles)}
          />
          <ChipGroup
            label="构图 / 视角"
            chips={COMPOSITION_CHIPS}
            selected={compositions}
            onToggle={toggle(setCompositions)}
          />
          <ChipGroup
            label="光线"
            chips={LIGHTING_CHIPS}
            selected={lightings}
            onToggle={toggle(setLightings)}
          />
          <ChipGroup
            label="色调"
            chips={COLOR_CHIPS}
            selected={colors}
            onToggle={toggle(setColors)}
          />
          <ChipGroup
            label="质量词"
            chips={QUALITY_CHIPS}
            selected={qualities}
            onToggle={toggle(setQualities)}
          />

          {/* Preview */}
          <div className="rounded-lg bg-surface-2 border border-line px-3 py-2">
            <span className="text-[10px] text-ink-dim block mb-1">预览</span>
            <p className="text-xs text-ink leading-relaxed break-words min-h-[1.5rem]">
              {preview ? (
                preview
              ) : (
                <span className="text-ink-dim italic">（选择维度后将在此预览）</span>
              )}
            </p>
          </div>

          {/* Actions */}
          <div className="flex items-center gap-2 justify-end pt-0.5">
            <button
              type="button"
              onClick={handleClear}
              disabled={!hasAny}
              className="px-3 py-1.5 rounded-lg text-xs bg-surface-2 border border-line text-ink-muted hover:bg-elevated hover:text-ink transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              清空选择
            </button>
            <button
              type="button"
              onClick={handleApply}
              disabled={!preview}
              className="px-3.5 py-1.5 rounded-lg text-xs bg-grad-primary text-white shadow-glow-primary hover:-translate-y-px disabled:opacity-30 disabled:shadow-none disabled:translate-y-0 disabled:cursor-not-allowed transition-all"
            >
              填入输入框
            </button>
          </div>
        </div>
      )}
    </div>
  )
}