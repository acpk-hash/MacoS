// 工作区规则（P8，TRAP 式轻量版）— 编辑当前工作根的 AGENTS.md。
// codex 原生把 AGENTS.md 当项目级指令每轮自动读取：把「希望 AI 始终遵守
// 的硬规则」沉淀在这里，agent 越用越懂你。读写走 ws_read_file/ws_write_file
//（本地工作根；UTF-8 无 BOM）。
import { useEffect, useState } from 'react'
import { useWorkspaceStore } from '../../stores/workspaceStore'

const isTauri =
  typeof window !== 'undefined' &&
  !!(window as unknown as Record<string, unknown>).__TAURI_INTERNALS__

const RULES_FILE = 'AGENTS.md'

const TEMPLATE = `# 工作区规则（AGENTS.md）

在这里写下希望 AI 始终遵守的硬规则，codex 每一轮都会自动读取本文件。

## 代码风格
- （示例）TypeScript 严格模式，缩进 2 空格，禁用 any

## 禁改的文件 / 目录
- （示例）不要修改 legacy/ 与 *.generated.ts

## 测试与验证命令
- （示例）改动后运行 npm test；前端类型检查 npx tsc --noEmit

## 其它约定
- （示例）提交信息用中文，遵循 feat/fix/chore 前缀
`

export default function RulesPane() {
  const root = useWorkspaceStore((s) => s.root)
  const remote = useWorkspaceStore((s) => s.remote)

  const [text, setText] = useState('')
  const [saved, setSaved] = useState('')
  const [exists, setExists] = useState(false)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  // 打开/切换工作根时加载 AGENTS.md（不存在 → 空内容 + 模板提示）。
  useEffect(() => {
    if (!isTauri || !root || remote) return
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const res = await invoke<{ content: string; too_large: boolean }>('ws_read_file', {
          relPath: RULES_FILE,
        })
        if (cancelled) return
        const content = res.too_large ? '' : res.content
        setText(content)
        setSaved(content)
        setExists(true)
      } catch {
        // 文件还不存在：正常情况，保持空白等待用户首次沉淀。
        if (cancelled) return
        setText('')
        setSaved('')
        setExists(false)
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [root, remote])

  const dirty = text !== saved

  const save = async () => {
    if (!isTauri || !root || saving) return
    setSaving(true)
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      await invoke('ws_write_file', { relPath: RULES_FILE, content: text })
      setSaved(text)
      setExists(true)
      useWorkspaceStore.setState({ notice: `已保存 ${RULES_FILE}` })
    } catch (e) {
      useWorkspaceStore.setState({ error: `保存规则失败：${String(e)}` })
    } finally {
      setSaving(false)
    }
  }

  if (remote) {
    return (
      <p className="text-[12px] text-ink-dim text-center mt-6">
        远程模式下暂不支持编辑工作区规则（规则文件位于本地工作根）。
      </p>
    )
  }

  return (
    <div className="flex flex-col h-full min-h-0 gap-1.5">
      <div className="flex items-center gap-2 flex-shrink-0">
        <span className="text-[11px] text-ink-dim font-mono truncate" title={`${root ?? ''}/${RULES_FILE}`}>
          {RULES_FILE}
        </span>
        <span className="text-[11px] text-ink-faint">
          codex 每轮自动读取 · 把踩过的坑、代码风格、禁改文件沉淀成硬规则
        </span>
        <div className="flex-1" />
        {!exists && !text && !loading && (
          <button
            onClick={() => setText(TEMPLATE)}
            className="text-[11px] text-ink-muted hover:text-ink border border-line rounded-btn px-2 py-1 transition-colors"
          >
            插入模板
          </button>
        )}
        <button
          onClick={() => void save()}
          disabled={!dirty || saving || loading}
          className="text-[11px] text-white bg-grad-primary rounded-btn px-2.5 py-1 transition-all disabled:opacity-35"
        >
          {saving ? '保存中…' : dirty ? '保存' : '已保存'}
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if ((e.ctrlKey || e.metaKey) && e.key === 's') {
            e.preventDefault()
            void save()
          }
        }}
        spellCheck={false}
        placeholder={
          loading
            ? '加载中…'
            : '在这里写下希望 AI 始终遵守的规则，如代码风格、禁改的文件、测试命令…（点右上「插入模板」快速开始）'
        }
        className="flex-1 min-h-0 w-full resize-none bg-editor border border-line rounded-card px-3 py-2 font-mono text-[12px] leading-relaxed text-ink placeholder:text-ink-faint focus:outline-none focus:border-line-strong"
      />
    </div>
  )
}
