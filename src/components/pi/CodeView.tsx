// 只读代码/文本查看器（①）。Monaco readOnly + monacoSetup 本地主题/语法高亮。
// 经 React.lazy 挂载（monaco 独立 chunk，不进主 bundle）；支持 :line 定位。
// 数据源跟随 workspaceStore：本地 ws_read_file / 远程 ssh_read_file。
import { useEffect, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { MONACO_THEME, languageForFile } from '../../lib/monacoSetup'
import { useWorkspaceStore } from '../../stores/workspaceStore'

interface WsFileContent {
  content: string
  encoding: string
  too_large: boolean
}

type ViewState =
  | { kind: 'loading' }
  | { kind: 'text'; content: string }
  | { kind: 'placeholder'; text: string }

export default function CodeView({
  relPath,
  name,
  line,
}: {
  relPath: string
  name: string
  line?: number
}) {
  const remote = useWorkspaceStore((s) => s.remote)
  const [state, setState] = useState<ViewState>({ kind: 'loading' })

  useEffect(() => {
    let alive = true
    setState({ kind: 'loading' })
    ;(async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const res = remote
          ? await invoke<WsFileContent>('ssh_read_file', {
              connId: remote.connId,
              relPath,
            })
          : await invoke<WsFileContent>('ws_read_file', { relPath })
        if (!alive) return
        if (res.too_large) {
          setState({ kind: 'placeholder', text: '文件超过预览上限（1 MB），已跳过' })
        } else if (res.encoding === 'binary') {
          setState({ kind: 'placeholder', text: '二进制文件，无法文本预览' })
        } else {
          setState({ kind: 'text', content: res.content })
        }
      } catch (e) {
        if (alive) setState({ kind: 'placeholder', text: `读取失败：${String(e)}` })
      }
    })()
    return () => {
      alive = false
    }
  }, [relPath, remote])

  const onMount: OnMount = (editor) => {
    if (line && line > 0) {
      editor.revealLineInCenter(line)
      editor.setPosition({ lineNumber: line, column: 1 })
    }
  }

  if (state.kind === 'loading') {
    return (
      <div className="w-full h-full flex items-center justify-center text-[12px] text-ink-dim">
        加载中…
      </div>
    )
  }
  if (state.kind === 'placeholder') {
    return (
      <div className="w-full h-full flex items-center justify-center px-4 text-center text-[12px] text-ink-dim">
        {state.text}
      </div>
    )
  }
  return (
    <Editor
      height="100%"
      language={languageForFile(name)}
      value={state.content}
      theme={MONACO_THEME}
      onMount={onMount}
      options={{
        readOnly: true,
        domReadOnly: true,
        minimap: { enabled: false },
        fontSize: 12,
        lineNumbers: 'on',
        scrollBeyondLastLine: false,
        renderLineHighlight: line ? 'line' : 'none',
        overviewRulerLanes: 0,
        folding: false,
        contextmenu: false,
        wordWrap: 'off',
        automaticLayout: true,
      }}
    />
  )
}
