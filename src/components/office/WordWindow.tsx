// Word 文档窗口：需求输入（可粘贴参考材料）→ 模型生成 Markdown →
// MarkdownLite 预览 → docx 库转 .docx → Blob 下载。
//
// TODO(上传改写)：上传 .docx 提取正文（需 JSZip 读 word/document.xml 或
// 引入解析库）后按指令改写再导出——当前版本先支持「生成 / 基于当前文稿
// 迭代修改」路径；参考材料可先手动粘贴到参考材料框达到近似效果。
import { useEffect, useState } from 'react'
import { useOfficeStore } from '../../stores/officeStore'
import MarkdownLite from '../ui/MarkdownLite'
import Button from '../ui/Button'
import ModelSelect from './ModelSelect'
import StageSteps from './StageSteps'
import Spinner from './Spinner'

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
  const [req, setReq] = useState('')
  const [ref, setRef] = useState('')
  const [showRef, setShowRef] = useState(false)

  useEffect(() => {
    void useOfficeStore.getState().loadModels()
  }, [])

  const generate = () => {
    if (!req.trim() || s.streaming) return
    void s.wordGenerate(req, ref)
    setReq('')
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
            disabled={s.streaming}
          />
          {s.wordStage === 'done' && (
            <Button variant="ghost" size="sm" onClick={s.wordReset}>
              新建
            </Button>
          )}
        </div>
      </div>

      {s.wordError && (
        <div className="rounded-card border border-[#f8514940] bg-[#f851491a] px-4 py-2.5 text-xs text-failed">
          {s.wordError}
        </div>
      )}

      {/* 需求输入（idle 首次生成；done 后为迭代修改） */}
      {s.wordStage !== 'generating' && (
        <div className="rounded-card border border-line bg-surface p-4">
          <p className="mb-2 text-xs text-ink-muted">
            {s.wordStage === 'done'
              ? '继续提要求，模型会在当前文稿基础上修改后输出完整新版。'
              : '描述要生成的文档（报告 / 信函 / 合同草稿 / 通知…），可展开粘贴参考材料。'}
          </p>
          <textarea
            value={req}
            onChange={(e) => setReq(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) generate()
            }}
            rows={3}
            placeholder="例：写一份实验室设备采购申请报告，包含背景、清单、预算与预期效益…"
            className="w-full resize-y rounded-btn border border-line bg-surface-2 px-3 py-2 text-sm text-ink
                       placeholder:text-ink-dim focus:outline-none focus:border-primary"
          />
          <div className="mt-2">
            <button
              onClick={() => setShowRef((v) => !v)}
              className="text-[11px] text-ink-dim hover:text-ink"
            >
              {showRef ? '▾ 收起参考材料' : '▸ 粘贴参考材料（可选）'}
            </button>
            {showRef && (
              <textarea
                value={ref}
                onChange={(e) => setRef(e.target.value)}
                rows={5}
                placeholder="粘贴事实依据 / 原始材料 / 待改写的文本…"
                className="mt-1.5 w-full resize-y rounded-btn border border-line bg-surface-2 px-3 py-2 text-xs text-ink-muted
                           placeholder:text-ink-dim focus:outline-none focus:border-primary"
              />
            )}
          </div>
          <div className="mt-3 flex justify-end">
            <Button onClick={generate} disabled={s.streaming || !req.trim()}>
              {s.wordStage === 'done' ? '按要求修改' : '生成文档'}
            </Button>
          </div>
        </div>
      )}

      {s.wordStage === 'generating' && (
        <div className="flex flex-col gap-2">
          <Spinner label="模型正在撰写文档…" streamText={s.streamText} />
          <div className="flex justify-end">
            <Button variant="danger" size="sm" onClick={() => void s.stopActive()}>
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
