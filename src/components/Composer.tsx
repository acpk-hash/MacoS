import React, { useEffect, useRef, useState } from 'react'
import type { Attachment } from '../stores/studioStore'
import {
  MAX_ATTACH_BYTES,
  MAX_TEXT_BYTES,
  compressImage,
  dataUrlBytes,
} from '../lib/attachments'

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

export default function Composer({
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
}: ComposerProps) {
  const [attachments, setAttachments] = useState<Attachment[]>([])
  const [dragOver, setDragOver] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const imageInputRef = useRef<HTMLInputElement>(null)
  const textInputRef = useRef<HTMLInputElement>(null)
  const [plusOpen, setPlusOpen] = useState(false)

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
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) {
          e.preventDefault()
          void addImageFile(file)
        }
      }
    }
  }

  const handleDrop = (e: React.DragEvent) => {
    if (!attachmentsEnabled) return
    e.preventDefault()
    setDragOver(false)
    const files = Array.from(e.dataTransfer?.files ?? [])
    for (const file of files) {
      if (file.type.startsWith('image/')) void addImageFile(file)
      else if (
        file.type.startsWith('text/') ||
        /\.(txt|md|json|csv|log)$/i.test(file.name)
      )
        void addTextFile(file)
      else showToast('不支持的文件类型：' + file.name)
    }
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
                <span className="max-w-[140px] truncate">{a.name}</span>
                <button
                  onClick={() => removeAttachment(i)}
                  className="ml-1 text-ink-dim hover:text-red-400 transition-colors"
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
                  <div className="absolute bottom-11 left-0 z-20 w-36 py-1 rounded-lg bg-surface-2 border border-line shadow-xl">
                    <button
                      onClick={() => {
                        setPlusOpen(false)
                        imageInputRef.current?.click()
                      }}
                      className="w-full text-left px-3 py-1.5 text-xs text-ink-muted hover:bg-elevated transition-colors"
                    >
                      上传图片
                    </button>
                    <button
                      onClick={() => {
                        setPlusOpen(false)
                        textInputRef.current?.click()
                      }}
                      className="w-full text-left px-3 py-1.5 text-xs text-ink-muted hover:bg-elevated transition-colors"
                    >
                      上传文本文件
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
              className="flex-shrink-0 w-9 h-9 flex items-center justify-center rounded-lg bg-gray-200 hover:bg-white text-gray-900 transition-colors"
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
              files.forEach((f) => void addImageFile(f))
              e.target.value = ''
            }}
          />
          <input
            ref={textInputRef}
            type="file"
            accept=".txt,.md,.json,.csv,.log,text/*"
            multiple
            className="hidden"
            onChange={(e) => {
              const files = Array.from(e.target.files ?? [])
              files.forEach((f) => void addTextFile(f))
              e.target.value = ''
            }}
          />
        </>
      )}
    </div>
  )
}
