import { useState } from 'react'
import { Link } from 'react-router-dom'

/* ── Types ──────────────────────────────────────────────────────────────────── */

type ToolId = 'product' | 'profit' | 'photo' | 'listing'

interface ToolCard {
  id: ToolId
  emoji: string
  title: string
  desc: string
  accent: string
}

const tools: ToolCard[] = [
  { id: 'product', emoji: '\u{1F50D}', title: '智能选品', desc: '品类分析 + 市场趋势 + 竞品对比', accent: 'bg-sky/10 text-sky' },
  { id: 'profit', emoji: '\u{1F4B0}', title: '利润计算器', desc: '成本/售价/费率/物流 → 实时利润', accent: 'bg-mint/10 text-mint' },
  { id: 'photo', emoji: '\u{1F5BC}️', title: '商品图片', desc: 'AI 商品图生成 + 背景替换', accent: 'bg-gold/10 text-gold' },
  { id: 'listing', emoji: '\u{1F4C4}', title: '详情页生成', desc: '标题/卖点/描述一键生成', accent: 'bg-coral/10 text-coral' },
]

const marketOptions = ['Amazon', 'eBay', 'Shopee', 'Temu', 'AliExpress']

/* ── Component ──────────────────────────────────────────────────────────────── */

export default function Commerce() {
  const [expanded, setExpanded] = useState<ToolId | null>(null)

  // Profit calculator state
  const [cost, setCost] = useState('')
  const [price, setPrice] = useState('')
  const [feeRate, setFeeRate] = useState('15')
  const [shipping, setShipping] = useState('')

  // Product research state
  const [category, setCategory] = useState('')
  const [market, setMarket] = useState('Amazon')

  // Photo generation state
  const [photoPrompt, setPhotoPrompt] = useState('')

  // Listing state
  const [listingTitle, setListingTitle] = useState('')
  const [listingFeatures, setListingFeatures] = useState('')
  const [listingDesc, setListingDesc] = useState('')

  function toggle(id: ToolId) {
    setExpanded(expanded === id ? null : id)
  }

  // Profit calculation
  const costNum = parseFloat(cost) || 0
  const priceNum = parseFloat(price) || 0
  const feeRateNum = parseFloat(feeRate) || 0
  const shippingNum = parseFloat(shipping) || 0
  const platformFee = priceNum * (feeRateNum / 100)
  const profit = priceNum - costNum - platformFee - shippingNum
  const margin = priceNum > 0 ? (profit / priceNum) * 100 : 0
  const hasProfitInput = cost !== '' && price !== ''

  return (
    <div className="page">
      <div className="page-header">
        <div className="flex items-center gap-2">
          <Link to="/explore" className="text-ink-muted active:text-ink" style={{ textDecoration: 'none' }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </Link>
          <div>
            <h1>跨境电商</h1>
            <p>选品 &middot; 利润 &middot; 图片 &middot; 详情页</p>
          </div>
        </div>
      </div>

      <div className="page-body">
        <div className="flex flex-col gap-3">
          {tools.map((tool) => {
            const isOpen = expanded === tool.id

            return (
              <div key={tool.id} className="animate-in">
                {/* Card header — always visible */}
                <button
                  onClick={() => toggle(tool.id)}
                  className="card w-full flex items-center gap-3.5 text-left transition-all active:bg-surface"
                >
                  <div
                    className={`w-11 h-11 rounded-2xl flex items-center justify-center text-lg shrink-0 ${tool.accent}`}
                  >
                    {tool.emoji}
                  </div>
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold text-ink">{tool.title}</p>
                    <p className="text-xs text-ink-muted mt-0.5">{tool.desc}</p>
                  </div>
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    className={`text-ink-faint shrink-0 transition-transform duration-200 ${isOpen ? 'rotate-90' : ''}`}
                  >
                    <path d="M9 18l6-6-6-6" />
                  </svg>
                </button>

                {/* Expandable form content */}
                {isOpen && (
                  <div className="card-flat mt-1 flex flex-col gap-3 animate-in">
                    {/* ── 智能选品 ──────────────────────────── */}
                    {tool.id === 'product' && (
                      <>
                        <div>
                          <label className="text-xs text-ink-dim font-medium block mb-1.5">商品品类</label>
                          <input
                            type="text"
                            className="input"
                            placeholder="例如：蓝牙耳机、瑜伽垫、宠物用品"
                            value={category}
                            onChange={(e) => setCategory(e.target.value)}
                          />
                        </div>
                        <div>
                          <label className="text-xs text-ink-dim font-medium block mb-1.5">目标市场</label>
                          <div className="flex flex-wrap gap-2">
                            {marketOptions.map((m) => (
                              <button
                                key={m}
                                onClick={() => setMarket(m)}
                                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all ${
                                  market === m
                                    ? 'bg-primary text-white'
                                    : 'bg-surface-2 text-ink-muted active:bg-line'
                                }`}
                              >
                                {m}
                              </button>
                            ))}
                          </div>
                        </div>
                        <button className="btn btn-primary btn-block" disabled={!category.trim()}>
                          开始选品分析
                        </button>
                      </>
                    )}

                    {/* ── 利润计算器 ────────────────────────── */}
                    {tool.id === 'profit' && (
                      <>
                        <div className="grid grid-cols-2 gap-2.5">
                          <div>
                            <label className="text-xs text-ink-dim font-medium block mb-1.5">成本价 ($)</label>
                            <input
                              type="number"
                              className="input"
                              placeholder="0.00"
                              value={cost}
                              onChange={(e) => setCost(e.target.value)}
                              inputMode="decimal"
                            />
                          </div>
                          <div>
                            <label className="text-xs text-ink-dim font-medium block mb-1.5">售价 ($)</label>
                            <input
                              type="number"
                              className="input"
                              placeholder="0.00"
                              value={price}
                              onChange={(e) => setPrice(e.target.value)}
                              inputMode="decimal"
                            />
                          </div>
                          <div>
                            <label className="text-xs text-ink-dim font-medium block mb-1.5">平台费率 (%)</label>
                            <input
                              type="number"
                              className="input"
                              placeholder="15"
                              value={feeRate}
                              onChange={(e) => setFeeRate(e.target.value)}
                              inputMode="decimal"
                            />
                          </div>
                          <div>
                            <label className="text-xs text-ink-dim font-medium block mb-1.5">物流费 ($)</label>
                            <input
                              type="number"
                              className="input"
                              placeholder="0.00"
                              value={shipping}
                              onChange={(e) => setShipping(e.target.value)}
                              inputMode="decimal"
                            />
                          </div>
                        </div>

                        {/* Live profit result */}
                        {hasProfitInput && (
                          <div className="card flex flex-col gap-2 animate-in">
                            <div className="flex items-center justify-between">
                              <span className="text-xs text-ink-dim font-medium">平台抽成</span>
                              <span className="text-sm text-ink-muted font-mono">
                                ${platformFee.toFixed(2)}
                              </span>
                            </div>
                            <div className="h-px bg-line-soft" />
                            <div className="flex items-center justify-between">
                              <span className="text-sm font-semibold text-ink">利润</span>
                              <span
                                className={`text-lg font-bold font-mono ${
                                  profit >= 0 ? 'text-mint' : 'text-coral'
                                }`}
                              >
                                ${profit.toFixed(2)}
                              </span>
                            </div>
                            <div className="flex items-center justify-between">
                              <span className="text-xs text-ink-dim font-medium">利润率</span>
                              <span
                                className={`text-sm font-semibold font-mono ${
                                  margin >= 0 ? 'text-mint' : 'text-coral'
                                }`}
                              >
                                {margin.toFixed(1)}%
                              </span>
                            </div>
                            {/* Visual indicator */}
                            <div className="h-2 rounded-full bg-surface-2 overflow-hidden mt-1">
                              <div
                                className={`h-full rounded-full transition-all duration-300 ${
                                  margin >= 20
                                    ? 'bg-mint'
                                    : margin >= 0
                                    ? 'bg-gold'
                                    : 'bg-coral'
                                }`}
                                style={{ width: `${Math.max(0, Math.min(100, margin))}%` }}
                              />
                            </div>
                            <p className="text-[10px] text-ink-faint text-center mt-0.5">
                              {margin >= 30
                                ? '高利润空间'
                                : margin >= 20
                                ? '利润良好'
                                : margin >= 10
                                ? '利润偏低'
                                : margin >= 0
                                ? '利润极薄，建议优化成本'
                                : '亏损，不建议上架'}
                            </p>
                          </div>
                        )}
                      </>
                    )}

                    {/* ── 商品图片 ──────────────────────────── */}
                    {tool.id === 'photo' && (
                      <>
                        <div>
                          <label className="text-xs text-ink-dim font-medium block mb-1.5">图片描述</label>
                          <textarea
                            className="input"
                            rows={3}
                            placeholder="描述你想要的商品图片，例如：白色背景上的蓝牙耳机，45度角拍摄，柔光效果"
                            value={photoPrompt}
                            onChange={(e) => setPhotoPrompt(e.target.value)}
                            style={{ resize: 'none' }}
                          />
                        </div>
                        <div className="flex gap-2">
                          <button className="btn btn-primary flex-1" disabled={!photoPrompt.trim()}>
                            生成图片
                          </button>
                          <button className="btn btn-secondary" onClick={() => setPhotoPrompt('')}>
                            清除
                          </button>
                        </div>
                        {/* Placeholder preview area */}
                        <div className="h-40 rounded-xl bg-surface-2 border border-line-soft flex items-center justify-center">
                          <div className="flex flex-col items-center gap-2 text-ink-faint">
                            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="opacity-40">
                              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
                              <circle cx="8.5" cy="8.5" r="1.5" />
                              <path d="M21 15l-5-5L5 21" />
                            </svg>
                            <p className="text-xs">AI 生成图片将在此显示</p>
                          </div>
                        </div>
                      </>
                    )}

                    {/* ── 详情页生成 ────────────────────────── */}
                    {tool.id === 'listing' && (
                      <>
                        <div>
                          <label className="text-xs text-ink-dim font-medium block mb-1.5">商品标题</label>
                          <input
                            type="text"
                            className="input"
                            placeholder="例如：Premium Wireless Earbuds"
                            value={listingTitle}
                            onChange={(e) => setListingTitle(e.target.value)}
                          />
                        </div>
                        <div>
                          <label className="text-xs text-ink-dim font-medium block mb-1.5">核心卖点</label>
                          <textarea
                            className="input"
                            rows={2}
                            placeholder="主动降噪、40h 续航、IPX5 防水"
                            value={listingFeatures}
                            onChange={(e) => setListingFeatures(e.target.value)}
                            style={{ resize: 'none' }}
                          />
                        </div>
                        <div>
                          <label className="text-xs text-ink-dim font-medium block mb-1.5">补充描述</label>
                          <textarea
                            className="input"
                            rows={3}
                            placeholder="目标人群、使用场景、竞品差异…"
                            value={listingDesc}
                            onChange={(e) => setListingDesc(e.target.value)}
                            style={{ resize: 'none' }}
                          />
                        </div>
                        <button
                          className="btn btn-primary btn-block"
                          disabled={!listingTitle.trim()}
                        >
                          生成详情页
                        </button>
                      </>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
