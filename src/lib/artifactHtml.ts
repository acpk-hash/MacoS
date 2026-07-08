// Artifact HTML helpers (H3)。
//
// 纯函数集合，负责在「AI 产出的 HTML 字符串」这一单一数据源之上做三件事：
//   1. 从模型回复里提取一个完整的 HTML 文档（优先 ```html 代码块）。
//   2. 给可编辑文本节点注入稳定的 data-artifact-id，供预览可视化编辑定位。
//   3. 编辑完成后，把预览 DOM 里某个节点的新文本写回 HTML 字符串。
//
// 全部基于浏览器内置 DOMParser / XMLSerializer，不引第三方依赖，便于 tsc 校验
// 与在 iframe 之外做无副作用的字符串变换（单一数据源 = HTML 字符串 state）。

/** data 属性名：标记一个可就地编辑的文本节点。 */
export const ARTIFACT_ID_ATTR = 'data-artifact-id'

/** 会被视为「可编辑文本块」的标签（叶子文本容器，避免整块容器变可编辑）。 */
const EDITABLE_TAGS = new Set([
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
  'p', 'li', 'span', 'a', 'td', 'th',
  'figcaption', 'blockquote', 'strong', 'em', 'small', 'label',
])

/**
 * 从模型回复文本中提取一个完整 HTML 文档。
 * 顺序：```html 代码块 → 任意 ``` 代码块 → 裸 <!doctype/<html> 片段 → 空串。
 */
export function extractHtml(reply: string): string {
  const text = reply ?? ''

  // 1) ```html ... ``` （大小写不敏感，允许 htm）
  const fenced = /```(?:html?|xml)?\s*\n([\s\S]*?)```/i.exec(text)
  if (fenced && /<\s*(html|!doctype|section|body|div|h[1-6]|p)\b/i.test(fenced[1])) {
    return fenced[1].trim()
  }

  // 2) 任意围栏代码块里若含 html 结构，也接受
  const anyFence = /```\s*\n?([\s\S]*?)```/.exec(text)
  if (anyFence && /<\s*(html|!doctype|section|body)\b/i.test(anyFence[1])) {
    return anyFence[1].trim()
  }

  // 3) 裸文档（模型没加围栏时）
  const bare = /<!doctype[\s\S]*<\/html>|<html[\s\S]*<\/html>/i.exec(text)
  if (bare) return bare[0].trim()

  // 4) 至少含一个 <section class="slide"> 之类结构的裸片段
  if (/<\s*(section|div|h[1-6]|p)\b/i.test(text)) return text.trim()

  return ''
}

/** 判断字符串是否已是一个较完整的 HTML 文档。 */
export function looksLikeHtmlDoc(html: string): boolean {
  return /<html[\s\S]*<\/html>|<!doctype/i.test(html)
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 把裸片段包成一个自包含、离线、蓝白风的 HTML 文档。
 * 当模型只回了 body 片段时用它兜底，保证 iframe 可直接渲染。
 */
export function ensureHtmlDocument(html: string, title = '文档'): string {
  const trimmed = (html ?? '').trim()
  if (looksLikeHtmlDoc(trimmed)) return trimmed
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
</head>
<body>
${trimmed}
</body>
</html>`
}

/** 一个 element 是否「只含文本」（没有元素子节点），因此适合就地编辑。 */
function isLeafTextEl(el: Element): boolean {
  if (el.children.length !== 0) return false
  const t = (el.textContent ?? '').trim()
  return t.length > 0
}

/**
 * 给 HTML 文档中的可编辑叶子文本节点注入稳定 data-artifact-id。
 * 已有 id 的保持不变（保证多轮编辑/重解析的稳定性）。返回新的 HTML 字符串。
 */
export function injectEditableIds(html: string): string {
  if (typeof DOMParser === 'undefined') return html
  const doc = new DOMParser().parseFromString(
    ensureHtmlDocument(html),
    'text/html',
  )
  let seq = 0
  const used = new Set<string>()
  doc.querySelectorAll(`[${ARTIFACT_ID_ATTR}]`).forEach((el) => {
    used.add(el.getAttribute(ARTIFACT_ID_ATTR) ?? '')
  })
  const all = doc.body.querySelectorAll(Array.from(EDITABLE_TAGS).join(','))
  all.forEach((el) => {
    if (el.hasAttribute(ARTIFACT_ID_ATTR)) return
    if (!isLeafTextEl(el)) return
    let id = `a${seq++}`
    while (used.has(id)) id = `a${seq++}`
    used.add(id)
    el.setAttribute(ARTIFACT_ID_ATTR, id)
  })
  return serializeDoc(doc)
}

/** 极简 CSS 属性选择器转义（id 只用 a\d+，这里做保守兜底）。 */
function cssEscape(s: string): string {
  // id 仅由 a\d+ 生成，不含特殊字符；用属性选择器时无需转义。
  return s
}

/**
 * 把某个 artifact 节点的新 HTML 内容写回文档字符串。
 * `id` 为 data-artifact-id，`newInner` 为编辑后的 innerHTML（通常是纯文本）。
 * 找不到对应节点时原样返回。
 */
export function applyEdit(html: string, id: string, newInner: string): string {
  if (typeof DOMParser === 'undefined') return html
  const doc = new DOMParser().parseFromString(html, 'text/html')
  const el = doc.querySelector(`[${ARTIFACT_ID_ATTR}="${cssEscape(id)}"]`)
  if (!el) return html
  el.innerHTML = newInner
  return serializeDoc(doc)
}

/** 统计文档中带 artifact id 的可编辑节点数（用于 UI 提示）。 */
export function countEditable(html: string): number {
  if (typeof DOMParser === 'undefined') return 0
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return doc.querySelectorAll(`[${ARTIFACT_ID_ATTR}]`).length
}

/** 序列化回带 <!DOCTYPE html> 前缀的完整字符串。 */
function serializeDoc(doc: Document): string {
  const dt = doc.doctype ? '<!DOCTYPE html>\n' : ''
  return dt + doc.documentElement.outerHTML
}

/** 供 iframe 内使用的可视化编辑运行时脚本（作为字符串注入）。
 *  仅当处于「可视化编辑」模式时注入；点击带 artifact id 的节点进入
 *  contenteditable，blur / Enter / Esc 时通过 postMessage 把 {id, html}
 *  回传给父窗口，父窗口再 applyEdit 写回源码字符串。 */
export const VISUAL_EDIT_RUNTIME = `
(function () {
  var ATTR = '${ARTIFACT_ID_ATTR}';
  var editing = null;
  function nodes() { return document.querySelectorAll('[' + ATTR + ']'); }
  function mark() {
    nodes().forEach(function (el) {
      el.style.outline = '1px dashed rgba(37,99,235,.45)';
      el.style.outlineOffset = '2px';
      el.style.cursor = 'text';
    });
  }
  function begin(el) {
    if (editing === el) return;
    finish();
    editing = el;
    el.setAttribute('contenteditable', 'true');
    el.style.outline = '2px solid #2563eb';
    el.focus();
  }
  function finish() {
    if (!editing) return;
    var el = editing;
    editing = null;
    el.removeAttribute('contenteditable');
    el.style.outline = '1px dashed rgba(37,99,235,.45)';
    var id = el.getAttribute(ATTR);
    parent.postMessage({ __artifact: true, type: 'edit', id: id, html: el.innerHTML }, '*');
  }
  document.addEventListener('click', function (e) {
    var el = e.target;
    while (el && el !== document.body && !(el.hasAttribute && el.hasAttribute(ATTR))) el = el.parentElement;
    if (el && el.hasAttribute && el.hasAttribute(ATTR)) { e.preventDefault(); begin(el); }
  }, true);
  document.addEventListener('blur', function (e) {
    if (editing && e.target === editing) finish();
  }, true);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && editing) { finish(); }
    if (e.key === 'Enter' && !e.shiftKey && editing) { e.preventDefault(); finish(); }
  }, true);
  mark();
  parent.postMessage({ __artifact: true, type: 'ready' }, '*');
})();
`
