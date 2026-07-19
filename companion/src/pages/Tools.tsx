import { Link } from 'react-router-dom'

const tiles = [
  { emoji: '\u{1F4DD}', label: '办公', to: '/office', desc: 'PPT/Excel/Word', bg: 'rgba(13,141,227,0.12)' },
  { emoji: '\u{1F3A8}', label: '图像', to: '/image', desc: 'AI 图像生成', bg: 'rgba(168,85,247,0.12)' },
  { emoji: '\u{1F3AC}', label: '视频', to: '/video', desc: '视频生成', bg: 'rgba(236,72,153,0.12)' },
  { emoji: '\u{1F52C}', label: '科研', to: '/science', desc: '文献与研究', bg: 'rgba(16,163,127,0.12)' },
  { emoji: '\u{1F50D}', label: '深度研究', to: '/research', desc: '多阶段调研', bg: 'rgba(245,158,11,0.12)' },
  { emoji: '\u{1F916}', label: 'Auto', to: '/auto', desc: '自动科研', bg: 'rgba(99,102,241,0.12)' },
  { emoji: '⏰', label: '定时', to: '/schedule', desc: '计划任务', bg: 'rgba(183,121,31,0.12)' },
  { emoji: '\u{1F504}', label: '盲测', to: '/compare', desc: '模型对比', bg: 'rgba(208,52,44,0.12)' },
  { emoji: '\u{1F4E1}', label: 'Webhook', to: '/webhooks', desc: '事件推送', bg: 'rgba(75,85,99,0.12)' },
]

export default function Tools() {
  return (
    <div className="page">
      <div className="page-header">
        <h1>工具</h1>
        <p>AI 驱动的生产力工具</p>
      </div>

      <div className="page-body">
        <div className="feature-grid">
          {tiles.map((t) => (
            <Link key={t.to} to={t.to} className="feature-tile animate-in">
              <div className="icon" style={{ background: t.bg }}>
                {t.emoji}
              </div>
              <span>{t.label}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
