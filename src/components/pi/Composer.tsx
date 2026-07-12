// /pi 中栏底部 Composer：多行输入（Enter 发送 / Shift+Enter 换行）、
// 运行中显示「排队 N 条」徽章与「停止」按钮。
// ③ 附件：📎 选择（plugin-dialog 多选）+ 拖拽（尽力解析路径）→ chips 可删；
// 发送时按 pi-app 原生约定把每个附件注入为 @<绝对路径> token（pi RPC 的
// prompt/steer/follow_up 只有 message 文本字段，pi-app 自身即以 @path 传附件，
// 图片同样走 @path，由 pi 端负责加载）。
import { useEffect, useRef, useState } from 'react'
import { usePiStore } from '../../stores/piStore'

const EMPTY_QUEUE: string[] = []

function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg'])
const VIDEO_EXTS = new Set(['mp4', 'mov', 'avi', 'mkv', 'webm'])

function chipIcon(p: string): string {
  const ext = (p.split('.').pop() ?? '').toLowerCase()
  if (IMG_EXTS.has(ext)) return '🖼'
  if (VIDEO_EXTS.has(ext)) return '🎞'
  return '📄'
}

/** 从 DataTransfer 尽力解出本地文件路径（Tauri WebView2 拿不到 File.path 时
 *  回退 text/uri-list / text/plain；全都拿不到则返回空数组）。 */
function pathsFromDataTransfer(dt: DataTransfer): string[] {
  const out: string[] = []
  for (const f of Array.from(dt.files)) {
    const p = (f as File & { path?: string }).path
    if (typeof p === 'string' && p) out.push(p)
  }
  if (out.length > 0) return out
  const raw = dt.getData('text/uri-list') || dt.getData('text/plain')
  if (!raw) return out
  for (const line of raw.split(/\r?\n/)) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    if (t.startsWith('file://')) {
      try {
        let p = decodeURIComponent(t.replace(/^file:\/\//, ''))
        // /D:/foo → D:/foo
        if (/^\/[A-Za-z]:\//.test(p)) p = p.slice(1)
        out.push(p)
      } catch {
        /* ignore */
      }
    } else if (/^[A-Za-z]:[\\/]/.test(t) || t.startsWith('/')) {
      out.push(t)
    }
  }
  return out
}

export default function PiComposer() {
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)

  const activeSessionId = usePiStore((s) => s.activeSessionId)
  const status = usePiStore(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)?.status ?? null,
  )
  const queue = usePiStore((s) =>
    s.activeSessionId ? s.composerQueue[s.activeSessionId] ?? EMPTY_QUEUE : EMPTY_QUEUE,
  )
  const send = usePiStore((s) => s.send)
  const abort = usePiStore((s) => s.abort)

  useEffect(() => {
    if (!hint) return
    const t = setTimeout(() => setHint(null), 4000)
    return () => clearTimeout(t)
  }, [hint])

  const running = status === 'running'
  const disabled = !activeSessionId

  const addPaths = (paths: string[]) => {
    if (paths.length === 0) return
    setAttachments((prev) => {
      const next = [...prev]
      for (const p of paths) if (!next.includes(p)) next.push(p)
      return next
    })
  }

  const pickFiles = async () => {
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const picked = await open({ multiple: true, title: '选择附件（图片 / 文件 / 视频）' })
      if (picked == null) return
      addPaths(Array.isArray(picked) ? picked : [picked])
    } catch {
      setHint('文件选择不可用（仅桌面端支持）')
    }
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDragOver(false)
    if (disabled) return
    const paths = pathsFromDataTransfer(e.dataTransfer)
    if (paths.length > 0) addPaths(paths)
    else setHint('当前环境拖拽拿不到文件路径，请用 📎 按钮选择')
  }

  const doSend = () => {
    const body = draft.trim()
    if ((!body && attachments.length === 0) || disabled) return
    const parts: string[] = []
    if (body) parts.push(body)
    if (attachments.length > 0) {
      // pi 原生 @path 附件注入（pi 端自行加载/读取，无需额外说明文字）。
      parts.push(attachments.map((p) => `@${p}`).join('\n'))
    }
    setDraft('')
    setAttachments([])
    void send(parts.join('\n\n'))
    // 高度复位
    const el = taRef.current
    if (el) el.style.height = 'auto'
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      doSend()
    }
  }

  // 简易自适应高度（1~10 行）。
  const onInput = () => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 220) + 'px'
  }

  return (
    <div className="flex-shrink-0 border-t border-line px-4 py-3">
      <div className="max-w-3xl mx-auto">
        <div
          onDragOver={(e) => {
            e.preventDefault()
            if (!disabled) setDragOver(true)
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          className={[
            'rounded-card border bg-surface transition-colors',
            dragOver
              ? 'border-primary border-dashed bg-primary-tint/40'
              : 'border-line focus-within:border-primary/60',
          ].join(' ')}
        >
          {/* 附件 chips */}
          {attachments.length > 0 && (
            <div className="flex flex-wrap gap-1.5 px-2.5 pt-2">
              {attachments.map((p) => (
                <span
                  key={p}
                  className="inline-flex items-center gap-1.5 max-w-[260px] px-2 py-0.5 rounded-chip bg-surface-2 border border-line text-[11px] text-ink-muted"
                  title={p}
                >
                  <span aria-hidden="true">{chipIcon(p)}</span>
                  <span className="truncate font-mono">{baseName(p)}</span>
                  <button
                    onClick={() =>
                      setAttachments((prev) => prev.filter((x) => x !== p))
                    }
                    className="text-ink-dim hover:text-coral flex-shrink-0"
                    title="移除附件"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}

          <textarea
            ref={taRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            onInput={onInput}
            rows={2}
            disabled={disabled}
            placeholder={
              disabled
                ? '先新建一个会话'
                : running
                  ? '输入插话内容，Enter 发送（运行中会先排队投递）'
                  : '交代一个任务，Enter 发送，Shift+Enter 换行；可拖入或 📎 添加附件'
            }
            className="w-full bg-transparent resize-none px-3 pt-2.5 pb-1 text-[13.5px] text-ink placeholder:text-ink-faint outline-none max-h-[220px] disabled:opacity-50"
          />
          <div className="flex items-center gap-2 px-2.5 pb-2">
            <button
              onClick={() => void pickFiles()}
              disabled={disabled}
              className="px-1.5 py-0.5 rounded-btn text-[13px] text-ink-dim hover:text-ink hover:bg-surface-2 disabled:opacity-40 disabled:pointer-events-none transition-colors"
              title="添加附件（图片 / 任意文件 / 视频）"
            >
              📎
            </button>
            <span className="text-[10.5px] text-ink-faint select-none">
              {hint ?? 'Enter 发送 · Shift+Enter 换行'}
            </span>
            <div className="flex-1" />
            {queue.length > 0 && (
              <span
                className="text-[10.5px] px-2 py-0.5 rounded-chip bg-gold/15 text-gold border border-gold/25"
                title={queue.map((q, i) => `${i + 1}. ${q}`).join('\n')}
              >
                排队 {queue.length} 条
              </span>
            )}
            {running && (
              <button
                onClick={() => void abort()}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-btn bg-surface-2 hover:bg-coral/15 border border-line hover:border-coral/30 text-[11.5px] text-ink-muted hover:text-coral transition-colors"
                title="停止当前任务"
              >
                <span className="w-2 h-2 bg-current rounded-[2px]" />
                停止
              </button>
            )}
            <button
              onClick={doSend}
              disabled={disabled || (!draft.trim() && attachments.length === 0)}
              className="px-3 py-1 rounded-btn bg-primary hover:bg-primary-hover disabled:opacity-30 disabled:pointer-events-none text-[11.5px] text-white transition-colors"
              title={running ? '发送插话（排队投递）' : '发送'}
            >
              发送
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
