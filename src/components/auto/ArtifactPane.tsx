// 产物检查器 — 右侧可吸合面板（借鉴 open-science RightPane 的交互，代码自写）：
// 左缘拖柄可拖宽（[MIN,MAX]∩70% 窗宽，松手才写回 store/localStorage）、
// 拖窄过阈值吸合关闭（恢复钮由 Auto 页渲染）、头部按钮/双击拖柄最大化覆盖全页。
// 内容：os_artifacts 按 kind 分组（pdf/md/tex/溯源），md/tex/jsonl 走 os_read_text
// 预览（md 用 MarkdownLite），pdf 显示路径+复制；运行中由 store 8s 轮询刷新。
import { useEffect, useState } from 'react'
import { useAutoStore, type OsArtifact } from '../../stores/autoStore'
import MarkdownLite from '../ui/MarkdownLite'
import { fmtDateTime, fmtSize } from './format'
import {
  IconChevronRight,
  IconCheck,
  IconCopy,
  IconFileText,
  IconMaximize,
  IconMinimize,
  IconRefresh,
  IconX,
} from './icons'

const PANE_MIN = 300
const PANE_MAX = 680
/** 拖到比这更窄就吸合关闭（低于 PANE_MIN，给出明确的「吸」感）。 */
const COLLAPSE_BELOW = 240
/** 面板最多占窗口宽度的比例，不把主区挤没。 */
const MAX_FRACTION = 0.7

const KIND_META: Record<string, { label: string; tone: string }> = {
  pdf: { label: 'PDF 论文', tone: 'bg-primary-tint text-primary' },
  md: { label: 'Markdown', tone: 'bg-[#10a37f1a] text-done' },
  tex: { label: 'LaTeX', tone: 'bg-[#0d8de31a] text-running' },
  jsonl: { label: '溯源记录', tone: 'bg-surface-2 text-ink-muted' },
}
const KIND_ORDER = ['pdf', 'md', 'tex', 'jsonl']

interface Preview {
  name: string
  kind: string
  path: string
  text: string | null
}

async function tauriInvoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke<T>(command, args)
}

export default function ArtifactPane() {
  const artifacts = useAutoStore((s) => s.artifacts)
  const artifactsAt = useAutoStore((s) => s.artifactsAt)
  const workspace = useAutoStore((s) => s.workspace)
  const runStatus = useAutoStore((s) => s.runStatus)
  const width = useAutoStore((s) => s.inspectorWidth)
  const maximized = useAutoStore((s) => s.inspectorMaximized)

  // 拖动中的实时宽度放本地；松手才写回 store（persist）。
  const [dragWidth, setDragWidth] = useState<number | null>(null)
  const dragging = dragWidth !== null

  const [preview, setPreview] = useState<Preview | null>(null)
  const [previewErr, setPreviewErr] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

  // 最大化不跨面板生命周期：卸载时还原。
  useEffect(() => {
    return () => useAutoStore.getState().setInspectorMaximized(false)
  }, [])

  const clamp = (w: number) =>
    Math.max(PANE_MIN, Math.min(w, PANE_MAX, Math.round(window.innerWidth * MAX_FRACTION)))

  const onDividerPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    e.currentTarget.setPointerCapture(e.pointerId)
    setDragWidth(width)
  }
  const onDividerPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!dragging) return
    // 面板贴窗口右缘：宽度即指针右侧的空间。
    const w = window.innerWidth - e.clientX
    if (w < COLLAPSE_BELOW) {
      // 吸合关闭 —— 面板卸载，拖动随之结束。
      setDragWidth(null)
      useAutoStore.getState().setInspectorOpen(false)
      return
    }
    setDragWidth(clamp(w))
  }
  const onDividerPointerUp = () => {
    if (!dragging) return
    useAutoStore.getState().setInspectorWidth(dragWidth)
    setDragWidth(null)
  }

  const openPreview = async (a: OsArtifact) => {
    setPreviewErr(null)
    setPreview({ name: a.name, kind: a.kind, path: a.path, text: null })
    try {
      const text = await tauriInvoke<string>('os_read_text', { path: a.path })
      setPreview((p) => (p && p.path === a.path ? { ...p, text } : p))
    } catch (e) {
      setPreview(null)
      setPreviewErr(String(e))
    }
  }

  const copyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path)
      setCopied(path)
      setTimeout(() => setCopied((p) => (p === path ? null : p)), 1500)
    } catch {
      /* 忽略：剪贴板不可用 */
    }
  }

  const groups = KIND_ORDER.map(
    (k) => [k, artifacts.filter((a) => a.kind === k)] as const,
  ).filter(([, items]) => items.length > 0)

  const body = (
    <div className="flex h-full flex-col bg-surface">
      {/* 头部 */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-line px-3">
        {preview ? (
          <>
            <button
              className="flex items-center gap-1 text-[11.5px] text-ink-dim hover:text-ink transition-colors"
              onClick={() => setPreview(null)}
              title="返回产物列表"
            >
              <IconChevronRight size={11} className="rotate-180" />
              产物
            </button>
            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink" title={preview.path}>
              {preview.name}
            </span>
          </>
        ) : (
          <>
            <IconFileText size={13} className="text-ink-muted shrink-0" />
            <span className="text-[12px] font-semibold text-ink">产物</span>
            <span className="text-[10.5px] text-ink-dim">
              {artifacts.length > 0 ? artifacts.length + ' 个' : ''}
              {runStatus === 'running' ? ' · 8s 自动刷新' : ''}
            </span>
            <div className="flex-1" />
            <button
              className="text-ink-dim hover:text-ink transition-colors disabled:opacity-40"
              disabled={!workspace.trim()}
              onClick={() => void useAutoStore.getState().refreshArtifacts()}
              title="手动刷新产物列表"
              aria-label="刷新产物"
            >
              <IconRefresh size={13} />
            </button>
          </>
        )}
        <button
          className="text-ink-dim hover:text-ink transition-colors"
          onClick={() => useAutoStore.getState().setInspectorMaximized(!maximized)}
          title={maximized ? '还原面板' : '最大化面板'}
          aria-label={maximized ? '还原面板' : '最大化面板'}
        >
          {maximized ? <IconMinimize size={13} /> : <IconMaximize size={13} />}
        </button>
        <button
          className="text-ink-dim hover:text-ink transition-colors"
          onClick={() => useAutoStore.getState().setInspectorOpen(false)}
          title="关闭产物面板"
          aria-label="关闭产物面板"
        >
          <IconX size={14} />
        </button>
      </div>

      {/* 内容体 */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {preview ? (
          <div className="px-3 py-2.5">
            {preview.text === null ? (
              <div className="py-8 text-center text-[11.5px] text-ink-faint">读取中…</div>
            ) : preview.kind === 'md' ? (
              <MarkdownLite text={preview.text} />
            ) : (
              <pre className="whitespace-pre-wrap break-words font-mono text-[11.5px] leading-5 text-ink-muted">
                {preview.text}
              </pre>
            )}
          </div>
        ) : (
          <div className="px-3 py-2.5">
            {previewErr && (
              <div className="mb-2 rounded-input border border-failed/30 bg-[#d0342c14] px-2.5 py-1.5 text-[11px] text-failed">
                {previewErr}
              </div>
            )}
            {groups.length === 0 && (
              <div className="py-10 text-center text-[11.5px] text-ink-faint leading-5">
                暂无产物
                <br />
                运行后 PDF / Markdown / LaTeX / 溯源记录会出现在这里
              </div>
            )}
            {groups.map(([kind, items]) => {
              const meta = KIND_META[kind] ?? { label: kind, tone: 'bg-surface-2 text-ink-muted' }
              return (
                <section key={kind} className="mb-3">
                  <div className="mb-1 text-[10.5px] font-semibold uppercase tracking-wider text-ink-dim">
                    {meta.label} · {items.length}
                  </div>
                  <ul className="space-y-0.5">
                    {items.map((a) => (
                      <li
                        key={a.path}
                        className="group rounded-input px-1.5 py-1 hover:bg-surface-2 transition-colors"
                      >
                        <div className="flex items-center gap-1.5">
                          <span
                            className={
                              'shrink-0 rounded px-1 py-0.5 font-mono text-[9.5px] uppercase ' + meta.tone
                            }
                          >
                            {a.kind}
                          </span>
                          {a.kind === 'pdf' ? (
                            <span className="min-w-0 flex-1 truncate text-[12px] text-ink" title={a.path}>
                              {a.name}
                            </span>
                          ) : (
                            <button
                              className="min-w-0 flex-1 truncate text-left text-[12px] text-ink hover:underline"
                              onClick={() => void openPreview(a)}
                              title={'预览 ' + a.path}
                            >
                              {a.name}
                            </button>
                          )}
                          <button
                            className="shrink-0 text-ink-faint opacity-0 group-hover:opacity-100 hover:text-ink transition-all"
                            onClick={() => void copyPath(a.path)}
                            title={copied === a.path ? '已复制' : '复制完整路径'}
                            aria-label="复制路径"
                          >
                            {copied === a.path ? (
                              <IconCheck size={12} className="text-done" />
                            ) : (
                              <IconCopy size={12} />
                            )}
                          </button>
                        </div>
                        <div className="pl-1.5 text-[10px] text-ink-faint tabular-nums truncate">
                          {fmtSize(a.size)} · {fmtDateTime(a.mtime)}
                          {a.kind === 'pdf' ? ' · 复制路径后用系统查看器打开' : ''}
                        </div>
                      </li>
                    ))}
                  </ul>
                </section>
              )
            })}
            {artifactsAt != null && groups.length > 0 && (
              <div className="pb-1 pt-2 text-center text-[10px] text-ink-faint">
                上次刷新 {fmtDateTime(artifactsAt)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )

  if (maximized) {
    // 覆盖 Auto 页全区（父容器 relative）；头部保留还原/关闭钮。
    return <div className="absolute inset-0 z-40 border-l border-line">{body}</div>
  }

  return (
    <div
      className="relative h-full shrink-0 border-l border-line"
      style={{ width: dragWidth ?? width }}
    >
      {body}
      {/* 左缘拖柄：拖动改宽（松手写回），拖过阈值吸合关闭，双击最大化。 */}
      <div
        onPointerDown={onDividerPointerDown}
        onPointerMove={onDividerPointerMove}
        onPointerUp={onDividerPointerUp}
        onPointerCancel={onDividerPointerUp}
        onDoubleClick={() => useAutoStore.getState().setInspectorMaximized(!maximized)}
        className="group absolute inset-y-0 left-0 z-10 w-[5px] cursor-col-resize"
        title="拖动调宽 · 拖到很窄自动收起 · 双击最大化"
      >
        <div
          className={
            'absolute inset-y-0 left-0 w-[2px] transition-colors ' +
            (dragging ? 'bg-primary/60' : 'bg-transparent group-hover:bg-primary/30')
          }
        />
      </div>
    </div>
  )
}
