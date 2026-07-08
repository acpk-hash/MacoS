// Chat export helpers — render conversations to Markdown / self-contained HTML
// and save them to disk via the Tauri dialog + a small Rust write command.
//
// The HTML export reuses the same react-markdown pipeline as the live view
// (GFM + math + code highlight) rendered to a static string, with KaTeX and
// highlight.js CSS inlined so the file is fully offline-viewable.

import { renderToStaticMarkup } from 'react-dom/server'
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import katexCss from 'katex/dist/katex.min.css?inline'
import hljsCss from 'highlight.js/styles/github-dark.css?inline'
import { normalizeMathDelimiters } from './mathDelimiters'
import type { ChatMessageRow } from '../stores/studioStore'

// Same plugin set as the live renderer (module-level → stable references).
const exportRemark = [remarkGfm, remarkMath]
const exportRehype = [rehypeHighlight, [rehypeKatex, { throwOnError: false }]] as never

// ── Markdown export ───────────────────────────────────────────────────────────

/** A single assistant/user message → its raw markdown content. */
export function messageToMarkdown(msg: ChatMessageRow): string {
  return normalizeMathDelimiters(msg.content.trim()) + '\n'
}

/** The whole conversation → markdown, split into `## 用户 / ## 助手` sections. */
export function conversationToMarkdown(
  messages: ChatMessageRow[],
  title: string,
): string {
  const parts: string[] = [`# ${title}\n`]
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    if (!m.content.trim()) continue
    const who = m.role === 'user' ? '用户' : '助手'
    const time = new Date(m.created_at).toLocaleString('zh-CN')
    const body = normalizeMathDelimiters(m.content.trim())
    parts.push(`## ${who} · ${time}\n\n${body}\n`)
  }
  return parts.join('\n')
}

// ── HTML export ───────────────────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/** Render a markdown string to a static HTML fragment (no wrapper document). */
function renderMarkdownFragment(text: string): string {
  return renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={exportRemark} rehypePlugins={exportRehype}>
      {normalizeMathDelimiters(text)}
    </ReactMarkdown>,
  )
}

const PAGE_CSS = `
:root { color-scheme: dark; }
* { box-sizing: border-box; }
body {
  margin: 0;
  background: #0b0e14;
  color: #e5e7eb;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC",
    "Microsoft YaHei", Roboto, Helvetica, Arial, sans-serif;
  line-height: 1.7;
  font-size: 16px;
}
.doc { max-width: 820px; margin: 0 auto; padding: 40px 24px 96px; }
.doc-title { font-size: 1.6rem; font-weight: 600; margin: 0 0 24px; color: #f3f4f6; }
.turn { padding: 16px 0; border-top: 1px solid #1f2430; }
.turn:first-of-type { border-top: none; }
.turn .who { font-size: 12px; letter-spacing: .04em; color: #8b93a7; margin-bottom: 8px; }
.turn.user .body { color: #cbd5e1; }
h1, h2, h3, h4 { color: #f3f4f6; line-height: 1.35; margin: 1.4em 0 .6em; }
h1 { font-size: 1.4rem; } h2 { font-size: 1.2rem; } h3 { font-size: 1.05rem; }
p { margin: .7em 0; }
a { color: #60a5fa; text-decoration: underline; text-underline-offset: 2px; }
a:hover { color: #93c5fd; }
ul, ol { padding-left: 1.5em; margin: .6em 0; }
li { margin: .25em 0; }
blockquote {
  margin: .8em 0; padding: .2em 1em; border-left: 3px solid #374151; color: #9ca3af;
}
hr { border: none; border-top: 1px solid #1f2430; margin: 1.6em 0; }
code {
  background: #1f2430; padding: .15em .4em; border-radius: 4px;
  font-size: .88em; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}
pre {
  background: #0d1117; border: 1px solid #30363d; border-radius: 8px;
  padding: 14px 16px; overflow-x: auto; margin: 1em 0;
}
pre code { background: transparent; padding: 0; font-size: .85em; line-height: 1.6; }
table { border-collapse: collapse; margin: 1em 0; font-size: .92em; display: block; overflow-x: auto; }
th, td { border: 1px solid #30363d; padding: 6px 12px; text-align: left; }
th { background: #161b22; font-weight: 600; }
img { max-width: 100%; border-radius: 8px; }
.katex { color: inherit; }
`

/** Wrap rendered fragments into a full, offline, dark-themed HTML document. */
function htmlDocument(title: string, bodyInner: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(title)}</title>
<style>
${katexCss}
${hljsCss}
${PAGE_CSS}
</style>
</head>
<body>
<main class="doc">
<h1 class="doc-title">${escapeHtml(title)}</h1>
${bodyInner}
</main>
</body>
</html>
`
}

/** A single message → a standalone HTML document. */
export function messageToHtml(msg: ChatMessageRow, title: string): string {
  const inner = `<article class="turn">\n${renderMarkdownFragment(msg.content)}\n</article>`
  return htmlDocument(title, inner)
}

/** The whole conversation → a standalone HTML document with per-turn sections. */
export function conversationToHtml(
  messages: ChatMessageRow[],
  title: string,
): string {
  const sections: string[] = []
  for (const m of messages) {
    if (m.role !== 'user' && m.role !== 'assistant') continue
    if (!m.content.trim()) continue
    const who = m.role === 'user' ? '用户' : '助手'
    const time = new Date(m.created_at).toLocaleString('zh-CN')
    sections.push(
      `<section class="turn ${m.role}">\n` +
        `<div class="who">${who} · ${escapeHtml(time)}</div>\n` +
        `<div class="body">${renderMarkdownFragment(m.content)}</div>\n` +
        `</section>`,
    )
  }
  return htmlDocument(title, sections.join('\n'))
}

// ── Saving to disk ────────────────────────────────────────────────────────────

/** Strip characters that are invalid in file names. */
export function safeFileName(name: string): string {
  const cleaned = name.replace(/[\/:*?"<>|\n\r\t]+/g, ' ').trim()
  return (cleaned || '对话').slice(0, 60)
}

/**
 * Open a Save dialog for the given content and write it via the Rust command.
 * `format` picks the extension + filter. Returns true if the file was saved.
 */
export async function saveExport(
  baseName: string,
  format: 'md' | 'html',
  content: string,
): Promise<boolean> {
  const { save } = await import('@tauri-apps/plugin-dialog')
  const { invoke } = await import('@tauri-apps/api/core')
  const ext = format === 'md' ? 'md' : 'html'
  const path = await save({
    defaultPath: `${safeFileName(baseName)}.${ext}`,
    filters: [
      {
        name: format === 'md' ? 'Markdown' : 'HTML',
        extensions: [ext],
      },
    ],
  })
  if (!path) return false
  await invoke('export_text_file', { path, content })
  return true
}
