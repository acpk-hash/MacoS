// Markdown → .docx 转换（Word 窗口导出用）。
//
// 只覆盖基本元素：# 标题（1~6 级）、无序/有序列表、**加粗**、*斜体*、
// `行内代码`、``` 围栏代码块、> 引用、--- 分隔线；表格/图片等复杂元素
// 按纯文本段落兜底。docx 库按需动态引入（见 officeStore.wordDownload）。

import {
  AlignmentType,
  BorderStyle,
  Document,
  HeadingLevel,
  Packer,
  Paragraph,
  TextRun,
} from 'docx'

const HEADINGS = [
  HeadingLevel.HEADING_1,
  HeadingLevel.HEADING_2,
  HeadingLevel.HEADING_3,
  HeadingLevel.HEADING_4,
  HeadingLevel.HEADING_5,
  HeadingLevel.HEADING_6,
] as const

/** 把一行 Markdown 内联文本拆成 TextRun（加粗/斜体/行内代码）。 */
function inlineRuns(text: string): TextRun[] {
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
  if (runs.length === 0) runs.push(new TextRun({ text: '' }))
  return runs
}

/** Markdown 文本 → docx Paragraph 列表。 */
export function markdownToParagraphs(md: string): Paragraph[] {
  const out: Paragraph[] = []
  const lines = md.replace(/\r\n/g, '\n').split('\n')
  let inCode = false

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
          children: inlineRuns(h[2].trim()),
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
          children: inlineRuns(ul[2]),
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
          children: [new TextRun({ text: `${ol[2]}. ` }), ...inlineRuns(ol[3])],
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
          children: inlineRuns(q[1]),
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
        children: inlineRuns(trimmed),
        alignment: AlignmentType.LEFT,
        spacing: { after: 120 },
      }),
    )
  }

  if (out.length === 0) out.push(new Paragraph({ children: [new TextRun('')] }))
  return out
}

/** Markdown → .docx Blob（浏览器端）。 */
export async function markdownToDocxBlob(md: string): Promise<Blob> {
  const doc = new Document({
    styles: {
      default: {
        document: {
          run: { font: '微软雅黑', size: 22 }, // 11pt 正文
        },
      },
    },
    sections: [{ children: markdownToParagraphs(md) }],
  })
  return Packer.toBlob(doc)
}
