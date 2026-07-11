// Monaco 离线接线（G2b）。
//
// - 用 vite 的 `?worker` 后缀把 Monaco 的各 language worker 本地打包，
//   彻底不依赖 CDN；`self.MonacoEnvironment.getWorker` 按 label 分发。
// - `loader.config({ monaco })` 让 @monaco-editor/react 使用本地 import 的
//   monaco 实例（否则默认会从 jsdelivr 拉取，离线不可用）。
// - 定义与 v0.9 Trae 风深色 IDE 主题协调的深色主题 `agentboard-dark`
//   （VSCode Dark+ 风：底 #1e1e22、当前行 #2a2a31、关键字紫蓝、字符串绿、
//   注释灰绿、行号 dim），取代旧的浅色 agentboard-light。
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

export const MONACO_THEME = 'agentboard-dark'

monaco.editor.defineTheme(MONACO_THEME, {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6a9955', fontStyle: 'italic' },
    { token: 'keyword', foreground: '9a8dff' },
    { token: 'string', foreground: 'a5d6a7' },
    { token: 'number', foreground: 'd29922' },
    { token: 'type', foreground: '4ec9b0' },
    { token: 'function', foreground: '82aaff' },
    { token: 'variable', foreground: 'e6e6ea' },
    { token: 'delimiter', foreground: 'b4b4be' },
    { token: 'tag', foreground: '5b8cff' },
    { token: 'attribute.name', foreground: 'd29922' },
  ],
  colors: {
    'editor.background': '#1e1e22',
    'editor.foreground': '#e6e6ea',
    'editorLineNumber.foreground': '#63636e',
    'editorLineNumber.activeForeground': '#b4b4be',
    'editor.selectionBackground': '#8b7cff33',
    'editor.inactiveSelectionBackground': '#8b7cff1c',
    'editor.lineHighlightBackground': '#2a2a31',
    'editor.lineHighlightBorder': '#00000000',
    'editorCursor.foreground': '#8b7cff',
    'editorWhitespace.foreground': '#2c2c33',
    'editorIndentGuide.background1': '#26262c',
    'editorIndentGuide.activeBackground1': '#3a3a44',
    'editorGutter.background': '#1e1e22',
    'editorWidget.background': '#26262c',
    'editorWidget.border': '#2c2c33',
    'editorSuggestWidget.background': '#26262c',
    'editorSuggestWidget.selectedBackground': '#8b7cff24',
    'input.background': '#202024',
    'dropdown.background': '#26262c',
    'scrollbarSlider.background': '#ffffff1f',
    'scrollbarSlider.hoverBackground': '#ffffff3d',
    'minimap.background': '#1e1e22',
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
