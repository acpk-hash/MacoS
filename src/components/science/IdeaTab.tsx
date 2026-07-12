/**
 * IdeaTab -- idea 思考(科研板块)
 *
 * 从知识库勾选若干条目 ->「生成 idea」:所选论文的元数据 + notes +
 * (有分析报告的带上摘录)交给模型,产出 Markdown 研究 idea 清单
 * (MarkdownLite 预览 + 导出 + 自动存 kb_root/ideas/)。
 * 下方对话框可针对 idea 继续追问(多轮,同一会话上下文保留)。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import MarkdownLite from '../ui/MarkdownLite'
import { Mascot } from '../ui'
import { useWorkbenchStore } from '../../stores/workbenchStore'
import { useKbStore } from '../../stores/kbStore'
import { useScienceStore } from '../../stores/scienceStore'
import { saveExport } from '../../lib/exportChat'

const DEFAULT_INSTRUCTION = ''

export default function IdeaTab() {
  const kbPapers = useKbStore((s) => s.papers)
  const papersLoading = useKbStore((s) => s.papersLoading)

  const modelKey = useScienceStore((s) => s.modelKey)
  const setModelKey = useScienceStore((s) => s.setModelKey)
  const ideaMd = useScienceStore((s) => s.ideaMd)
  const ideaGenerating = useScienceStore((s) => s.ideaGenerating)
  const ideaSavedPath = useScienceStore((s) => s.ideaSavedPath)
  const ideaError = useScienceStore((s) => s.ideaError)
  const ideaSessionId = useScienceStore((s) => s.ideaSessionId)
  const ideaMessages = useScienceStore((s) => s.ideaMessages)
  const ideaStreaming = useScienceStore((s) => s.ideaStreaming)
  const ideaStreamText = useScienceStore((s) => s.ideaStreamText)
  const generateIdeas = useScienceStore((s) => s.generateIdeas)
  const ideaAsk = useScienceStore((s) => s.ideaAsk)
  const resetIdea = useScienceStore((s) => s.resetIdea)

  const aggModels = useWorkbenchStore((s) => s.aggModels)
  const modelsLoaded = useWorkbenchStore((s) => s.modelsLoaded)
  const loadModels = useWorkbenchStore((s) => s.loadModels)

  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [instruction, setInstruction] = useState(DEFAULT_INSTRUCTION)
  const [question, setQuestion] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!modelsLoaded) void loadModels()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const chatModels = useMemo(
    () => aggModels.filter((m) => (m.kind ?? 'chat') === 'chat'),
    [aggModels],
  )

  useEffect(() => {
    if (!modelKey && chatModels.length > 0) {
      const preferred = chatModels.find((m) => m.modelId === 'gpt-5.5') ?? chatModels[0]
      setModelKey(preferred.providerId + '|' + preferred.modelId)
    }
  }, [chatModels, modelKey, setModelKey])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [ideaMessages.length, ideaStreamText, ideaMd])

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const doGenerate = () => {
    if (selected.size === 0 || ideaGenerating) return
    void generateIdeas(Array.from(selected), instruction)
  }

  const doAsk = () => {
    const q = question.trim()
    if (!q || ideaStreaming || !ideaSessionId) return
    setQuestion('')
    void ideaAsk(q)
  }

  const toolBtn =
    'text-[11.5px] px-2.5 py-1 rounded-md bg-surface-2 border border-line text-ink hover:bg-elevated transition-colors disabled:opacity-40'
  const selectCls =
    'bg-surface border border-line rounded-lg px-2 py-1 text-[12px] text-ink focus:outline-none focus:border-primary transition-colors'

  return (
    <div className="flex-1 min-h-0 flex overflow-hidden">
      {/* 左:知识库条目多选 */}
      <div className="w-80 flex-shrink-0 border-r border-line flex flex-col bg-surface/20">
        <div className="px-3 py-2 border-b border-line/60 flex-shrink-0 flex items-center gap-2">
          <span className="text-[11.5px] text-ink-dim flex-1">
            知识库条目({papersLoading ? '加载中…' : kbPapers.length})
          </span>
          <button onClick={() => setSelected(new Set(kbPapers.map((p) => p.id)))} className={toolBtn}>
            全选
          </button>
          <button onClick={() => setSelected(new Set())} className={toolBtn}>
            清空
          </button>
        </div>
        <div className="flex-1 overflow-y-auto py-1">
          {kbPapers.length === 0 && !papersLoading ? (
            <p className="px-3 py-4 text-[11.5px] text-ink-dim leading-5">
              知识库为空。先在「知识库」导入论文,或在「文献搜索」一键入库。
            </p>
          ) : (
            kbPapers.map((p) => (
              <label
                key={p.id}
                className="flex items-start gap-2 px-3 py-1.5 cursor-pointer hover:bg-surface-2/60 transition-colors"
              >
                <input
                  type="checkbox"
                  checked={selected.has(p.id)}
                  onChange={() => toggle(p.id)}
                  className="mt-0.5 h-3.5 w-3.5 accent-primary flex-shrink-0"
                />
                <span className="min-w-0">
                  <span className="block text-[12px] text-ink leading-5 break-words">
                    {p.title || p.orig_filename || '无标题'}
                  </span>
                  <span className="flex flex-wrap gap-1.5 mt-0.5 text-[10px] text-ink-dim">
                    {p.year && <span>{p.year}</span>}
                    {p.analyzed === 1 && (
                      <span className="px-1 py-px rounded bg-primary-tint text-primary">已详析</span>
                    )}
                  </span>
                </span>
              </label>
            ))
          )}
        </div>
        <div className="border-t border-line px-3 py-2 flex-shrink-0 space-y-1.5">
          <textarea
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            rows={2}
            placeholder="附加要求(可选,如「偏向可四个月完成的小论文」)"
            className="w-full bg-surface border border-line rounded-lg px-2.5 py-1.5 text-[11.5px] text-ink placeholder-ink-dim focus:outline-none focus:border-primary transition-colors resize-none"
          />
          <div className="flex items-center gap-2">
            <select
              value={modelKey}
              onChange={(e) => setModelKey(e.target.value)}
              className={selectCls + ' flex-1 min-w-0'}
            >
              {chatModels.length === 0 && <option value="">无可用模型</option>}
              {chatModels.map((m) => (
                <option key={m.providerId + '|' + m.modelId} value={m.providerId + '|' + m.modelId}>
                  {m.providerLabel} · {m.modelId}
                </option>
              ))}
            </select>
            <button
              onClick={doGenerate}
              disabled={ideaGenerating || selected.size === 0 || !modelKey}
              className="text-[12px] px-3.5 py-1.5 rounded-md bg-primary text-white hover:bg-primary/90 disabled:opacity-40 transition-colors whitespace-nowrap"
            >
              {ideaGenerating ? '生成中…' : '生成 idea(' + selected.size + ')'}
            </button>
          </div>
        </div>
      </div>

      {/* 右:idea 清单 + 追问对话 */}
      <div className="flex-1 min-w-0 flex flex-col">
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto px-4 py-3 space-y-3">
          {ideaError && <p className="text-[12px] text-failed">{ideaError}</p>}
          {!ideaMd && !ideaGenerating && !ideaError && (
            <div className="h-full flex flex-col items-center justify-center text-center py-12">
              <Mascot mood="idle" size={64} className="mb-3" />
              <p className="text-ink-muted text-sm">从左侧勾选知识库条目,生成研究 idea 清单</p>
              <p className="text-ink-dim text-xs mt-1 leading-5 max-w-md">
                会带上所选论文的元数据与笔记;已生成分析报告(「已详析」)的论文
                会附上报告摘录,idea 依据更扎实。生成后可继续追问打磨。
              </p>
            </div>
          )}
          {(ideaMd || ideaGenerating) && (
            <div className="bg-surface border border-line rounded-card shadow-card p-4">
              <div className="flex items-center gap-2 mb-2">
                <span className="text-[12px] font-semibold text-ink flex-1">研究 idea 清单</span>
                {ideaGenerating && (
                  <span className="w-3 h-3 rounded-full border-2 border-primary border-t-transparent animate-spin" />
                )}
                {ideaMd && !ideaGenerating && (
                  <>
                    <button
                      onClick={() => void saveExport('研究idea清单', 'md', ideaMd)}
                      className={toolBtn}
                    >
                      导出 .md
                    </button>
                    <button onClick={resetIdea} className={toolBtn}>
                      清空重来
                    </button>
                  </>
                )}
              </div>
              {ideaSavedPath && (
                <p className="text-[10.5px] text-done mb-2 break-all">已存入 {ideaSavedPath}</p>
              )}
              {ideaMd ? (
                <MarkdownLite text={ideaMd} />
              ) : (
                <p className="text-[12px] text-ink-dim">正在整理资料并生成…</p>
              )}
            </div>
          )}
          {ideaMessages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[80%] bg-primary-tint text-ink rounded-lg px-3 py-1.5 text-[12px] leading-5 whitespace-pre-wrap">
                  {m.content}
                </div>
              </div>
            ) : (
              <div key={i} className="bg-surface border border-line rounded-lg px-3 py-2">
                <MarkdownLite text={m.content} />
              </div>
            ),
          )}
          {ideaStreaming && (
            <div className="bg-surface border border-line rounded-lg px-3 py-2">
              {ideaStreamText ? (
                <MarkdownLite text={ideaStreamText} />
              ) : (
                <span className="text-[11.5px] text-ink-dim">思考中…</span>
              )}
            </div>
          )}
        </div>

        <div className="border-t border-line px-4 py-2 flex-shrink-0">
          <div className="flex gap-2">
            <textarea
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault()
                  doAsk()
                }
              }}
              rows={2}
              disabled={!ideaSessionId || ideaGenerating}
              placeholder={
                ideaSessionId
                  ? '针对 idea 继续追问(多轮,上下文保留;Enter 发送)'
                  : '先生成 idea 清单,再在这里追问'
              }
              className="flex-1 bg-surface border border-line rounded-lg px-2.5 py-1.5 text-[12px] text-ink placeholder-ink-dim focus:outline-none focus:border-primary transition-colors resize-none disabled:opacity-50"
            />
            <button
              onClick={doAsk}
              disabled={!ideaSessionId || ideaStreaming || ideaGenerating || !question.trim()}
              className="text-[12px] px-3.5 rounded-md bg-primary text-white hover:bg-primary/90 disabled:opacity-40 transition-colors"
            >
              发送
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
