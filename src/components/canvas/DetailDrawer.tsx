// Right-slide detail drawer. Content is looked up lazily from the ref map
// on node click (nodes themselves only carry summaries).

import type { DetailEntry } from './types'

function fmtTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return String(ms)
  }
}

function statusText(s: string): string {
  if (s === 'running') return '运行中'
  if (s === 'failed') return '失败'
  return '已完成'
}

export default function DetailDrawer({
  entry,
  onClose,
}: {
  entry: DetailEntry | null
  onClose: () => void
}) {
  return (
    <div
      className={`absolute top-0 right-0 h-full w-[380px] bg-gray-900 border-l border-gray-800 shadow-2xl transition-transform duration-200 z-20 flex flex-col ${
        entry ? 'translate-x-0' : 'translate-x-full'
      }`}
    >
      {entry && (
        <>
          <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
            <span className="text-sm font-semibold text-gray-200">
              {entry.type === 'task' && '任务详情'}
              {entry.type === 'session' && '会话详情'}
              {entry.type === 'step' && '步骤详情'}
            </span>
            <button
              onClick={onClose}
              className="text-gray-500 hover:text-gray-200 text-lg leading-none"
              title="关闭"
            >
              ×
            </button>
          </div>

          <div className="flex-1 overflow-auto p-4 text-sm text-gray-300 space-y-3">
            {entry.type === 'task' && (
              <>
                <Field label="标题" value={entry.title || '未命名任务'} />
                <Field label="状态" value={entry.status} />
                <Field label="会话数" value={String(entry.sessionCount)} />
              </>
            )}

            {entry.type === 'session' && (
              <>
                <Field label="引擎" value={entry.engine} />
                <Field label="线程 ID" value={entry.threadId ?? '（无）'} mono />
                <Field label="状态" value={statusText(entry.status)} />
                <Field label="开始时间" value={fmtTime(entry.startedAt)} />
                <Field
                  label="结束时间"
                  value={entry.endedAt != null ? fmtTime(entry.endedAt) : '进行中'}
                />
                <Field label="步骤数" value={String(entry.stepCount)} />
                {entry.errorText && (
                  <div>
                    <div className="text-[11px] text-gray-500 mb-1">错误</div>
                    <pre className="text-[12px] text-red-400 whitespace-pre-wrap break-all bg-gray-950 rounded p-2">
                      {entry.errorText}
                    </pre>
                  </div>
                )}
              </>
            )}

            {entry.type === 'step' && entry.stepKind === 'reply' && (
              <div>
                <div className="text-[11px] text-gray-500 mb-1">回复全文</div>
                <pre className="text-[12px] whitespace-pre-wrap break-words bg-gray-950 rounded p-3 leading-relaxed">
                  {entry.text || '（空回复）'}
                </pre>
              </div>
            )}

            {entry.type === 'step' && entry.stepKind === 'command' && (
              <>
                <div>
                  <div className="text-[11px] text-gray-500 mb-1">命令</div>
                  <pre className="text-[12px] font-mono whitespace-pre-wrap break-all bg-gray-950 rounded p-2">
                    {entry.cmd}
                  </pre>
                </div>
                <Field
                  label="退出码"
                  value={String(entry.exitCode)}
                  danger={entry.exitCode !== 0}
                />
                <div>
                  <div className="text-[11px] text-gray-500 mb-1">输出（末尾）</div>
                  <pre className="text-[11px] font-mono whitespace-pre-wrap break-all bg-gray-950 rounded p-2 max-h-72 overflow-auto text-gray-400">
                    {entry.outputTail || '（无输出）'}
                  </pre>
                </div>
              </>
            )}

            {entry.type === 'step' && entry.stepKind === 'file' && (
              <>
                <Field label="路径" value={entry.path ?? ''} mono />
                <Field label="变更类型" value={entry.changeKind ?? ''} />
                <div className="text-[12px] font-mono">
                  <span className="text-green-400">+{entry.added ?? 0}</span>{'  '}
                  <span className="text-red-400">-{entry.removed ?? 0}</span>
                </div>
                <div>
                  <div className="text-[11px] text-gray-500 mb-1">差异</div>
                  <pre className="text-[11px] font-mono whitespace-pre bg-gray-950 rounded p-2 max-h-96 overflow-auto">
                    {entry.diff || '（无差异内容）'}
                  </pre>
                </div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function Field({
  label,
  value,
  mono,
  danger,
}: {
  label: string
  value: string
  mono?: boolean
  danger?: boolean
}) {
  return (
    <div>
      <div className="text-[11px] text-gray-500 mb-0.5">{label}</div>
      <div
        className={`text-[13px] break-all ${mono ? 'font-mono' : ''} ${
          danger ? 'text-red-400' : 'text-gray-200'
        }`}
      >
        {value}
      </div>
    </div>
  )
}
