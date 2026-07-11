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

// ── 多语言映射（P3）───────────────────────────────────────────────
//
// 顶部 `import * as monaco from 'monaco-editor'` 走的是包入口
// esm/vs/editor/editor.main.js，它已经 import 了
// `basic-languages/monaco.contribution`——即 monaco 自带的全部 ~80 种
// monarch 语法高亮均已注册（tokenizer 按语言懒加载，vite 拆成小 chunk，
// 不会把主 bundle 撑爆）。这里只需把扩展名/文件名映射到 language id。
// 注意：basic-languages 提供语法着色，不是 IntelliSense/LSP。

/** Map a lowercase file extension to a Monaco language id. */
export function languageForExt(ext: string): string {
  const e = ext.toLowerCase()
  const map: Record<string, string> = {
    // Web / 脚本
    ts: 'typescript',
    tsx: 'typescript',
    mts: 'typescript',
    cts: 'typescript',
    js: 'javascript',
    jsx: 'javascript',
    mjs: 'javascript',
    cjs: 'javascript',
    json: 'json',
    jsonc: 'json',
    ipynb: 'json',
    html: 'html',
    htm: 'html',
    vue: 'html',
    css: 'css',
    scss: 'scss',
    less: 'less',
    md: 'markdown',
    markdown: 'markdown',
    mdx: 'mdx',
    rst: 'restructuredtext',
    // 系统 / 编译语言
    py: 'python',
    pyw: 'python',
    rs: 'rust',
    go: 'go',
    java: 'java',
    c: 'c',
    h: 'c',
    cpp: 'cpp',
    cc: 'cpp',
    cxx: 'cpp',
    hpp: 'cpp',
    hh: 'cpp',
    hxx: 'cpp',
    cs: 'csharp',
    fs: 'fsharp',
    fsi: 'fsharp',
    fsx: 'fsharp',
    m: 'objective-c',
    mm: 'objective-c',
    kt: 'kotlin',
    kts: 'kotlin',
    swift: 'swift',
    scala: 'scala',
    sbt: 'scala',
    dart: 'dart',
    jl: 'julia',
    pas: 'pascal',
    pp: 'pascal',
    // 动态 / 函数式
    php: 'php',
    rb: 'ruby',
    lua: 'lua',
    r: 'r',
    pl: 'perl',
    pm: 'perl',
    ex: 'elixir',
    exs: 'elixir',
    clj: 'clojure',
    cljs: 'clojure',
    cljc: 'clojure',
    edn: 'clojure',
    coffee: 'coffee',
    tcl: 'tcl',
    vb: 'vb',
    // Shell / 运维
    sh: 'shell',
    bash: 'shell',
    zsh: 'shell',
    fish: 'shell',
    ps1: 'powershell',
    psm1: 'powershell',
    psd1: 'powershell',
    bat: 'bat',
    cmd: 'bat',
    dockerfile: 'dockerfile',
    hcl: 'hcl',
    tf: 'hcl',
    tfvars: 'hcl',
    bicep: 'bicep',
    // 配置 / 数据
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'ini', // monaco 无 toml monarch，ini 高亮最接近
    ini: 'ini',
    conf: 'ini',
    cfg: 'ini',
    properties: 'ini',
    env: 'ini',
    xml: 'xml',
    svg: 'xml',
    xsl: 'xml',
    plist: 'xml',
    csproj: 'xml',
    sql: 'sql',
    mysql: 'mysql',
    pgsql: 'pgsql',
    graphql: 'graphql',
    gql: 'graphql',
    proto: 'protobuf',
    // 模板 / 其他
    cshtml: 'razor',
    hbs: 'handlebars',
    handlebars: 'handlebars',
    pug: 'pug',
    jade: 'pug',
    twig: 'twig',
    liquid: 'liquid',
    sol: 'solidity',
    wgsl: 'wgsl',
    sv: 'systemverilog',
    svh: 'systemverilog',
  }
  return map[e] ?? 'plaintext'
}

/**
 * 由完整文件名判断 Monaco language id：先看特殊文件名（Dockerfile、
 * .env、Gemfile 等无扩展名/点开头的文件），再回退到扩展名映射。
 */
export function languageForFile(fileName: string): string {
  const name = fileName.toLowerCase()
  const special: Record<string, string> = {
    dockerfile: 'dockerfile',
    containerfile: 'dockerfile',
    gemfile: 'ruby',
    rakefile: 'ruby',
    '.gitignore': 'ini',
    '.gitattributes': 'ini',
    '.editorconfig': 'ini',
    '.npmrc': 'ini',
    '.prettierrc': 'json',
    '.eslintrc': 'json',
  }
  if (special[name]) return special[name]
  if (name.startsWith('dockerfile.')) return 'dockerfile'
  if (name === '.env' || name.startsWith('.env.')) return 'ini'
  const ext = name.includes('.') ? name.split('.').pop() ?? '' : ''
  return languageForExt(ext)
}
