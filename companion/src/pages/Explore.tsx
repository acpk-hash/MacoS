import { Link } from 'react-router-dom'

const tiles = [
  { emoji: '\u{1F9E9}', label: 'Skills', to: '/skills', bg: 'bg-sky/10' },
  { emoji: '\u{1F50C}', label: 'MCP', to: '/mcp', bg: 'bg-mint/10' },
  { emoji: '\u{1F517}', label: 'Hooks', to: '/hooks', bg: 'bg-gold/10' },
  { emoji: '\u{1F916}', label: 'Agent', to: '/agent', bg: 'bg-coral/10' },
  { emoji: '\u{1F4DA}', label: '知识库', to: '/kb', bg: 'bg-mint/10' },
  { emoji: '\u{1F3A8}', label: '画布', to: '/canvas', bg: 'bg-gold/10' },
  { emoji: '\u{1F6D2}', label: '电商', to: '/commerce', bg: 'bg-coral/10' },
  { emoji: '\u{1F4C8}', label: '热点', to: '/trends', bg: 'bg-sky/10' },
  { emoji: '\u{1F50D}', label: '检索', to: '/vector', bg: 'bg-mint/10' },
]

export default function Explore() {
  return (
    <div className="page">
      <div className="page-header">
        <h1>{'探索'}</h1>
        <p>{'发现更多 AI 能力'}</p>
      </div>
      <div className="page-body">
        <div className="feature-grid">
          {tiles.map((t) => (
            <Link key={t.to} to={t.to} className="feature-tile animate-in">
              <div className={`icon ${t.bg}`}>{t.emoji}</div>
              <span>{t.label}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  )
}
