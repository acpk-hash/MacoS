// Artifacts 页（H3/P7）——文档 / PPT 的两阶段生成 + HTML 可视化编辑。
//
// P7 起改为「先规划询问、确认后再生成」（claude.ai/design 式两阶段）：
//   ① 规划：描述需求 → 模型先产出结构化规划（markdown，不出 HTML）；
//   ② 确认：右侧面板展示规划，可直接编辑文本或再对话让模型修订；
//   ③ 生成：点「按此规划生成」→ 以最终规划为强上下文产出自包含 HTML，
//      之后进入原有的 预览 / 源码 / 可视化编辑 / 保存 / 导出 流程。
//
// 三区布局：
//   左：AI 对话 / 指令区（带 规划›确认›生成 步骤指示）。
//   中：Monaco HTML 源码（可折叠，仅生成后显示）——手改源码实时刷新预览。
//   右：规划确认面板（阶段①②）或 iframe 实时预览（阶段③）；「可视化编辑」
//       模式下点击文字块就地编辑，blur 后经 postMessage 把改动写回源码字符串。
//
// 单一数据源 = artifactStore.html（规划阶段则是 artifactStore.plan）。
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { MONACO_THEME } from '../lib/monacoSetup'
import { useArtifactStore, type ArtifactStage } from '../stores/artifactStore'
import {
  applyEdit,
  injectEditableIds,
  countEditable,
  VISUAL_EDIT_RUNTIME,
} from '../lib/artifactHtml'
import ModelPicker from '../components/ModelPicker'
import { Mascot } from '../components/ui'
import { saveExport } from '../lib/exportChat'
import type { Attachment } from '../stores/studioStore'
import {
  MAX_ATTACH_BYTES,
  MAX_TEXT_BYTES,
  compressImage,
  dataUrlBytes,
} from '../lib/attachments'

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

// ── 步骤指示（规划 › 确认 › 生成） ──────────────────────────────────

const STEP_LABELS = ['规划', '确认', '生成']

function stageStep(stage: ArtifactStage): number {
  if (stage === 'idle' || stage === 'planning') return 0
  if (stage === 'plan_ready') return 1
  return 2
}

function StepIndicator({ stage }: { stage: ArtifactStage }) {
  const cur = stageStep(stage)
  return (
    <div className="flex items-center gap-1 px-3 py-1.5 border-b border-line flex-shrink-0">
      {STEP_LABELS.map((label, i) => (
        <Fragment key={label}>
          {i > 0 && <span className="text-[10px] text-ink-dim">›</span>}
          <span
            className={[
              'px-1.5 py-0.5 rounded-md text-[11px] transition-colors',
              i === cur
                ? 'bg-primary-tint text-primary font-medium'
                : i < cur
                  ? 'text-ink-muted'
                  : 'text-ink-dim',
            ].join(' ')}
          >
            {i < cur ? '✓ ' : ''}
            {label}
          </span>
        </Fragment>
      ))}
    </div>
  )
}

// ── 规划 markdown 渲染（深色主题、轻量组件映射） ────────────────────

const planMdComponents: Components = {
  h1: ({ children }) => (
    <h1 className="text-[16px] font-bold text-ink mt-3 mb-1.5 first:mt-0">{children}</h1>
  ),
  h2: ({ children }) => (
    <h2 className="text-[14.5px] font-semibold text-primary mt-3 mb-1 first:mt-0">
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3 className="text-[13.5px] font-semibold text-ink mt-2 mb-1">{children}</h3>
  ),
  p: ({ children }) => <p className="my-1 text-ink-muted">{children}</p>,
  ul: ({ children }) => (
    <ul className="list-disc pl-5 my-1 space-y-0.5 text-ink-muted">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="list-decimal pl-5 my-1 space-y-0.5 text-ink-muted">{children}</ol>
  ),
  strong: ({ children }) => (
    <strong className="text-ink font-semibold">{children}</strong>
  ),
  code: ({ children }) => (
    <code className="px-1 py-0.5 rounded bg-surface-2 text-[12px] text-primary">
      {children}
    </code>
  ),
  hr: () => <hr className="my-2 border-line" />,
}

function PlanMarkdown({ text }: { text: string }) {
  return (
    <div className="text-[13px] leading-6 text-ink break-words">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={planMdComponents}>
        {text}
      </ReactMarkdown>
    </div>
  )
}

export default function Artifacts() {
  const {
    aggModels,
    modelsLoaded,
    currentModel,
    currentProviderId,
    turns,
    stage,
    plan,
    html,
    streaming,
    error,
    loadModels,
    setModelSel,
    ask,
    confirmPlan,
    stop,
    setPlan,
    setHtml,
    saveDraft,
    reset,
  } = useArtifactStore()

  const [draft, setDraft] = useState('')
  const [mode, setMode] = useState<Mode>('source')
  const [showSource, setShowSource] = useState(true)
  const [planEditing, setPlanEditing] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const [attachments, setAttachments] = useState<Attachment[]>([])

  const iframeRef = useRef<HTMLIFrameElement>(null)
  const toastTimer = useRef<number | null>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const textInputRef = useRef<HTMLInputElement>(null)

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

  // 阶段①②（以及首次生成中）右侧显示规划面板而非预览。
  const showPlanPanel =
    !html &&
    (stage === 'planning' || stage === 'plan_ready' || stage === 'generating')

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

  // ── 参考文件附件（复用 attachments.ts：图片压缩转 data URL、文本内联） ──

  const addImageFile = async (file: File) => {
    try {
      const dataUrl = await compressImage(file)
      if (dataUrlBytes(dataUrl) > MAX_ATTACH_BYTES) {
        showToast('图片超过 10MB，已跳过')
        return
      }
      setAttachments((prev) => [
        ...prev,
        { kind: 'image', name: file.name || '图片', data_url: dataUrl },
      ])
    } catch {
      showToast('图片处理失败')
    }
  }

  const addTextFile = async (file: File) => {
    if (file.size > MAX_TEXT_BYTES) {
      showToast('文本文件超过 200KB，已跳过')
      return
    }
    try {
      const text = await file.text()
      setAttachments((prev) => [
        ...prev,
        { kind: 'text', name: file.name || '文本文件', text },
      ])
    } catch {
      showToast('文本文件读取失败')
    }
  }

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx))
  }

  const submit = () => {
    let t = draft.trim()
    if (streaming) return
    // 只附了参考文件没打字：用一个默认指令。
    if (!t && attachments.length > 0) {
      t =
        stage === 'idle'
          ? '请基于附带的参考资料规划一份文档 / PPT。'
          : '请基于附带的参考资料调整。'
    }
    if (!t) return
    setDraft('')
    const atts = attachments
    setAttachments([])
    void ask(t, atts)
  }

  const handleNew = () => {
    reset()
    setPlanEditing(false)
    setDraft('')
  }

  const handleSaveDraft = () => {
    if (!html && !plan) return
    const ok = saveDraft()
    showToast(ok ? '已保存草稿（刷新 / 重启后自动恢复）' : '保存失败')
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
            onClick={handleNew}
            className="text-xs text-ink-muted hover:text-ink border border-line rounded-lg px-2 py-1 transition-colors"
            title="清空并新建文档"
          >
            新建
          </button>
        </div>

        {/* 步骤指示：规划 › 确认 › 生成 */}
        <StepIndicator stage={stage} />

        {/* 对话流 */}
        <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3 min-h-0">
          {turns.length === 0 ? (
            <div className="flex flex-col items-center text-center mt-6">
              <Mascot mood="happy" size={64} className="mb-3" />
              <p className="text-sm text-ink-muted mb-1">描述你想要的文档或 PPT</p>
              <p className="text-xs text-ink-dim mb-4">
                模型会先给出规划供你确认 / 调整，确认后再生成可离线打开的 HTML
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
                <div key={i} className="flex flex-col items-end gap-1">
                  {t.attachments && t.attachments.length > 0 && (
                    <div className="flex flex-wrap gap-1 justify-end">
                      {t.attachments.map((a, j) => (
                        <span
                          key={j}
                          className="px-2 py-0.5 rounded-md bg-surface border border-line text-[11px] text-ink-muted"
                        >
                          {a.kind === 'image' ? '🖼' : '📄'} {a.name ?? '参考文件'}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="max-w-[90%] px-3 py-2 rounded-pop rounded-br-md bg-primary text-white text-[13px] leading-6 whitespace-pre-wrap break-words">
                    {t.content}
                  </div>
                </div>
              ) : (
                <div
                  key={i}
                  className="px-3 py-2 rounded-lg bg-surface border border-line text-[12.5px] text-ink-muted leading-6"
                >
                  {t.kind === 'plan'
                    ? '已产出 / 更新规划（见右侧面板，可编辑或确认）'
                    : '已生成 / 更新 HTML（见中栏源码与右侧预览）'}
                </div>
              ),
            )
          )}
          {streaming && (
            <div className="px-3 py-2 rounded-lg bg-surface border border-line text-[12.5px] text-ink-dim">
              {stage === 'planning' ? '正在拟定规划…' : '正在生成 HTML…'}
            </div>
          )}
          {error && (
            <div className="px-3 py-2 rounded-lg bg-coral/10 border border-coral/30 text-[12.5px] text-coral break-words">
              {error}
            </div>
          )}
        </div>

        {/* 输入区 */}
        <div className="border-t border-line p-2.5 flex-shrink-0 space-y-2">
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {attachments.map((a, i) => (
                <div
                  key={i}
                  className="flex items-center gap-1.5 px-2 py-1 rounded-lg bg-surface border border-line text-[11px] text-ink-muted"
                >
                  {a.kind === 'image' && a.data_url ? (
                    <img
                      src={a.data_url}
                      alt={a.name ?? ''}
                      className="w-6 h-6 rounded object-cover"
                    />
                  ) : (
                    <span aria-hidden="true">📄</span>
                  )}
                  <span className="max-w-[120px] truncate">{a.name}</span>
                  <button
                    onClick={() => removeAttachment(i)}
                    className="text-ink-dim hover:text-failed transition-colors"
                    title="移除"
                  >
                    ✕
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="flex items-center gap-1.5">
            <button
              onClick={() => imageInputRef.current?.click()}
              className="text-[11px] text-ink-muted hover:text-ink border border-line rounded-lg px-2 py-1 transition-colors"
              title="附加参考图片（截图、示意图等）"
            >
              📎 图片
            </button>
            <button
              onClick={() => textInputRef.current?.click()}
              className="text-[11px] text-ink-muted hover:text-ink border border-line rounded-lg px-2 py-1 transition-colors"
              title="附加参考文档（大纲、素材，.txt / .md / .json / .csv）"
            >
              📎 参考文档
            </button>
            <span className="text-[10px] text-ink-dim">
              附件内容会随指令一起发给模型
            </span>
          </div>
          <ModelPicker
            models={aggModels}
            value={{ providerId: currentProviderId ?? '', modelId: currentModel }}
            onChange={(v) => setModelSel(v.providerId, v.modelId)}
            className="w-full bg-surface border border-line rounded-lg px-2 py-1.5 text-xs text-ink focus:outline-none focus:border-primary transition-colors"
            title="选择模型"
            emptyLabel={
              modelsLoaded && aggModels.length === 0
                ? '无可用模型——请到设置添加服务商'
                : '加载中…'
            }
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
              stage === 'idle'
                ? '例如：做一个 5 页关于 XX 的 PPT…（先出规划，确认后再生成）'
                : stage === 'plan_ready'
                  ? '想调整规划？如：把第 2 页换成…（也可直接在右侧编辑规划）'
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
                disabled={!currentModel || (!draft.trim() && attachments.length === 0)}
                className="flex-1 text-xs px-3 py-2 rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
              >
                {stage === 'idle'
                  ? '生成规划'
                  : stage === 'plan_ready'
                    ? '调整规划'
                    : '发送'}
              </button>
            )}
          </div>
        </div>
      </div>

      {/* ── 中：HTML 源码（Monaco，可折叠，仅生成后显示） ── */}
      {showSource && html && (
        <div className="flex flex-col w-[38%] min-w-[280px] flex-shrink-0 border-r border-line h-full min-h-0">
          <div className="flex items-center gap-2 px-3 h-9 border-b border-line flex-shrink-0 bg-surface/40">
            <span className="text-[12.5px] text-ink-muted font-medium">HTML 源码</span>
            <span className="text-[11px] text-ink-dim">{html.length + ' 字符'}</span>
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

      {/* ── 右：规划确认面板（阶段①②）或实时预览（阶段③） ── */}
      <div className="flex flex-col flex-1 min-w-0 h-full min-h-0">
        <div className="flex items-center gap-2 px-3 h-9 border-b border-line flex-shrink-0 bg-surface/40">
          {!showSource && html && (
            <button
              onClick={() => setShowSource(true)}
              className="text-[11px] text-ink-dim hover:text-ink"
              title="展开源码栏"
            >
              ⟩ 源码
            </button>
          )}
          <span className="text-[12.5px] text-ink-muted font-medium">
            {showPlanPanel ? '规划确认' : '预览'}
          </span>

          {/* 可视化 / 源码编辑切换（仅生成后有意义） */}
          {!showPlanPanel && (
            <>
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
            </>
          )}

          <div className="flex-1" />

          <button
            onClick={handleSaveDraft}
            disabled={!html && !plan}
            className="text-[11px] text-white bg-primary hover:bg-primary-hover rounded-lg px-2.5 py-1 disabled:opacity-40 transition-colors"
            title="保存当前草稿到本机（含规划与预览里的就地修改），刷新 / 重启后自动恢复"
          >
            保存
          </button>
          {!showPlanPanel && (
            <>
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
                className="text-[11px] text-ink-muted hover:text-ink border border-line rounded-lg px-2 py-1 disabled:opacity-40 transition-colors"
                title="另存为 .html 文件（可离线打开）"
              >
                导出 HTML
              </button>
            </>
          )}
        </div>

        <div className="flex-1 min-h-0 bg-bg relative">
          {showPlanPanel ? (
            /* ── 规划确认面板（深色渲染，可编辑 / 确认） ── */
            <div className="absolute inset-0 flex flex-col">
              <div className="flex items-center gap-2 px-4 py-2 border-b border-line flex-shrink-0">
                <span className="text-[12.5px] font-medium text-ink">📋 规划</span>
                {stage === 'planning' && (
                  <span className="text-[11px] text-ink-dim animate-pulse">
                    模型正在拟定规划…
                  </span>
                )}
                {stage === 'generating' && (
                  <span className="text-[11px] text-primary animate-pulse">
                    正在按规划生成 HTML…
                  </span>
                )}
                <div className="flex-1" />
                {stage === 'plan_ready' && (
                  <button
                    onClick={() => setPlanEditing((v) => !v)}
                    className="text-[11px] text-ink-muted hover:text-ink border border-line rounded-lg px-2 py-1 transition-colors"
                    title="直接编辑规划文本（markdown）"
                  >
                    {planEditing ? '完成编辑' : '✏️ 编辑规划'}
                  </button>
                )}
              </div>

              <div className="flex-1 min-h-0 flex flex-col px-5 py-4">
                {plan ? (
                  planEditing && stage === 'plan_ready' ? (
                    <textarea
                      value={plan}
                      onChange={(e) => setPlan(e.target.value)}
                      className="flex-1 w-full resize-none bg-surface border border-line rounded-lg p-3 text-[12.5px] font-mono text-ink leading-6 focus:outline-none focus:border-primary transition-colors"
                      placeholder="在这里直接编辑规划（markdown）…"
                    />
                  ) : (
                    <div className="flex-1 min-h-0 overflow-y-auto pr-1">
                      <PlanMarkdown text={plan} />
                    </div>
                  )
                ) : (
                  <div className="flex flex-col items-center mt-16 gap-3">
                    <Mascot mood="happy" size={64} />
                    <p className="text-[12.5px] text-ink-dim">
                      模型正在根据你的需求拟定规划…
                    </p>
                  </div>
                )}
              </div>

              {stage === 'plan_ready' && (
                <div className="border-t border-line px-4 py-3 flex items-center gap-3 flex-shrink-0">
                  <button
                    onClick={() => void confirmPlan()}
                    disabled={!plan.trim()}
                    className="text-xs px-4 py-2 rounded-lg bg-primary text-white hover:bg-primary-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                  >
                    ✅ 按此规划生成
                  </button>
                  <span className="text-[11px] text-ink-dim">
                    不满意？在左侧输入调整要求让模型修订，或点「编辑规划」直接改
                  </span>
                </div>
              )}
            </div>
          ) : html ? (
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
              <p className="text-[13px] text-ink-muted">
                左侧描述需求 → 先出规划 → 确认后生成
              </p>
              <p className="text-[11px] text-ink-dim">
                生成后支持点文字就地编辑、导出 HTML / 打印 PDF
              </p>
            </div>
          )}
        </div>
      </div>

      {/* 隐藏的文件选择框（参考附件用） */}
      <input
        ref={imageInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          files.forEach((f) => void addImageFile(f))
          e.target.value = ''
        }}
      />
      <input
        ref={textInputRef}
        type="file"
        accept=".txt,.md,.json,.csv,.log,.html,text/*"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files ?? [])
          files.forEach((f) => void addTextFile(f))
          e.target.value = ''
        }}
      />

      {/* Toast */}
      {toast && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 rounded-lg bg-surface border border-line text-sm text-ink shadow-xl">
          {toast}
        </div>
      )}
    </div>
  )
}
