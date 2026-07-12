// 轻量 Markdown 渲染（GFM/公式/高亮统一管线）。
// 从旧 workbench/ChatPanel 抽出，供 pi Timeline 等处复用。
import React from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'
import rehypeHighlight from 'rehype-highlight'
import rehypeKatex from 'rehype-katex'
import 'highlight.js/styles/github-dark.css'
import 'katex/dist/katex.min.css'
import { normalizeMathDelimiters } from '../../lib/mathDelimiters'

const REMARK_PLUGINS = [remarkGfm, remarkMath]
const REHYPE_PLUGINS = [
  rehypeHighlight,
  [rehypeKatex, { throwOnError: false, errorColor: 'currentColor' }],
] as never

const mdComponents: Components = {
  pre: ({ children }) => (
    <pre className="my-2 overflow-x-auto rounded-lg border border-line bg-surface-2 p-2.5 text-[12.5px] leading-relaxed">
      {children}
    </pre>
  ),
  code(props) {
    const { className, children } = props
    const isBlock = /language-/.test(className || '')
    if (!isBlock) {
      return (
        <code className="px-1.5 py-0.5 rounded bg-surface-2 text-[0.85em] font-mono text-mint">
          {children}
        </code>
      )
    }
    return <code className={className}>{children}</code>
  },
  p: ({ children }) => <p className="my-1.5 leading-6">{children}</p>,
  ul: ({ children }) => <ul className="my-1.5 list-disc pl-5 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="my-1.5 list-decimal pl-5 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="leading-6">{children}</li>,
  h1: ({ children }) => <h1 className="text-base font-semibold mt-3 mb-1.5">{children}</h1>,
  h2: ({ children }) => <h2 className="text-[15px] font-semibold mt-3 mb-1.5">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold mt-2 mb-1">{children}</h3>,
  a: ({ href, children }) => (
    <a href={href} className="text-sky underline underline-offset-2">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-lavender/40 pl-3 my-1.5 text-ink-muted">
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="my-2 overflow-x-auto">
      <table className="border-collapse text-[13px]">{children}</table>
    </div>
  ),
  th: ({ children }) => (
    <th className="border border-line px-2 py-1 bg-surface-2 text-left font-medium">{children}</th>
  ),
  td: ({ children }) => <td className="border border-line px-2 py-1">{children}</td>,
}

export const MarkdownLite = React.memo(function MarkdownLite({ text }: { text: string }) {
  return (
    <div className="text-[13.5px] text-ink break-words">
      <ReactMarkdown
        remarkPlugins={REMARK_PLUGINS}
        rehypePlugins={REHYPE_PLUGINS}
        components={mdComponents}
      >
        {normalizeMathDelimiters(text)}
      </ReactMarkdown>
    </div>
  )
})

export default MarkdownLite
