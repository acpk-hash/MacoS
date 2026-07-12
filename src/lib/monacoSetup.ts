// Monaco 离线接线（G2b）。
//
// - 用 vite 的 `?worker` 后缀把 Monaco 的各 language worker 本地打包，
//   彻底不依赖 CDN；`self.MonacoEnvironment.getWorker` 按 label 分发。
// - `loader.config({ monaco })` 让 @monaco-editor/react 使用本地 import 的
//   monaco 实例（否则默认会从 jsdelivr 拉取，离线不可用）。
// - 定义与 v0.11 Codex 风浅色主题协调的浅色主题（主题名保留
//   `agentboard-dark` 旧名以免改动引用；底 #ffffff、当前行 #f5f5f3、
//   行号 #b3b3ad、选中 #d7d7f0 系），对齐全站浅色 token。
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

let monacoIntelliSenseInitialized = false

/**
 * 启用 Monaco 自带的轻量代码智能（TS/JS/JSON），不依赖 node_modules/LSP/后端。
 * 幂等：模块可被重复 import，defaults 只配置一次。
 */
export function initializeMonacoIntelliSense(): void {
  if (monacoIntelliSenseInitialized) return
  monacoIntelliSenseInitialized = true

  const ts = monaco.languages.typescript
  const compilerOptions: monaco.languages.typescript.CompilerOptions = {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.NodeJs,
    allowNonTsExtensions: true,
    jsx: ts.JsxEmit.React,
    allowJs: true,
    esModuleInterop: true,
    skipLibCheck: true,
    lib: ['esnext', 'dom'],
  }
  const diagnosticsOptions: monaco.languages.typescript.DiagnosticsOptions = {
    noSemanticValidation: false,
    noSyntaxValidation: false,
    diagnosticCodesToIgnore: [2307, 2792, 2304, 2580, 7016],
  }

  ts.typescriptDefaults.setCompilerOptions(compilerOptions)
  ts.javascriptDefaults.setCompilerOptions(compilerOptions)
  ts.typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
  ts.javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
  ts.typescriptDefaults.setEagerModelSync(true)
  ts.javascriptDefaults.setEagerModelSync(true)

  monaco.languages.json.jsonDefaults.setDiagnosticsOptions({
    validate: true,
    allowComments: true,
    schemas: [],
  })
}

monaco.editor.defineTheme(MONACO_THEME, {
  base: 'vs',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '6a737d', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'a626a4' },
    { token: 'string', foreground: '50a14f' },
    { token: 'number', foreground: '986801' },
    { token: 'type', foreground: '0184bc' },
    { token: 'function', foreground: '4078f2' },
    { token: 'variable', foreground: '383a42' },
    { token: 'delimiter', foreground: '696c77' },
    { token: 'tag', foreground: 'e45649' },
    { token: 'attribute.name', foreground: '986801' },
  ],
  colors: {
    'editor.background': '#ffffff',
    'editor.foreground': '#1f1f1e',
    'editorLineNumber.foreground': '#b3b3ad',
    'editorLineNumber.activeForeground': '#55554f',
    'editor.selectionBackground': '#d7d7f0',
    'editor.inactiveSelectionBackground': '#e7e7f4',
    'editor.lineHighlightBackground': '#f5f5f3',
    'editor.lineHighlightBorder': '#00000000',
    'editorCursor.foreground': '#202123',
    'editorWhitespace.foreground': '#e6e6e3',
    'editorIndentGuide.background1': '#efefec',
    'editorIndentGuide.activeBackground1': '#d6d6d2',
    'editorGutter.background': '#ffffff',
    'editorWidget.background': '#ffffff',
    'editorWidget.border': '#e6e6e3',
    'editorSuggestWidget.background': '#ffffff',
    'editorSuggestWidget.selectedBackground': '#20212314',
    'input.background': '#ffffff',
    'dropdown.background': '#ffffff',
    'scrollbarSlider.background': '#00000021',
    'scrollbarSlider.hoverBackground': '#0000003d',
    'minimap.background': '#ffffff',
  },
})

loader.config({ monaco })
initializeMonacoIntelliSense()

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
    yml: 'yaml',
    yaml: 'yaml',
    toml: 'ini',
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