// Artifacts 页（H3）——文档 / PPT 的 HTML 可视化编辑，类似 claude.ai 的 artifacts。
//
// 三区布局（蓝白科研风）：
//   左：AI 对话 / 指令区——描述需求让模型产出完整、离线、自包含的 HTML；可继续
//       对话让它改。
//   中：Monaco HTML 源码（可折叠）——手改源码实时刷新预览。
//   右：iframe 实时预览——srcDoc=当前 HTML；「可视化编辑」模式下点击文字块就地
//       编辑，blur 后经 postMessage 把改动写回源码字符串。
//
// 单一数据源 = artifactStore.html。预览、Monaco、可视化编辑三者都读/写它。
import { useEffect, useMemo, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import { MONACO_THEME } from '../lib/monacoSetup'
import { useArtifactStore } from '../stores/artifactStore'
import {
  applyEdit,
  injectEditableIds,
  countEditable,
  VISUAL_EDIT_RUNTIME,
} from '../lib/artifactHtml'
import ModelPicker from '../components/ModelPicker'
import { Mascot } from '../components/ui'
import { saveExport } from '../lib/exportChat'

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

const EXAMPLES = [
  '做一个 5 页关于「深度学习入门」的科研风 PPT',
  '写一份简洁的产品介绍单页文档，含标题、要点列表和结语',
  '做一个 3 页的项目周报幻灯片：进展 / 问题 / 下周计划',
]

type Mode = 'source' | 'visual'

/** 把 artifact-id 注入后的 HTML，并在可视化模式下追加编辑运行时脚本。 */
function buildPreviewDoc(html: string, mode: Mode): string {
  const withIds = injectEditableIds(html)
  if (mode !== 'visual') return withIds
  const script = '<' + 'script>' + VISUAL_EDIT_RUNTIME + '<' + '/script>'
  if (/<\/body>/i.test(withIds)) {
    return withIds.replace(/<\/body>/i, script + '</body>')
  }
  return withIds + script
}

export default function Artifacts() {
  const {
    aggModels,
    currentModel,
    currentProviderId,
    turns,
    html,
    streaming,
    error,
    loadModels,
    setModelSel,
    ask,
    stop,
    setHtml,
    reset,
  } = useArtifactStore()

  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<Mode>('source')
  const [showSource, setShowSource] = useState(true)
  const [toast, setToast] = useState<string | null>(null)

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const toastTimer = useRef<number | null>(null)

  const showToast = (m: string) => {
    setToast(m)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2400)
  }

  useEffect(() => {
    if (isTauri) loadModels()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  // 预览文档（随 html / 模式变化重算）。
  const previewDoc = useMemo(
    () => (html ? buildPreviewDoc(html, mode) : ''),
    [html, mode],
  )
  const editableCount = useMemo(() => (html ? countEditable(html) : 0), [html])

  // 监听 iframe 可视化编辑的回写消息。
  useEffect(() => {
    const onMsg = (e: MessageEvent) => {
      const d = e.data as {
        __artifact?: boolean
        type?: string
        id?: string
        html?: string
      }
      if (!d || !d.__artifact) return
      if (d.type === 'edit' && d.id != null) {
        const next = applyEdit(html, d.id, d.html ?? '')
        if (next !== html) {
          setHtml(next)
          showToast('已写回源码')
        }
      }
    }
    window.addEventListener('message', onMsg)
    return () => window.removeEventListener('message', onMsg)
  }, [html, setHtml])

  const submit = () => {
    const t = draft.trim()
    if (!t || streaming) return
    setDraft('')
    void ask(t)
  }

  const exportHtml = async () => {
    if (!html) return
    try {
      const ok = await saveExport('文档', 'html', html)
      if (ok) showToast('已导出 HTML')
    } catch (e) {
      showToast('导出失败：' + String(e))
    }
  }

  // 打印 / 导出 PDF：把当前 HTML 写进隐藏 iframe 并调用其 print()。
  const printDoc = () => {
    if (!html) return
    const frame = document.createElement('iframe')
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0'
    document.body.appendChild(frame)
    const win = frame.contentWindow
    const doc = frame.contentDocument
    if (!win || !doc) {
      document.body.removeChild(frame)
      return
    }
    doc.open()
    doc.write(html)
    doc.close()
    win.focus()
    window.setTimeout(() => {
      win.print()
      window.setTimeout(() => document.body.removeChild(frame), 1000)
    }, 200)
  }

  if (!isTauri) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <p className="text-ink-muted text-sm">请在桌面应用中使用</p>
        <p className="text-ink-dim text-xs">
          此功能需要 Tauri 桌面运行时，无法在普通浏览器中运行。
        </p>
      </div>
    )
  }

  return (
    <div className="flex h-full min-h-0">
      {/* ── 左：AI 对话 / 指令区 ─────────────────────────── */}
      <div className="flex flex-col w-[300px] flex-shrink-0 border-r border-line h-full bg-surface/40 min-h-0">
        <div className="px-3 py-2.5 border-b border-line flex items-center gap-2 flex-shrink-0">
          <span className="text-sm font-semibold text-primary">文档 / PPT</span>
          <div className="flex-1" />
          <button
            onClick={() => reset()}
            className="text-xs text-ink-muted hover:text-ink border border-line rounded-lg px-2 py-1 transition-colors"
            title="清空并新建文档"
          >
            新建
          </button>
        </div>

        {/* 对话流 */}
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 min-h-0">
          {turns.length === 0 ? (
            <div className="flex flex-col items-center text-center mt-6">
              <Mascot mood="happy" size={64} className="mb-3" />
              <p className="text-sm text-ink-muted mb-1">描述你想要的文档或 PPT</p>
              <p className="text-xs text-ink-dim mb-4">
                模型会产出可离线打开的自包含 HTML
              </p>
              <div className="space-y-2 w-full">
                {EXAMPLES.map((p) => (
                  <button
                    key={p}
                    onClick={() => setDraft(p)}
                    className="w-full text-left px-3 py-2 rounded-lg bg-surface border border-line hover:border-line-strong text-xs text-ink-muted leading-relaxed transition-colors"
                  >
                    {p}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            turns.map((t, i) =>
              t.role === 'user' ? (
                <div key={i} className="flex justify-end">
                  <div className="max-w-[90%] px-3 py-2 rounded-pop rounded-br-md bg-primary text-white text-[13px] leading-6 whitespace-pre-wrap break-words">
                    {t.content}
                  </div>
                </div>
              ) : (
                <div
                  key={i}
                  className="px-3 py-2 rounded-lg bg-surface border border-line text-[12.5px] text-ink-muted leading-6"
                >
                  已生成 / 更新 HTML（见中栏源码与右侧预览）
                </div>
              ),
            )
          )}
          {streaming && (
            <div className="px-3 py-2 rounded-lg bg-surface border border-line text-[12.5px] text-ink-dim">
              正在生成 HTML…
            </div>
          )}
          {error && (
            <div className="px-3 py-2 rounded-lg bg-[#fef2f2] border border-[#fecaca] text-[12.5px] text-failed break-words">
              {error}
            </div>
          )}
        </div>

        {/* 输入区 */}
        <div className="border-t border-line p-2.5 flex-shrink-0 space-y-2">
          <ModelPicker
            models={aggModels}
            value={{ providerId: currentProviderId ?? '', modelId: currentModel }}
            onChange={(v) => setModelSel(v.providerId, v.modelId)}
            className="w-full bg-surface border border-line rounded-lg px-2 py-1.5 text-xs text-ink focus:outline-none focus:border-primary transition-colors"
            title="选择模型"
          />
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
            rows={3}
            placeholder={
              turns.length === 0
                ? '例如：做一个 5 页关于 XX 的 PPT…'
                : '继续对话让它改，如：把第 2 页标题改成…'
            }
            className="w-full resize-none bg-surface border border-line rounded-lg px-2.5 py-2 text-[13px] text-ink placeholder:text-ink-dim focus:outline-none focus:border-primary transition-colors"
          />
          <div className="flex gap-2">
            {streaming ? (
              <button
                onClick={() => void stop()}
                className="flex-1 text-xs px-3 py-2 rounded-lg bg-surface border border-line text-ink-muted hover:text-ink transition-colors"
              >
                停止
              </button>
            ) : (
              <button
                onClick={submit}
                disabled={!currentModel || !draft.trim()}
                className="flex-1 text-xs px-3 py-2 rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {turns.length === 0 ? '生成' : '发送'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── 中：HTML 源码（Monaco，可折叠） ─────────────── */}
      {showSource && (
        <div className="flex flex-col w-[38%] min-w-[280px] flex-shrink-0 border-r border-line h-full min-h-0">
          <div className="flex items-center gap-2 px-3 h-9 border-b border-line flex-shrink-0 bg-surface/40">
            <span className="text-[12.5px] text-ink-muted font-medium">HTML 源码</span>
            <span className="text-[11px] text-ink-dim">
              {html ? html.length + ' 字符' : '空'}
            </span>
            <div className="flex-1" />
            <button
              onClick={() => setShowSource(false)}
              className="text-[11px] text-ink-dim hover:text-ink"
              title="折叠源码栏"
            >
              收起 ⟨
            </button>
          </div>
          <div className="flex-1 min-h-0">
            <Editor
              theme={MONACO_THEME}
              language="html"
              value={html}
              onChange={(v) => setHtml(v ?? '')}
              options={{
                fontSize: 12.5,
                minimap: { enabled: false },
                scrollBeyondLastLine: false,
                wordWrap: 'on',
                smoothScrolling: true,
                padding: { top: 8, bottom: 8 },
                tabSize: 2,
                automaticLayout: true,
              }}
              loading={<div className="p-4 text-[12px] text-ink-dim">编辑器加载中…</div>}
            />
          </div>
        </div>
      )}

      {/* ── 右：实时预览 ─────────────────────────────────── */}
      <div className="flex flex-col flex-1 min-w-0 h-full min-h-0">
        <div className="flex items-center gap-2 px-3 h-9 border-b border-line flex-shrink-0 bg-surface/40">
          {!showSource && (
            <button
              onClick={() => setShowSource(true)}
              className="text-[11px] text-ink-dim hover:text-ink"
              title="展开源码栏"
            >
              ⟩ 源码
            </button>
          )}
          <span className="text-[12.5px] text-ink-muted font-medium">预览</span>

          {/* 可视化 / 源码编辑切换 */}
          <div className="ml-1 flex rounded-lg border border-line overflow-hidden">
            <button
              onClick={() => setMode('source')}
              className={[
                'px-2.5 py-1 text-[11px] transition-colors',
                mode === 'source'
                  ? 'bg-primary text-white'
                  : 'bg-surface text-ink-muted hover:text-ink',
              ].join(' ')}
            >
              源码编辑
            </button>
            <button
              onClick={() => setMode('visual')}
              disabled={!html}
              className={[
                'px-2.5 py-1 text-[11px] transition-colors disabled:opacity-40',
                mode === 'visual'
                  ? 'bg-primary text-white'
                  : 'bg-surface text-ink-muted hover:text-ink',
              ].join(' ')}
              title="点击预览里的文字块即可就地编辑"
            >
              可视化编辑
            </button>
          </div>
          {mode === 'visual' && (
            <span className="text-[11px] text-ink-dim">
              点文字块编辑（{editableCount} 处可编辑）
            </span>
          )}

          <div className="flex-1" />

          <button
            onClick={printDoc}
            disabled={!html}
            className="text-[11px] text-ink-muted hover:text-ink border border-line rounded-lg px-2 py-1 disabled:opacity-40 transition-colors"
            title="用系统打印对话框导出为 PDF"
          >
            导出 PDF
          </button>
          <button
            onClick={() => void exportHtml()}
            disabled={!html}
            className="text-[11px] text-white bg-primary hover:bg-primary-hover rounded-lg px-2.5 py-1 disabled:opacity-40 transition-colors"
          >
            导出 HTML
          </button>
        </div>

        <div className="flex-1 min-h-0 bg-[#f1f6ff] relative">
          {html ? (
            <iframe
              key={mode}
              ref={iframeRef}
              title="artifact-preview"
              srcDoc={previewDoc}
              sandbox={
                mode === 'visual'
                  ? 'allow-same-origin allow-scripts'
                  : 'allow-same-origin'
              }
              className="w-full h-full border-0 bg-white"
            />
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-center px-6">
              <Mascot mood="idle" size={72} />
              <p className="text-[13px] text-ink-muted">左侧描述需求，生成后在这里预览</p>
              <p className="text-[11px] text-ink-dim">
                支持点文字就地编辑、导出 HTML / 打印 PDF
              </p>
            </div>
          )}
        </div>
      </div>

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-surface border border-line text-sm text-ink shadow-xl">
          {toast}
        </div>
      )}
    </div>
  )
}
