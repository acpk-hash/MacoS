// Monaco 离线接线（G2b）。
//
// - 用 vite 的 `?worker` 后缀把 Monaco 的各 language worker 本地打包，
//   彻底不依赖 CDN；`self.MonacoEnvironment.getWorker` 按 label 分发。
// - `loader.config({ monaco })` 让 @monaco-editor/react 使用本地 import 的
//   monaco 实例（否则默认会从 jsdelivr 拉取，离线不可用）。
// - 定义与二次元玻璃主题协调的暗色主题 `agentboard-dark`（背景走 surface
//   色系，光标粉色、字符串薄荷、关键字樱花），避免默认纯黑。
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
    { token: 'comment', foreground: '6f6a8f', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'ff7fbf' },
    { token: 'string', foreground: '7fe7c4' },
    { token: 'number', foreground: 'ffd88f' },
    { token: 'type', foreground: '7fb0ff' },
    { token: 'function', foreground: 'b58fff' },
    { token: 'variable', foreground: 'ece8fb' },
    { token: 'delimiter', foreground: 'a49dc7' },
    { token: 'tag', foreground: 'ff8b9a' },
    { token: 'attribute.name', foreground: 'ffd88f' },
  ],
  colors: {
    'editor.background': '#1a1728',
    'editor.foreground': '#ece8fb',
    'editorLineNumber.foreground': '#4a4463',
    'editorLineNumber.activeForeground': '#a49dc7',
    'editor.selectionBackground': '#3a2f5a',
    'editor.inactiveSelectionBackground': '#2a2440',
    'editor.lineHighlightBackground': '#221d36',
    'editor.lineHighlightBorder': '#00000000',
    'editorCursor.foreground': '#ff7fbf',
    'editorWhitespace.foreground': '#2f2a44',
    'editorIndentGuide.background1': '#272338',
    'editorIndentGuide.activeBackground1': '#3a3352',
    'editorGutter.background': '#1a1728',
    'editorWidget.background': '#1e1b2e',
    'editorWidget.border': '#272338',
    'editorSuggestWidget.background': '#1e1b2e',
    'editorSuggestWidget.selectedBackground': '#2f2a44',
    'input.background': '#14121f',
    'dropdown.background': '#1e1b2e',
    'scrollbarSlider.background': '#b58fff2e',
    'scrollbarSlider.hoverBackground': '#b58fff55',
    'minimap.background': '#181524',
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
