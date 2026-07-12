// /pi — 产品新主界面：严格仿 pi-app 的三栏对话式编码 agent 壳。
// 左：项目 + 会话列表（~240px）；中：Timeline + Composer；右：tab 式
// 「文件」（文件树 + 预览）/「会话信息」（~340px，可折叠）；
// 底部：可折叠「终端 / SSH」条（跨中+右栏，IDE 式）。
// 模型数据只读复用 workbenchStore 的 providers_models（不改动该 store）。
import { useEffect } from 'react'
import { usePiStore } from '../stores/piStore'
import { useWorkbenchStore } from '../stores/workbenchStore'
import SessionList, { pickProjectDir } from '../components/pi/SessionList'
import PiTimeline from '../components/pi/Timeline'
import PiComposer from '../components/pi/Composer'
import RightPanel from '../components/pi/RightPanel'
import BottomBar from '../components/pi/BottomBar'

function baseName(p: string): string {
  const parts = p.split(/[\\/]/)
  return parts[parts.length - 1] || p
}

/** 路径宽松等价（分隔符 / 大小写不敏感，Windows 友好）。 */
function samePath(a: string | null, b: string | null): boolean {
  if (!a || !b) return false
  const norm = (s: string) => s.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase()
  return norm(a) === norm(b)
}

/** 空状态引导（未开项目 / 无会话两档）。 */
function EmptyGuide({
  title,
  hint,
  action,
  onAction,
}: {
  title: string
  hint: string
  action: string
  onAction: () => void
}) {
  return (
    <div className="flex-1 flex items-center justify-center">
      <div className="text-center select-none">
        <div className="text-[15px] text-ink mb-1.5">{title}</div>
        <div className="text-[12px] text-ink-dim leading-6 mb-4 whitespace-pre-line">{hint}</div>
        <button
          onClick={onAction}
          className="px-4 py-2 rounded-btn bg-primary hover:bg-primary-hover text-[12.5px] text-white transition-colors"
        >
          {action}
        </button>
      </div>
    </div>
  )
}

export default function PiShell() {
  const init = usePiStore((s) => s.init)
  const cwd = usePiStore((s) => s.cwd)
  const setCwd = usePiStore((s) => s.setCwd)
  const sessions = usePiStore((s) => s.sessions)
  const activeSessionId = usePiStore((s) => s.activeSessionId)
  const newSession = usePiStore((s) => s.newSession)
  const piError = usePiStore((s) => s.error)
  const clearError = usePiStore((s) => s.clearError)
  const selProviderId = usePiStore((s) => s.selProviderId)
  const selModel = usePiStore((s) => s.selModel)
  const setModelSel = usePiStore((s) => s.setModelSel)
  const rightOpen = usePiStore((s) => s.rightOpen)
  const setRightOpen = usePiStore((s) => s.setRightOpen)

  // 模型来源：只读 workbenchStore 的 providers_models 聚合。
  // （gpt-5.6-luna/-sol/-terra 等新解禁模型由后端标记 kind=chat 自动进入，
  //   前端除 kind==chat 外无任何额外过滤。）
  const aggModels = useWorkbenchStore((s) => s.aggModels)
  const modelsLoaded = useWorkbenchStore((s) => s.modelsLoaded)

  const active = sessions.find((x) => x.id === activeSessionId) ?? null

  useEffect(() => {
    void init()
  }, [init])

  useEffect(() => {
    if (!modelsLoaded) void useWorkbenchStore.getState().loadModels()
  }, [modelsLoaded])

  // 默认模型：优先 gpt-5.5，否则第一个（与工作台一致）。
  useEffect(() => {
    if (!modelsLoaded || selModel || aggModels.length === 0) return
    const first = aggModels.find((m) => m.modelId === 'gpt-5.5') ?? aggModels[0]
    setModelSel(first.providerId, first.modelId)
  }, [modelsLoaded, selModel, aggModels, setModelSel])

  // ①：会话打开（或切到不同 cwd 的会话）时，用 ws_open_folder(cwd) 初始化
  // 右栏文件树的数据源。已是同一根（且非远程）则不重复打开。
  const activeCwd = active?.cwd ?? null
  useEffect(() => {
    if (!activeCwd) return
    // workspaceStore（→ monaco）按需加载，保持主 chunk 精简。
    void import('../stores/workspaceStore').then(({ useWorkspaceStore }) => {
      const ws = useWorkspaceStore.getState()
      if (!ws.remote && samePath(ws.root, activeCwd)) return
      usePiStore.getState().closePreview()
      void ws.openFolder(activeCwd)
    })
  }, [activeCwd])

  const canCreate = !!cwd && !!selModel

  const handleNewSession = () => {
    if (!cwd) return
    void newSession(cwd, selModel || undefined, selProviderId)
  }

  const handleOpenProject = async () => {
    const dir = await pickProjectDir()
    if (dir) setCwd(dir)
  }

  const modelKey = selProviderId && selModel ? `${selProviderId}::${selModel}` : ''

  return (
    <div className="flex h-full min-h-0 bg-editor overflow-hidden">
      {/* 左栏 */}
      <SessionList canCreate={canCreate} onNewSession={handleNewSession} />

      {/* 右侧整体：上（中栏 + 右栏）+ 底部终端条 */}
      <div className="flex-1 min-w-0 flex flex-col h-full">
        <div className="flex-1 min-h-0 flex">
          {/* 中栏 */}
          <div className="flex-1 min-w-0 flex flex-col h-full">
            {/* 顶部细条：项目名 + 模型 + 右栏开关 */}
            <div className="flex-shrink-0 flex items-center gap-2.5 h-9 px-3 border-b border-line">
              <span className="text-[12px] text-ink font-medium truncate" title={cwd ?? undefined}>
                {cwd ? baseName(cwd) : 'pi 工作台'}
              </span>
              {active && (
                <span className="text-[10.5px] text-ink-faint truncate">/ {active.title}</span>
              )}
              <div className="flex-1" />
              {aggModels.length > 0 && (
                <select
                  value={modelKey}
                  onChange={(e) => {
                    const [pid, ...rest] = e.target.value.split('::')
                    setModelSel(pid, rest.join('::'))
                  }}
                  title="新会话使用的模型（已开会话的模型不变）"
                  className="max-w-[220px] px-2 py-1 rounded-btn bg-surface-2 border border-line text-[11px] text-ink-muted outline-none hover:text-ink cursor-pointer"
                >
                  {aggModels.map((m) => (
                    <option
                      key={`${m.providerId}::${m.modelId}`}
                      value={`${m.providerId}::${m.modelId}`}
                    >
                      {m.providerLabel} · {m.modelId}
                    </option>
                  ))}
                </select>
              )}
              <button
                onClick={() => setRightOpen(!rightOpen)}
                className={[
                  'px-2 py-1 rounded-btn border border-line text-[11px] transition-colors',
                  rightOpen
                    ? 'bg-primary-tint text-ink'
                    : 'bg-surface-2 text-ink-dim hover:text-ink',
                ].join(' ')}
                title={rightOpen ? '收起右栏' : '展开右栏'}
              >
                ◧
              </button>
            </div>

            {/* 错误横幅（store 级错误，如 pi_open 失败） */}
            {piError && (
              <div className="flex-shrink-0 flex items-center gap-2 px-3 py-1.5 bg-coral/10 border-b border-coral/30 text-[11.5px] text-coral">
                <span className="flex-1 truncate" title={piError}>
                  {piError}
                </span>
                <button onClick={clearError} className="hover:text-ink flex-shrink-0">
                  ✕
                </button>
              </div>
            )}

            {/* Timeline / 空状态 */}
            {!cwd ? (
              <EmptyGuide
                title="打开项目文件夹开始"
                hint={'选择一个本地项目目录，\nagent 将在该目录里读代码、改文件、跑命令。'}
                action="打开项目文件夹"
                onAction={() => void handleOpenProject()}
              />
            ) : !active ? (
              <EmptyGuide
                title="新建会话"
                hint={`项目：${cwd}\n开一个会话，把任务交给 agent。`}
                action="＋ 新会话"
                onAction={handleNewSession}
              />
            ) : (
              <PiTimeline />
            )}

            {/* Composer（有活动会话才有意义，但保持常驻减少布局跳动） */}
            {cwd && active && <PiComposer />}
          </div>

          {/* 右栏（可折叠，tab：文件 / 会话信息） */}
          {rightOpen && active && <RightPanel />}
        </div>

        {/* 底部：可折叠 终端 / SSH 条（④⑤） */}
        <BottomBar cwd={activeCwd ?? cwd} />
      </div>
    </div>
  )
}
