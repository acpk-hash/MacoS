// .docx 正文抽取（Word 窗口参考材料上传用）。
// fflate 解压 word/document.xml → 按 </w:p> 切段 → 收集 <w:t> 文本。
// fflate 经动态 import 引入（本模块本身也应被动态 import，保持分包）。

const XML_ENTITY_RE = /&(amp|lt|gt|quot|apos|#x?[0-9a-fA-F]+);/g

function decodeXmlEntities(s: string): string {
  return s.replace(XML_ENTITY_RE, (_, ent: string) => {
    switch (ent) {
      case 'amp':
        return '&'
      case 'lt':
        return '<'
      case 'gt':
        return '>'
      case 'quot':
        return '"'
      case 'apos':
        return "'"
      default: {
        const code = ent.startsWith('#x')
          ? parseInt(ent.slice(2), 16)
          : parseInt(ent.slice(1), 10)
        return Number.isFinite(code) ? String.fromCodePoint(code) : ''
      }
    }
  })
}

/** word/document.xml → 纯文本（段落一行；tab/br 保留）。 */
export function docxXmlToText(xml: string): string {
  const out: string[] = []
  // 把 tab / 换行标记转成占位 w:t，再统一按 w:t 抽取，保证顺序。
  const prepared = xml
    .replace(/<w:tab\s*\/>/g, '<w:t>\t</w:t>')
    .replace(/<w:br\s*\/>/g, '<w:t>\n</w:t>')
  for (const part of prepared.split('</w:p>')) {
    let text = ''
    const tRe = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>/g
    let m: RegExpExecArray | null
    while ((m = tRe.exec(part)) !== null) text += decodeXmlEntities(m[1])
    if (text.trim()) out.push(text)
  }
  return out.join('\n')
}

/** .docx 文件 → 正文纯文本。非法 zip / 缺 document.xml 时抛错。 */
export async function extractDocxText(file: File | Blob): Promise<string> {
  const { unzipSync, strFromU8 } = await import('fflate')
  const buf = new Uint8Array(await file.arrayBuffer())
  let files: Record<string, Uint8Array>
  try {
    files = unzipSync(buf)
  } catch {
    throw new Error('不是有效的 .docx（zip 解压失败）')
  }
  const entry = files['word/document.xml']
  if (!entry) throw new Error('不是有效的 .docx（缺少 word/document.xml）')
  return docxXmlToText(strFromU8(entry))
}
