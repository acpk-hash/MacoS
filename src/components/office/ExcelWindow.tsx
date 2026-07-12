// Excel 处理窗口：上传 xlsx/csv → exceljs 前端解析 → 预览 + 概要 →
// 自然语言指令 → 模型返回结构化新表（JSON）→ 应用 → exceljs 生成新
// xlsx → Blob 即时下载；附修改前后差异简述。
import { useEffect, useRef, useState } from 'react'
import { useOfficeStore, MAX_XLSX_BYTES } from '../../stores/officeStore'
import Button from '../ui/Button'
import ModelSelect from './ModelSelect'
import StageSteps from './StageSteps'
import Spinner from './Spinner'

const STEPS = ['上传表格', '下达指令', '模型处理', '下载新版本']
const PREVIEW_ROWS = 200

function stepIndex(stage: string): number {
  switch (stage) {
    case 'idle':
    case 'parsing':
      return 0
    case 'ready':
      return 1
    case 'processing':
      return 2
    default:
      return 3
  }
}

export default function ExcelWindow() {
  const s = useOfficeStore()
  const fileRef = useRef<HTMLInputElement>(null)
  const [instr, setInstr] = useState('')

  useEffect(() => {
    void useOfficeStore.getState().loadModels()
  }, [])

  const pick = (files: FileList | null) => {
    const f = files?.[0]
    if (f) void s.excelLoadFile(f)
    if (fileRef.current) fileRef.current.value = ''
  }

  const run = () => {
    if (!instr.trim() || s.streaming) return
    void s.excelRun(instr)
  }

  const t = s.excelTable

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <StageSteps steps={STEPS} current={stepIndex(s.excelStage)} />
        <div className="flex items-center gap-2">
          <ModelSelect
            models={s.aggModels}
            modelId={s.currentModel}
            onChange={s.setModelSel}
            disabled={s.streaming}
          />
          {s.excelStage !== 'idle' && (
            <Button variant="ghost" size="sm" onClick={s.excelReset}>
              重新上传
            </Button>
          )}
        </div>
      </div>

      {s.excelError && (
        <div className="rounded-card border border-[#d0342c40] bg-[#d0342c14] px-4 py-2.5 text-xs text-failed">
          {s.excelError}
        </div>
      )}

      {/* 上传区 */}
      {(s.excelStage === 'idle' || s.excelStage === 'parsing') && (
        <div
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault()
            pick(e.dataTransfer.files)
          }}
          className="flex flex-col items-center gap-3 rounded-card border border-dashed border-line bg-surface px-6 py-12"
        >
          <p className="text-sm text-ink-muted">
            {s.excelStage === 'parsing'
              ? '正在解析文件…'
              : '拖入或选择 .xlsx / .csv 文件（不超过 ' +
                Math.round(MAX_XLSX_BYTES / 1024 / 1024) +
                'MB）'}
          </p>
          <Button
            onClick={() => fileRef.current?.click()}
            disabled={s.excelStage === 'parsing'}
          >
            选择文件
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".xlsx,.csv"
            className="hidden"
            onChange={(e) => pick(e.target.files)}
          />
        </div>
      )}

      {/* 概要 + 指令 + 差异 */}
      {t && s.excelStage !== 'processing' && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
            <span className="rounded-chip border border-line bg-surface-2 px-2 py-0.5">
              {s.excelFileName}
            </span>
            <span>
              {t.rows.length} 行 × {t.headers.length} 列
            </span>
            <span className="text-ink-dim">
              列名：{t.headers.filter(Boolean).join('、') || '（无表头）'}
            </span>
          </div>

          {s.excelDiff && (
            <div className="rounded-card border border-[#10a37f40] bg-[#10a37f1a] px-4 py-3 text-xs text-done">
              <div className="font-medium">✓ 已应用修改：{s.excelDiff.summary}</div>
              <div className="mt-1 text-ink-muted">
                行数 {s.excelDiff.rowsBefore} → {s.excelDiff.rowsAfter}，列数{' '}
                {s.excelDiff.colsBefore} → {s.excelDiff.colsAfter}
              </div>
            </div>
          )}

          <div className="flex gap-2">
            <input
              value={instr}
              onChange={(e) => setInstr(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') run()
              }}
              placeholder='下达处理指令，例："把B列求和加到末行" / "筛选出金额>1000的行"'
              className="flex-1 rounded-btn border border-line bg-surface-2 px-3 py-2 text-sm text-ink
                         placeholder:text-ink-dim focus:outline-none focus:border-primary"
            />
            <Button onClick={run} disabled={s.streaming || !instr.trim()}>
              执行
            </Button>
            {s.excelStage === 'done' && (
              <Button variant="soft" onClick={() => void s.excelDownload()}>
                ⬇ 下载新版本 .xlsx
              </Button>
            )}
          </div>
        </>
      )}

      {s.excelStage === 'processing' && (
        <div className="flex flex-col gap-2">
          <Spinner label="模型正在处理表格数据…" streamText={s.streamText} />
          <div className="flex justify-end">
            <Button variant="danger" size="sm" onClick={() => void s.stopActive()}>
              停止
            </Button>
          </div>
        </div>
      )}

      {/* 表格预览（前 200 行，深色表格） */}
      {t && (
        <div className="overflow-hidden rounded-card border border-line bg-surface">
          <div className="border-b border-line px-4 py-2 text-xs text-ink-muted">
            数据预览（前 {Math.min(PREVIEW_ROWS, t.rows.length)} 行
            {t.rows.length > PREVIEW_ROWS ? '，其余已省略' : ''}）
          </div>
          <div className="max-h-[420px] overflow-auto">
            <table className="w-full border-collapse text-xs">
              <thead className="sticky top-0 bg-surface-2">
                <tr>
                  <th className="border-b border-r border-line px-2 py-1.5 text-right text-[10px] text-ink-dim">
                    #
                  </th>
                  {t.headers.map((h, i) => (
                    <th
                      key={i}
                      className="whitespace-nowrap border-b border-line px-2.5 py-1.5 text-left font-medium text-ink"
                    >
                      {h || `列${i + 1}`}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {t.rows.slice(0, PREVIEW_ROWS).map((r, ri) => (
                  <tr key={ri} className="odd:bg-transparent even:bg-surface-2/40">
                    <td className="border-r border-line px-2 py-1 text-right text-[10px] text-ink-dim">
                      {ri + 1}
                    </td>
                    {t.headers.map((_, ci) => (
                      <td
                        key={ci}
                        className="max-w-[280px] truncate px-2.5 py-1 text-ink-muted"
                        title={r[ci] == null ? '' : String(r[ci])}
                      >
                        {r[ci] == null ? '' : String(r[ci])}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
