import { Link } from 'react-router-dom'

/**
 * 首次运行 / 无可用服务商时的引导卡：告诉用户去设置页添加一个
 * OpenAI 兼容服务商，取代以前"正在加载模型…"的永久转圈占位。
 */
export default function ProviderGuideCard({
  title = '还没有配置模型服务',
  hint = '添加一个 OpenAI 兼容服务商（Base URL + API Key）即可开始。API Key 仅保存在本机凭据管理器，不会上传。',
  compact = false,
}: {
  title?: string
  hint?: string
  compact?: boolean
}) {
  if (compact) {
    return (
      <div className="rounded-card glass border border-line px-3 py-2.5 text-left">
        <p className="text-[12.5px] text-ink font-medium mb-0.5">{title}</p>
        <p className="text-[11.5px] text-ink-dim leading-5 mb-2">{hint}</p>
        <Link
          to="/settings"
          className="inline-block px-2.5 py-1 rounded-btn bg-grad-primary text-white text-[11.5px] font-medium shadow-glow-primary hover:-translate-y-px transition-all"
        >
          去设置添加服务商
        </Link>
      </div>
    )
  }
  return (
    <div className="max-w-md w-full rounded-pop glass-strong px-6 py-8 flex flex-col items-center text-center gap-3">
      <span className="text-3xl" aria-hidden="true">🔌</span>
      <h2 className="text-lg font-semibold text-ink">{title}</h2>
      <p className="text-sm text-ink-dim leading-relaxed">{hint}</p>
      <Link
        to="/settings"
        className="mt-1 px-5 py-2.5 rounded-btn bg-grad-primary text-white text-sm font-medium shadow-glow-primary hover:-translate-y-px transition-all"
      >
        去设置添加服务商
      </Link>
    </div>
  )
}
