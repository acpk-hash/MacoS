// PPT 生成窗口 — 「选项驱动」流程，建在 artifactStore 上：
// 输入主题/材料 → 模型出选项组（chip 勾选）→ 生成可编辑 workflow 步骤 →
// 确认 → 生成自包含 HTML 演示文稿 → **双栏编辑视图**（左 Monaco 源码 /
// 右 iframe 可视化直改，见 HtmlSplitEditor）+ 带附件的「继续修改」对话。
// 状态全部在 artifactStore（含 localStorage 草稿自动保存）：离开页面不丢。
import { lazy, Suspense, useEffect, useMemo, useState } from 'react'
import {
  useArtifactStore,
  initArtifactEventListener,
} from '../../stores/artifactStore'
import { downloadBlob } from '../../stores/officeStore'
import { filesToAttachments } from '../../lib/attachments'
import type { Attachment } from '../../stores/studioStore'
import Button from '../ui/Button'
import ModelSelect from './ModelSelect'
import StageSteps from './StageSteps'
import Spinner from './Spinner'
import AttachBar, { filesFromClipboard } from './AttachBar'

const HtmlSplitEditor = lazy(() => import('./HtmlSplitEditor'))

const STEPS = ['描述需求', '勾选方向', '确认流程', '生成演示文稿']

function stepIndex(stage: string): number {
  switch (stage) {
    case 'idle':
    case 'options':
      return 0
    case 'options_ready':
    case 'workflow':
      return 1
    case 'workflow_ready':
    case 'generating':
      return 2
    default:
      return 3
  }
}

export default function PptWindow() {
  const s = useArtifactStore()
  const [input, setInput] = useState('')
  const [editInput, setEditInput] = useState('')
  // 「继续修改」附件（发送后清空；文本类内联、图片走多模态）。
  const [editAtts, setEditAtts] = useState<Attachment[]>([])
  const [editWarnings, setEditWarnings] = useState<string[]>([])

  useEffect(() => {
    void initArtifactEventListener()
    void useArtifactStore.getState().loadModels()
  }, [])

  // 默认 gpt-5.5（有则选中）。
  useEffect(() => {
    if (!s.modelsLoaded) return
    const st = useArtifactStore.getState()
    const preferred = st.aggModels.find((m) => m.modelId === 'gpt-5.5')
    if (preferred && st.currentModel !== 'gpt-5.5') {
      st.setModelSel(preferred.providerId, preferred.modelId)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s.modelsLoaded])

  const submit = () => {
    const t = input.trim()
    if (!t || s.streaming) return
    setInput('')
    void s.ask(t)
  }

  const addEditFiles = async (files: File[]) => {
    if (files.length === 0) return
    const existing = editAtts
      .filter((a) => a.kind === 'text')
      .reduce((n, a) => n + (a.text?.length ?? 0), 0)
    const res = await filesToAttachments(files, existing)
    setEditAtts((prev) => [...prev, ...res.attachments])
    setEditWarnings(res.warnings)
  }

  const submitEdit = () => {
    const t = editInput.trim()
    if (!t || s.streaming) return
    void s.ask(t, editAtts)
    setEditInput('')
    setEditAtts([])
    setEditWarnings([])
  }

  const chatModels = useMemo(
    () => s.aggModels.filter((m) => m.kind === 'chat'),
    [s.aggModels],
  )

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StageSteps steps={STEPS} current={stepIndex(s.stage)} />
        <div className="flex items-center gap-2">
          <ModelSelect
            models={chatModels}
            modelId={s.currentModel}
            onChange={s.setModelSel}
            disabled={s.streaming}
          />
          <Button variant="ghost" size="sm" onClick={() => s.reset()}>
            新建
          </Button>
        </div>
      </div>

      {s.error && (
        <div className="rounded-card border border-[#d0342c40] bg-[#d0342c14] px-4 py-2.5 text-xs text-failed">
          {s.error}
        </div>
      )}

      {/* 阶段：输入需求 */}
      {(s.stage === 'idle' || s.stage === 'options_ready') && (
        <div className="rounded-card border border-line bg-surface p-4">
          <p className="mb-2 text-xs text-ink-muted">
            {s.stage === 'idle'
              ? '描述你的演示主题，或直接粘贴大纲 / 参考材料——软件会先给出几组方向选项让你勾选，再据此生成。'
              : '对选项不满意？在这里补充说明，模型会重新出一组选项。'}
          </p>
          <div className="flex gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) submit()
              }}
              rows={s.stage === 'idle' ? 4 : 2}
              placeholder="例：给研究生新生做一个 15 分钟的「文献管理入门」分享…"
              className="flex-1 resize-y rounded-btn border border-line bg-surface-2 px-3 py-2 text-sm text-ink
                         placeholder:text-ink-dim focus:outline-none focus:border-primary"
            />
            <Button onClick={submit} disabled={s.streaming || !input.trim()}>
              {s.stage === 'idle' ? '开始' : '重出选项'}
            </Button>
          </div>
        </div>
      )}

      {(s.stage === 'options' || s.stage === 'workflow') && (
        <Spinner
          label={
            s.stage === 'options'
              ? '模型正在根据你的需求准备选项…'
              : '模型正在编排制作流程…'
          }
        />
      )}

      {/* 阶段：勾选选项 */}
      {s.stage === 'options_ready' && s.optionGroups.length > 0 && (
        <div className="rounded-card border border-line bg-surface p-4">
          <p className="mb-3 text-xs text-ink-muted">
            先回答几个问题——勾选生成形式与方向（带 ✦ 为模型推荐）：
          </p>
          <div className="flex flex-col gap-3">
            {s.optionGroups.map((g) => (
              <div key={g.id}>
                <div className="mb-1.5 text-xs font-medium text-ink">
                  {g.title}
                  <span className="ml-1.5 text-[10px] text-ink-dim">
                    {g.multi ? '（可多选）' : '（单选）'}
                  </span>
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {g.options.map((o) => {
                    const picked = (s.selections[g.id] ?? []).includes(o.id)
                    const recommended = (g.defaults ?? []).includes(o.id)
                    return (
                      <button
                        key={o.id}
                        title={o.desc}
                        onClick={() => s.toggleOption(g.id, o.id)}
                        className={
                          picked
                            ? 'rounded-chip border px-2.5 py-1 text-xs transition-colors border-primary bg-primary-tint text-primary font-medium'
                            : 'rounded-chip border px-2.5 py-1 text-xs transition-colors border-line bg-surface-2 text-ink-muted hover:border-line-strong hover:text-ink'
                        }
                      >
                        {recommended ? '✦ ' : ''}
                        {o.label}
                      </button>
                    )
                  })}
                </div>
              </div>
            ))}
          </div>
          <div className="mt-4 flex justify-end">
            <Button onClick={() => void s.confirmOptions()} disabled={s.streaming}>
              就按这些方向 → 生成流程
            </Button>
          </div>
        </div>
      )}

      {/* 阶段：确认 / 微调 workflow */}
      {s.stage === 'workflow_ready' && (
        <div className="rounded-card border border-line bg-surface p-4">
          <p className="mb-3 text-xs text-ink-muted">
            这是拟定的制作流程，可直接改文字、增删步骤，确认后据此生成演示文稿：
          </p>
          <div className="flex flex-col gap-2">
            {s.workflow.map((st, i) => (
              <div key={i} className="flex items-start gap-2">
                <span className="mt-2 w-5 shrink-0 text-right text-[11px] text-ink-dim">
                  {i + 1}.
                </span>
                <div className="flex-1">
                  <input
                    value={st.title}
                    onChange={(e) =>
                      s.setWorkflowStep(i, { ...st, title: e.target.value })
                    }
                    className="w-full rounded-btn border border-line bg-surface-2 px-2.5 py-1.5 text-xs font-medium text-ink
                               focus:outline-none focus:border-primary"
                  />
                  <input
                    value={st.detail}
                    onChange={(e) =>
                      s.setWorkflowStep(i, { ...st, detail: e.target.value })
                    }
                    placeholder="该步说明（内容与视觉要点）"
                    className="mt-1 w-full rounded-btn border border-line bg-surface px-2.5 py-1 text-[11px] text-ink-muted
                               placeholder:text-ink-dim focus:outline-none focus:border-primary"
                  />
                </div>
                <button
                  onClick={() => s.removeWorkflowStep(i)}
                  title="删除该步"
                  className="mt-1.5 rounded-btn px-1.5 py-1 text-xs text-ink-dim hover:bg-surface-2 hover:text-failed"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
          <div className="mt-3 flex items-center justify-between">
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => s.addWorkflowStep()}>
                + 加一步
              </Button>
              <Button variant="ghost" size="sm" onClick={() => s.backToOptions()}>
                ← 回到选项
              </Button>
            </div>
            <Button onClick={() => void s.confirmWorkflow()} disabled={s.streaming}>
              确认流程，生成演示文稿
            </Button>
          </div>
          <div className="mt-3 border-t border-line pt-3">
            <div className="flex gap-2">
              <input
                value={editInput}
                onChange={(e) => setEditInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && editInput.trim() && !s.streaming) {
                    void s.ask(editInput.trim())
                    setEditInput('')
                  }
                }}
                placeholder="也可以让模型改流程，例：把案例部分扩成两页"
                className="flex-1 rounded-btn border border-line bg-surface-2 px-3 py-1.5 text-xs text-ink
                           placeholder:text-ink-dim focus:outline-none focus:border-primary"
              />
              <Button
                variant="soft"
                size="sm"
                disabled={s.streaming || !editInput.trim()}
                onClick={() => {
                  void s.ask(editInput.trim())
                  setEditInput('')
                }}
              >
                让模型改
              </Button>
            </div>
          </div>
        </div>
      )}

      {s.stage === 'generating' && (
        <Spinner label="正在生成 HTML 演示文稿（篇幅较长，请稍候）…" />
      )}

      {/* 阶段：完成 → 双栏编辑（左源码 / 右可视化预览）+ 继续修改 */}
      {s.stage === 'done' && s.html && (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <span className="text-xs text-ink-muted">
              左栏改源码自动同步预览；右栏点击文字可直接修改，改完点「保存修改 →
              源码」。导出 HTML 后浏览器打开按 F11 全屏放映。
            </span>
            <Button
              size="sm"
              onClick={() =>
                downloadBlob(
                  new Blob([s.html], { type: 'text/html;charset=utf-8' }),
                  '演示文稿-' + new Date().toISOString().slice(0, 10) + '.html',
                )
              }
            >
              下载 HTML
            </Button>
          </div>
          <Suspense
            fallback={
              <div className="rounded-card border border-line bg-surface py-16 text-center text-sm text-ink-dim">
                编辑器加载中…
              </div>
            }
          >
            <HtmlSplitEditor value={s.html} onCommit={(html) => s.setHtml(html)} />
          </Suspense>
          <div className="flex flex-col gap-1.5">
            <div className="flex gap-2">
              <input
                value={editInput}
                onChange={(e) => setEditInput(e.target.value)}
                onPaste={(e) => {
                  const files = filesFromClipboard(e)
                  if (files.length > 0) {
                    e.preventDefault()
                    void addEditFiles(files)
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitEdit()
                }}
                placeholder="继续修改，例：第 3 页配色换成深蓝；可 Ctrl+V 粘贴截图、点 📎 传参考文件"
                className="flex-1 rounded-btn border border-line bg-surface-2 px-3 py-2 text-sm text-ink
                           placeholder:text-ink-dim focus:outline-none focus:border-primary"
              />
              <Button disabled={s.streaming || !editInput.trim()} onClick={submitEdit}>
                修改
              </Button>
            </div>
            <AttachBar
              attachments={editAtts}
              warnings={editWarnings}
              onAdd={(files) => void addEditFiles(files)}
              onRemove={(i) => setEditAtts((prev) => prev.filter((_, x) => x !== i))}
              disabled={s.streaming}
              hint="附件随修改要求一起交给模型：文本内联，图片走多模态"
            />
          </div>
        </div>
      )}

      {s.streaming && (
        <div className="flex justify-end">
          <Button variant="danger" size="sm" onClick={() => void s.stop()}>
            停止
          </Button>
        </div>
      )}
    </div>
  )
}
