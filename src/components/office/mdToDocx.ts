// Markdown → .docx 转换（Word 窗口导出 / PDF 翻译导出用）。
//
// 基本元素：# 标题（1~6 级）、无序/有序列表、**加粗**、*斜体*、
// `行内代码`、``` 围栏代码块、> 引用、--- 分隔线；表格/图片等复杂元素
// 按纯文本段落兜底。docx 库按需动态引入（见 officeStore.wordDownload）。
//
// 数学公式（opts.math 开启）：$...$ 行内、$$...$$ 独立公式 →
// LaTeX --temml--> MathML --mathml2omml--> OMML --ImportedXmlComponent-->
// docx 原生 Math 段落；单条公式转换失败时降级为 LaTeX 原文 + 标注，不中断导出。
// temml / mathml2omml 动态 import（不进主 bundle）。

import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  ImportedXmlComponent,
  Packer,
  Paragraph,
  TextRun,
  type ParagraphChild,
} from 'docx'

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const

// ── 公式转换 ────────────────────────────────────────────────────────

/** LaTeX → docx 可嵌入的 OMML 组件；失败返回 null（调用方降级）。 */
export type MathConverter = (
  latex: string,
  display: boolean,
) => ImportedXmlComponent | null

export interface MathStats {
  total: number
  failed: number
}

/**
 * 动态装载 LaTeX→OMML 转换链（temml + mathml2omml）。
 * stats 由调用方传入，用于统计转换成功/降级数量。
 */
export async function createMathConverter(stats: MathStats): Promise<MathConverter> {
  const [{ default: temml }, { mml2omml }] = await Promise.all([
    import('temml'),
    import('mathml2omml'),
  ])
  return (latex, display) => {
    stats.total++
    try {
      const mml = temml.renderToString(latex, {
        displayMode: display,
        throwOnError: true,
      })
      const omml = mml2omml(mml)
      if (!omml || !omml.includes('oMath')) throw new Error('empty OMML')
      return ImportedXmlComponent.fromXmlString(omml)
    } catch {
      stats.failed++
      return null
    }
  }
}

/** 公式 → 段内 children；转换失败降级为 LaTeX 原文 + 标注。 */
function mathChildren(
  latex: string,
  display: boolean,
  conv: MathConverter,
): ParagraphChild[] {
  const t = latex.trim()
  if (!t) return []
  const comp = conv(t, display)
  if (comp) return [comp as unknown as ParagraphChild]
  return [
    new TextRun({ text: display ? `$$${t}$$` : `$${t}$`, font: 'Consolas' }),
    new TextRun({ text: '〔公式未转换〕', color: '999999', size: 14 }),
  ]
}

// ── 行内解析 ────────────────────────────────────────────────────────

/** 把一行 Markdown 内联文本拆成 TextRun（加粗/斜体/行内代码）。 */
function formatRuns(text: string): TextRun[] {
  const runs: TextRun[] = []
  // 按 **bold** / *italic* / `code` 切分；未闭合的标记按普通文本处理。
  const re = /(\*\*[^*]+\*\*|\*[^*\n]+\*|`[^`\n]+`)/g
  let last = 0
  let m: RegExpExecArray | null
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push(new TextRun({ text: text.slice(last, m.index) }))
    const tok = m[0]
    if (tok.startsWith('**')) {
      runs.push(new TextRun({ text: tok.slice(2, -2), bold: true }))
    } else if (tok.startsWith('`')) {
      runs.push(new TextRun({ text: tok.slice(1, -1), font: 'Consolas' }))
    } else {
      runs.push(new TextRun({ text: tok.slice(1, -1), italics: true }))
    }
    last = m.index + tok.length
  }
  if (last < text.length) runs.push(new TextRun({ text: text.slice(last) }))
  return runs
}

/** 内联解析：先切出 $...$ / $$...$$ 公式（如启用），其余走 formatRuns。 */
function inlineRuns(text: string, mathConv?: MathConverter): ParagraphChild[] {
  const out: ParagraphChild[] = []
  if (mathConv) {
    const re = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g
    let last = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(text)) !== null) {
      if (m.index > last) out.push(...formatRuns(text.slice(last, m.index)))
      out.push(...mathChildren(m[1] ?? m[2] ?? '', false, mathConv))
      last = m.index + m[0].length
    }
    if (last < text.length) out.push(...formatRuns(text.slice(last)))
  } else {
    out.push(...formatRuns(text))
  }
  if (out.length === 0) out.push(new TextRun({ text: '' }))
  return out
}

// ── 块级解析 ────────────────────────────────────────────────────────

/** 独立公式段落（居中）。 */
function displayMathParagraph(latex: string, conv: MathConverter): Paragraph {
  return new Paragraph({
    children: mathChildren(latex, true, conv),
    alignment: AlignmentType.CENTER,
    spacing: { before: 120, after: 120 },
  })
}

/** Markdown 文本 → docx Paragraph 列表。 */
export function markdownToParagraphs(
  md: string,
  mathConv?: MathConverter,
): Paragraph[] {
  const out: Paragraph[] = []
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  let inCode = false
  /** 进行中的 $$ 多行公式块（null = 不在块内）。 */
  let mathBlock: string[] | null = null

  for (const rawLine of lines) {
    const line = rawLine

    // 围栏代码块开关
    if (/^\s*```/.test(line)) {
      inCode = !inCode
      continue
    }
    if (inCode) {
      out.push(
        new Paragraph({
          children: [new TextRun({ text: line, font: 'Consolas', size: 18 })],
          spacing: { after: 0 },
        }),
      )
      continue
    }

    const trimmed = line.trim()

    // $$ 多行公式块（仅启用公式转换时特殊处理）
    if (mathConv && mathBlock !== null) {
      if (trimmed === '$$') {
        out.push(displayMathParagraph(mathBlock.join('\n'), mathConv))
        mathBlock = null
      } else {
        mathBlock.push(line)
      }
      continue
    }
    if (mathConv && trimmed === '$$') {
      mathBlock = []
      continue
    }
    if (mathConv) {
      const dm = /^\$\$([\s\S]+)\$\$$/.exec(trimmed)
      if (dm) {
        out.push(displayMathParagraph(dm[1], mathConv))
        continue
      }
    }

    if (trimmed === '') continue

    // 分隔线
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      out.push(
        new Paragraph({
          border: {
            bottom: { style: BorderStyle.SINGLE, size: 4, color: '999999' },
          },
          spacing: { before: 120, after: 120 },
        }),
      )
      continue
    }

    // 标题
    const h = /^(#{1,6})\s+(.*)$/.exec(trimmed)
    if (h) {
      out.push(
        new Paragraph({
          heading: HEADINGS[h[1].length - 1],
          children: inlineRuns(h[2].trim(), mathConv),
          spacing: { before: 200, after: 120 },
        }),
      )
      continue
    }

    // 无序列表（按缩进推列表层级，2 空格一级，最多 3 层）
    const ul = /^(\s*)[-*+]\s+(.*)$/.exec(line)
    if (ul) {
      const level = Math.min(2, Math.floor(ul[1].length / 2))
      out.push(
        new Paragraph({
          children: inlineRuns(ul[2], mathConv),
          bullet: { level },
          spacing: { after: 60 },
        }),
      )
      continue
    }

    // 有序列表：保留编号文本 + 缩进（避免 docx numbering 配置的复杂度）
    const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line)
    if (ol) {
      out.push(
        new Paragraph({
          children: [
            new TextRun({ text: `${ol[2]}. ` }),
            ...inlineRuns(ol[3], mathConv),
          ],
          indent: { left: 360 + Math.min(2, Math.floor(ol[1].length / 2)) * 360 },
          spacing: { after: 60 },
        }),
      )
      continue
    }

    // 引用
    const q = /^>\s?(.*)$/.exec(trimmed)
    if (q) {
      out.push(
        new Paragraph({
          children: inlineRuns(q[1], mathConv),
          indent: { left: 480 },
          border: {
            left: { style: BorderStyle.SINGLE, size: 12, color: '8B7CFF' },
          },
          spacing: { after: 80 },
        }),
      )
      continue
    }

    // 普通段落（表格行等复杂结构也按纯文本兜底）
    out.push(
      new Paragraph({
        children: inlineRuns(trimmed, mathConv),
        alignment: AlignmentType.LEFT,
        spacing: { after: 120 },
      }),
    )
  }

  // 未闭合的 $$ 块：按普通文本兜底，不丢内容。
  if (mathBlock !== null && mathBlock.length > 0) {
    for (const l of mathBlock) {
      out.push(new Paragraph({ children: formatRuns(l), spacing: { after: 60 } }))
    }
  }

  if (out.length === 0) out.push(new Paragraph({ children: [new TextRun('')] }))
  return out
}

// ── 导出入口 ────────────────────────────────────────────────────────

export interface MdToDocxOptions {
  /** 开启 $...$ / $$...$$ → OMML 公式转换（默认关闭，避免普通文档误伤 $ 字符）。 */
  math?: boolean
}

export interface MdToDocxResult {
  blob: Blob
  /** 公式总数 / 降级（转换失败保留 LaTeX 原文）数。 */
  mathTotal: number
  mathFailed: number
}

/** Markdown → .docx（带公式统计）。 */
export async function markdownToDocxBlobEx(
  md: string,
  opts?: MdToDocxOptions,
): Promise<MdToDocxResult> {
  const stats: MathStats = { total: 0, failed: 0 }
  let conv: MathConverter | undefined
  if (opts?.math && /\$/.test(md)) {
    try {
      conv = await createMathConverter(stats)
    } catch (e) {
      console.warn('[mdToDocx] 公式转换链加载失败，整篇按纯文本导出:', e)
    }
  }
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: '微软雅黑', size: 22 }, // 11pt 正文
        },
      },
    },
    sections: [{ children: markdownToParagraphs(md, conv) }],
  })
  const blob = await Packer.toBlob(doc)
  return { blob, mathTotal: stats.total, mathFailed: stats.failed }
}

/** Markdown → .docx Blob（浏览器端）。 */
export async function markdownToDocxBlob(
  md: string,
  opts?: MdToDocxOptions,
): Promise<Blob> {
  return (await markdownToDocxBlobEx(md, opts)).blob
}
