import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { getActiveProvider } from '../lib/api'

const stylePresets = ['写实', '动漫', '水彩', '油画', '3D', '像素']
const sizeOptions = ['1:1', '16:9', '9:16', '4:3']

interface GeneratedImage {
  id: string
  prompt: string
  date: string
  color: string
}

// placeholder palette for demo gallery items
const placeholderColors = [
  'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
  'linear-gradient(135deg, #f093fb 0%, #f5576c 100%)',
  'linear-gradient(135deg, #4facfe 0%, #00f2fe 100%)',
  'linear-gradient(135deg, #43e97b 0%, #38f9d7 100%)',
  'linear-gradient(135deg, #fa709a 0%, #fee140 100%)',
  'linear-gradient(135deg, #a18cd1 0%, #fbc2eb 100%)',
]

export default function ImageStudio() {
  const navigate = useNavigate()
  const provider = getActiveProvider()
  const disabled = !provider

  const [prompt, setPrompt] = useState('')
  const [style, setStyle] = useState('写实')
  const [size, setSize] = useState('1:1')
  const [images, setImages] = useState<GeneratedImage[]>([])
  const [generating, setGenerating] = useState(false)

  function handleGenerate() {
    if (disabled || !prompt.trim() || generating) return
    setGenerating(true)
    // Simulate generation
    setTimeout(() => {
      const newImg: GeneratedImage = {
        id: Date.now().toString(),
        prompt: prompt.trim(),
        date: new Date().toLocaleDateString('zh-CN'),
        color: placeholderColors[images.length % placeholderColors.length],
      }
      setImages((prev) => [newImg, ...prev])
      setGenerating(false)
    }, 1500)
  }

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
          <h1>图像</h1>
          <p>AI 图像生成</p>
        </div>
      </div>

      <div className="page-body">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          {/* Prompt */}
          <div>
            <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
              提示词
            </label>
            <textarea
              className="input"
              placeholder="描述你想生成的图像..."
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              rows={4}
              style={{ resize: 'none', fontFamily: 'inherit' }}
            />
          </div>

          {/* Style chips */}
          <div>
            <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
              风格
            </label>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {stylePresets.map((s) => (
                <button
                  key={s}
                  onClick={() => setStyle(s)}
                  className={style === s ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>

          {/* Size */}
          <div>
            <label style={{ fontSize: 13, fontWeight: 500, color: 'var(--text-muted)', marginBottom: 6, display: 'block' }}>
              尺寸
            </label>
            <div style={{ display: 'flex', gap: 8 }}>
              {sizeOptions.map((sz) => (
                <button
                  key={sz}
                  onClick={() => setSize(sz)}
                  className={size === sz ? 'btn btn-primary btn-sm' : 'btn btn-secondary btn-sm'}
                  style={{ flex: 1 }}
                >
                  {sz}
                </button>
              ))}
            </div>
          </div>

          {/* Generate button */}
          <button
            className="btn btn-primary btn-block"
            disabled={disabled || !prompt.trim() || generating}
            onClick={handleGenerate}
          >
            {generating ? '生成中...' : '生成图像'}
          </button>

          {disabled && (
            <p style={{ fontSize: 12, color: 'var(--failed)', textAlign: 'center' }}>
              需要配置 AI 服务商
            </p>
          )}

          {/* Gallery */}
          {images.length > 0 ? (
            <div style={{ marginTop: 8 }}>
              <p style={{ fontSize: 13, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 10 }}>
                生成记录
              </p>
              <div
                style={{
                  display: 'grid',
                  gridTemplateColumns: 'repeat(2, 1fr)',
                  gap: 10,
                }}
              >
                {images.map((img) => (
                  <div key={img.id} className="card animate-in" style={{ padding: 0, overflow: 'hidden' }}>
                    {/* Color placeholder for image */}
                    <div
                      style={{
                        width: '100%',
                        aspectRatio: '1',
                        background: img.color,
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.5)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                        <circle cx="8.5" cy="8.5" r="1.5" />
                        <polyline points="21 15 16 10 5 21" />
                      </svg>
                    </div>
                    <div style={{ padding: '8px 10px' }}>
                      <p
                        style={{
                          fontSize: 12,
                          color: 'var(--text)',
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                      >
                        {img.prompt}
                      </p>
                      <p style={{ fontSize: 11, color: 'var(--text-faint)', marginTop: 2 }}>{img.date}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : (
            /* Empty state */
            <div
              className="card-flat"
              style={{
                marginTop: 8,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                minHeight: 180,
                gap: 12,
              }}
            >
              <div
                style={{
                  width: 64,
                  height: 64,
                  borderRadius: 16,
                  background: 'linear-gradient(135deg, rgba(168,85,247,0.15), rgba(236,72,153,0.15))',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
              >
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="var(--text-dim)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                  <circle cx="8.5" cy="8.5" r="1.5" />
                  <polyline points="21 15 16 10 5 21" />
                </svg>
              </div>
              <p style={{ fontSize: 14, color: 'var(--text-dim)', textAlign: 'center' }}>
                输入提示词生成第一张图
              </p>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
