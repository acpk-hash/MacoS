// 当前 pi 会话用量 — 只读 piStore（usageById + sessions），仅本次运行期（内存）数据。

import { usePiStore, type PiSessionStatus } from '../../stores/piStore'
import { fmtCost, fmtTokens } from './format'

const PI_STATUS_LABEL: Record<PiSessionStatus, string> = {
  idle: '空闲',
  running: '运行中',
  done: '已完成',
  error: '出错',
}

function piStatusClass(s: PiSessionStatus): string {
  if (s === 'error') return 'bg-[#f851491f] text-failed'
  if (s === 'running') return 'bg-[#5b8cff1f] text-running'
  if (s === 'done') return 'bg-[#3fb9501f] text-done'
  return 'bg-elevated/60 text-ink-muted'
}

export default function PiSessionUsageTable() {
  const sessions = usePiStore((s) => s.sessions)
  const usageById = usePiStore((s) => s.usageById)

  if (sessions.length === 0) {
    return (
      <div className="text-[12px] text-ink-dim">
        本次运行还没有 pi 会话。在「会话」页开始对话后，各会话的 token 与费用会实时出现在这里。
      </div>
    )
  }

  const totals = sessions.reduce(
    (acc, sess) => {
      const u = usageById[sess.id]
      if (!u) return acc
      acc.input += u.input
      acc.output += u.output
      acc.cacheRead += u.cacheRead
      acc.cacheWrite += u.cacheWrite
      acc.cost += u.cost
      acc.turns += u.turns
      return acc
    },
    { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 },
  )

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[12px]">
        <thead>
          <tr className="text-left text-[10.5px] text-ink-dim border-b border-line">
            <th className="py-2 pr-3 font-medium">会话</th>
            <th className="py-2 pr-3 font-medium">模型</th>
            <th className="py-2 pr-3 font-medium text-right">输入</th>
            <th className="py-2 pr-3 font-medium text-right">输出</th>
            <th className="py-2 pr-3 font-medium text-right">缓存读</th>
            <th className="py-2 pr-3 font-medium text-right">缓存写</th>
            <th className="py-2 pr-3 font-medium text-right">轮次</th>
            <th className="py-2 pr-3 font-medium text-right">费用</th>
            <th className="py-2 font-medium">状态</th>
          </tr>
        </thead>
        <tbody>
          {sessions.map((sess) => {
            const u = usageById[sess.id]
            return (
              <tr
                key={sess.id}
                className="border-b border-line/60 hover:bg-surface/60 transition-colors"
              >
                <td className="py-2 pr-3 max-w-[220px]">
                  <span className="text-ink line-clamp-1 break-all" title={sess.title}>
                    {sess.title || '新会话'}
                  </span>
                </td>
                <td className="py-2 pr-3 font-mono text-ink-muted whitespace-nowrap">
                  {sess.model || '—'}
                </td>
                <td className="py-2 pr-3 font-mono tabular-nums text-right text-ink whitespace-nowrap">
                  {u ? fmtTokens(u.input) : '—'}
                </td>
                <td className="py-2 pr-3 font-mono tabular-nums text-right text-ink whitespace-nowrap">
                  {u ? fmtTokens(u.output) : '—'}
                </td>
                <td className="py-2 pr-3 font-mono tabular-nums text-right text-ink-muted whitespace-nowrap">
                  {u ? fmtTokens(u.cacheRead) : '—'}
                </td>
                <td className="py-2 pr-3 font-mono tabular-nums text-right text-ink-muted whitespace-nowrap">
                  {u ? fmtTokens(u.cacheWrite) : '—'}
                </td>
                <td className="py-2 pr-3 tabular-nums text-right text-ink-muted whitespace-nowrap">
                  {u ? u.turns : '—'}
                </td>
                <td className="py-2 pr-3 font-mono tabular-nums text-right text-ink whitespace-nowrap">
                  {u ? fmtCost(u.cost) : '—'}
                </td>
                <td className="py-2 whitespace-nowrap">
                  <span
                    className={
                      'text-[10px] px-1.5 py-0.5 rounded ' + piStatusClass(sess.status)
                    }
                  >
                    {PI_STATUS_LABEL[sess.status]}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
        <tfoot>
          <tr className="text-[11.5px] font-medium border-t border-line">
            <td className="py-2 pr-3 text-ink-muted">合计（{sessions.length} 个会话）</td>
            <td className="py-2 pr-3" />
            <td className="py-2 pr-3 font-mono tabular-nums text-right text-ink whitespace-nowrap">
              {fmtTokens(totals.input)}
            </td>
            <td className="py-2 pr-3 font-mono tabular-nums text-right text-ink whitespace-nowrap">
              {fmtTokens(totals.output)}
            </td>
            <td className="py-2 pr-3 font-mono tabular-nums text-right text-ink-muted whitespace-nowrap">
              {fmtTokens(totals.cacheRead)}
            </td>
            <td className="py-2 pr-3 font-mono tabular-nums text-right text-ink-muted whitespace-nowrap">
              {fmtTokens(totals.cacheWrite)}
            </td>
            <td className="py-2 pr-3 tabular-nums text-right text-ink-muted whitespace-nowrap">
              {totals.turns}
            </td>
            <td className="py-2 pr-3 font-mono tabular-nums text-right text-ink whitespace-nowrap">
              {fmtCost(totals.cost)}
            </td>
            <td className="py-2" />
          </tr>
        </tfoot>
      </table>
    </div>
  )
}
