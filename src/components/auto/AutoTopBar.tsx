// 顶部运行配置条（常驻）：环境 pill（未装→安装引导卡）、工作目录、模型、
// 研究方向输入（单行↔多行，粘贴长材料自动折叠）、开始/停止。
import { useEffect, useRef, useState } from 'react'
import { useAutoStore } from '../../stores/autoStore'
import { useWorkbenchStore } from '../../stores/workbenchStore'
import { Button, StatusDot } from '../ui'
import { IconChevronDown, IconChevronRight, IconFolder, IconPlay, IconStop } from './icons'

const NL = String.fromCharCode(10)
const SELECT =
  'bg-surface-2 border border-line rounded-input px-2 py-1.5 text-[12px] text-ink outline-none focus:border-primary/50'

/** 研究方向视为「长材料」的阈值：含换行或超长则折叠为摘要展示。 */
const LONG_TOPIC = 160

function baseName(p: string): string {
  const parts = p.split(/[\\/]/).filter(Boolean)
  return parts[parts.length - 1] || p
}

export default function AutoTopBar() {
  const detect = useAutoStore((s) => s.detect)
  const detecting = useAutoStore((s) => s.detecting)
  const installing = useAutoStore((s) => s.installing)
  const installLog = useAutoStore((s) => s.installLog)
  const workspace = useAutoStore((s) => s.workspace)
  const topic = useAutoStore((s) => s.topic)
  const providerId = useAutoStore((s) => s.providerId)
  const model = useAutoStore((s) => s.model)
  const runStatus = useAutoStore((s) => s.runStatus)
  const starting = useAutoStore((s) => s.starting)
  const history = useAutoStore((s) => s.history)

  const aggModels = useWorkbenchStore((s) => s.aggModels)
  const modelsLoaded = useWorkbenchStore((s) => s.modelsLoaded)

  const [envOpen, setEnvOpen] = useState(false)
  const [topicExpanded, setTopicExpanded] = useState(false)
  const installLogRef = useRef<HTMLPreElement | null>(null)

  const running = runStatus === 'running'
  const idle = runStatus === 'idle' || runStatus === 'stopped' || runStatus === 'done' || runStatus === 'error'
  const installed = !!detect?.installed
  // Most recent stopped/error run for the current workspace (resume candidate).
  const lastStopped = !running && idle
    ? history.find((r) => (r.status === 'stopped' || r.status === 'error') && r.workspace === workspace)
    : null
  const longTopic = topic.includes(NL) || topic.length > LONG_TOPIC

  // 模型来源：只读 workbenchStore 聚合模型（chat 档），未加载则触发加载。
  useEffect(() => {
    if (!useWorkbenchStore.getState().modelsLoaded) {
      void useWorkbenchStore.getState().loadModels()
    }
  }, [])

  // 默认模型 gpt-5.5（加载完成且未选时设一次；持久化的旧选择若已失效也重选）。
  useEffect(() => {
    if (!modelsLoaded || aggModels.length === 0) return
    const st = useAutoStore.getState()
    const valid =
      st.model && aggModels.some((m) => m.modelId === st.model && m.providerId === st.providerId)
    if (valid) return
    const first = aggModels.find((m) => m.modelId === 'gpt-5.5') ?? aggModels[0]
    st.setModel(first.providerId, first.modelId)
  }, [modelsLoaded, aggModels])

  // 检测完成且未安装 → 自动展开安装引导卡。
  useEffect(() => {
    if (detect && !detect.installed) setEnvOpen(true)
  }, [detect])

  // 安装日志自动滚底。
  useEffect(() => {
    const el = installLogRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [installLog])

  const canStart =
    installed && !!workspace.trim() && !!topic.trim() && !!model && !running && !starting

  // 环境 pill 的状态与文案。
  const pill = detecting
    ? { status: 'awaiting' as const, pulse: true, text: '检测中…' }
    : !detect
      ? { status: 'idle' as const, pulse: false, text: '环境未检测' }
      : detect.installed
        ? { status: 'done' as const, pulse: false, text: ('openscience ' + (detect.version ?? '')).trim() }
        : { status: 'failed' as const, pulse: false, text: 'openscience 未安装' }

  const onTopicPaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData('text')
    if (!pasted.includes(NL) && pasted.length <= LONG_TOPIC) return
    // 长材料：保留换行整体写入，随后自动折叠为摘要展示。
    e.preventDefault()
    const el = e.currentTarget
    const cur = useAutoStore.getState().topic
    const a = el.selectionStart ?? cur.length
    const b = el.selectionEnd ?? cur.length
    useAutoStore.getState().setTopic(cur.slice(0, a) + pasted + cur.slice(b))
    setTopicExpanded(false)
  }

  return (
    <div className="shrink-0 border-b border-line bg-surface px-4 py-2.5">
      {/* 第一行：标题 + 环境 pill + 工作目录 + 模型 + 开始/停止 */}
      <div className="flex items-center gap-2">
        <h1 className="text-[13px] font-bold text-ink shrink-0">Auto 自动科研</h1>
        <button
          className={
            'flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] transition-colors ' +
            (envOpen
              ? 'border-line-strong bg-surface-2 text-ink'
              : 'border-line text-ink-muted hover:text-ink hover:bg-surface-2')
          }
          onClick={() => setEnvOpen((v) => !v)}
          title="环境状态（点击展开详情）"
        >
          <StatusDot status={pill.status} size={6} pulse={pill.pulse} />
          {pill.text}
          {envOpen ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />}
        </button>

        <div className="flex-1" />

        <button
          className="flex items-center gap-1.5 rounded-input border border-line px-2.5 py-1.5 text-[12px] text-ink-muted hover:text-ink hover:bg-surface-2 transition-colors max-w-[220px]"
          onClick={() => void useAutoStore.getState().pickWorkspace()}
          title={workspace || '选择研究工作目录（产物与 openscience.json 落在这里）'}
        >
          <IconFolder size={13} className="shrink-0" />
          <span className="truncate">{workspace ? baseName(workspace) : '选择工作目录'}</span>
        </button>

        <select
          className={SELECT + ' max-w-[220px]'}
          value={providerId && model ? providerId + '::' + model : ''}
          onChange={(e) => {
            const [pid, mid] = e.target.value.split('::')
            if (pid && mid) useAutoStore.getState().setModel(pid, mid)
          }}
          title="模型（来自设置里的服务商）"
        >
          {!modelsLoaded && <option value="">模型加载中…</option>}
          {modelsLoaded && aggModels.length === 0 && <option value="">无可用模型</option>}
          {aggModels.map((m) => (
            <option key={m.providerId + '::' + m.modelId} value={m.providerId + '::' + m.modelId}>
              {m.providerLabel} / {m.modelId}
            </option>
          ))}
        </select>

        {running ? (
          <Button variant="danger" size="sm" onClick={() => void useAutoStore.getState().stop()}>
            <IconStop size={12} />
            停止
          </Button>
        ) : (
          <Button
            variant="primary"
            size="sm"
            disabled={!canStart}
            onClick={() => void useAutoStore.getState().start()}
            title={
              !installed
                ? '需先安装 openscience CLI'
                : !workspace.trim()
                  ? '请先选择工作目录'
                  : !topic.trim()
                    ? '请填写研究方向'
                    : '开始自动科研流水线（自动生成 openscience.json）'
            }
          >
            <IconPlay size={12} />
            {starting ? '启动中…' : '开始研究'}
          </Button>
        )}
        {lastStopped && !running && !starting && (
          <Button
            variant="soft"
            size="sm"
            disabled={!canStart}
            onClick={() => useAutoStore.getState().resumeRun(lastStopped)}
            title={'继续上次已停止的研究（以相同配置重新启动）：' + lastStopped.topic.slice(0, 60)}
          >
            <IconPlay size={12} />
            继续研究
          </Button>
        )}
      </div>

      {/* 第二行：研究方向输入（单行 / 折叠摘要 / 多行展开） */}
      <div className="mt-2 flex items-start gap-2">
        {topicExpanded ? (
          <textarea
            className="flex-1 min-h-[96px] resize-y bg-surface-2 border border-line rounded-input px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-primary/50 leading-5"
            placeholder="研究方向 / 课题描述（作为 research agent 的初始指令，可粘贴长材料）"
            value={topic}
            onChange={(e) => useAutoStore.getState().setTopic(e.target.value)}
            autoFocus
          />
        ) : longTopic ? (
          <button
            className="flex-1 flex items-center gap-2 bg-surface-2 border border-line rounded-input px-2.5 py-1.5 text-left hover:border-line-strong transition-colors min-w-0"
            onClick={() => setTopicExpanded(true)}
            title="已折叠长材料，点击展开编辑"
          >
            <span className="truncate text-[12.5px] text-ink">{topic.split(NL)[0]}</span>
            <span className="shrink-0 rounded-chip bg-primary-tint px-1.5 py-0.5 text-[10px] text-primary font-medium">
              已折叠 · {topic.length} 字
            </span>
          </button>
        ) : (
          <input
            className="flex-1 bg-surface-2 border border-line rounded-input px-2.5 py-1.5 text-[12.5px] text-ink outline-none focus:border-primary/50"
            placeholder="研究方向 / 课题描述（作为 research agent 的初始指令，可粘贴长材料）"
            value={topic}
            onChange={(e) => useAutoStore.getState().setTopic(e.target.value)}
            onPaste={onTopicPaste}
          />
        )}
        <button
          className="shrink-0 rounded-input border border-line px-2 py-1.5 text-[11px] text-ink-dim hover:text-ink hover:bg-surface-2 transition-colors"
          onClick={() => setTopicExpanded((v) => !v)}
          title={topicExpanded ? '收起为单行' : '展开为多行编辑'}
        >
          {topicExpanded ? '收起' : '展开'}
        </button>
      </div>

      {/* 安装引导卡（环境详情） */}
      {envOpen && (
        <div className="mt-2 rounded-card border border-line bg-editor p-3">
          <div className="flex items-center gap-2 text-[12px]">
            <span className="flex items-center gap-1.5 text-ink-muted">
              <StatusDot status={detect?.node ? 'done' : 'failed'} size={6} />
              Node.js {detect?.node ? '已安装' : '未安装（安装 openscience 的前提）'}
            </span>
            <span className="flex items-center gap-1.5 text-ink-muted">
              <StatusDot status={installed ? 'done' : 'failed'} size={6} />
              openscience CLI{' '}
              {installed ? '已安装' + (detect?.version ? ' v' + detect.version : '') : '未安装'}
            </span>
            <div className="flex-1" />
            <Button
              variant="ghost"
              size="sm"
              disabled={detecting}
              onClick={() => void useAutoStore.getState().detectEnv()}
            >
              重新检测
            </Button>
            {!installed && (
              <Button
                variant="primary"
                size="sm"
                disabled={installing || !detect?.node}
                onClick={() => void useAutoStore.getState().install()}
                title={detect?.node ? 'npm install -g @synsci/openscience' : '需要先安装 Node.js'}
              >
                {installing ? '安装中…' : '一键安装'}
              </Button>
            )}
          </div>
          {!installed && (
            <p className="mt-1.5 text-[11px] text-ink-dim leading-4">
              自动科研流水线依赖 open-science（@synsci/openscience，MIT）headless
              CLI。一键安装等价于 npm install -g @synsci/openscience，安装输出实时显示在下方。
            </p>
          )}
          {installLog.length > 0 && (
            <pre
              ref={installLogRef}
              className="mt-2 max-h-36 overflow-y-auto rounded-input border border-line bg-surface-2 p-2 font-mono text-[11px] text-ink-dim whitespace-pre-wrap leading-4"
            >
              {installLog.join(NL)}
            </pre>
          )}
        </div>
      )}
    </div>
  )
}
