import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getActiveProvider } from '../lib/api'

type Tab = 'ppt' | 'excel' | 'word'

const tabs: { key: Tab; label: string }[] = [
  { key: 'ppt', label: 'PPT' },
  { key: 'excel', label: 'Excel' },
  { key: 'word', label: 'Word' },
]

const pptStyles = ['简约', '商务', '学术', '创意']
const slideCounts = [8, 12, 16, 20]
const wordLengths = ['短', '中', '长']

export default function Office() {
  const navigate = useNavigate()
  const provider = getActiveProvider()
  const disabled = !provider

  const [activeTab, setActiveTab] = useState<Tab>('ppt')

  // PPT state
  const [pptTopic, setPptTopic] = useState('')
  const [pptStyle, setPptStyle] = useState('简约')
  const [pptSlides, setPptSlides] = useState(12)

  // Word state
  const [wordTopic, setWordTopic] = useState('')
  const [wordLength, setWordLength] = useState('中')

  return (
    <div className="page">
      {/* Header with back button */}
      <div className="page-header" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          onClick={() => navigate('/tools')}
          className="btn-secondary"
          style={{ padding: '4px 8px', borderRadius: 8, fontSize: 13 }}
        >
          ←
        </button>
        <div>
          <h1>办公</h1>
          <p>PPT / Excel / Word 生成</p>
        </div>
      </div>

      {/* Tab bar */}
      <div
        style={{
          display: 'flex',
          borderBottom: '1px solid var(--border-soft)',
          background: 'var(--editor)',
          flexShrink: 0,
        }}
      >
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setActiveTab(t.key)}
            style={{
              flex: 1,
              padding: '10px 0',
              fontSize: 14,
              fontWeight: activeTab === t.key ? 600 : 500,
              color: activeTab === t.key ? 'var(--primary)' : 'var(--text-dim)',
              background: 'transparent',
              border: 'none',
              borderBottom: activeTab === t.key ? '2px solid var(--primary)' : '2px solid transparent',
              cursor: 'pointer',
              transition: 'all 0.15s',
            }}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="page-body">
        {disabled && (
          <div className="card-flat animate-in" style={{ marginBottom: 12, textAlign: 'center' }}>
            <p style={{ fontSize: 13, color: 'var(--failed)' }}>
              需要配置 AI 服务商才能使用此功能
            </p>
          </div>
        )}

        {/* PPT Tab */}
        {activeTab === 'ppt' && (
          <div className="animate-in" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
                主题
              </label>
              <input
                className="input"
                placeholder="输入 PPT 主题，如：年度工作汇报"
                value={pptTopic}
                onChange={(e) => setPptTopic(e.target.value)}
              />
            </div>

            <div>
              <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
                风格
              </label>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {pptStyles.map((s) => (
                  <button
                    key={s}
                    onClick={() => setPptStyle(s)}
                    className={pptStyle === s ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
                页数
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                {slideCounts.map((n) => (
                  <button
                    key={n}
                    onClick={() => setPptSlides(n)}
                    className={pptSlides === n ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
                  >
                    {n}
                  </button>
                ))}
              </div>
            </div>

            <button className="btn btn-primary btn-block" disabled={disabled || !pptTopic.trim()}>
              生成 PPT
            </button>

            {/* Preview placeholder */}
            <div
              className="card-flat"
              style={{
                marginTop: 4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 140,
                color: 'var(--text-faint)',
                fontSize: 13,
              }}
            >
              PPT 预览将在此显示
            </div>
          </div>
        )}

        {/* Excel Tab */}
        {activeTab === 'excel' && (
          <div className="animate-in" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div
              className="card"
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 140,
                gap: 10,
                border: '2px dashed var(--border-strong)',
                background: 'var(--surface)',
                cursor: 'pointer',
              }}
            >
              <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              <p style={{ fontSize: 14, color: 'var(--text-muted)' }}>点击或拖拽上传 Excel 文件</p>
              <p style={{ fontSize: 12, color: 'var(--text-faint)' }}>支持 .xlsx, .xls, .csv</p>
            </div>

            <div className="card-flat" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="dot dot-off" />
              <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>等待文件上传</span>
            </div>

            <button className="btn btn-primary btn-block" disabled={disabled}>
              导出
            </button>
          </div>
        )}

        {/* Word Tab */}
        {activeTab === 'word' && (
          <div className="animate-in" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
                主题
              </label>
              <input
                className="input"
                placeholder="输入文档主题，如：项目可行性报告"
                value={wordTopic}
                onChange={(e) => setWordTopic(e.target.value)}
              />
            </div>

            <div>
              <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
                文档长度
              </label>
              <div style={{ display: 'flex', gap: 8 }}>
                {wordLengths.map((l) => (
                  <button
                    key={l}
                    onClick={() => setWordLength(l)}
                    className={wordLength === l ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
                    style={{ flex: 1 }}
                  >
                    {l}
                  </button>
                ))}
              </div>
            </div>

            <div>
              <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
                格式选项
              </label>
              <div className="card-flat" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--text)' }}>
                  <input type="checkbox" defaultChecked /> 自动生成目录
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--text)' }}>
                  <input type="checkbox" /> 包含封面页
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, color: 'var(--text)' }}>
                  <input type="checkbox" defaultChecked /> 添加页码
                </label>
              </div>
            </div>

            <button className="btn btn-primary btn-block" disabled={disabled || !wordTopic.trim()}>
              生成 Word
            </button>

            {/* Preview placeholder */}
            <div
              className="card-flat"
              style={{
                marginTop: 4,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 140,
                color: 'var(--text-faint)',
                fontSize: 13,
              }}
            >
              文档预览将在此显示
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
