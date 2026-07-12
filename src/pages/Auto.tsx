// Auto 板块 — open-science 全流水线自动科研工作台。
// 信息架构照搬 open-science 本尊（MIT），用 Iris 组件体系与白色主题实现：
//   1 顶部运行配置条（环境/目录/模型/方向/开始停止）
//   2 阶段流水线卡（点击过滤日志）  3 实时日志
//   4 右侧产物检查器（可拖宽/可最大化/拖窄吸合关闭）
//   5 底部运行历史台账（按天分组+状态分面+Reproduce）  6 空态模板卡
// 运行状态全部住在 autoStore（挂 taskRegistry module:'auto'），离开页面不丢。
import { useEffect } from 'react'
import { useAutoStore } from '../stores/autoStore'
import AutoTopBar from '../components/auto/AutoTopBar'
import PipelineView from '../components/auto/PipelineView'
import LiveLog from '../components/auto/LiveLog'
import ArtifactPane from '../components/auto/ArtifactPane'
import RunHistory from '../components/auto/RunHistory'
import AutoStarters from '../components/auto/AutoStarters'
import { IconPanelRight, IconX } from '../components/auto/icons'

export default function Auto() {
  const error = useAutoStore((s) => s.error)
  const inspectorOpen = useAutoStore((s) => s.inspectorOpen)
  const historyCount = useAutoStore((s) => s.history.length)
  const runStatus = useAutoStore((s) => s.runStatus)
  const hasLog = useAutoStore((s) => s.log.length > 0)

  // 首次挂载初始化 store（幂等）：载入持久化状态、注册 os-event、环境检测。
  useEffect(() => {
    void useAutoStore.getState().init()
  }, [])

  // 空态：没有历史、没在跑、也没有残留日志 → 模板卡引导。
  const showStarters = historyCount === 0 && runStatus === 'idle' && !hasLog

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-editor">
      <AutoTopBar />

      {error && (
        <div className="flex shrink-0 items-center gap-2 border-b border-failed/30 bg-[#d0342c0d] px-4 py-1.5">
          <span className="min-w-0 flex-1 truncate text-[11.5px] text-failed" title={error}>
            {error}
          </span>
          <button
            className="shrink-0 text-failed/70 hover:text-failed transition-colors"
            onClick={() => useAutoStore.getState().clearError()}
            aria-label="关闭错误提示"
          >
            <IconX size={12} />
          </button>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        {/* 主区：流水线 + 日志（或空态模板卡），底部历史台账 */}
        <div className="flex min-w-0 flex-1 flex-col">
          {showStarters ? (
            <AutoStarters />
          ) : (
            <div className="flex min-h-0 flex-1 flex-col gap-2.5 px-4 py-3">
              <PipelineView />
              <LiveLog />
            </div>
          )}
          <RunHistory />
        </div>

        {/* 右侧产物检查器（吸合关闭后由下方恢复钮召回） */}
        {inspectorOpen && <ArtifactPane />}
      </div>

      {!inspectorOpen && (
        <button
          className="absolute right-0 top-1/2 z-20 -translate-y-1/2 rounded-l-lg border border-r-0 border-line bg-surface px-1.5 py-3 text-ink-dim shadow-card hover:text-ink hover:bg-surface-2 transition-colors"
          onClick={() => useAutoStore.getState().setInspectorOpen(true)}
          title="打开产物面板"
          aria-label="打开产物面板"
        >
          <IconPanelRight size={14} />
        </button>
      )}
    </div>
  )
}
