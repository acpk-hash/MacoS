// 中栏 Monaco 编辑器（G2b）。多标签、Ctrl+S 保存、脏标记、AI 改动提示。
// M3b：代码追随（AI 改动自动跳转 + 改动行高亮渐隐 + 「跟随 AI」开关）与
// HTML/Markdown 实时预览（代码 / 预览 / 分屏，编辑防抖 300ms 即时刷新）。
// Q1：预览扩展 — PDF（pdfjs，懒加载）、图片（ws_read_bytes → data URL）、
// SVG（文本实时预览）；其余二进制显示友好占位。
// 顶部 import monacoSetup 触发离线 worker/主题接线。
import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type * as MonacoNs from 'monaco-editor'
import type { editor } from 'monaco-editor'
import { MONACO_THEME } from '../../lib/monacoSetup'
import { useWorkspaceStore, type OpenTab } from '../../stores/workspaceStore'
import { MarkdownLite } from './ChatPanel'
import Mascot from '../ui/Mascot'
import ImagePreview, { IMAGE_MIME } from './ImagePreview'

// PDF 预览懒加载：pdfjs 体积大，独立 chunk，仅在首次打开 .pdf 时拉取。
const PdfPreview = lazy(() => import('./PdfPreview'))

type ViewMode = 'code' | 'preview' | 'split'

type PreviewKind = 'html' | 'markdown' | 'svg' | 'pdf' | 'image' | null

/**
 * 由文件名判断预览类型：
 * - html/md/svg：文本，支持 代码 / 预览 / 分屏 切换；
 * - pdf/图片：二进制（不受 tooLarge 标记影响），仅预览模式，走 ws_read_bytes。
 */
function previewKind(tab: OpenTab | null): PreviewKind {
  if (!tab) return null
  const ext = tab.name.toLowerCase().split('.').pop() ?? ''
  if (ext === 'pdf') return 'pdf'
  if (ext in IMAGE_MIME) return 'image'
  if (tab.tooLarge) return null
  if (ext === 'html' || ext === 'htm') return 'html'
  if (ext === 'md' || ext === 'markdown') return 'markdown'
  if (ext === 'svg') return 'svg'
  return null
}

/** pdf / 图片：没有代码模式，只有预览。 */
function isBinaryPreview(kind: PreviewKind): boolean {
  return kind === 'pdf' || kind === 'image'
}

/** 预览内容防抖（300ms）；切换 tab 时立即取新值，不等防抖。 */
function useDebouncedDoc(relPath: string | null, content: string, ms: number): string {
  const [v, setV] = useState(content)
  const keyRef = useRef(relPath)
  useEffect(() => {
    if (keyRef.current !== relPath) {
      keyRef.current = relPath
      setV(content)
      return
    }
    const t = window.setTimeout(() => setV(content), ms)
    return () => window.clearTimeout(t)
  }, [relPath, content, ms])
  return v
}

/** HTML 实时预览：全沙箱 iframe（不允许脚本），srcDoc 随编辑内容走。 */
function HtmlPreview({ doc }: { doc: string }) {
  return (
    <iframe
      sandbox=""
      title="HTML 预览"
      srcDoc={doc}
      className="w-full h-full border-0 bg-white"
    />
  )
}

/** Markdown 预览：复用对话区的 react-markdown 管线（GFM/公式/代码高亮）。 */
function MarkdownPreview({ text }: { text: string }) {
  return (
    <div className="w-full h-full overflow-y-auto bg-editor">
      <div className="max-w-[820px] mx-auto px-6 py-5">
        <MarkdownLite text={text} />
      </div>
    </div>
  )
}

/** SVG 实时预览：文本内容直接转 data URL，随编辑刷新。 */
function SvgPreview({ doc }: { doc: string }) {
  return (
    <div className="w-full h-full overflow-auto bg-editor flex items-center justify-center p-4">
      <img
        src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(doc)}`}
        alt="SVG 预览"
        className="max-w-full max-h-full object-contain"
      />
    </div>
  )
}

function TabButton({ tab, active }: { tab: OpenTab; active: boolean }) {
  const setActive = useWorkspaceStore((s) => s.setActive)
  const closeTab = useWorkspaceStore((s) => s.closeTab)
  const dirty = tab.content !== tab.savedContent
  return (
    <div
      onClick={() => setActive(tab.relPath)}
      title={tab.relPath}
      className={[
        'group flex items-center gap-1.5 pl-3 pr-2 h-9 border-r border-line cursor-pointer flex-shrink-0 max-w-[200px]',
        active ? 'bg-editor text-ink font-medium shadow-[inset_0_1px_0_#8b7cff]' : 'bg-transparent text-ink-muted hover:bg-surface-2',
      ].join(' ')}
    >
      {tab.aiModified && <span className="w-1.5 h-1.5 rounded-full bg-mint flex-shrink-0" />}
      <span className="text-[12.5px] truncate">{tab.name}</span>
      <button
        onClick={(e) => {
          e.stopPropagation()
          closeTab(tab.relPath)
        }}
        className="ml-0.5 w-4 h-4 flex items-center justify-center rounded text-ink-dim hover:text-coral hover:bg-elevated flex-shrink-0"
      >
        {dirty ? <span className="w-1.5 h-1.5 rounded-full bg-gold group-hover:hidden" /> : null}
        <span className={dirty ? 'hidden group-hover:inline' : ''}>✕</span>
      </button>
    </div>
  )
}

const VIEW_MODES: Array<{ id: ViewMode; label: string; title: string }> = [
  { id: 'code', label: '</>', title: '代码' },
  { id: 'preview', label: '◉', title: '预览' },
  { id: 'split', label: '◫', title: '分屏（左代码右预览）' },
]

export default function EditorPane() {
  const tabs = useWorkspaceStore((s) => s.tabs)
  const activeTab = useWorkspaceStore((s) => s.activeTab)
  const updateContent = useWorkspaceStore((s) => s.updateContent)
  const followAi = useWorkspaceStore((s) => s.followAi)
  const setFollowAi = useWorkspaceStore((s) => s.setFollowAi)
  const aiHighlight = useWorkspaceStore((s) => s.aiHighlight)
  const remote = useWorkspaceStore((s) => s.remote)

  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)
  const monacoRef = useRef<typeof MonacoNs | null>(null)
  const decoIds = useRef<string[]>([])
  const fadeTimer = useRef<number | null>(null)
  const appliedSeq = useRef(0)

  // 每个 tab 记住自己的视图模式（代码/预览/分屏），默认代码。
  const [viewModes, setViewModes] = useState<Record<string, ViewMode>>({})

  const active = tabs.find((t) => t.relPath === activeTab) ?? null
  const kind = previewKind(active)
  const binaryOnly = isBinaryPreview(kind)
  const mode: ViewMode = binaryOnly
    ? 'preview'
    : kind && active
      ? viewModes[active.relPath] ?? 'code'
      : 'code'
  const previewDoc = useDebouncedDoc(active?.relPath ?? null, active?.content ?? '', 300)

  /** 把最近一次 AI 改动高亮画到编辑器：改动行加渐隐底色 + 左侧强调条。 */
  const applyHighlight = useCallback(() => {
    const st = useWorkspaceStore.getState()
    const hl = st.aiHighlight
    const ed = editorRef.current
    const mo = monacoRef.current
    if (!hl || !ed || !mo) return
    if (hl.relPath !== st.activeTab) return
    if (appliedSeq.current === hl.seq) return
    if (Date.now() - hl.seq > 15000) return // 过期改动不再补高亮
    const model = ed.getModel()
    if (!model) return
    appliedSeq.current = hl.seq
    const maxLn = model.getLineCount()
    const decs = hl.ranges
      .filter(([a]) => a <= maxLn)
      .map(([a, b]) => ({
        range: new mo.Range(a, 1, Math.min(b, maxLn), 1),
        options: {
          isWholeLine: true,
          className: 'ai-edit-line',
          linesDecorationsClassName: 'ai-edit-gutter',
        },
      }))
    if (fadeTimer.current) window.clearTimeout(fadeTimer.current)
    decoIds.current = ed.deltaDecorations(decoIds.current, decs)
    if (st.followAi) {
      ed.revealLineInCenter(Math.min(hl.firstLine, maxLn), mo.editor.ScrollType.Smooth)
    }
    // CSS 动画负责视觉渐隐；到点后移除 decorations 兜底清理。
    fadeTimer.current = window.setTimeout(() => {
      const e2 = editorRef.current
      if (e2) decoIds.current = e2.deltaDecorations(decoIds.current, [])
    }, 3200)
  }, [])

  // AI 改动到达 / 切到被改 tab 时上色（延迟一拍等 value 刷进 model）。
  useEffect(() => {
    if (!aiHighlight) return
    const t = window.setTimeout(applyHighlight, 80)
    return () => window.clearTimeout(t)
  }, [aiHighlight, activeTab, applyHighlight])

  useEffect(
    () => () => {
      if (fadeTimer.current) window.clearTimeout(fadeTimer.current)
    },
    [],
  )

  // 预览模式下 Monaco 不在焦点，兜一个全局 Ctrl/Cmd+S（Monaco 内部自己处理）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 's') return
      e.preventDefault()
      const el = e.target as HTMLElement | null
      if (el && typeof el.closest === 'function' && el.closest('.monaco-editor')) return
      const cur = useWorkspaceStore.getState().activeTab
      if (cur) void useWorkspaceStore.getState().saveTab(cur)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onMount: OnMount = (ed, monaco) => {
    editorRef.current = ed
    monacoRef.current = monaco
    decoIds.current = []
    // Ctrl/Cmd+S → 保存当前标签（从 store 取最新 activeTab）。
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const cur = useWorkspaceStore.getState().activeTab
      if (cur) void useWorkspaceStore.getState().saveTab(cur)
    })
    // tab 因 key 变化重挂载后，补画可能尚未消费的 AI 高亮。
    window.setTimeout(applyHighlight, 80)
  }

  const setMode = (rel: string, m: ViewMode) => {
    setViewModes((prev) => ({ ...prev, [rel]: m }))
  }

  // binaryOnly（pdf/图片）在 body 分支单独处理，这里只管文本类。
  const showEditor = !kind || mode === 'code' || mode === 'split'
  const showPreview = !!kind && !binaryOnly && (mode === 'preview' || mode === 'split')

  return (
    <div className="flex-1 min-w-0 flex flex-col h-full bg-surface">
      {/* Tab bar + 右侧控制区（视图切换 / 跟随 AI） */}
      <div className="flex items-stretch h-9 border-b border-line flex-shrink-0 bg-bg">
        <div className="flex items-stretch flex-1 min-w-0 overflow-x-auto">
          {tabs.length === 0 ? (
            <div className="flex items-center px-3 text-[11px] text-ink-dim select-none">
              未打开文件
            </div>
          ) : (
            tabs.map((t) => (
              <TabButton key={t.relPath} tab={t} active={t.relPath === activeTab} />
            ))
          )}
        </div>
        <div className="flex items-center gap-1.5 px-2 flex-shrink-0 border-l border-line">
          {kind && active && !binaryOnly && (
            <div className="flex items-center rounded-btn border border-line overflow-hidden">
              {VIEW_MODES.map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMode(active.relPath, m.id)}
                  title={m.title}
                  className={[
                    'px-2 h-6 text-[11px] font-mono transition-colors',
                    mode === m.id
                      ? 'bg-lavender/20 text-lavender'
                      : 'text-ink-dim hover:text-ink hover:bg-surface-2',
                  ].join(' ')}
                >
                  {m.label}
                </button>
              ))}
            </div>
          )}
          {binaryOnly && active && (
            <span
              className="px-2 h-6 flex items-center rounded-btn border border-lavender/30 bg-lavender/10 text-[11px] text-lavender select-none"
              title={kind === 'pdf' ? 'PDF 文件：仅预览模式' : '图片文件：仅预览模式'}
            >
              {kind === 'pdf' ? 'PDF 预览' : '图片预览'}
            </span>
          )}
          <button
            onClick={() => setFollowAi(!followAi)}
            title={
              followAi
                ? '跟随 AI：开 — AI 改动自动打开文件并跳转高亮'
                : '跟随 AI：关 — 只标记改动，不抢占你的光标'
            }
            className={[
              'flex items-center gap-1 px-2 h-6 rounded-btn border text-[11px] transition-colors',
              followAi
                ? 'border-mint/40 bg-mint/10 text-mint'
                : 'border-line text-ink-dim hover:text-ink hover:bg-surface-2',
            ].join(' ')}
          >
            <span
              className={[
                'w-1.5 h-1.5 rounded-full',
                followAi ? 'bg-mint' : 'bg-ink-dim/60',
              ].join(' ')}
            />
            跟随 AI
          </button>
        </div>
      </div>

      {/* AI-modified banner */}
      {active?.aiModified && (
        <button
          onClick={() => void useWorkspaceStore.getState().reloadTab(active.relPath)}
          className="flex items-center gap-2 px-3 py-1.5 text-[12px] text-mint bg-mint/10 border-b border-mint/25 hover:bg-mint/20 transition-colors"
        >
          <span className="w-1.5 h-1.5 rounded-full bg-mint" />
          AI 修改了此文件，且你有未保存改动 — 点击加载 AI 的版本
        </button>
      )}

      {/* Editor body */}
      <div className="flex-1 min-h-0 relative">
        {!active ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-6">
            <Mascot mood="idle" size={72} />
            <p className="text-[13px] text-ink-muted">从左侧文件树选一个文件开始编辑</p>
            <p className="text-[11px] text-ink-dim">或在右侧对话，让 AI 直接帮你改代码</p>
          </div>
        ) : binaryOnly ? (
          <div className="absolute inset-0">
            {remote ? (
              <div className="w-full h-full flex flex-col items-center justify-center gap-2 text-center px-6">
                <div className="text-3xl">🌐</div>
                <p className="text-[13px] text-ink-muted">远程文件暂不支持 PDF / 图片预览</p>
                <p className="text-[11px] text-ink-dim">{active.relPath}</p>
              </div>
            ) : kind === 'pdf' ? (
              <Suspense
                fallback={
                  <div className="w-full h-full flex items-center justify-center text-[12px] text-ink-dim">
                    PDF 预览组件加载中…
                  </div>
                }
              >
                <PdfPreview relPath={active.relPath} />
              </Suspense>
            ) : (
              <ImagePreview
                relPath={active.relPath}
                ext={active.name.toLowerCase().split('.').pop() ?? ''}
              />
            )}
          </div>
        ) : active.tooLarge ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-6">
            <div className="text-3xl">🗄️</div>
            <p className="text-[13px] text-ink-muted">
              {active.encoding === 'binary'
                ? '该文件类型暂不支持预览，可用外部程序打开'
                : '文件过大（>1MB），编辑器已跳过加载'}
            </p>
            <p className="text-[11px] text-ink-dim">{active.relPath}</p>
          </div>
        ) : (
          <div className="absolute inset-0 flex">
            {showEditor && (
              <div
                className={
                  mode === 'split' ? 'w-1/2 min-w-0 h-full border-r border-line' : 'flex-1 min-w-0 h-full'
                }
              >
                <Editor
                  key={active.relPath}
                  theme={MONACO_THEME}
                  language={active.language}
                  value={active.content}
                  onChange={(v) => updateContent(active.relPath, v ?? '')}
                  onMount={onMount}
                  options={{
                    fontSize: 13,
                    lineHeight: 20,
                    fontFamily:
                      'ui-monospace, SFMono-Regular, "Cascadia Code", "JetBrains Mono", Consolas, monospace',
                    minimap: { enabled: mode !== 'split', maxColumn: 80 },
                    scrollBeyondLastLine: false,
                    smoothScrolling: true,
                    cursorBlinking: 'smooth',
                    renderLineHighlight: 'all',
                    roundedSelection: true,
                    padding: { top: 10, bottom: 10 },
                    tabSize: 2,
                    automaticLayout: true,
                  }}
                  loading={<div className="p-4 text-[12px] text-ink-dim">编辑器加载中…</div>}
                />
              </div>
            )}
            {showPreview && (
              <div className={mode === 'split' ? 'w-1/2 min-w-0 h-full' : 'flex-1 min-w-0 h-full'}>
                {kind === 'html' ? (
                  <HtmlPreview doc={previewDoc} />
                ) : kind === 'svg' ? (
                  <SvgPreview doc={previewDoc} />
                ) : (
                  <MarkdownPreview text={previewDoc} />
                )}
              </div>
            )}
          </div>
        )}
      </div>

      {/* Status bar */}
      {active && (
        <div className="flex items-center gap-3 h-6 px-3 border-t border-line bg-surface/40 text-[10.5px] text-ink-dim flex-shrink-0 select-none">
          <span className="truncate flex-1">{active.relPath}</span>
          {kind && mode !== 'code' && (
            <span className="text-lavender">{mode === 'split' ? '分屏预览' : '预览'}</span>
          )}
          <span>{binaryOnly ? (kind === 'pdf' ? 'PDF' : '图片') : active.language}</span>
          {active.content !== active.savedContent && <span className="text-gold">● 未保存</span>}
          <span className="text-ink-dim/70">Ctrl+S 保存</span>
        </div>
      )}
    </div>
  )
}
