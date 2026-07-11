import React, { useEffect, useImperativeHandle, useRef, useState } from 'react'
import type { Attachment } from '../stores/studioStore'
import { attachmentsTextBytes, filesToAttachments } from '../lib/attachments'

const MAX_TEXTAREA_H = 200 // ~8 lines

export interface ComposerProps {
  draft: string
  setDraft: (v: string) => void
  onSend: (content: string, attachments: Attachment[]) => void
  disabled?: boolean
  busy?: boolean
  onStop?: () => void
  showToast: (msg: string) => void
  placeholder?: string
  footerHint?: string | null
  attachmentsEnabled?: boolean
  requireContent?: boolean
  renderPlusMenu?: (close: () => void) => React.ReactNode
  paramsSlot?: React.ReactNode
  focusToken?: number
  maxWidthClass?: string
}

/** Imperative surface：让页面级拖放遮罩把文件塞进当前 Composer。 */
export interface ComposerHandle {
  addFiles: (files: File[]) => void
}

const Composer = React.forwardRef<ComposerHandle, ComposerProps>(function Composer(
  {
    draft,
    setDraft,
    onSend,
    disabled = false,
    busy = false,
    onStop,
    showToast,
    placeholder,
    footerHint = 'AI 也可能会出错，请核对重要信息。',
    attachmentsEnabled = true,
    requireContent = false,
    renderPlusMenu,
    paramsSlot,
    focusToken,
    maxWidthClass = 'max-w-3xl',
  },
  ref,
) {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [plusOpen, setPlusOpen] = useState(false)

  // 供 addFiles 的总量预算读取最新附件（避免闭包里拿到旧值）。
  const attachmentsRef = useRef<Attachment[]>(attachments)
  attachmentsRef.current = attachments

  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, MAX_TEXTAREA_H) + 'px'
  }, [draft])

  useEffect(() => {
    if (focusToken === undefined) return
    const el = textareaRef.current
    if (el && !disabled) {
      el.focus()
      const len = el.value.length
      el.setSelectionRange(len, len)
    }
  }, [focusToken]) // eslint-disable-line react-hooks/exhaustive-deps

  /** 任意文件统一入口：图片→压缩附件；文本类→内联；其余→提示跳过。 */
  const addFiles = async (files: File[]) => {
    if (!attachmentsEnabled || files.length === 0) return
    const { attachments: added, warnings } = await filesToAttachments(
      files,
      attachmentsTextBytes(attachmentsRef.current),
    )
    if (added.length > 0) setAttachments((prev) => [...prev, ...added])
    if (warnings.length > 0) {
      const extra = warnings.length > 3 ? ' 等 ' + warnings.length + ' 条' : ''
      showToast(warnings.slice(0, 3).join('；') + extra)
    }
  }

  useImperativeHandle(ref, () => ({
    addFiles: (files: File[]) => void addFiles(files),
  }))

  const removeAttachment = (idx: number) => {
    setAttachments((prev) => prev.filter((_, i) => i !== idx))
  }

  const hasContent = draft.trim().length > 0
  const hasAttach = attachmentsEnabled && attachments.length > 0
  const canSend =
    !disabled &&
    !busy &&
    (requireContent ? hasContent : hasContent || hasAttach)

  const handleSend = () => {
    const content = draft.trim()
    const atts = attachmentsEnabled ? attachments : []
    if (disabled || busy) return
    if (requireContent ? !content : !content && atts.length === 0) return
    onSend(content, atts)
    setDraft('')
    setAttachments([])
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSend()
    }
  }

  const handlePaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!attachmentsEnabled) return
    const items = e.clipboardData?.items
    if (!items) return
    const files: File[] = []
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) files.push(file)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      void addFiles(files)
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    if (!attachmentsEnabled) return
    // preventDefault 同时向页面级遮罩标记「此处已处理」（defaultPrevented）。
    e.preventDefault()
    setDragOver(false)
    void addFiles(Array.from(e.dataTransfer?.files ?? []))
  }

  const showPlus = !!renderPlusMenu || attachmentsEnabled

  return (
    <div className="px-4 pb-4 pt-1 flex-shrink-0">
      <div
        onDragOver={(e) => {
          if (!attachmentsEnabled) return
          e.preventDefault()
          setDragOver(true)
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={[
          maxWidthClass,
          'mx-auto rounded-pop glass transition-colors',
          dragOver ? 'border-lavender bg-sakura/20' : 'border-line',
          disabled ? 'opacity-60' : '',
        ].join(' ')}
      >
        {paramsSlot && (
          <div className="px-3 pt-3 border-b border-line/60 pb-3">
            {paramsSlot}
          </div>
        )}

        {attachmentsEnabled && attachments.length > 0 && (
          <div className="flex flex-wrap gap-2 px-3 pt-3">
            {attachments.map((a, i) => (
              <div
                key={i}
                className="relative group flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-surface border border-line text-xs text-ink-muted"
              >
                {a.kind === 'image' && a.data_url ? (
                  <img
                    src={a.data_url}
                    alt={a.name ?? ''}
                    className="w-8 h-8 rounded object-cover"
                  />
                ) : (
                  <span aria-hidden="true">📄</span>
                )}
                <span className="max-w-[140px] truncate" title={a.name}>
                  {a.name}
                </span>
                <button
                  onClick={() => removeAttachment(i)}
                  className="ml-1 text-ink-dim hover:text-failed transition-colors"
                  title="移除"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="flex items-end gap-2 p-2">
          {showPlus && (
            <div className="relative flex-shrink-0">
              <button
                onClick={() => setPlusOpen((v) => !v)}
                className="w-9 h-9 flex items-center justify-center rounded-lg text-ink-muted hover:bg-elevated hover:text-ink transition-colors text-xl leading-none"
                title={renderPlusMenu ? '更多' : '添加附件'}
              >
                +
              </button>
              {plusOpen &&
                (renderPlusMenu ? (
                  <div className="absolute bottom-11 left-0 z-20">
                    {renderPlusMenu(() => setPlusOpen(false))}
                  </div>
                ) : (
                  <div className="absolute bottom-11 left-0 z-20 w-44 py-1 rounded-lg bg-surface-2 border border-line shadow-xl">
                    <button
                      onClick={() => {
                        setPlusOpen(false)
                        fileInputRef.current?.click()
                      }}
                      className="w-full text-left px-3 py-1.5 text-xs text-ink-muted hover:bg-elevated transition-colors"
                    >
                      添加文件（图片 / 文本）
                    </button>
                    <button
                      onClick={() => {
                        setPlusOpen(false)
                        imageInputRef.current?.click()
                      }}
                      className="w-full text-left px-3 py-1.5 text-xs text-ink-muted hover:bg-elevated transition-colors"
                    >
                      上传图片
                    </button>
                  </div>
                ))}
            </div>
          )}

          <textarea
            ref={textareaRef}
            rows={1}
            value={draft}
            disabled={disabled}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            placeholder={placeholder ?? '发送消息，Enter 发送 / Shift+Enter 换行'}
            className="flex-1 bg-transparent resize-none px-2 py-2 text-[15px] text-ink placeholder-ink-dim focus:outline-none max-h-[200px] disabled:cursor-not-allowed"
          />

          {busy && onStop ? (
            <button
              onClick={onStop}
              className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-lg bg-surface-2 hover:bg-elevated text-ink transition-colors"
              title="停止生成"
            >
              <span className="w-3 h-3 bg-surface rounded-[2px]" />
            </button>
          ) : (
            <button
              onClick={handleSend}
              disabled={!canSend}
              className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-btn bg-grad-primary shadow-glow-primary hover:-translate-y-px disabled:opacity-30 disabled:shadow-none disabled:translate-y-0 disabled:cursor-not-allowed text-white transition-all"
              title="发送"
            >
              ↑
            </button>
          )}
        </div>
      </div>
      {footerHint && (
        <p
          className={[
            maxWidthClass,
            'mx-auto text-center text-[10px] text-ink-dim mt-2',
          ].join(' ')}
        >
          {footerHint}
        </p>
      )}

      {attachmentsEnabled && (
        <>
          <input
            ref={imageInputRef}
            type="file"
            accept="image/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              if (files.length > 0) void addFiles(files)
              e.target.value = ''
            }}
          />
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              if (files.length > 0) void addFiles(files)
              e.target.value = ''
            }}
          />
        </>
      )}
    </div>
  )
})

export default Composer
