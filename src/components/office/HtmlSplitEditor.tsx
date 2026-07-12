// PPT 结果双栏编辑器（①）：左 = Monaco HTML 源码，右 = iframe 实时预览。
// - 左改 → 防抖 600ms 提交 onCommit → 右侧 srcDoc 刷新；
// - 右侧开启 designMode（文字点击直改），「保存修改」把 iframe 当前 DOM
//   序列化写回源码（onCommit）——可视化修改必须显式保存，避免与左栏互踩；
// - value 外部变化（模型改稿 / 保存可视化修改）时左栏与预览同步刷新。
// 本组件应经 React.lazy 挂载（monaco 独立 chunk）。
import { useEffect, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import { MONACO_THEME } from '../../lib/monacoSetup'
import Button from '../ui/Button'

export default function HtmlSplitEditor({
  value,
  onCommit,
}: {
  /** 当前 HTML（store 单一数据源）。 */
  value: string
  /** 源码/可视化编辑提交（写回 store）。 */
  onCommit: (html: string) => void
}) {
  const [code, setCode] = useState(value)
  /** 预览是否有未保存的可视化修改。 */
  const [visualDirty, setVisualDirty] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // 外部 value 变化（模型改稿 / 可视化保存）→ 同步左栏。
  useEffect(() => {
    setCode(value)
  }, [value])

  useEffect(
    () => () => {
      if (debounceRef.current != null) clearTimeout(debounceRef.current)
    },
    [],
  )

  const handleEditorChange = (v: string | undefined) => {
    const next = v ?? ''
    setCode(next)
    if (debounceRef.current != null) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null
      onCommit(next)
    }, 600)
  }

  /** iframe 加载完成 → 开启可视化编辑并监听改动。 */
  const handleFrameLoad = () => {
    const doc = iframeRef.current?.contentDocument
    if (!doc) return
    try {
      doc.designMode = 'on'
      doc.addEventListener('input', () => setVisualDirty(true))
      setVisualDirty(false)
    } catch (e) {
      console.warn('[HtmlSplitEditor] enable designMode failed:', e)
    }
  }

  /** 把预览当前 DOM 序列化写回源码与 store。 */
  const saveVisualEdit = () => {
    const doc = iframeRef.current?.contentDocument
    if (!doc?.documentElement) return
    const html = '<!DOCTYPE html>\n' + doc.documentElement.outerHTML
    setVisualDirty(false)
    setCode(html)
    onCommit(html)
  }

  /** 放弃预览里的未保存修改：用当前源码重写 iframe 文档（触发 onLoad 重挂编辑）。 */
  const discardVisualEdit = () => {
    const doc = iframeRef.current?.contentDocument
    if (!doc) return
    setVisualDirty(false)
    doc.open()
    doc.write(value)
    doc.close()
  }

  return (
    <div className="overflow-hidden rounded-card border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-1.5">
        <span className="text-[11px] text-ink-dim">
          左：HTML 源码（可改，自动同步预览）· 右：预览已开启可视化编辑，点击文字即可直接修改
        </span>
        <div className="flex items-center gap-2">
          {visualDirty && (
            <span className="text-[11px] text-gold">预览有未保存的修改</span>
          )}
          <Button
            size="sm"
            variant="soft"
            disabled={!visualDirty}
            onClick={saveVisualEdit}
            title="把右侧预览中的直接修改序列化写回源码与草稿"
          >
            保存修改 → 源码
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!visualDirty}
            onClick={discardVisualEdit}
          >
            放弃预览修改
          </Button>
        </div>
      </div>
      <div className="grid h-[560px] grid-cols-2">
        <div className="min-w-0 border-r border-line">
          <Editor
            language="html"
            theme={MONACO_THEME}
            value={code}
            onChange={handleEditorChange}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              wordWrap: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
            }}
          />
        </div>
        <iframe
          ref={iframeRef}
          title="ppt-live-preview"
          srcDoc={value}
          sandbox="allow-same-origin"
          onLoad={handleFrameLoad}
          className="h-full w-full bg-white"
        />
      </div>
    </div>
  )
}
