// /pi 中栏底部 Composer：多行输入（Enter 发送 / Shift+Enter 换行）、
// 运行中显示「排队 N 条」徽章与「停止」按钮。
// ③ 附件：📎 选择（plugin-dialog 多选）+ 拖拽（尽力解析路径）→ chips 可删；
// 发送时按 pi-app 原生约定把每个附件注入为 @<绝对路径> token（pi RPC 的
// prompt/steer/follow_up 只有 message 文本字段，pi-app 自身即以 @path 传附件，
// 图片同样走 @path，由 pi 端负责加载）。
import { useEffect, useMemo, useRef, useState } from 'react'
import { usePiStore } from '../../stores/piStore'
import { useHooksStore } from '../../stores/hooksStore'
import { useMcpStore } from '../../stores/mcpStore'
import { useAgentHubStore } from '../../stores/agentHubStore'

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

// ── / 命令面板 & 技能唤起 & 粘贴图片辅助 ────────────────────────────────────────

/** 内置快捷命令（22 条）——选中后 insertText 替换 `/xxx` 保留光标可续输。 */
export interface BuiltinCommand {
  name: string
  description: string
  /** 选中后替换到输入框的文本。 */
  insertText: string
}

export const BUILTIN_COMMANDS: BuiltinCommand[] = [
  { name: 'resume',    description: '恢复上次中断的任务',     insertText: '请恢复并继续上次中断的任务。' },
  { name: 'review',    description: '代码审查',               insertText: '请对当前变更做一次代码审查，重点关注正确性、安全和可维护性。' },
  { name: 'goal',      description: '设定项目目标',           insertText: '请为当前项目设定目标：' },
  { name: 'fix',       description: '修复 bug',               insertText: '请修复以下 bug：' },
  { name: 'test',      description: '补充测试',               insertText: '请为以下功能补充单元测试：' },
  { name: 'refactor',  description: '重构代码',               insertText: '请重构以下代码，提高可读性和可维护性：' },
  { name: 'explain',   description: '解释代码',               insertText: '请解释以下代码的作用和实现思路：' },
  { name: 'commit',    description: '生成 commit 消息',       insertText: '请根据当前变更生成一条简洁准确的 commit 消息。' },
  { name: 'pr',        description: '生成 PR 描述',           insertText: '请根据当前分支的变更生成 PR 标题和描述。' },
  { name: 'doc',       description: '生成文档',               insertText: '请为以下代码生成文档注释：' },
  { name: 'optimize',  description: '性能优化',               insertText: '请分析并优化以下代码的性能：' },
  { name: 'security',  description: '安全审查',               insertText: '请对以下代码做安全审查，检查常见漏洞：' },
  { name: 'debug',     description: '调试问题',               insertText: '请帮我调试以下问题：' },
  { name: 'migrate',   description: '代码迁移',               insertText: '请帮我将以下代码迁移到：' },
  { name: 'deploy',    description: '部署指引',               insertText: '请生成当前项目的部署步骤和注意事项。' },
  { name: 'lint',      description: '代码规范检查',           insertText: '请检查以下代码的代码规范问题并给出修复建议：' },
  { name: 'translate', description: '翻译代码注释',           insertText: '请将以下代码中的注释翻译为：' },
  { name: 'diagram',   description: '生成架构图描述',         insertText: '请为当前项目生成架构图的 Mermaid 描述。' },
  { name: 'api',       description: '设计 API',               insertText: '请为以下功能设计 RESTful API：' },
  { name: 'config',    description: '配置文件生成',           insertText: '请生成以下服务的配置文件：' },
  { name: 'clean',     description: '清理代码',               insertText: '请清理以下代码：移除死代码、统一风格、简化逻辑。' },
  { name: 'deps',      description: '依赖分析',               insertText: '请分析当前项目的依赖关系，标出过时或有安全问题的依赖。' },
]

/** 统一命令面板条目：内置命令 / 已安装 skill / 已安装 hook。 */
interface PanelItem {
  kind: 'command' | 'skill' | 'hook' | 'mcp' | 'agent'
  name: string
  description: string
  /** 内置命令选中后插入的文本；skill 则构造 `/skill:<name> `；hook 则构造 `/hook:<id> `。 */
  insertText: string
}

/** 粘贴图片的 mime → 落盘扩展名。 */
function extForMime(mime: string): string {
  const m = mime.toLowerCase()
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg'
  if (m.includes('gif')) return 'gif'
  if (m.includes('webp')) return 'webp'
  if (m.includes('bmp')) return 'bmp'
  if (m.includes('svg')) return 'svg'
  return 'png'
}

/** Blob → base64 data URL（后端容忍前缀，整串直传）。 */
function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result ?? ''))
    r.onerror = () => reject(r.error ?? new Error('读取剪贴板图片失败'))
    r.readAsDataURL(blob)
  })
}

/** 光标前的 / 唤起 token：行首或空白后的 `/xxx` → { start, filter }。 */
function slashTokenBeforeCaret(
  text: string,
  caret: number,
): { start: number; filter: string } | null {
  const before = text.slice(0, caret)
  const m = /(^|\s)\/([A-Za-z0-9:_-]*)$/.exec(before)
  if (!m) return null
  return { start: caret - m[2].length - 1, filter: m[2] }
}

/** 简易模糊匹配：filter 的每个字符按顺序出现在 target 中。 */
function fuzzyMatch(target: string, filter: string): boolean {
  if (!filter) return true
  let fi = 0
  for (let ti = 0; ti < target.length && fi < filter.length; ti++) {
    if (target[ti] === filter[fi]) fi++
  }
  return fi === filter.length
}

export default function PiComposer() {
  const [draft, setDraft] = useState('')
  const [attachments, setAttachments] = useState<string[]>([])
  const [dragOver, setDragOver] = useState(false)
  const [hint, setHint] = useState<string | null>(null)
  const taRef = useRef<HTMLTextAreaElement>(null)
  // / 命令面板：token（start=斜杠位置）+ 高亮索引。
  const [slash, setSlash] = useState<{ start: number; filter: string } | null>(null)
  const [slashIdx, setSlashIdx] = useState(0)

  const activeSessionId = usePiStore((s) => s.activeSessionId)
  const status = usePiStore(
    (s) => s.sessions.find((x) => x.id === s.activeSessionId)?.status ?? null,
  )
  const queue = usePiStore((s) =>
    s.activeSessionId ? s.composerQueue[s.activeSessionId] ?? EMPTY_QUEUE : EMPTY_QUEUE,
  )
  const send = usePiStore((s) => s.send)
  const abort = usePiStore((s) => s.abort)
  const installedSkills = usePiStore((s) => s.installedSkills)
  const loadInstalledSkills = usePiStore((s) => s.loadInstalledSkills)
  const installedHookIds = useHooksStore((s) => s.installedHookIds)
  const hooksGetActive = useHooksStore((s) => s.getActive)
  const mcpInstalled = useMcpStore((s) => s.installed)
  const mcpLoadInstalled = useMcpStore((s) => s.loadInstalled)
  const agentRecords = useAgentHubStore((s) => s.records)

  // 统一命令面板数据源：顶部=内置快捷命令，中间=已安装 skills，底部=已安装 hooks。
  const panelItems = useMemo<{ commands: PanelItem[]; skills: PanelItem[]; hooks: PanelItem[]; mcps: PanelItem[]; agents: PanelItem[] }>(() => {
    if (!slash) return { commands: [], skills: [], hooks: [], mcps: [], agents: [] }
    const f = slash.filter.toLowerCase()
    const isSkillOnly = f.startsWith('skill:')
    const isHookOnly = f.startsWith('hook:')
    const skillFilter = isSkillOnly ? f.replace(/^skill:/, '') : f
    const hookFilter = isHookOnly ? f.replace(/^hook:/, '') : f

    const commands: PanelItem[] = (isSkillOnly || isHookOnly)
      ? []
      : BUILTIN_COMMANDS.filter(
          (c) =>
            fuzzyMatch(c.name.toLowerCase(), f) ||
            fuzzyMatch(c.description.toLowerCase(), f),
        ).map((c) => ({
          kind: 'command' as const,
          name: c.name,
          description: c.description,
          insertText: c.insertText,
        }))

    const skills: PanelItem[] = isHookOnly
      ? []
      : installedSkills
          .filter(
            (sk) =>
              !skillFilter ||
              sk.name.includes(skillFilter) ||
              sk.description.toLowerCase().includes(skillFilter),
          )
          .slice(0, 8)
          .map((sk) => ({
            kind: 'skill' as const,
            name: sk.name,
            description: sk.description,
            insertText: '/skill:' + sk.name + ' ',
          }))

    const activeHooks = hooksGetActive()
    const hooks: PanelItem[] = isSkillOnly
      ? []
      : activeHooks
          .filter(
            (h) =>
              !hookFilter ||
              h.id.includes(hookFilter) ||
              h.name.toLowerCase().includes(hookFilter) ||
              h.description.toLowerCase().includes(hookFilter),
          )
          .slice(0, 8)
          .map((h) => ({
            kind: 'hook' as const,
            name: h.id,
            description: h.name + ' - ' + h.description,
            insertText: '/hook:' + h.id + ' ',
          }))

    const isMcpOnly = f.startsWith('mcp:')
    const mcpFilter = isMcpOnly ? f.replace(/^mcp:/, '') : f
    const isAgentOnly = f.startsWith('replay:')
    const agentFilter = isAgentOnly ? f.replace(/^replay:/, '') : f

    const mcps: PanelItem[] = (isSkillOnly || isHookOnly || isAgentOnly)
      ? []
      : mcpInstalled
          .filter(
            (m) =>
              !mcpFilter ||
              m.name.toLowerCase().includes(mcpFilter) ||
              m.command.toLowerCase().includes(mcpFilter),
          )
          .slice(0, 8)
          .map((m) => ({
            kind: 'mcp' as const,
            name: m.name,
            description: `MCP: ${m.command} ${m.args.slice(0, 2).join(' ')}`,
            insertText: '@mcp:' + m.name + ' ',
          }))

    const agents: PanelItem[] = (isSkillOnly || isHookOnly || isMcpOnly)
      ? []
      : agentRecords
          .filter(
            (r) =>
              !agentFilter ||
              r.title.toLowerCase().includes(agentFilter) ||
              r.id.toLowerCase().includes(agentFilter),
          )
          .slice(0, 8)
          .map((r) => ({
            kind: 'agent' as const,
            name: r.title,
            description: `${r.model || '默认'} · ${new Date(r.finishedAt).toLocaleDateString('zh-CN')}`,
            insertText: '/replay:' + r.id + ' ',
          }))

    return { commands, skills, hooks, mcps, agents }
  }, [slash, installedSkills, installedHookIds, hooksGetActive, mcpInstalled, agentRecords])

  const allPanelItems = useMemo(
    () => [...panelItems.commands, ...panelItems.skills, ...panelItems.hooks, ...panelItems.mcps, ...panelItems.agents],
    [panelItems],
  )

  const pendingText = usePiStore((s) => s.pendingComposerText)
  useEffect(() => {
    if (pendingText == null) return
    usePiStore.getState().setPendingComposerText(null)
    setDraft(pendingText)
    requestAnimationFrame(() => {
      const el = taRef.current
      if (!el) return
      el.style.height = 'auto'
      el.style.height = Math.min(el.scrollHeight, 220) + 'px'
      el.focus()
    })
  }, [pendingText])

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

  const onChangeDraft = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const v = e.target.value
    setDraft(v)
    const tok = slashTokenBeforeCaret(v, e.target.selectionStart ?? v.length)
    setSlash(tok)
    setSlashIdx(0)
    if (tok) { void loadInstalledSkills(); void mcpLoadInstalled() }
  }

  const pickItem = (item: PanelItem) => {
    if (!slash) return
    const caret = taRef.current?.selectionStart ?? draft.length
    const inserted = item.insertText
    setDraft(draft.slice(0, slash.start) + inserted + draft.slice(caret))
    setSlash(null)
    const el = taRef.current
    if (el) {
      const pos = slash.start + inserted.length
      requestAnimationFrame(() => {
        el.focus()
        el.setSelectionRange(pos, pos)
      })
    }
  }

  const onPaste = async (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (disabled) return
    const images = Array.from(e.clipboardData?.items ?? []).filter(
      (it) => it.kind === 'file' && it.type.startsWith('image/'),
    )
    if (images.length === 0) return
    e.preventDefault()
    for (const it of images) {
      const file = it.getAsFile()
      if (!file) continue
      try {
        const base64 = await blobToBase64(file)
        const { invoke } = await import('@tauri-apps/api/core')
        const path = await invoke<string>('save_clipboard_file', {
          base64,
          ext: extForMime(it.type),
        })
        addPaths([path])
        setHint('已粘贴图片 → 附件')
      } catch (err) {
        setHint('粘贴图片失败：' + String(err))
      }
    }
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
      parts.push(attachments.map((p) => '@' + p).join('\n'))
    }
    setDraft('')
    setAttachments([])
    setSlash(null)
    void send(parts.join('\n\n'))
    const el = taRef.current
    if (el) el.style.height = 'auto'
  }

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (slash && allPanelItems.length > 0) {
      if (e.key === 'Escape') {
        e.preventDefault()
        setSlash(null)
        return
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashIdx((i) => (i + 1) % allPanelItems.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashIdx((i) => (i - 1 + allPanelItems.length) % allPanelItems.length)
        return
      }
      if (
        ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') &&
        !e.nativeEvent.isComposing
      ) {
        e.preventDefault()
        pickItem(allPanelItems[slashIdx] ?? allPanelItems[0])
        return
      }
    } else if (slash && e.key === 'Escape') {
      e.preventDefault()
      setSlash(null)
      return
    }
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      doSend()
    }
  }

  const onInput = () => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 220) + 'px'
  }

  const commandCount = panelItems.commands.length
  const skillsCount = panelItems.skills.length
  const hooksCount = panelItems.hooks.length
  const mcpsCount = panelItems.mcps.length
  const hasCommands = commandCount > 0
  const hasSkills = skillsCount > 0
  const hasHooks = hooksCount > 0
  const hasMcps = mcpsCount > 0
  const hasAgents = panelItems.agents.length > 0
  const hasAny = allPanelItems.length > 0

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
            'relative rounded-card border bg-surface transition-colors',
            dragOver
              ? 'border-primary border-dashed bg-primary-tint/40'
              : 'border-line focus-within:border-primary/60',
          ].join(' ')}
        >
          {/* / 统一命令面板（上浮） */}
          {slash && (
            <div className="absolute bottom-full left-0 right-0 z-30 mb-1.5 overflow-hidden rounded-card border border-line bg-surface shadow-lg">
              <p className="px-3 pb-1 pt-2 text-[10px] text-ink-faint">
                命令面板 · ↑↓ 选择 · Enter/Tab 插入 · Esc 关闭
              </p>
              {!hasAny ? (
                <p className="px-3 pb-2.5 text-[11.5px] text-ink-dim">无匹配命令或技能</p>
              ) : (
                <ul className="max-h-72 overflow-y-auto pb-1">
                  {panelItems.commands.map((item, i) => (
                    <li key={'cmd-' + item.name}>
                      <button
                        onMouseDown={(ev) => {
                          ev.preventDefault()
                          pickItem(item)
                        }}
                        onMouseEnter={() => setSlashIdx(i)}
                        className={[
                          'w-full px-3 py-1.5 text-left transition-colors',
                          i === slashIdx ? 'bg-primary-tint' : 'hover:bg-surface-2',
                        ].join(' ')}
                      >
                        <span className="font-mono text-[12px] text-ink">/{item.name}</span>
                        <span className="ml-2 text-[11px] text-ink-muted">
                          {item.description}
                        </span>
                      </button>
                    </li>
                  ))}
                  {hasCommands && hasSkills && (
                    <li className="my-1 mx-3 border-t border-line" />
                  )}
                  {hasSkills && (
                    <li className="px-3 pt-1 pb-0.5 text-[10px] text-ink-faint select-none">
                      已安装技能
                    </li>
                  )}
                  {panelItems.skills.map((item, si) => {
                    const globalIdx = commandCount + si
                    return (
                      <li key={'sk-' + item.name}>
                        <button
                          onMouseDown={(ev) => {
                            ev.preventDefault()
                            pickItem(item)
                          }}
                          onMouseEnter={() => setSlashIdx(globalIdx)}
                          className={[
                            'w-full px-3 py-1.5 text-left transition-colors',
                            globalIdx === slashIdx ? 'bg-primary-tint' : 'hover:bg-surface-2',
                          ].join(' ')}
                        >
                          <span className="font-mono text-[12px] text-ink">/skill:{item.name}</span>
                          {item.description && (
                            <span className="ml-2 text-[11px] text-ink-muted">
                              {item.description.length > 64
                                ? item.description.slice(0, 64) + '…'
                                : item.description}
                            </span>
                          )}
                        </button>
                      </li>
                    )
                  })}
                  {(hasCommands || hasSkills) && hasHooks && (
                    <li className="my-1 mx-3 border-t border-line" />
                  )}
                  {hasHooks && (
                    <li className="px-3 pt-1 pb-0.5 text-[10px] text-ink-faint select-none">
                      已安装 Hooks
                    </li>
                  )}
                  {panelItems.hooks.map((item, hi) => {
                    const globalIdx = commandCount + skillsCount + hi
                    return (
                      <li key={'hk-' + item.name}>
                        <button
                          onMouseDown={(ev) => {
                            ev.preventDefault()
                            pickItem(item)
                          }}
                          onMouseEnter={() => setSlashIdx(globalIdx)}
                          className={[
                            'w-full px-3 py-1.5 text-left transition-colors',
                            globalIdx === slashIdx ? 'bg-primary-tint' : 'hover:bg-surface-2',
                          ].join(' ')}
                        >
                          <span className="font-mono text-[12px] text-ink">/hook:{item.name}</span>
                          {item.description && (
                            <span className="ml-2 text-[11px] text-ink-muted">
                              {item.description.length > 64
                                ? item.description.slice(0, 64) + '…'
                                : item.description}
                            </span>
                          )}
                        </button>
                      </li>
                    )
                  })}
                  {(hasCommands || hasSkills || hasHooks) && hasMcps && (
                    <li className="my-1 mx-3 border-t border-line" />
                  )}
                  {hasMcps && (
                    <li className="px-3 pt-1 pb-0.5 text-[10px] text-ink-faint select-none">
                      MCP Servers
                    </li>
                  )}
                  {panelItems.mcps.map((item, mi) => {
                    const globalIdx = commandCount + skillsCount + hooksCount + mi
                    return (
                      <li key={'mcp-' + item.name}>
                        <button
                          onMouseDown={(ev) => {
                            ev.preventDefault()
                            pickItem(item)
                          }}
                          onMouseEnter={() => setSlashIdx(globalIdx)}
                          className={[
                            'w-full px-3 py-1.5 text-left transition-colors',
                            globalIdx === slashIdx ? 'bg-primary-tint' : 'hover:bg-surface-2',
                          ].join(' ')}
                        >
                          <span className="font-mono text-[12px] text-ink">@mcp:{item.name}</span>
                          {item.description && (
                            <span className="ml-2 text-[11px] text-ink-muted">
                              {item.description.length > 64
                                ? item.description.slice(0, 64) + '…'
                                : item.description}
                            </span>
                          )}
                        </button>
                      </li>
                    )
                  })}
                  {(hasCommands || hasSkills || hasHooks || hasMcps) && hasAgents && (
                    <li className="my-1 mx-3 border-t border-line" />
                  )}
                  {hasAgents && (
                    <li className="px-3 pt-1 pb-0.5 text-[10px] text-ink-faint select-none">
                      Agent 工作流存档
                    </li>
                  )}
                  {panelItems.agents.map((item, ai) => {
                    const globalIdx = commandCount + skillsCount + hooksCount + mcpsCount + ai
                    return (
                      <li key={'ag-' + item.name}>
                        <button
                          onMouseDown={(ev) => {
                            ev.preventDefault()
                            pickItem(item)
                          }}
                          onMouseEnter={() => setSlashIdx(globalIdx)}
                          className={[
                            'w-full px-3 py-1.5 text-left transition-colors',
                            globalIdx === slashIdx ? 'bg-primary-tint' : 'hover:bg-surface-2',
                          ].join(' ')}
                        >
                          <span className="font-mono text-[12px] text-ink">/replay:{item.name.length > 24 ? item.name.slice(0, 24) + '…' : item.name}</span>
                          {item.description && (
                            <span className="ml-2 text-[11px] text-ink-muted">
                              {item.description}
                            </span>
                          )}
                        </button>
                      </li>
                    )
                  })}
                </ul>
              )}
            </div>
          )}

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
            onChange={onChangeDraft}
            onKeyDown={onKeyDown}
            onInput={onInput}
            onPaste={(e) => void onPaste(e)}
            onBlur={() => setSlash(null)}
            rows={2}
            disabled={disabled}
            placeholder={
              disabled
                ? '先新建一个会话'
                : running
                  ? '输入插话内容，Enter 发送（运行中会先排队投递）'
                  : '交代一个任务，Enter 发送；输入 / 唤起命令面板，可粘贴图片、拖入或 📎 添加附件'
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
              {hint ?? 'Enter 发送 · Shift+Enter 换行 · / 唤起命令'}
            </span>
            <div className="flex-1" />
            {queue.length > 0 && (
              <span
                className="text-[10.5px] px-2 py-0.5 rounded-chip bg-gold/15 text-gold border border-gold/25"
                title={queue.map((q, i) => (i + 1) + '. ' + q).join('\n')}
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
