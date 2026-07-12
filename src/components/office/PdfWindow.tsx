// PDF 智能翻译窗口（④）：上传（可多选）PDF → pdfjs 前端提取每页文本 →
// 两种模式：
//   转 Word：选一份 PDF，按批逐段翻译（进度条 + 可中断，任务挂全局任务条），
//            公式要求模型输出 LaTeX，导出时经 temml→mathml2omml 转 OMML
//            嵌入 .docx（失败段落降级 LaTeX 原文 + 标注）；
//   转 PPT ：全部 PDF 提炼演讲要点 → 交给 artifactStore（与 PPT 窗口同引擎）
//            生成 HTML 演示稿，并自动切到 PPT 窗口的双栏编辑视图。
// 全部关键状态在 officeStore：切走页面任务照跑，回来完整恢复。
import { useEffect, useRef, useState } from 'react'
import { useOfficeStore } from '../../stores/officeStore'
import MarkdownLite from '../ui/MarkdownLite'
import Button from '../ui/Button'
import ModelSelect from './ModelSelect'
import StageSteps from './StageSteps'
import Spinner from './Spinner'

const STEPS = ['上传 PDF', '选择模式', '翻译 / 提炼', '结果']

function stepIndex(stage: string): number {
  switch (stage) {
    case 'idle':
    case 'parsing':
      return 0
    case 'ready':
      return 1
    case 'translating':
    case 'summarizing':
      return 2
    default:
      return 3
  }
}

export default function PdfWindow() {
  const s = useOfficeStore()
  const fileRef = useRef<HTMLInputElement>(null)
  const [showLogs, setShowLogs] = useState(false)

  useEffect(() => {
    void useOfficeStore.getState().loadModels()
  }, [])

  const busy = s.pdfStage === 'translating' || s.pdfStage === 'summarizing'
  const parsing = s.pdfStage === 'parsing'

  const pick = (files: FileList | null) => {
    const fs = Array.from(files ?? [])
    if (fs.length > 0) void s.pdfAddFiles(fs)
    if (fileRef.current) fileRef.current.value = ''
  }

  const progressPct = s.pdfProgress
    ? Math.round((s.pdfProgress.done / Math.max(1, s.pdfProgress.total)) * 100)
    : 0

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StageSteps steps={STEPS} current={stepIndex(s.pdfStage)} />
        <div className="flex items-center gap-2">
          <ModelSelect
            models={s.aggModels}
            modelId={s.currentModel}
            onChange={s.setModelSel}
            disabled={busy}
          />
          {s.pdfStage !== 'idle' && (
            <Button variant="ghost" size="sm" onClick={s.pdfReset} disabled={busy}>
              重新开始
            </Button>
          )}
        </div>
      </div>

      {s.pdfError && (
        <div className="rounded-card border border-[#d0342c40] bg-[#d0342c14] px-4 py-2.5 text-xs text-failed">
          {s.pdfError}
        </div>
      )}

      {/* 上传区 */}
      {(s.pdfStage === 'idle' || parsing) && (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            pick(e.dataTransfer.files)
          }}
          className="flex flex-col items-center gap-3 rounded-card border border-dashed border-line bg-surface px-6 py-12"
        >
          <p className="text-sm text-ink-muted">
            {parsing
              ? '正在提取 PDF 文本…'
              : '拖入或选择 .pdf 文件（可多选；转 Word 用单份，转 PPT 可综合多份）'}
          </p>
          <Button onClick={() => fileRef.current?.click()} disabled={parsing}>
            选择 PDF
          </Button>
        </div>
      )}
      <input
        ref={fileRef}
        type="file"
        accept=".pdf"
        multiple
        className="hidden"
        onChange={(e) => pick(e.target.files)}
      />

      {/* 文档列表 + 模式操作 */}
      {s.pdfDocs.length > 0 && (
        <div className="rounded-card border border-line bg-surface p-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-medium text-ink">
              已上传 {s.pdfDocs.length} 份 PDF
              <span className="ml-1.5 text-[10px] font-normal text-ink-dim">
                （转 Word 时以选中的一份为准）
              </span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => fileRef.current?.click()}
              disabled={busy || parsing}
            >
              ＋ 继续添加
            </Button>
          </div>
          <div className="flex flex-col gap-1">
            {s.pdfDocs.map((d, i) => (
              <label
                key={`${d.name}-${i}`}
                className={`flex cursor-pointer items-center gap-2 rounded-btn border px-2.5 py-1.5 text-xs transition-colors ${
                  i === s.pdfSelected
                    ? 'border-primary bg-primary-tint text-ink'
                    : 'border-line bg-surface-2 text-ink-muted hover:border-line-strong'
                }`}
              >
                <input
                  type="radio"
                  name="pdf-selected"
                  checked={i === s.pdfSelected}
                  onChange={() => s.pdfSetSelected(i)}
                  disabled={busy}
                  className="accent-[#202123]"
                />
                <span className="flex-1 truncate">{d.name}</span>
                <span className="text-[10px] text-ink-dim">{d.pages.length} 页</span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault()
                    s.pdfRemoveDoc(i)
                  }}
                  disabled={busy}
                  className="text-ink-dim hover:text-failed"
                  title="移除"
                >
                  ✕
                </button>
              </label>
            ))}
          </div>
        </div>
      )}

      {/* 模式与操作 */}
      {s.pdfDocs.length > 0 && !busy && (
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-[11px] text-ink-dim">
            译成
            <select
              value={s.pdfTargetLang}
              onChange={(e) => s.pdfSetTargetLang(e.target.value)}
              className="rounded-btn border border-line bg-surface-2 px-2 py-1 text-xs text-ink
                         focus:outline-none focus:border-primary"
            >
              <option value="中文">中文（默认英→中）</option>
              <option value="English">English</option>
            </select>
          </label>
          <Button onClick={() => void s.pdfTranslate()} disabled={busy}>
            翻译成 Word（公式保真）
          </Button>
          <Button
            variant="soft"
            onClick={() => void s.pdfToPpt()}
            disabled={busy}
            title="综合全部已上传 PDF 提炼演讲要点，交给 PPT 引擎生成演示稿（会覆盖 PPT 窗口当前草稿）"
          >
            转演讲 PPT（综合全部 PDF）
          </Button>
          {s.pdfStage === 'done' && s.pdfMarkdown && (
            <Button variant="soft" onClick={() => void s.pdfDownloadDocx()}>
              ⬇ 下载译文 .docx
            </Button>
          )}
        </div>
      )}

      {/* 翻译进度 */}
      {s.pdfStage === 'translating' && (
        <div className="flex flex-col gap-2">
          {s.pdfProgress && (
            <div className="rounded-card border border-line bg-surface p-4">
              <div className="mb-1.5 flex items-center justify-between text-xs text-ink-muted">
                <span>
                  逐批翻译中：{s.pdfProgress.done}/{s.pdfProgress.total} 批
                </span>
                <span>{progressPct}%</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-surface-2">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${progressPct}%` }}
                />
              </div>
            </div>
          )}
          <Spinner label="模型正在翻译（可中断，已完成的批次会保留）…" streamText={s.pdfStreamText} />
          <div className="flex justify-end">
            <Button variant="danger" size="sm" onClick={() => void s.pdfCancel()}>
              中断翻译
            </Button>
          </div>
        </div>
      )}

      {s.pdfStage === 'summarizing' && (
        <div className="flex flex-col gap-2">
          <Spinner
            label="正在提炼演讲要点（完成后自动交给 PPT 引擎并跳转）…"
            streamText={s.pdfStreamText}
          />
          <div className="flex justify-end">
            <Button
              variant="danger"
              size="sm"
              onClick={() => void s.stopChannel('pdf')}
            >
              停止
            </Button>
          </div>
        </div>
      )}

      {/* 译文预览 */}
      {s.pdfMarkdown && !busy && (
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line px-4 py-2">
            <span className="text-xs text-ink-muted">
              译文预览（公式以 LaTeX 表示，导出 .docx 时转为 Word 原生公式）
            </span>
            <Button size="sm" onClick={() => void s.pdfDownloadDocx()}>
              ⬇ 下载 .docx
            </Button>
          </div>
          <div className="max-h-[480px] overflow-y-auto px-6 py-4">
            <MarkdownLite text={s.pdfMarkdown} />
          </div>
        </div>
      )}

      {/* 处理日志 */}
      {s.pdfLogs.length > 0 && (
        <div className="rounded-card border border-line bg-surface">
          <button
            onClick={() => setShowLogs((v) => !v)}
            className="w-full px-4 py-2 text-left text-[11px] text-ink-dim hover:text-ink"
          >
            {showLogs ? '▾' : '▸'} 处理日志（{s.pdfLogs.length}）
          </button>
          {showLogs && (
            <div className="border-t border-line px-4 py-2">
              {s.pdfLogs.map((l, i) => (
                <div key={i} className="py-0.5 text-[11px] leading-relaxed text-ink-muted">
                  · {l}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}
