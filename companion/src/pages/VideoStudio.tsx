import { useNavigate } from 'react-router-dom'

const features = [
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    ),
    title: '文字转视频',
    desc: '输入描述，AI 生成短视频',
    gradient: 'linear-gradient(135deg, rgba(13,141,227,0.12), rgba(99,102,241,0.12))',
    accent: 'var(--running)',
  },
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
        <circle cx="8.5" cy="8.5" r="1.5" />
        <polyline points="21 15 16 10 5 21" />
      </svg>
    ),
    title: '图片转视频',
    desc: '静态图片动态化',
    gradient: 'linear-gradient(135deg, rgba(168,85,247,0.12), rgba(236,72,153,0.12))',
    accent: '#a855f7',
  },
  {
    icon: (
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <polygon points="23 7 16 12 23 17 23 7" />
        <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
      </svg>
    ),
    title: '视频编辑',
    desc: 'AI 辅助剪辑与特效',
    gradient: 'linear-gradient(135deg, rgba(245,158,11,0.12), rgba(236,72,153,0.12))',
    accent: 'var(--awaiting)',
  },
]

export default function VideoStudio() {
  const navigate = useNavigate()

  return (
    <div className="page">
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={() => navigate('/tools')}
          className="btn-secondary"
          style={{ padding: '4px 8px', borderRadius: 8, fontSize: 13 }}
        >
          ←
        </button>
        <div>
          <h1>视频</h1>
          <p>AI 视频生成</p>
        </div>
      </div>

      <div className="page-body">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20, alignItems: 'center' }}>
          {/* Hero section */}
          <div
            className="animate-in"
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              gap: 16,
              paddingTop: 24,
              paddingBottom: 8,
            }}
          >
            <div
              style={{
                width: 80,
                height: 80,
                borderRadius: 24,
                background: 'linear-gradient(135deg, rgba(236,72,153,0.15), rgba(168,85,247,0.15))',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <polygon points="23 7 16 12 23 17 23 7" />
                <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
              </svg>
            </div>

            <div style={{ textAlign: 'center' }}>
              <h2 style={{ fontSize: 20, fontWeight: 700, color: 'var(--text)', marginBottom: 8 }}>
                视频生成
              </h2>
              <span className="badge badge-gold">即将推出</span>
            </div>
          </div>

          {/* Feature preview cards */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, width: '100%' }}>
            {features.map((f) => (
              <div
                key={f.title}
                className="card animate-in"
                style={{ display: 'flex', alignItems: 'center', gap: 14 }}
              >
                <div
                  style={{
                    width: 48,
                    height: 48,
                    borderRadius: 14,
                    background: f.gradient,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    color: f.accent,
                    flexShrink: 0,
                  }}
                >
                  {f.icon}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <p style={{ fontSize: 15, fontWeight: 600, color: 'var(--text)' }}>{f.title}</p>
                  <p style={{ fontSize: 13, color: 'var(--text-dim)', marginTop: 2 }}>{f.desc}</p>
                </div>
                <div
                  style={{
                    width: 8,
                    height: 8,
                    borderRadius: '50%',
                    background: 'var(--text-faint)',
                    opacity: 0.4,
                    flexShrink: 0,
                  }}
                />
              </div>
            ))}
          </div>

          {/* Bottom message */}
          <div
            className="card-flat animate-in"
            style={{
              width: '100%',
              textAlign: 'center',
              padding: '20px 16px',
            }}
          >
            <p style={{ fontSize: 14, color: 'var(--text-dim)', fontWeight: 500 }}>
              敬请期待
            </p>
            <p style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 4 }}>
              视频生成功能正在开发中，将在后续版本中推出
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
