// Word 文档窗口：需求输入 + 参考材料（粘贴文本 / 上传附件：txt·md·csv 直读，
// docx 用 fflate 解 word/document.xml 抽文本，图片走多模态）→ 模型生成
// Markdown → MarkdownLite 预览 → docx 库转 .docx → Blob 下载。
// 全部关键状态在 officeStore：切走页面任务照跑，回来完整恢复。
import { useEffect, useState } from 'react'
import { useOfficeStore } from '../../stores/officeStore'
import MarkdownLite from '../ui/MarkdownLite'
import Button from '../ui/Button'
import ModelSelect from './ModelSelect'
import StageSteps from './StageSteps'
import Spinner from './Spinner'
import AttachBar, { filesFromClipboard } from './AttachBar'

const STEPS = ['描述需求', '模型撰写', '预览与下载']

function stepIndex(stage: string): number {
  switch (stage) {
    case 'idle':
      return 0
    case 'generating':
      return 1
    default:
      return 2
  }
}

export default function WordWindow() {
  const s = useOfficeStore()
  const [showRef, setShowRef] = useState(false)

  useEffect(() => {
    void useOfficeStore.getState().loadModels()
  }, [])

  const busy = s.wordStage === 'generating'
  const hasRef =
    s.wordReference.trim().length > 0 || s.wordAttachments.length > 0

  const generate = () => {
    if (!s.wordRequirement.trim() || busy) return
    void s.wordGenerate()
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StageSteps steps={STEPS} current={stepIndex(s.wordStage)} />
        <div className="flex items-center gap-2">
          <ModelSelect
            models={s.aggModels}
            modelId={s.currentModel}
            onChange={s.setModelSel}
            disabled={busy}
          />
          {s.wordStage === 'done' && (
            <Button variant="ghost" size="sm" onClick={s.wordReset}>
              新建
            </Button>
          )}
        </div>
      </div>

      {s.wordError && (
        <div className="rounded-card border border-[#d0342c40] bg-[#d0342c14] px-4 py-2.5 text-xs text-failed">
          {s.wordError}
        </div>
      )}

      {/* 需求输入（idle 首次生成；done 后为迭代修改） */}
      {!busy && (
        <div className="rounded-card border border-line bg-surface p-4">
          <p className="mb-2 text-xs text-ink-muted">
            {s.wordStage === 'done'
              ? '继续提要求，模型会在当前文稿基础上修改后输出完整新版。'
              : '描述要生成的文档（报告 / 信函 / 合同草稿 / 通知…），可展开粘贴或上传参考材料。'}
          </p>
          <textarea
            value={s.wordRequirement}
            onChange={(e) => s.setWordRequirement(e.target.value)}
            onPaste={(e) => {
              const files = filesFromClipboard(e)
              if (files.length > 0) {
                e.preventDefault()
                void s.wordAddFiles(files)
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate()
            }}
            rows={3}
            placeholder="例：写一份实验室设备采购申请报告，包含背景、清单、预算与预期效益…（可 Ctrl+V 粘贴截图作参考）"
            className="w-full resize-y rounded-btn border border-line bg-surface-2 px-3 py-2 text-sm text-ink
                       placeholder:text-ink-dim focus:outline-none focus:border-primary"
          />
          <div className="mt-2 flex flex-col gap-1.5">
            <button
              onClick={() => setShowRef((v) => !v)}
              className="self-start text-[11px] text-ink-dim hover:text-ink"
            >
              {showRef || hasRef
                ? '▾ 参考材料（粘贴 + 附件）'
                : '▸ 参考材料：粘贴文本 / 上传附件（可选）'}
            </button>
            {(showRef || hasRef) && (
              <>
                <textarea
                  value={s.wordReference}
                  onChange={(e) => s.setWordReference(e.target.value)}
                  rows={5}
                  placeholder="粘贴事实依据 / 原始材料 / 待改写的文本…"
                  className="w-full resize-y rounded-btn border border-line bg-surface-2 px-3 py-2 text-xs text-ink-muted
                             placeholder:text-ink-dim focus:outline-none focus:border-primary"
                />
                <AttachBar
                  attachments={s.wordAttachments}
                  warnings={s.wordWarnings}
                  onAdd={(files) => void s.wordAddFiles(files)}
                  onRemove={s.wordRemoveAttachment}
                  disabled={busy}
                  hint="txt/md/csv 直读；docx 自动抽正文；图片走多模态"
                />
              </>
            )}
          </div>
          <div className="mt-3 flex justify-end">
            <Button onClick={generate} disabled={busy || !s.wordRequirement.trim()}>
              {s.wordStage === 'done' ? '按要求修改' : '生成文档'}
            </Button>
          </div>
        </div>
      )}

      {busy && (
        <div className="flex flex-col gap-2">
          <Spinner label="模型正在撰写文档…" streamText={s.wordStreamText} />
          <div className="flex justify-end">
            <Button
              variant="danger"
              size="sm"
              onClick={() => void s.stopChannel('word')}
            >
              停止
            </Button>
          </div>
        </div>
      )}

      {/* 预览 + 下载 */}
      {s.wordStage === 'done' && s.wordMarkdown && (
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <div className="flex items-center justify-between border-b border-line px-4 py-2">
            <span className="text-xs text-ink-muted">
              文档预览（标题 / 段落 / 列表 / 加粗将转入 .docx）
            </span>
            <Button size="sm" onClick={() => void s.wordDownload()}>
              ⬇ 下载 .docx
            </Button>
          </div>
          <div className="max-h-[520px] overflow-y-auto px-6 py-4">
            <MarkdownLite text={s.wordMarkdown} />
          </div>
        </div>
      )}
    </div>
  )
}
