// Monaco 离线接线（G2b）。
//
// - 用 vite 的 `?worker` 后缀把 Monaco 的各 language worker 本地打包，
//   彻底不依赖 CDN；`self.MonacoEnvironment.getWorker` 按 label 分发。
// - `loader.config({ monaco })` 让 @monaco-editor/react 使用本地 import 的
//   monaco 实例（否则默认会从 jsdelivr 拉取，离线不可用）。
// - 定义与 v0.7 蓝白科研主题协调的浅色主题 `agentboard-light`（白底、当前行
//   浅蓝、关键字主色蓝、字符串绿），取代旧的暗色 `agentboard-dark`。
//
// 该文件应在编辑器组件挂载前 import 一次（EditorPane 顶部 import 触发）。
import * as monaco from 'monaco-editor'
import { loader } from '@monaco-editor/react'
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker'
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker'
import cssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker'
import htmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker'
import tsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker'

// 离线 worker 分发。所有 worker 都由 vite 本地打包，无任何网络请求。
;(self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
  getWorker(_workerId: string, label: string): Worker {
    if (label === 'json') return new jsonWorker()
    if (label === 'css' || label === 'scss' || label === 'less') return new cssWorker()
    if (label === 'html' || label === 'handlebars' || label === 'razor') return new htmlWorker()
    if (label === 'typescript' || label === 'javascript') return new tsWorker()
    return new editorWorker()
  },
}

export const MONACO_THEME = 'agentboard-light'

monaco.editor.defineTheme(MONACO_THEME, {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '94a3b8', fontStyle: 'italic' },
    { token: 'keyword', foreground: '2563eb' },
    { token: 'string', foreground: '16a34a' },
    { token: 'number', foreground: 'd97706' },
    { token: 'type', foreground: '0e7490' },
    { token: 'function', foreground: '7c3aed' },
    { token: 'variable', foreground: '1e293b' },
    { token: 'delimiter', foreground: '475569' },
    { token: 'tag', foreground: 'dc2626' },
    { token: 'attribute.name', foreground: 'd97706' },
  ],
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#1e293b',
    'editorLineNumber.foreground': '#cbd5e1',
    'editorLineNumber.activeForeground': '#475569',
    'editor.selectionBackground': '#dbeafe',
    'editor.inactiveSelectionBackground': '#eff4ff',
    'editor.lineHighlightBackground': '#f1f6ff',
    'editor.lineHighlightBorder': '#00000000',
    'editorCursor.foreground': '#2563eb',
    'editorWhitespace.foreground': '#e2e8f0',
    'editorIndentGuide.background1': '#eef2f7',
    'editorIndentGuide.activeBackground1': '#cbd7e6',
    'editorGutter.background': '#ffffff',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#e2e8f0',
    'editorSuggestWidget.background': '#ffffff',
    'editorSuggestWidget.selectedBackground': '#eff4ff',
    'input.background': '#f8fafc',
    'dropdown.background': '#ffffff',
    'scrollbarSlider.background': '#64748b40',
    'scrollbarSlider.hoverBackground': '#64748b66',
    'minimap.background': '#f8fafc',
  },
})

loader.config({ monaco })

/** Map a lowercase file extension to a Monaco language id. */
export function languageForExt(ext: string): string {
  const e = ext.toLowerCase()
  const map: Record<string, string> = {
    ts: 'typescript',
    tsx: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    jsonc: 'json',
    html: 'html',
    htm: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    markdown: 'markdown',
    py: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    hpp: 'cpp',
    cs: 'csharp',
    php: 'php',
    rb: 'ruby',
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'ini',
    ini: 'ini',
    xml: 'xml',
    svg: 'xml',
    sql: 'sql',
    kt: 'kotlin',
    swift: 'swift',
    dart: 'dart',
    vue: 'html',
    lua: 'lua',
    r: 'r',
    dockerfile: 'dockerfile',
  }
  return map[e] ?? 'plaintext'
}
