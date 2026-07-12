/**
 * LibraryTab -- 科研知识库主区（自 698a026 的 components/research/LibraryTab.tsx 恢复）
 *
 * .md 条目预览: 文献搜索「一键入库」生成的元数据+链接条目是 .md 文件，
 * 用 KbTextPreview（kb_read_bytes → UTF-8 → MarkdownLite）渲染。
 *
 * 布局: 顶部工具条 | 左列分类树 | 中部论文表 | 右侧详情抽屉
 *
 * PDF 预览: PdfPreview 依赖 ws_read_bytes（需工作区相对路径），无法直接用于 KB 绝对路径。
 * 此处内置 KbPdfPreview，经后端 kb_read_bytes(paperId) 读字节(base64)再用 pdfjs 加载，
 * 绕开 assetProtocol scope 限制（论文位于任意绝对路径）。
 */
import { useEffect, useRef, useState, useCallback } from 'react'
import * as pdfjs from 'pdfjs-dist'
import type { PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'
import MarkdownLite from '../ui/MarkdownLite'
import {
  useKbStore,
  type Category,
  type Tag,
  type PaperSummary,
  type Paper,
  type RenamePreview,
  type ApplyItem,
} from '../../stores/kbStore'

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl

// -- Tauri guard --------------------------------------------------------------

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

// -- Helpers ------------------------------------------------------------------

function fmtSize(bytes: number | null): string {
  if (bytes == null) return '-'
  if (bytes < 1024) return bytes + ' B'
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB'
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB'
}

function fmtDate(ms: number | null): string {
  if (ms == null) return '-'
  return new Date(ms).toLocaleDateString('zh-CN')
}

// -- KB PDF Preview (absolute filePath via convertFileSrc) --------------------

const MAX_PAGES = 80
const ZOOM_STEPS = [0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3]

function KbPdfPage({ doc, pageNo, scale }: { doc: PDFDocumentProxy; pageNo: number; scale: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    let cancelled = false
    let task: RenderTask | null = null
    ;(async () => {
      try {
        const page = await doc.getPage(pageNo)
        if (cancelled) return
        const canvas = canvasRef.current
        if (!canvas) return
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        const vp = page.getViewport({ scale })
        canvas.width = Math.floor(vp.width * dpr)
        canvas.height = Math.floor(vp.height * dpr)
        canvas.style.width = Math.floor(vp.width) + 'px'
        canvas.style.height = Math.floor(vp.height) + 'px'
        task = page.render({
          canvas,
          viewport: vp,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        })
        await task.promise
      } catch {
        /* ignore cancel */
      }
    })()
    return () => {
      cancelled = true
      task?.cancel()
    }
  }, [doc, pageNo, scale])
  return <canvas ref={canvasRef} className="bg-white shadow-lg flex-shrink-0" />
}
function KbPdfPreview({ paperId }: { paperId: string }) {
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [pageWidth, setPageWidth] = useState(612)
  const [error, setError] = useState<string | null>(null)
  const [zoom, setZoom] = useState<number | 'fit'>('fit')
  const [boxWidth, setBoxWidth] = useState(0)
  const boxRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    setBoxWidth(el.clientWidth)
    const ro = new ResizeObserver(() => setBoxWidth(el.clientWidth))
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  useEffect(() => {
    let alive = true
    let loaded: PDFDocumentProxy | null = null
    setDoc(null)
    setError(null)
    setZoom('fit')
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const res = await invoke<{ base64: string; size: number }>('kb_read_bytes', { id: paperId })
        const bin = atob(res.base64)
        const data = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i)
        if (!alive) return
        loaded = await pdfjs.getDocument({ data }).promise
        if (!alive) { void loaded.loadingTask.destroy(); return }
        const p1 = await loaded.getPage(1)
        if (!alive) return
        setPageWidth(p1.getViewport({ scale: 1 }).width)
        setDoc(loaded)
      } catch (e) {
        if (alive) setError(String(e))
      }
    })()
    return () => {
      alive = false
      if (loaded) void loaded.loadingTask.destroy()
    }
  }, [paperId])

  const fitScale = Math.min(Math.max((boxWidth - 48) / pageWidth, 0.3), 3)
  const scale = zoom === 'fit' ? fitScale : zoom

  const zoomBy = (dir: 1 | -1) => {
    const cur = scale
    const next = dir === 1
      ? ZOOM_STEPS.find((z) => z > cur * 1.01)
      : [...ZOOM_STEPS].reverse().find((z) => z < cur * 0.99)
    if (next) setZoom(next)
  }

  const numPages = doc?.numPages ?? 0
  const shownPages = Math.min(numPages, MAX_PAGES)

  const btn = 'px-2 h-6 rounded border border-line text-[11px] text-ink-dim hover:text-ink hover:bg-surface-2 transition-colors'

  return (
    <div className="w-full h-full flex flex-col bg-editor">
      <div className="flex items-center gap-2 px-3 h-8 border-b border-line bg-surface/60 flex-shrink-0 select-none">
        <span className="text-[11px] text-ink-dim truncate flex-1">
          {doc ? '共 ' + numPages + ' 页' + (numPages > MAX_PAGES ? ' (仅渲染前 ' + MAX_PAGES + ' 页)' : '') : ''}
        </span>
        <button className={btn} onClick={() => zoomBy(-1)}>-</button>
        <span className="text-[11px] text-ink-muted w-12 text-center font-mono">{Math.round(scale * 100)}%</span>
        <button className={btn} onClick={() => zoomBy(1)}>+</button>
        <button className={[btn, zoom === 'fit' ? 'border-primary/40 text-primary' : ''].join(' ')} onClick={() => setZoom('fit')}>适应宽</button>
      </div>
      <div ref={boxRef} className="flex-1 min-h-0 overflow-auto">
        {error ? (
          <div className="w-full h-full flex flex-col items-center justify-center gap-2 px-6 text-center">
            <p className="text-[12px] text-failed">PDF 加载失败: {error}</p>
          </div>
        ) : !doc ? (
          <div className="w-full h-full flex items-center justify-center text-[12px] text-ink-dim">
            解析中...
          </div>
        ) : (
          <div className="flex flex-col items-center gap-4 py-4 px-3">
            {Array.from({ length: shownPages }, (_, i) => (
              <KbPdfPage key={paperId + ':' + (i + 1)} doc={doc} pageNo={i + 1} scale={scale} />
            ))}
            {numPages > MAX_PAGES && (
              <p className="text-[11px] text-ink-dim py-2">-- 已达预览上限 ({MAX_PAGES} 页) --</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// -- KB text/.md preview (metadata stub entries from lit search) ---------------

function KbTextPreview({ paperId }: { paperId: string }) {
  const [text, setText] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    setText(null)
    setError(null)
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const res = await invoke<{ base64: string; size: number }>('kb_read_bytes', { id: paperId })
        const bin = atob(res.base64)
        const data = new Uint8Array(bin.length)
        for (let i = 0; i < bin.length; i++) data[i] = bin.charCodeAt(i)
        if (!alive) return
        setText(new TextDecoder('utf-8').decode(data))
      } catch (e) {
        if (alive) setError(String(e))
      }
    })()
    return () => {
      alive = false
    }
  }, [paperId])

  return (
    <div className="w-full h-full overflow-auto bg-editor px-3 py-2">
      {error ? (
        <p className="text-[12px] text-failed">条目加载失败: {error}</p>
      ) : text == null ? (
        <p className="text-[12px] text-ink-dim">加载中...</p>
      ) : (
        <MarkdownLite text={text} />
      )}
    </div>
  )
}

// -- Category tree helpers ----------------------------------------------------

function buildTree(categories: Category[]): Map<string | null, Category[]> {
  const map = new Map<string | null, Category[]>()
  for (const c of categories) {
    const key = c.parent_id ?? null
    const arr = map.get(key) ?? []
    arr.push(c)
    map.set(key, arr)
  }
  return map
}
// -- Category tree node -------------------------------------------------------

function CategoryNode({
  cat,
  tree,
  activeCategoryId,
  onSelect,
  onAdd,
  onRename,
  onDelete,
  depth,
}: {
  cat: Category
  tree: Map<string | null, Category[]>
  activeCategoryId: string | null
  onSelect: (id: string) => void
  onAdd: (parentId: string) => void
  onRename: (cat: Category) => void
  onDelete: (cat: Category) => void
  depth: number
}) {
  const [hovered, setHovered] = useState(false)
  const children = tree.get(cat.id) ?? []
  const active = activeCategoryId === cat.id

  return (
    <div>
      <div
        className={
          'group flex items-center gap-1 py-1 rounded-md cursor-pointer text-[12px] transition-colors ' +
          (active ? 'bg-primary-tint text-primary font-semibold' : 'text-ink-dim hover:bg-surface-2 hover:text-ink')
        }
        style={{ paddingLeft: (8 + depth * 14) + 'px', paddingRight: '4px' }}
        onClick={() => onSelect(cat.id)}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        {cat.color && (
          <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ backgroundColor: cat.color }} />
        )}
        <span className="flex-1 truncate">{cat.name}</span>
        {hovered && (
          <span className="flex items-center gap-0.5 flex-shrink-0">
            <button
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-surface text-ink-dim hover:text-ink text-[10px]"
              title="添加子分类"
              onClick={(e) => { e.stopPropagation(); onAdd(cat.id) }}
            >+</button>
            <button
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-surface text-ink-dim hover:text-ink text-[10px]"
              title="重命名"
              onClick={(e) => { e.stopPropagation(); onRename(cat) }}
            >e</button>
            <button
              className="w-5 h-5 flex items-center justify-center rounded hover:bg-surface text-failed text-[10px]"
              title="删除"
              onClick={(e) => { e.stopPropagation(); onDelete(cat) }}
            >x</button>
          </span>
        )}
      </div>
      {children.map((child) => (
        <CategoryNode
          key={child.id}
          cat={child}
          tree={tree}
          activeCategoryId={activeCategoryId}
          onSelect={onSelect}
          onAdd={onAdd}
          onRename={onRename}
          onDelete={onDelete}
          depth={depth + 1}
        />
      ))}
    </div>
  )
}

// -- Normalize dialog ---------------------------------------------------------

function NormalizeDialog({
  papers,
  onClose,
}: {
  papers: PaperSummary[]
  onClose: () => void
}) {
  const store = useKbStore()
  const [template, setTemplate] = useState('{year}_{author}_{title}')
  const [previews, setPreviews] = useState<RenamePreview[] | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [applying, setApplying] = useState(false)
  const [resultMsg, setResultMsg] = useState<string | null>(null)
  const [previewError, setPreviewError] = useState<string | null>(null)

  const doPreview = async () => {
    setPreviewing(true)
    setPreviewError(null)
    setResultMsg(null)
    try {
      const ids = papers.map((p) => p.id)
      const result = await store.normalizePreview(ids, template)
      setPreviews(result)
    } catch (e) {
      setPreviewError('预览失败：' + String(e))
    } finally {
      setPreviewing(false)
    }
  }

  const doApply = async () => {
    if (!previews || previews.length === 0) return
    setApplying(true)
    setResultMsg(null)
    try {
      const items: ApplyItem[] = previews.map((p) => ({ id: p.id, new_name: p.new_name }))
      const result = await store.normalizeApply(items)
      const failMsg = result.failed.length > 0 ? `，${result.failed.length} 个失败` : ''
      setResultMsg(`已应用 ${result.applied} 个重命名${failMsg}`)
      setPreviews(null)
    } catch (e) {
      setResultMsg('应用失败：' + String(e))
    } finally {
      setApplying(false)
    }
  }

  const inputCls = 'w-full bg-surface border border-line rounded-md px-2 py-1.5 text-[12px] text-ink placeholder-ink-dim focus:outline-none focus:border-primary transition-colors'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div
        className="bg-bg border border-line rounded-xl shadow-2xl p-5 flex flex-col gap-3"
        style={{ width: '520px', maxHeight: '80vh' }}
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[14px] font-semibold text-ink">规范化文件命名</h3>

        <div>
          <p className="text-[11px] text-ink-dim mb-1">
            模板（占位符：<code className="text-primary">{'{year}'}</code>、<code className="text-primary">{'{author}'}</code>、<code className="text-primary">{'{title}'}</code>）
          </p>
          <input
            className={inputCls}
            value={template}
            onChange={(e) => { setTemplate(e.target.value); setPreviews(null); setResultMsg(null) }}
            placeholder="{year}_{author}_{title}"
          />
        </div>

        <p className="text-[11px] text-ink-dim">
          作用范围：当前列表全部（共 {papers.length} 篇）
        </p>

        <div className="flex gap-2 flex-wrap">
          <button
            onClick={() => void doPreview()}
            disabled={previewing || applying}
            className="px-3 py-1.5 text-[12px] border border-line rounded-md text-ink-dim hover:text-ink hover:bg-surface-2 disabled:opacity-50 transition-colors"
          >
            {previewing ? '生成预览中...' : '预览'}
          </button>
          {previews && previews.length > 0 && (
            <button
              onClick={() => void doApply()}
              disabled={applying}
              className="px-3 py-1.5 text-[12px] bg-primary text-white rounded-md hover:opacity-90 disabled:opacity-50 transition-opacity"
            >
              {applying ? '应用中...' : '应用'}
            </button>
          )}
          <button
            onClick={onClose}
            className="px-3 py-1.5 text-[12px] border border-line rounded-md text-ink-dim hover:text-ink hover:bg-surface-2 transition-colors ml-auto"
          >
            关闭
          </button>
        </div>

        {previewError && <p className="text-[12px] text-failed">{previewError}</p>}
        {resultMsg && (
          <p className={'text-[12px] ' + (resultMsg.includes('失败') ? 'text-failed' : 'text-done')}>
            {resultMsg}
          </p>
        )}

        {previews && (
          <div className="flex-1 overflow-y-auto border border-line rounded-md bg-surface/40 min-h-0" style={{ maxHeight: '300px' }}>
            {previews.length === 0 ? (
              <p className="text-[12px] text-ink-dim p-3 text-center">没有需要重命名的文件</p>
            ) : (
              <table className="w-full text-[11px] border-collapse">
                <thead className="sticky top-0 bg-surface border-b border-line">
                  <tr className="text-ink-dim text-left">
                    <th className="px-2 py-1.5 font-medium w-1/2">原文件名</th>
                    <th className="px-2 py-1.5 font-medium w-1/2">新文件名</th>
                  </tr>
                </thead>
                <tbody>
                  {previews.map((p) => (
                    <tr key={p.id} className="border-b border-line/40 hover:bg-surface-2/40">
                      <td className="px-2 py-1 text-ink-muted truncate max-w-0" title={p.old_name}>
                        <span className="truncate block">{p.old_name}</span>
                      </td>
                      <td className="px-2 py-1 text-ink truncate max-w-0" title={p.new_name}>
                        <span className="truncate block">{p.new_name}</span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

// -- Detail drawer ------------------------------------------------------------

function DetailDrawer({ paper, categories, tags, onClose }: {
  paper: Paper
  categories: Category[]
  tags: Tag[]
  onClose: () => void
}) {
  const store = useKbStore()
  const [editTitle, setEditTitle] = useState(paper.title ?? '')
  const [editAuthors, setEditAuthors] = useState(paper.authors ?? '')
  const [editYear, setEditYear] = useState(paper.year != null ? String(paper.year) : '')
  const [editVenue, setEditVenue] = useState(paper.venue ?? '')
  const [editDoi, setEditDoi] = useState(paper.doi ?? '')
  const [editNotes, setEditNotes] = useState(paper.notes ?? '')
  const [editStarred, setEditStarred] = useState(paper.starred === 1)
  const [saving, setSaving] = useState(false)
  const [saveMsg, setSaveMsg] = useState<string | null>(null)
  const [newTag, setNewTag] = useState('')
  const [showPdf, setShowPdf] = useState(false)
  const [deleteConfirm, setDeleteConfirm] = useState(false)
  const [deleting, setDeleting] = useState(false)

  // -- File management state -------------------------------------------------
  const [renameInput, setRenameInput] = useState('')
  const [renaming, setRenaming] = useState(false)
  const [renameMsg, setRenameMsg] = useState<string | null>(null)
  const [undoing, setUndoing] = useState(false)
  const [undoMsg, setUndoMsg] = useState<string | null>(null)
  const [moving, setMoving] = useState(false)
  const [moveMsg, setMoveMsg] = useState<string | null>(null)

  // tags available for future tag-picker UI
  void tags

  useEffect(() => {
    setEditTitle(paper.title ?? '')
    setEditAuthors(paper.authors ?? '')
    setEditYear(paper.year != null ? String(paper.year) : '')
    setEditVenue(paper.venue ?? '')
    setEditDoi(paper.doi ?? '')
    setEditNotes(paper.notes ?? '')
    setEditStarred(paper.starred === 1)
    setSaveMsg(null)
    setShowPdf(false)
    setDeleteConfirm(false)
    setRenameInput('')
    setRenameMsg(null)
    setUndoMsg(null)
    setMoveMsg(null)
  }, [paper.id])

  const doSave = async () => {
    setSaving(true)
    setSaveMsg(null)
    try {
      await store.updateMetadata(paper.id, {
        title: editTitle || null,
        authors: editAuthors || null,
        year: editYear ? parseInt(editYear, 10) : null,
        venue: editVenue || null,
        doi: editDoi || null,
        notes: editNotes || null,
        starred: editStarred,
      })
      setSaveMsg('已保存')
      await store.loadPapers()
    } catch (e) {
      setSaveMsg('保存失败: ' + String(e))
    } finally {
      setSaving(false)
    }
  }

  const doSetCategory = async (catId: string) => {
    try {
      await store.setCategory(paper.id, catId === '__none__' ? null : catId)
      await store.loadPapers()
    } catch (e) {
      useKbStore.setState({ error: '设置分类失败: ' + String(e) })
    }
  }

  const doAddTag = async () => {
    const t = newTag.trim()
    if (!t) return
    try {
      await store.addTags(paper.id, [t])
      setNewTag('')
    } catch (e) {
      useKbStore.setState({ error: '添加标签失败: ' + String(e) })
    }
  }

  const doRemoveTag = async (tagId: string) => {
    try {
      await store.removeTag(paper.id, tagId)
    } catch (e) {
      useKbStore.setState({ error: '删除标签失败: ' + String(e) })
    }
  }

  const doDelete = async () => {
    setDeleting(true)
    try {
      const deleteFile = paper.managed === 1
      await store.deletePaper(paper.id, deleteFile)
      onClose()
      await store.loadPapers()
    } catch (e) {
      useKbStore.setState({ error: '删除失败: ' + String(e) })
    } finally {
      setDeleting(false)
      setDeleteConfirm(false)
    }
  }

  // -- File management handlers ----------------------------------------------

  const doRename = async () => {
    const name = renameInput.trim()
    if (!name) return
    setRenaming(true)
    setRenameMsg(null)
    try {
      const newPath = await store.renameFile(paper.id, name)
      setRenameMsg('重命名成功: ' + newPath.split(/[/\\]/).pop())
      setRenameInput('')
    } catch (e) {
      setRenameMsg('重命名失败: ' + String(e))
    } finally {
      setRenaming(false)
    }
  }

  const doUndo = async () => {
    setUndoing(true)
    setUndoMsg(null)
    try {
      const restoredPath = await store.renameUndo(paper.id)
      setUndoMsg('已撤销，当前文件: ' + restoredPath.split(/[/\\]/).pop())
    } catch (e) {
      setUndoMsg('撤销失败: ' + String(e))
    } finally {
      setUndoing(false)
    }
  }

  const doMove = async () => {
    if (!isTauri) return
    setMoving(true)
    setMoveMsg(null)
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const dir = await open({ directory: true, multiple: false, title: '选择目标目录' })
      if (!dir || typeof dir !== 'string') { setMoving(false); return }
      if (paper.managed === 0) {
        // 就地索引：提示用户原文件会被物理移动
        if (!window.confirm('该论文为就地索引模式，移动将会物理移动原始文件到新目录，确认继续？')) {
          setMoving(false)
          return
        }
      }
      const newPath = await store.moveFile(paper.id, dir)
      setMoveMsg('已移动到: ' + newPath.split(/[/\\]/).slice(0, -1).join('/'))
    } catch (e) {
      setMoveMsg('移动失败: ' + String(e))
    } finally {
      setMoving(false)
    }
  }

  const isMdEntry = !!paper.file_path && /\.(md|markdown|txt)$/i.test(paper.file_path)
  const inputCls = 'w-full bg-surface border border-line rounded-md px-2 py-1 text-[12px] text-ink placeholder-ink-dim focus:outline-none focus:border-primary transition-colors'
  const labelCls = 'text-[11px] text-ink-dim mb-0.5'
  const sectionLabelCls = 'text-[11px] text-ink-dim font-medium uppercase tracking-wide mb-1'

  return (
    <div className="flex flex-col h-full border-l border-line bg-surface/30 overflow-hidden" style={{ minWidth: '300px', maxWidth: '380px', width: '340px' }}>
      <div className="flex items-center gap-2 px-3 py-2 border-b border-line flex-shrink-0">
        <span className="flex-1 text-[13px] font-semibold text-ink truncate" title={paper.title ?? paper.orig_filename ?? ''}>
          {paper.title || paper.orig_filename || '无标题'}
        </span>
        <button
          onClick={() => setEditStarred((v) => !v)}
          className={'text-[16px] transition-colors ' + (editStarred ? 'text-yellow-400' : 'text-ink-dim hover:text-yellow-400')}
          title={editStarred ? '取消星标' : '星标'}
        >&#9733;</button>
        <button
          onClick={onClose}
          className="text-ink-dim hover:text-ink text-[14px] w-6 h-6 flex items-center justify-center rounded hover:bg-surface-2"
        >&#x2715;</button>
      </div>

      <div className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        <div className="space-y-2">
          <div>
            <p className={labelCls}>标题</p>
            <input className={inputCls} value={editTitle} onChange={(e) => setEditTitle(e.target.value)} placeholder="论文标题" />
          </div>
          <div>
            <p className={labelCls}>作者</p>
            <input className={inputCls} value={editAuthors} onChange={(e) => setEditAuthors(e.target.value)} placeholder="作者（逗号分隔）" />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <p className={labelCls}>年份</p>
              <input className={inputCls} value={editYear} onChange={(e) => setEditYear(e.target.value)} placeholder="2024" type="number" />
            </div>
            <div className="flex-1">
              <p className={labelCls}>来源/期刊</p>
              <input className={inputCls} value={editVenue} onChange={(e) => setEditVenue(e.target.value)} placeholder="NeurIPS / arXiv..." />
            </div>
          </div>
          <div>
            <p className={labelCls}>DOI</p>
            <input className={inputCls} value={editDoi} onChange={(e) => setEditDoi(e.target.value)} placeholder="10.xxxx/..." />
          </div>
          <div>
            <p className={labelCls}>笔记</p>
            <textarea
              className={inputCls + ' resize-none'}
              rows={3}
              value={editNotes}
              onChange={(e) => setEditNotes(e.target.value)}
              placeholder="个人笔记..."
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => void doSave()}
            disabled={saving}
            className="px-3 py-1 text-[12px] bg-primary text-white rounded-md hover:opacity-90 disabled:opacity-50 transition-opacity"
          >
            {saving ? '保存中...' : '保存元数据'}
          </button>
          {saveMsg && <span className={'text-[11px] ' + (saveMsg.startsWith('保存失败') ? 'text-failed' : 'text-done')}>{saveMsg}</span>}
        </div>

        <div>
          <p className={labelCls}>所属分类</p>
          <select
            className={inputCls}
            value={paper.category_id ?? '__none__'}
            onChange={(e) => void doSetCategory(e.target.value)}
          >
            <option value="__none__">-- 无分类 --</option>
            {categories.map((c) => (
              <option key={c.id} value={c.id}>{c.name}</option>
            ))}
          </select>
        </div>

        <div>
          <p className={labelCls}>标签</p>
          <div className="flex flex-wrap gap-1 mb-1">
            {paper.tags.map((t) => (
              <span
                key={t.id}
                className="flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] bg-primary-tint text-primary"
              >
                {t.name}
                <button
                  onClick={() => void doRemoveTag(t.id)}
                  className="hover:text-failed text-[10px] leading-none"
                >&#x2715;</button>
              </span>
            ))}
            {paper.tags.length === 0 && <span className="text-[11px] text-ink-dim">暂无标签</span>}
          </div>
          <div className="flex gap-1">
            <input
              className={inputCls + ' flex-1'}
              value={newTag}
              onChange={(e) => setNewTag(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void doAddTag() }}
              placeholder="输入标签名回车添加"
            />
            <button
              onClick={() => void doAddTag()}
              className="px-2 py-1 text-[11px] border border-line rounded-md text-ink-dim hover:text-ink hover:bg-surface-2 transition-colors"
            >添加</button>
          </div>
        </div>

        {/* ── 文件管理 ─────────────────────────────────────────────── */}
        <div className="border-t border-line/60 pt-3 space-y-3">
          <p className={sectionLabelCls}>文件管理</p>

          {/* 重命名 */}
          <div>
            <p className={labelCls}>重命名文件</p>
            <p className="text-[11px] text-ink-muted mb-1 break-all">
              当前: {paper.orig_filename ?? paper.file_path?.split(/[/\\]/).pop() ?? '-'}
            </p>
            <div className="flex gap-1">
              <input
                className={inputCls + ' flex-1'}
                value={renameInput}
                onChange={(e) => setRenameInput(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void doRename() }}
                placeholder="新文件名（无需含扩展名）"
              />
              <button
                onClick={() => void doRename()}
                disabled={renaming || !renameInput.trim()}
                className="px-2 py-1 text-[11px] bg-primary text-white rounded-md hover:opacity-90 disabled:opacity-50 transition-opacity whitespace-nowrap"
              >
                {renaming ? '...' : '确定'}
              </button>
            </div>
            {renameMsg && (
              <p className={'text-[11px] mt-1 ' + (renameMsg.startsWith('重命名失败') ? 'text-failed' : 'text-done')}>
                {renameMsg}
              </p>
            )}
            <div className="mt-1.5">
              <button
                onClick={() => void doUndo()}
                disabled={undoing}
                className="text-[11px] text-ink-dim hover:text-ink disabled:opacity-50 underline underline-offset-2"
              >
                {undoing ? '撤销中...' : '撤销上次重命名'}
              </button>
              {undoMsg && (
                <p className={'text-[11px] mt-0.5 ' + (undoMsg.startsWith('撤销失败') ? 'text-failed' : 'text-done')}>
                  {undoMsg}
                </p>
              )}
            </div>
          </div>

          {/* 移动 */}
          <div>
            <p className={labelCls}>移动文件</p>
            {paper.managed === 0 && (
              <p className="text-[11px] text-amber-400 mb-1">
                就地索引模式：移动将物理移动原始文件。
              </p>
            )}
            <button
              onClick={() => void doMove()}
              disabled={moving || !paper.file_path}
              className="px-3 py-1 text-[12px] border border-line rounded-md text-ink-dim hover:text-ink hover:bg-surface-2 disabled:opacity-50 transition-colors"
            >
              {moving ? '选择目录中...' : '移动到...'}
            </button>
            {moveMsg && (
              <p className={'text-[11px] mt-1 ' + (moveMsg.startsWith('移动失败') ? 'text-failed' : 'text-done')}>
                {moveMsg}
              </p>
            )}
          </div>
        </div>
        {/* ── 文件管理 end ─────────────────────────────────────────── */}

        <div className="text-[11px] text-ink-dim space-y-0.5">
          <p>文件: <span className="text-ink-muted break-all">{paper.orig_filename ?? '-'}</span></p>
          <p>大小: {fmtSize(paper.file_size)}</p>
          <p>入库: {fmtDate(paper.added_at)}</p>
          <p>类型: {paper.managed === 1 ? '托管（已复制入库）' : '就地索引（原文件不会被删除）'}</p>
        </div>

        {paper.file_path && (
          <div>
            <button
              onClick={() => setShowPdf((v) => !v)}
              className="text-[12px] text-primary hover:underline"
            >
              {showPdf
                ? '收起' + (isMdEntry ? '条目' : ' PDF ') + '预览'
                : '展开' + (isMdEntry ? '条目' : ' PDF ') + '预览（看原文）'}
            </button>
            {showPdf && (
              <div className="mt-2 rounded-md overflow-hidden border border-line" style={{ height: '400px' }}>
                {isMdEntry ? (
                  <KbTextPreview paperId={paper.id} />
                ) : (
                  <KbPdfPreview paperId={paper.id} />
                )}
              </div>
            )}
          </div>
        )}

        <div className="pt-2 border-t border-line/60">
          {!deleteConfirm ? (
            <button onClick={() => setDeleteConfirm(true)} className="text-[12px] text-failed hover:underline">
              删除论文...
            </button>
          ) : (
            <div className="bg-surface border border-failed/30 rounded-md p-3 space-y-2">
              <p className="text-[12px] text-ink">
                {paper.managed === 1
                  ? '将同时删除数据库记录和磁盘文件。此操作不可撤销。'
                  : '仅删除索引记录，原始文件不会被删除（就地索引模式）。'}
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() => void doDelete()}
                  disabled={deleting}
                  className="px-3 py-1 text-[12px] bg-failed text-white rounded-md hover:opacity-90 disabled:opacity-50"
                >
                  {deleting ? '删除中...' : '确认删除'}
                </button>
                <button
                  onClick={() => setDeleteConfirm(false)}
                  className="px-3 py-1 text-[12px] border border-line rounded-md text-ink-dim hover:text-ink hover:bg-surface-2"
                >
                  取消
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
// -- Sort helpers -------------------------------------------------------------

type SortKey = 'title' | 'authors' | 'year' | 'venue' | 'file_size' | 'added_at'
type SortDir = 'asc' | 'desc'

function sortPapers(papers: PaperSummary[], key: SortKey, dir: SortDir): PaperSummary[] {
  const factor = dir === 'asc' ? 1 : -1
  return [...papers].sort((a, b) => {
    const av = a[key]
    const bv = b[key]
    if (av == null && bv == null) return 0
    if (av == null) return 1
    if (bv == null) return -1
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * factor
    return String(av).localeCompare(String(bv)) * factor
  })
}

// -- Paper table row ----------------------------------------------------------

function PaperRow({
  paper,
  active,
  categories,
  onClick,
}: {
  paper: PaperSummary
  active: boolean
  categories: Category[]
  onClick: () => void
}) {
  const catName = categories.find((c) => c.id === paper.category_id)?.name

  return (
    <tr
      className={
        'border-b border-line/40 cursor-pointer transition-colors ' +
        (active ? 'bg-primary-tint/40' : 'hover:bg-surface-2/60')
      }
      onClick={onClick}
    >
      <td className="px-3 py-2 max-w-0">
        <div className="flex items-center gap-1 min-w-0">
          {paper.starred === 1 && <span className="text-yellow-400 flex-shrink-0 text-[12px]">&#9733;</span>}
          <span className="truncate text-ink font-medium" title={paper.title ?? paper.orig_filename ?? ''}>
            {paper.title || paper.orig_filename || '无标题'}
          </span>
          {catName && (
            <span className="flex-shrink-0 ml-1 px-1.5 py-0.5 text-[10px] rounded bg-surface-2 text-ink-dim">
              {catName}
            </span>
          )}
        </div>
      </td>
      <td className="px-3 py-2 text-ink-muted truncate max-w-0">
        <span className="truncate block">{paper.authors ?? '-'}</span>
      </td>
      <td className="px-3 py-2 text-ink-dim">{paper.year ?? '-'}</td>
      <td className="px-3 py-2 text-ink-dim truncate max-w-0">
        <span className="truncate block">{paper.venue ?? '-'}</span>
      </td>
      <td className="px-3 py-2 text-ink-dim whitespace-nowrap">{fmtSize(paper.file_size)}</td>
      <td className="px-3 py-2 text-ink-dim whitespace-nowrap">{fmtDate(paper.added_at)}</td>
    </tr>
  )
}
// -- Main component -----------------------------------------------------------

export default function LibraryTab() {
  const store = useKbStore()
  const [localQuery, setLocalQuery] = useState('')
  const [sortKey, setSortKey] = useState<SortKey>('added_at')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [addCatName, setAddCatName] = useState('')
  const [addCatParent, setAddCatParent] = useState<string | null>(null)
  const [showAddCat, setShowAddCat] = useState(false)
  const [renameCat, setRenameCat] = useState<{ id: string; name: string } | null>(null)
  const [importing, setImporting] = useState(false)
  const [uploading, setUploading] = useState(false)
  const [showNormalize, setShowNormalize] = useState(false)

  const tree = buildTree(store.categories)
  const rootCats = tree.get(null) ?? []

  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  // -- Init: register kb-event listener + watchStart -------------------------
  useEffect(() => {
    void store.init()
    void store.watchStart()
    return () => {
      void store.watchStop()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleQueryChange = (q: string) => {
    setLocalQuery(q)
    if (searchTimer.current) clearTimeout(searchTimer.current)
    searchTimer.current = setTimeout(() => {
      store.setQuery(q)
      void store.loadPapers({ query: q || null, categoryId: store.activeCategoryId, tagId: store.activeTagId })
    }, 300)
  }

  const handleCategorySelect = (id: string | null) => {
    store.setActiveCategoryId(id)
    void store.loadPapers({ categoryId: id, tagId: store.activeTagId, query: store.query || null })
  }

  const handleTagFilter = (id: string | null) => {
    store.setActiveTagId(id)
    void store.loadPapers({ tagId: id, categoryId: store.activeCategoryId, query: store.query || null })
  }

  const doImportDir = async () => {
    if (!isTauri) return
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const dir = await open({ directory: true, multiple: false, title: '选择论文目录（将递归扫描所有 PDF）' })
      if (!dir || typeof dir !== 'string') return
      setImporting(true)
      const result = await store.importDir(dir, true)
      await store.loadPapers()
      useKbStore.setState({ notice: '扫描完成：发现 ' + result.found + ' 个 PDF，新增 ' + result.added + ' 篇' })
    } catch (e) {
      useKbStore.setState({ error: '导入失败：' + String(e) })
    } finally {
      setImporting(false)
    }
  }

  const doUpload = async () => {
    if (!isTauri) return
    try {
      const { open } = await import('@tauri-apps/plugin-dialog')
      const file = await open({
        multiple: false,
        filters: [{ name: 'PDF', extensions: ['pdf'] }],
        title: '选择 PDF 文件',
      })
      if (!file || typeof file !== 'string') return
      setUploading(true)
      await store.uploadPaper(file, 'index', store.activeCategoryId ?? null)
      await store.loadPapers()
      useKbStore.setState({ notice: '上传成功' })
    } catch (e) {
      useKbStore.setState({ error: '上传失败：' + String(e) })
    } finally {
      setUploading(false)
    }
  }

  const doAddCategory = async () => {
    const name = addCatName.trim()
    if (!name) return
    try {
      await store.addCategory(name, addCatParent)
      setAddCatName('')
      setAddCatParent(null)
      setShowAddCat(false)
    } catch (e) {
      useKbStore.setState({ error: '创建分类失败：' + String(e) })
    }
  }

  const doRenameCategory = async () => {
    if (!renameCat) return
    const name = renameCat.name.trim()
    if (!name) return
    try {
      await store.updateCategory(renameCat.id, { name })
      setRenameCat(null)
    } catch (e) {
      useKbStore.setState({ error: '重命名失败：' + String(e) })
    }
  }

  const doDeleteCategory = useCallback(async (cat: Category) => {
    if (!window.confirm('删除分类「' + cat.name + '」？该分类下的论文将变为无分类。')) return
    try {
      await store.deleteCategory(cat.id)
    } catch (e) {
      useKbStore.setState({ error: '删除分类失败：' + String(e) })
    }
  }, [store])

  const handleSort = (key: SortKey) => {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir('asc')
    }
  }

  const sortedPapers = sortPapers(store.papers, sortKey, sortDir)

  const ThBtn = ({ col, label }: { col: SortKey; label: string }) => (
    <button
      className="flex items-center gap-0.5 text-left hover:text-ink transition-colors"
      onClick={() => handleSort(col)}
    >
      {label}
      {sortKey === col && <span className="text-[10px]">{sortDir === 'asc' ? '▲' : '▼'}</span>}
    </button>
  )

  const btnCls = 'px-3 py-1.5 text-[12px] rounded-md border border-line text-ink-dim hover:text-ink hover:bg-surface-2 transition-colors flex items-center gap-1 disabled:opacity-50'
  const btnPrimary = 'px-3 py-1.5 text-[12px] rounded-md bg-primary text-white hover:opacity-90 transition-opacity flex items-center gap-1 disabled:opacity-50'

  const hasData = store.papers.length > 0 || store.categories.length > 0

  return (
    <div className="flex-1 flex flex-col min-h-0">
      {store.error && (
        <div className="px-4 py-2 text-[12px] text-failed border-b border-line/60 flex items-center gap-2">
          <span className="flex-1">{store.error}</span>
          <button className="text-ink-dim hover:text-ink" onClick={store.clearNotice}>&#x2715;</button>
        </div>
      )}
      {store.notice && !store.error && (
        <div className="px-4 py-2 text-[12px] text-done border-b border-line/60 flex items-center gap-2">
          <span className="flex-1">{store.notice}</span>
          <button className="text-ink-dim hover:text-ink" onClick={store.clearNotice}>&#x2715;</button>
        </div>
      )}

      <div className="px-4 py-2 border-b border-line flex-shrink-0 flex items-center gap-2 flex-wrap">
        <button className={btnPrimary} onClick={() => void doImportDir()} disabled={!isTauri || importing}>
          {importing ? '导入中...' : '导入目录'}
        </button>
        <button className={btnCls} onClick={() => void doUpload()} disabled={!isTauri || uploading}>
          {uploading ? '上传中...' : '上传论文'}
        </button>
        <button
          className={btnCls}
          onClick={() => setShowNormalize(true)}
          disabled={!isTauri || store.papers.length === 0}
          title="按模板批量规范化当前列表的文件名"
        >
          规范化命名
        </button>
        <div className="flex-1 min-w-[160px] max-w-xs">
          <input
            value={localQuery}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder="搜索标题 / 作者 / 笔记..."
            className="w-full bg-surface border border-line rounded-md px-3 py-1 text-[12px] text-ink placeholder-ink-dim focus:outline-none focus:border-primary transition-colors"
          />
        </div>
        <span className="ml-auto text-[12px] text-ink-dim whitespace-nowrap">
          {store.papersLoading ? '加载中...' : '共 ' + store.papers.length + ' 篇'}
        </span>
      </div>

      <div className="flex-1 flex min-h-0 overflow-hidden">
        <div className="w-48 flex-shrink-0 border-r border-line flex flex-col overflow-hidden bg-surface/20">
          <div className="flex-1 overflow-y-auto py-2">
            <button
              className={
                'w-full text-left px-3 py-1 text-[12px] rounded-md transition-colors ' +
                (store.activeCategoryId == null && store.activeTagId == null
                  ? 'bg-primary-tint text-primary font-semibold'
                  : 'text-ink-dim hover:text-ink hover:bg-surface-2')
              }
              onClick={() => { handleCategorySelect(null); handleTagFilter(null) }}
            >
              全部论文
            </button>

            {store.categories.length > 0 && (
              <div className="mt-2 mb-1 px-3 text-[10px] text-ink-dim uppercase tracking-wider">分类</div>
            )}
            {rootCats.map((cat) => (
              <CategoryNode
                key={cat.id}
                cat={cat}
                tree={tree}
                activeCategoryId={store.activeCategoryId}
                onSelect={(id) => handleCategorySelect(id)}
                onAdd={(parentId) => { setAddCatParent(parentId); setShowAddCat(true) }}
                onRename={(c) => setRenameCat({ id: c.id, name: c.name })}
                onDelete={(c) => void doDeleteCategory(c)}
                depth={0}
              />
            ))}

            {store.tags.length > 0 && (
              <>
                <div className="mt-2 mb-1 px-3 text-[10px] text-ink-dim uppercase tracking-wider">标签</div>
                {store.tags.map((tag) => (
                  <button
                    key={tag.id}
                    className={
                      'w-full text-left px-3 py-1 text-[12px] rounded-md transition-colors ' +
                      (store.activeTagId === tag.id
                        ? 'bg-primary-tint text-primary font-semibold'
                        : 'text-ink-dim hover:text-ink hover:bg-surface-2')
                    }
                    onClick={() => handleTagFilter(store.activeTagId === tag.id ? null : tag.id)}
                  >
                    # {tag.name}
                  </button>
                ))}
              </>
            )}
          </div>

          <div className="border-t border-line p-2">
            <button
              className="w-full text-[12px] text-ink-dim hover:text-ink px-2 py-1 rounded-md hover:bg-surface-2 transition-colors text-left"
              onClick={() => { setAddCatParent(null); setShowAddCat(true) }}
            >
              + 新建分类
            </button>
          </div>
        </div>

        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {!hasData && !store.papersLoading ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
              <div className="text-4xl mb-4">📚</div>
              <h3 className="text-[15px] font-semibold text-ink mb-2">知识库为空</h3>
              <p className="text-[13px] text-ink-muted mb-4">
                点击「导入目录」将您现有的论文 PDF 批量入库。<br />
                支持递归扫描，原文件不会被移动或修改。
              </p>
              <button className={btnPrimary} onClick={() => void doImportDir()} disabled={!isTauri || importing}>
                {importing ? '导入中...' : '导入目录'}
              </button>
              <p className="text-[11px] text-ink-dim mt-3">
                已有大量论文？直接选择存放目录，一键全部入库。
              </p>
            </div>
          ) : (
            <div className="flex-1 overflow-auto">
              <table className="w-full border-collapse text-[12px]">
                <thead className="sticky top-0 z-10 bg-surface border-b border-line">
                  <tr className="text-ink-dim text-left">
                    <th className="px-3 py-2 font-medium w-[35%]"><ThBtn col="title" label="标题" /></th>
                    <th className="px-3 py-2 font-medium w-[20%]"><ThBtn col="authors" label="作者" /></th>
                    <th className="px-3 py-2 font-medium w-[6%]"><ThBtn col="year" label="年" /></th>
                    <th className="px-3 py-2 font-medium w-[14%]"><ThBtn col="venue" label="来源" /></th>
                    <th className="px-3 py-2 font-medium w-[8%]"><ThBtn col="file_size" label="大小" /></th>
                    <th className="px-3 py-2 font-medium w-[10%]"><ThBtn col="added_at" label="入库时间" /></th>
                  </tr>
                </thead>
                <tbody>
                  {sortedPapers.length === 0 && !store.papersLoading ? (
                    <tr>
                      <td colSpan={6} className="text-center py-12 text-ink-dim text-[12px]">
                        没有匹配的论文
                      </td>
                    </tr>
                  ) : (
                    sortedPapers.map((paper) => (
                      <PaperRow
                        key={paper.id}
                        paper={paper}
                        active={store.selectedPaperId === paper.id}
                        categories={store.categories}
                        onClick={() => store.selectPaper(paper.id)}
                      />
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {store.selectedPaperId && store.selectedPaper && (
          <DetailDrawer
            paper={store.selectedPaper}
            categories={store.categories}
            tags={store.tags}
            onClose={() => store.selectPaper(null)}
          />
        )}
        {store.selectedPaperId && store.selectedPaperLoading && (
          <div className="border-l border-line flex items-center justify-center" style={{ width: '340px' }}>
            <span className="text-[12px] text-ink-dim">加载中...</span>
          </div>
        )}
      </div>

      {showAddCat && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setShowAddCat(false)}>
          <div className="bg-bg border border-line rounded-xl shadow-2xl p-5 w-80" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[14px] font-semibold text-ink mb-3">
              {addCatParent ? '新建子分类' : '新建分类'}
            </h3>
            <input
              autoFocus
              className="w-full bg-surface border border-line rounded-md px-3 py-2 text-[13px] text-ink placeholder-ink-dim focus:outline-none focus:border-primary mb-3"
              placeholder="分类名称"
              value={addCatName}
              onChange={(e) => setAddCatName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void doAddCategory() }}
            />
            <div className="flex justify-end gap-2">
              <button className="px-3 py-1.5 text-[12px] border border-line rounded-md text-ink-dim hover:text-ink hover:bg-surface-2" onClick={() => setShowAddCat(false)}>取消</button>
              <button className="px-3 py-1.5 text-[12px] bg-primary text-white rounded-md hover:opacity-90" onClick={() => void doAddCategory()}>创建</button>
            </div>
          </div>
        </div>
      )}

      {renameCat && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setRenameCat(null)}>
          <div className="bg-bg border border-line rounded-xl shadow-2xl p-5 w-80" onClick={(e) => e.stopPropagation()}>
            <h3 className="text-[14px] font-semibold text-ink mb-3">重命名分类</h3>
            <input
              autoFocus
              className="w-full bg-surface border border-line rounded-md px-3 py-2 text-[13px] text-ink placeholder-ink-dim focus:outline-none focus:border-primary mb-3"
              value={renameCat.name}
              onChange={(e) => setRenameCat({ ...renameCat, name: e.target.value })}
              onKeyDown={(e) => { if (e.key === 'Enter') void doRenameCategory() }}
            />
            <div className="flex justify-end gap-2">
              <button className="px-3 py-1.5 text-[12px] border border-line rounded-md text-ink-dim hover:text-ink hover:bg-surface-2" onClick={() => setRenameCat(null)}>取消</button>
              <button className="px-3 py-1.5 text-[12px] bg-primary text-white rounded-md hover:opacity-90" onClick={() => void doRenameCategory()}>确认</button>
            </div>
          </div>
        </div>
      )}

      {showNormalize && (
        <NormalizeDialog
          papers={store.papers}
          onClose={() => setShowNormalize(false)}
        />
      )}
    </div>
  )
}
