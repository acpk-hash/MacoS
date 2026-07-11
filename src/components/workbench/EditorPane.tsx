// 中栏 Monaco 编辑器（G2b）。多标签、Ctrl+S 保存、脏标记、AI 改动提示。
// 顶部 import monacoSetup 触发离线 worker/主题接线。
import { useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { editor } from 'monaco-editor'
import { MONACO_THEME } from '../../lib/monacoSetup'
import { useWorkspaceStore, type OpenTab } from '../../stores/workspaceStore'
import Mascot from '../ui/Mascot'

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

export default function EditorPane() {
  const tabs = useWorkspaceStore((s) => s.tabs)
  const activeTab = useWorkspaceStore((s) => s.activeTab)
  const updateContent = useWorkspaceStore((s) => s.updateContent)
  const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null)

  const active = tabs.find((t) => t.relPath === activeTab) ?? null

  const onMount: OnMount = (ed, monaco) => {
    editorRef.current = ed
    // Ctrl/Cmd+S → 保存当前标签（从 store 取最新 activeTab）。
    ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      const cur = useWorkspaceStore.getState().activeTab
      if (cur) void useWorkspaceStore.getState().saveTab(cur)
    })
  }

  return (
    <div className="flex-1 min-w-0 flex flex-col h-full bg-surface">
      {/* Tab bar */}
      <div className="flex items-stretch h-9 border-b border-line overflow-x-auto flex-shrink-0 bg-bg">
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
        ) : active.tooLarge ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-6">
            <div className="text-3xl">🗄️</div>
            <p className="text-[13px] text-ink-muted">
              {active.encoding === 'binary' ? '二进制文件，无法在编辑器中显示' : '文件过大（&gt;1MB），已跳过预览'}
            </p>
            <p className="text-[11px] text-ink-dim">{active.relPath}</p>
          </div>
        ) : (
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
              minimap: { enabled: true, maxColumn: 80 },
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
        )}
      </div>

      {/* Status bar */}
      {active && (
        <div className="flex items-center gap-3 h-6 px-3 border-t border-line bg-surface/40 text-[10.5px] text-ink-dim flex-shrink-0 select-none">
          <span className="truncate flex-1">{active.relPath}</span>
          <span>{active.language}</span>
          {active.content !== active.savedContent && <span className="text-gold">● 未保存</span>}
          <span className="text-ink-dim/70">Ctrl+S 保存</span>
        </div>
      )}
    </div>
  )
}
