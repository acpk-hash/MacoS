import { useEffect, useCallback, useState, useRef, useMemo } from 'react'
import { useCanvasStore } from '../stores/canvasStore'
import type { CanvasNode, CanvasEdge, CanvasMode, CanvasProject } from '../stores/canvasStore'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8)
}

// ---------------------------------------------------------------------------
// Project List Sidebar
// ---------------------------------------------------------------------------

function ProjectList({
  projects,
  activeId,
  onSelect,
  onCreate,
  onDelete,
}: {
  projects: CanvasProject[]
  activeId: string | null
  onSelect: (id: string) => void
  onCreate: (mode: CanvasMode) => void
  onDelete: (id: string) => void
}) {
  return (
    <div className="w-56 border-r border-line flex flex-col flex-shrink-0 bg-surface">
      <div className="px-3 py-2 border-b border-line">
        <h3 className="text-xs font-semibold text-ink mb-2">画布项目</h3>
        <div className="flex gap-1">
          <button
            className="flex-1 px-2 py-1 text-xs rounded bg-primary text-white hover:bg-primary-hover transition-colors"
            onClick={() => onCreate('mindmap')}
          >
            + 思维导图
          </button>
          <button
            className="flex-1 px-2 py-1 text-xs rounded bg-surface-2 text-ink hover:bg-primary-tint transition-colors"
            onClick={() => onCreate('freeform')}
          >
            + 自由画布
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {projects.length === 0 ? (
          <div className="flex items-center justify-center h-20 text-xs text-ink-muted">暂无项目</div>
        ) : (
          projects.map((p) => (
            <div
              key={p.id}
              className={[
                'flex items-center gap-2 px-3 py-2 cursor-pointer group transition-colors',
                p.id === activeId ? 'bg-primary-tint text-primary' : 'hover:bg-surface-2 text-ink',
              ].join(' ')}
              onClick={() => onSelect(p.id)}
            >
              <span className="text-xs">{p.mode === 'mindmap' ? '🗺' : '📐'}</span>
              <span className="flex-1 text-xs truncate">{p.name}</span>
              <button
                className="text-xs text-ink-faint hover:text-failed opacity-0 group-hover:opacity-100"
                onClick={(e) => { e.stopPropagation(); onDelete(p.id) }}
              >
                ×
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// SVG Canvas (Whiteboard)
// ---------------------------------------------------------------------------

function CanvasBoard({
  project,
}: {
  project: CanvasProject
}) {
  const store = useCanvasStore()
  const svgRef = useRef<SVGSVGElement>(null)
  const [dragging, setDragging] = useState<{ nodeId: string; offsetX: number; offsetY: number } | null>(null)
  const [editingNode, setEditingNode] = useState<string | null>(null)
  const [editText, setEditText] = useState('')
  const [connecting, setConnecting] = useState<string | null>(null)

  // Pan state
  const [isPanning, setIsPanning] = useState(false)
  const [panStart, setPanStart] = useState({ x: 0, y: 0 })

  const nodes = project.nodes
  const edges = project.edges
  const panX = project.panX
  const panY = project.panY
  const zoom = project.zoom

  // Node map for quick lookup
  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes])

  const handleMouseDown = useCallback(
    (e: React.MouseEvent, nodeId?: string) => {
      if (nodeId) {
        // If connecting mode, finish connection
        if (connecting && connecting !== nodeId) {
          store.addEdge({ id: uid(), sourceId: connecting, targetId: nodeId, label: '' })
          setConnecting(null)
          return
        }
        const node = nodeMap.get(nodeId)
        if (!node) return
        const svg = svgRef.current
        if (!svg) return
        const pt = svg.createSVGPoint()
        pt.x = e.clientX; pt.y = e.clientY
        const svgP = pt.matrixTransform(svg.getScreenCTM()?.inverse())
        setDragging({ nodeId, offsetX: svgP.x - node.x, offsetY: svgP.y - node.y })
      } else if (e.button === 0 && !e.shiftKey) {
        // Pan
        setIsPanning(true)
        setPanStart({ x: e.clientX - panX, y: e.clientY - panY })
      }
    },
    [connecting, nodeMap, panX, panY, store],
  )

  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      if (dragging) {
        const svg = svgRef.current
        if (!svg) return
        const pt = svg.createSVGPoint()
        pt.x = e.clientX; pt.y = e.clientY
        const svgP = pt.matrixTransform(svg.getScreenCTM()?.inverse())
        store.updateNode(dragging.nodeId, {
          x: svgP.x - dragging.offsetX,
          y: svgP.y - dragging.offsetY,
        })
      } else if (isPanning) {
        store.setPan(e.clientX - panStart.x, e.clientY - panStart.y)
      }
    },
    [dragging, isPanning, panStart, store],
  )

  const handleMouseUp = useCallback(() => {
    setDragging(null)
    setIsPanning(false)
  }, [])

  const handleDoubleClick = useCallback(
    (e: React.MouseEvent, nodeId?: string) => {
      if (nodeId) {
        const node = nodeMap.get(nodeId)
        if (node) {
          setEditingNode(nodeId)
          setEditText(node.text)
        }
      } else {
        // Add new node at click position
        const svg = svgRef.current
        if (!svg) return
        const pt = svg.createSVGPoint()
        pt.x = e.clientX; pt.y = e.clientY
        const svgP = pt.matrixTransform(svg.getScreenCTM()?.inverse())
        const newNode: CanvasNode = {
          id: uid(),
          x: svgP.x,
          y: svgP.y,
          width: 120,
          height: 40,
          text: '新节点',
          parentId: null,
          shape: project.mode === 'mindmap' ? 'rect' : 'rect',
          color: '#6366f1',
        }
        store.addNode(newNode)
      }
    },
    [nodeMap, project.mode, store],
  )

  const handleWheel = useCallback(
    (e: React.WheelEvent) => {
      e.preventDefault()
      const delta = e.deltaY > 0 ? 0.9 : 1.1
      const newZoom = Math.max(0.2, Math.min(3, zoom * delta))
      store.setZoom(newZoom)
    },
    [zoom, store],
  )

  const commitEdit = useCallback(() => {
    if (editingNode) {
      store.updateNode(editingNode, { text: editText })
      setEditingNode(null)
    }
  }, [editingNode, editText, store])

  // Mind map: add child
  const addChild = useCallback(
    (parentId: string) => {
      const parent = nodeMap.get(parentId)
      if (!parent) return
      const childId = uid()
      const child: CanvasNode = {
        id: childId,
        x: parent.x + 180,
        y: parent.y + (Math.random() - 0.5) * 100,
        width: 120,
        height: 40,
        text: '子节点',
        parentId,
        shape: 'rect',
        color: '#818cf8',
      }
      store.addNode(child)
      store.addEdge({ id: uid(), sourceId: parentId, targetId: childId, label: '' })
    },
    [nodeMap, store],
  )

  // Export SVG
  const exportSVG = useCallback(() => {
    const svg = svgRef.current
    if (!svg) return
    const serializer = new XMLSerializer()
    const svgStr = serializer.serializeToString(svg)
    const blob = new Blob([svgStr], { type: 'image/svg+xml' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url; a.download = `${project.name}.svg`; a.click()
    URL.revokeObjectURL(url)
  }, [project.name])

  // Export PNG
  const exportPNG = useCallback(() => {
    const svg = svgRef.current
    if (!svg) return
    const serializer = new XMLSerializer()
    const svgStr = serializer.serializeToString(svg)
    const canvas = document.createElement('canvas')
    canvas.width = 1600; canvas.height = 1000
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    const img = new Image()
    img.onload = () => {
      ctx.fillStyle = '#1e1e2e'
      ctx.fillRect(0, 0, canvas.width, canvas.height)
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height)
      const url = canvas.toDataURL('image/png')
      const a = document.createElement('a')
      a.href = url; a.download = `${project.name}.png`; a.click()
    }
    img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgStr)
  }, [project.name])

  return (
    <div className="flex-1 flex flex-col min-w-0">
      {/* Toolbar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-line bg-surface text-xs">
        <span className="font-semibold text-ink">{project.name}</span>
        <span className="text-ink-faint">({project.mode === 'mindmap' ? '思维导图' : '自由画布'})</span>
        <span className="flex-1" />
        {project.mode === 'freeform' && (
          <button
            className={['px-2 py-0.5 rounded transition-colors', connecting ? 'bg-primary text-white' : 'bg-surface-2 text-ink hover:bg-primary-tint'].join(' ')}
            onClick={() => setConnecting(connecting ? null : '__start__')}
            title="点击节点开始连线，再点另一节点完成"
          >
            {connecting ? '连线中...' : '连线'}
          </button>
        )}
        <button className="px-2 py-0.5 rounded bg-surface-2 text-ink hover:bg-primary-tint transition-colors" onClick={exportSVG}>导出 SVG</button>
        <button className="px-2 py-0.5 rounded bg-surface-2 text-ink hover:bg-primary-tint transition-colors" onClick={exportPNG}>导出 PNG</button>
        <span className="text-ink-faint">{Math.round(zoom * 100)}%</span>
      </div>

      {/* SVG Canvas */}
      <svg
        ref={svgRef}
        className="flex-1 cursor-crosshair"
        style={{ background: 'var(--color-editor, #1e1e2e)' }}
        onMouseDown={(e) => handleMouseDown(e)}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onMouseLeave={handleMouseUp}
        onDoubleClick={(e) => handleDoubleClick(e)}
        onWheel={handleWheel}
      >
        <g transform={`translate(${panX},${panY}) scale(${zoom})`}>
          {/* Edges */}
          {edges.map((e) => {
            const s = nodeMap.get(e.sourceId)
            const t = nodeMap.get(e.targetId)
            if (!s || !t) return null
            return (
              <g key={e.id}>
                <line
                  x1={s.x + s.width / 2} y1={s.y + s.height / 2}
                  x2={t.x + t.width / 2} y2={t.y + t.height / 2}
                  stroke="var(--color-line, #555)" strokeWidth={1.5}
                />
                {e.label && (
                  <text
                    x={(s.x + t.x + s.width) / 2} y={(s.y + t.y + s.height) / 2 - 6}
                    textAnchor="middle" fontSize={10} fill="var(--color-ink-faint, #888)"
                  >{e.label}</text>
                )}
              </g>
            )
          })}

          {/* Nodes */}
          {nodes.map((n) => (
            <g
              key={n.id}
              onMouseDown={(e) => { e.stopPropagation(); handleMouseDown(e, n.id) }}
              onDoubleClick={(e) => { e.stopPropagation(); handleDoubleClick(e, n.id) }}
              style={{ cursor: dragging?.nodeId === n.id ? 'grabbing' : 'grab' }}
            >
              {n.shape === 'ellipse' ? (
                <ellipse
                  cx={n.x + n.width / 2} cy={n.y + n.height / 2}
                  rx={n.width / 2} ry={n.height / 2}
                  fill={n.color + '33'} stroke={n.color} strokeWidth={1.5} rx2={8}
                />
              ) : (
                <rect
                  x={n.x} y={n.y} width={n.width} height={n.height}
                  rx={6} fill={n.color + '33'} stroke={n.color} strokeWidth={1.5}
                />
              )}
              {editingNode === n.id ? (
                <foreignObject x={n.x} y={n.y} width={n.width} height={n.height}>
                  <input
                    autoFocus
                    value={editText}
                    onChange={(e) => setEditText(e.target.value)}
                    onBlur={commitEdit}
                    onKeyDown={(e) => { if (e.key === 'Enter') commitEdit() }}
                    style={{
                      width: '100%', height: '100%', background: 'transparent',
                      border: 'none', color: 'white', textAlign: 'center',
                      fontSize: 12, outline: 'none',
                    }}
                  />
                </foreignObject>
              ) : (
                <text
                  x={n.x + n.width / 2} y={n.y + n.height / 2 + 4}
                  textAnchor="middle" fontSize={12} fill="var(--color-ink, #eee)"
                >{n.text}</text>
              )}

              {/* Mind map: add child button */}
              {project.mode === 'mindmap' && (
                <g
                  onClick={(e) => { e.stopPropagation(); addChild(n.id) }}
                  style={{ cursor: 'pointer' }}
                >
                  <circle cx={n.x + n.width + 8} cy={n.y + n.height / 2} r={8} fill="var(--color-surface-2, #333)" stroke="var(--color-primary, #6366f1)" strokeWidth={1} />
                  <text x={n.x + n.width + 8} y={n.y + n.height / 2 + 4} textAnchor="middle" fontSize={12} fill="var(--color-primary, #6366f1)">+</text>
                </g>
              )}

              {/* Delete button */}
              <g
                onClick={(e) => { e.stopPropagation(); store.removeNode(n.id) }}
                style={{ cursor: 'pointer' }}
                opacity={0.4}
              >
                <circle cx={n.x + n.width - 4} cy={n.y - 4} r={7} fill="var(--color-failed, #f44)" />
                <text x={n.x + n.width - 4} y={n.y} textAnchor="middle" fontSize={10} fill="white">×</text>
              </g>
            </g>
          ))}
        </g>
      </svg>

      {/* Hint */}
      <div className="px-3 py-1 border-t border-line bg-surface text-xs text-ink-faint">
        双击空白添加节点 | 双击节点编辑文本 | 拖拽移动节点 | 滚轮缩放
        {project.mode === 'mindmap' && ' | 点 + 添加子节点'}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Main Page
// ---------------------------------------------------------------------------

export default function Canvas() {
  const store = useCanvasStore()

  useEffect(() => {
    store._hydrate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const activeProject = store.projects.find((p) => p.id === store.activeProjectId)

  const handleCreate = useCallback(
    (mode: CanvasMode) => {
      const name = mode === 'mindmap' ? '新思维导图' : '新画布'
      store.createProject(name, mode)
    },
    [store],
  )

  return (
    <div className="flex h-full">
      <ProjectList
        projects={store.projects}
        activeId={store.activeProjectId}
        onSelect={(id) => store.setActiveProject(id)}
        onCreate={handleCreate}
        onDelete={(id) => store.deleteProject(id)}
      />
      {activeProject ? (
        <CanvasBoard project={activeProject} />
      ) : (
        <div className="flex-1 flex items-center justify-center text-sm text-ink-muted">
          选择或创建一个画布项目
        </div>
      )}
    </div>
  )
}