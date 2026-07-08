// SSH 远程面板（G2c）— 底部面板「SSH」标签的内容。
// 左：连接表单 + 已连主机 + 记住的主机；右：远程命令终端（ssh_exec）。
// 凭据只在提交时传给 ssh_connect，随后从表单里清除，绝不留存/落库。
import { useState, type FormEvent } from 'react'
import { useSshStore, type SshAuthKind } from '../../stores/sshStore'
import { useWorkspaceStore } from '../../stores/workspaceStore'
import StatusDot from '../ui/StatusDot'

interface FormState {
  host: string
  port: number
  user: string
  authKind: SshAuthKind
  password: string
  keyPath: string
  passphrase: string
  remember: boolean
}

const EMPTY_FORM: FormState = {
  host: '',
  port: 22,
  user: '',
  authKind: 'password',
  password: '',
  keyPath: '',
  passphrase: '',
  remember: false,
}

export default function SshPanel() {
  const conns = useSshStore((s) => s.conns)
  const connecting = useSshStore((s) => s.connecting)
  const savedHosts = useSshStore((s) => s.savedHosts)
  const connect = useSshStore((s) => s.connect)
  const disconnect = useSshStore((s) => s.disconnect)
  const termConnId = useSshStore((s) => s.termConnId)
  const termLines = useSshStore((s) => s.termLines)
  const termRunning = useSshStore((s) => s.termRunning)
  const runExec = useSshStore((s) => s.runExec)
  const setTermConn = useSshStore((s) => s.setTermConn)
  const removeSaved = useSshStore((s) => s.removeSaved)

  const openRemote = useWorkspaceStore((s) => s.openRemote)
  const remote = useWorkspaceStore((s) => s.remote)
  const switchToLocal = useWorkspaceStore((s) => s.switchToLocal)

  const [showForm, setShowForm] = useState(true)
  const [form, setForm] = useState<FormState>(EMPTY_FORM)
  const [cmd, setCmd] = useState('')

  const upd = <K extends keyof FormState>(k: K, v: FormState[K]) =>
    setForm((f) => ({ ...f, [k]: v }))

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const conn = await connect({
      host: form.host,
      port: form.port,
      user: form.user,
      authKind: form.authKind,
      password: form.password,
      keyPath: form.keyPath,
      passphrase: form.passphrase,
      remember: form.remember,
    })
    // Always drop secrets from the form after an attempt.
    setForm((f) => ({ ...f, password: '', passphrase: '' }))
    if (conn) {
      setShowForm(false)
      await openRemote({
        connId: conn.conn_id,
        host: conn.host,
        user: conn.user,
        root: conn.root,
      })
    }
  }

  const runTerm = async (e: FormEvent) => {
    e.preventDefault()
    if (!termConnId || !cmd.trim()) return
    const c = cmd
    setCmd('')
    await runExec(termConnId, c)
  }

  const inputCls =
    'w-full bg-surface-2 border border-line rounded-input px-2 py-1 text-[12px] text-ink placeholder:text-ink-dim focus:outline-none focus:border-line-strong min-w-0'

  return (
    <div className="flex gap-3 h-full min-h-0 text-[12px]">
      {/* ── 左：连接 + 主机 ─────────────────────────────── */}
      <div className="w-64 flex-shrink-0 flex flex-col gap-2 overflow-y-auto pr-1">
        {/* 当前数据源提示 */}
        <div className="flex items-center gap-1.5 text-[11px]">
          <span className="text-ink-dim">当前文件树：</span>
          {remote ? (
            <>
              <StatusDot status="running" size={7} />
              <span className="text-sky truncate">{remote.user}@{remote.host}</span>
              <button
                onClick={() => void switchToLocal()}
                className="ml-auto text-ink-dim hover:text-ink underline"
                title="切回本地文件树"
              >
                切回本地
              </button>
            </>
          ) : (
            <span className="text-ink-muted">本地</span>
          )}
        </div>

        {/* 已连接主机 */}
        {conns.length > 0 && (
          <div className="flex flex-col gap-1">
            {conns.map((c) => {
              const active = remote?.connId === c.conn_id
              return (
                <div
                  key={c.conn_id}
                  className="flex items-center gap-1.5 px-2 py-1.5 rounded-md glass border border-line"
                >
                  <StatusDot status={active ? 'running' : 'done'} size={7} />
                  <span className="truncate flex-1 text-ink" title={`${c.user}@${c.host}:${c.port}`}>
                    {c.user}@{c.host}
                  </span>
                  <button
                    onClick={() =>
                      void openRemote({ connId: c.conn_id, host: c.host, user: c.user, root: c.root })
                    }
                    className="text-[11px] text-sky hover:text-lavender"
                    title="在文件树浏览此主机"
                  >
                    浏览
                  </button>
                  <button
                    onClick={() => void disconnect(c.conn_id)}
                    className="text-[11px] text-ink-dim hover:text-coral"
                    title="断开连接"
                  >
                    断开
                  </button>
                </div>
              )
            })}
          </div>
        )}

        <button
          onClick={() => setShowForm((v) => !v)}
          className="text-[11px] text-ink-dim hover:text-sakura self-start"
        >
          {showForm ? '收起表单' : '＋ 新建连接'}
        </button>

        {/* 连接表单 */}
        {showForm && (
          <form onSubmit={submit} className="flex flex-col gap-1.5 p-2 rounded-card glass border border-line">
            <div className="flex gap-1.5">
              <input
                className={inputCls}
                placeholder="主机 host"
                value={form.host}
                onChange={(e) => upd('host', e.target.value)}
              />
              <input
                className={`${inputCls} w-16 flex-shrink-0`}
                type="number"
                placeholder="端口"
                value={form.port}
                onChange={(e) => upd('port', Number(e.target.value) || 22)}
              />
            </div>
            <input
              className={inputCls}
              placeholder="用户名 user"
              value={form.user}
              onChange={(e) => upd('user', e.target.value)}
            />
            <div className="flex gap-2 text-[11px] text-ink-muted">
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  checked={form.authKind === 'password'}
                  onChange={() => upd('authKind', 'password')}
                />
                密码
              </label>
              <label className="flex items-center gap-1 cursor-pointer">
                <input
                  type="radio"
                  checked={form.authKind === 'key'}
                  onChange={() => upd('authKind', 'key')}
                />
                密钥
              </label>
            </div>
            {form.authKind === 'password' ? (
              <input
                className={inputCls}
                type="password"
                placeholder="密码（不保存）"
                autoComplete="off"
                value={form.password}
                onChange={(e) => upd('password', e.target.value)}
              />
            ) : (
              <>
                <input
                  className={inputCls}
                  placeholder="私钥路径，如 C:\Users\me\.ssh\id_ed25519"
                  value={form.keyPath}
                  onChange={(e) => upd('keyPath', e.target.value)}
                />
                <input
                  className={inputCls}
                  type="password"
                  placeholder="passphrase（可空，不保存）"
                  autoComplete="off"
                  value={form.passphrase}
                  onChange={(e) => upd('passphrase', e.target.value)}
                />
              </>
            )}
            <label className="flex items-center gap-1.5 text-[11px] text-ink-dim cursor-pointer">
              <input
                type="checkbox"
                checked={form.remember}
                onChange={(e) => upd('remember', e.target.checked)}
              />
              记住主机（仅保存 host/端口/用户/密钥路径，绝不保存密码）
            </label>
            <button
              type="submit"
              disabled={connecting}
              className="mt-0.5 px-3 py-1.5 rounded-btn bg-grad-primary text-white text-[12px] font-medium shadow-glow-primary hover:-translate-y-px transition-all disabled:opacity-40"
            >
              {connecting ? '连接中…' : '连接'}
            </button>
          </form>
        )}

        {/* 记住的主机 */}
        {savedHosts.length > 0 && (
          <div className="flex flex-col gap-1 mt-1">
            <div className="text-[11px] text-ink-dim">记住的主机</div>
            {savedHosts.map((h) => (
              <div
                key={`${h.user}@${h.host}:${h.port}`}
                className="flex items-center gap-1.5 px-2 py-1 rounded-md hover:bg-surface-2"
              >
                <button
                  onClick={() => {
                    setShowForm(true)
                    setForm({
                      ...EMPTY_FORM,
                      host: h.host,
                      port: h.port,
                      user: h.user,
                      authKind: h.authKind,
                      keyPath: h.keyPath ?? '',
                    })
                  }}
                  className="truncate flex-1 text-left text-ink-muted hover:text-ink text-[11px]"
                  title="填入连接表单"
                >
                  {h.user}@{h.host}:{h.port}
                </button>
                <button
                  onClick={() => void removeSaved(h.host, h.user, h.port)}
                  className="text-[11px] text-ink-dim hover:text-coral"
                  title="忘记此主机"
                >
                  ✕
                </button>
              </div>
            ))}
          </div>
        )}

        <p className="text-[10.5px] text-ink-dim/80 leading-4 mt-1">
          说明：可连 SSH、浏览/编辑远程文件、跑远程命令；暂不支持在远程运行 AI
          代理（需远程安装 pi，后续评估）。
        </p>
      </div>

      {/* ── 右：远程终端 ───────────────────────────────── */}
      <div className="flex-1 min-w-0 flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-ink-muted">远程终端</span>
          {conns.length > 0 ? (
            <select
              value={termConnId ?? ''}
              onChange={(e) => setTermConn(e.target.value)}
              className="bg-surface-2 border border-line rounded-input px-1.5 py-0.5 text-[11px] text-ink-muted focus:outline-none max-w-[180px]"
            >
              {conns.map((c) => (
                <option key={c.conn_id} value={c.conn_id}>
                  {c.user}@{c.host}
                </option>
              ))}
            </select>
          ) : (
            <span className="text-[11px] text-ink-dim">未连接</span>
          )}
          {termRunning && <span className="text-[11px] text-lavender animate-pulse">运行中…</span>}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto rounded-card bg-surface-2 border border-line p-2 font-mono text-[12px] leading-relaxed">
          {termLines.length === 0 ? (
            <p className="text-ink-dim text-center mt-4">
              {conns.length === 0 ? '先在左侧连接一个主机' : '在下方输入命令并回车'}
            </p>
          ) : (
            termLines.map((l) => (
              <div key={l.id} className="mb-2">
                <div className="text-mint">
                  <span className="text-ink-dim">$ </span>
                  {l.cmd}
                  {l.exit !== 0 && <span className="text-coral"> (exit {l.exit})</span>}
                </div>
                {l.stdout.trim() && (
                  <pre className="text-ink-muted whitespace-pre-wrap break-words mt-0.5">{l.stdout}</pre>
                )}
                {l.stderr.trim() && (
                  <pre className="text-coral/90 whitespace-pre-wrap break-words mt-0.5">{l.stderr}</pre>
                )}
              </div>
            ))
          )}
        </div>

        <form onSubmit={runTerm} className="flex items-center gap-1.5">
          <span className="text-ink-dim font-mono text-[12px]">$</span>
          <input
            className={inputCls}
            placeholder={termConnId ? '远程命令，如 ls -la' : '先连接主机'}
            value={cmd}
            disabled={!termConnId || termRunning}
            onChange={(e) => setCmd(e.target.value)}
          />
          <button
            type="submit"
            disabled={!termConnId || termRunning || !cmd.trim()}
            className="px-3 py-1 rounded-btn bg-surface-2 hover:bg-[#e9eef5] border border-line text-[12px] text-ink disabled:opacity-40"
          >
            运行
          </button>
        </form>
      </div>
    </div>
  )
}
