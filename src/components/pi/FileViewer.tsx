// 右栏「文件」tab 下半：文件内容预览（①）。
// 按扩展名分流：图片 → ImagePreview（ws_read_bytes→dataURL）；
// PDF → PdfPreview（ws_read_bytes + pdfjs，lazy）；其余 → CodeView（Monaco 只读，lazy）。
// 头部：文件名 + 复制绝对/相对路径 + 关闭。远程数据源时二进制预览降级为占位。
import { lazy, Suspense, useEffect, useState } from 'react'
import { usePiStore, type PiFilePreview } from '../../stores/piStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import ImagePreview, { IMAGE_MIME } from './ImagePreview'

const PdfPreview = lazy(() => import('./PdfPreview'))
const CodeView = lazy(() => import('./CodeView'))

/** 工作根 + rel_path 拼绝对路径：本地按根的分隔符风格，远程恒用 '/'。 */
function absPath(root: string, rel: string, isRemote: boolean): string {
  if (!rel) return root
  if (isRemote) return root.replace(/\/+$/, '') + '/' + rel
  const winStyle = root.includes('\\') || /^[a-zA-Z]:/.test(root)
  if (winStyle) return root.replace(/[\\/]+$/, '') + '\\' + rel.replace(/\//g, '\\')
  return root.replace(/\/+$/, '') + '/' + rel
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

function extOf(name: string): string {
  const i = name.lastIndexOf('.')
  return i < 0 ? '' : name.slice(i + 1).toLowerCase()
}

const OFFICE_EXTS = new Set(['docx', 'doc', 'xlsx', 'xls', 'pptx', 'ppt', 'odt', 'ods', 'odp'])

const fallback = (
  <div className="w-full h-full flex items-center justify-center text-[12px] text-ink-dim">
    加载预览组件…
  </div>
)

function OfficePlaceholder({ relPath, name }: { relPath: string; name: string }) {
  const [opening, setOpening] = useState(false)
  const openSystem = async () => {
    setOpening(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('ws_open_system', { relPath })
    } catch (e) {
      console.warn('打开失败:', e)
    } finally {
      setOpening(false)
    }
  }
  return (
    <div className="w-full h-full flex flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-[32px]">📄</div>
      <p className="text-[13px] text-ink font-medium">{name}</p>
      <p className="text-[12px] text-ink-muted">Office 文档需用系统应用打开</p>
      <button
        onClick={() => void openSystem()}
        disabled={opening}
        className="px-4 py-1.5 rounded-btn bg-primary text-white text-[12px] hover:bg-primary-hover disabled:opacity-50"
      >
        {opening ? '正在打开…' : '用系统应用打开'}
      </button>
    </div>
  )
}

export default function FileViewer({ preview }: { preview: PiFilePreview }) {
  const closePreview = usePiStore((s) => s.closePreview)
  const root = useWorkspaceStore((s) => s.root)
  const remote = useWorkspaceStore((s) => s.remote)
  const [copied, setCopied] = useState<string | null>(null)

  useEffect(() => {
    if (!copied) return
    const t = setTimeout(() => setCopied(null), 1500)
    return () => clearTimeout(t)
  }, [copied])

  const ext = extOf(preview.name)
  const isImage = !!IMAGE_MIME[ext]
  const isPdf = ext === 'pdf'
  const isOffice = OFFICE_EXTS.has(ext)
  const binaryOnRemote = !!remote && (isImage || isPdf)

  const doCopy = async (text: string, label: string) => {
    if (await copyText(text)) setCopied(label)
  }

  const btn =
    'px-1.5 h-5 rounded-btn border border-line text-[10px] text-ink-dim hover:text-ink hover:bg-surface-2 transition-colors flex-shrink-0'

  return (
    <div className="flex-1 min-h-0 flex flex-col border-t border-line">
      {/* 头部：文件名 + 复制路径 + 关闭 */}
      <div className="flex-shrink-0 flex items-center gap-1.5 px-2 h-7 bg-surface/80 border-b border-line select-none">
        <span
          className="text-[11px] text-ink font-mono truncate flex-1"
          title={preview.relPath}
        >
          {preview.name}
        </span>
        {copied && <span className="text-[10px] text-mint flex-shrink-0">已复制{copied}</span>}
        <button
          className={btn}
          onClick={() => void doCopy(absPath(root ?? '', preview.relPath, !!remote), '路径')}
          title="复制绝对路径"
        >
          路径
        </button>
        <button
          className={btn}
          onClick={() => void doCopy(preview.relPath, '相对路径')}
          title="复制相对路径"
        >
          相对
        </button>
        <button
          onClick={closePreview}
          className="text-[11px] text-ink-dim hover:text-coral px-1 flex-shrink-0"
          title="关闭预览"
        >
          ✕
        </button>
      </div>

      {/* 内容区 */}
      <div className="flex-1 min-h-0">
        {binaryOnRemote ? (
          <div className="w-full h-full flex items-center justify-center px-4 text-center text-[12px] text-ink-dim">
            远程数据源暂不支持图片 / PDF 预览
          </div>
        ) : isImage ? (
          <ImagePreview relPath={preview.relPath} ext={ext} />
        ) : isPdf ? (
          <Suspense fallback={fallback}>
            <PdfPreview relPath={preview.relPath} />
          </Suspense>
        ) : isOffice ? (
          <OfficePlaceholder relPath={preview.relPath} name={preview.name} />
        ) : (
          <Suspense fallback={fallback}>
            <CodeView relPath={preview.relPath} name={preview.name} line={preview.line} />
          </Suspense>
        )}
      </div>
    </div>
  )
}
