// MCP 安装对话框：预填 command/args，env 配置表单，确认安装。
import { Button } from '../ui'
import { useMcpStore } from '../../stores/mcpStore'

export default function McpInstallDialog() {
  const entry = useMcpStore((s) => s.installDialogEntry)
  const env = useMcpStore((s) => s.installDialogEnv)
  const args = useMcpStore((s) => s.installDialogArgs)
  const installing = useMcpStore((s) => s.installing)
  const close = useMcpStore((s) => s.closeInstallDialog)
  const setEnvVar = useMcpStore((s) => s.setInstallEnvVar)
  const setArgs = useMcpStore((s) => s.setInstallArgs)
  const confirm = useMcpStore((s) => s.confirmInstall)

  if (!entry) return null

  const envKeys = Object.keys(env)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <div className="w-full max-w-lg rounded-pop border border-line bg-elevated p-5 shadow-pop">
        <h3 className="text-[15px] font-semibold text-ink">
          安装 {entry.name}
        </h3>
        <p className="mt-1 text-[11.5px] text-ink-muted">{entry.description}</p>

        {/* 命令预览 */}
        <div className="mt-4">
          <label className="block text-[11px] font-medium text-ink-dim mb-1">启动命令</label>
          <div className="rounded-card border border-line bg-surface px-3 py-2 font-mono text-[11px] text-ink-muted">
            {entry.default_command}
          </div>
        </div>

        {/* 参数 */}
        <div className="mt-3">
          <label className="block text-[11px] font-medium text-ink-dim mb-1">参数</label>
          <input
            type="text"
            className="w-full rounded-card border border-line bg-surface px-3 py-2 font-mono text-[11px] text-ink
                       focus:border-primary focus:outline-none transition-colors"
            value={args.join(' ')}
            onChange={(e) => setArgs(e.target.value.split(/\s+/).filter(Boolean))}
          />
        </div>

        {/* 环境变量 */}
        {envKeys.length > 0 && (
          <div className="mt-4">
            <p className="text-[11px] font-medium text-ink-dim mb-2">环境变量（API Key 等）</p>
            <div className="flex flex-col gap-2">
              {envKeys.map((k) => {
                const hint = entry.env_hints.find(([ek]) => ek === k)?.[1] ?? ''
                return (
                  <div key={k}>
                    <label className="block text-[10.5px] text-ink-muted mb-0.5">{k}</label>
                    <input
                      type="text"
                      placeholder={hint}
                      className="w-full rounded-card border border-line bg-surface px-3 py-1.5 font-mono text-[11px] text-ink
                                 placeholder:text-ink-faint focus:border-primary focus:outline-none transition-colors"
                      value={env[k]}
                      onChange={(e) => setEnvVar(k, e.target.value)}
                    />
                  </div>
                )
              })}
            </div>
          </div>
        )}

        {/* 操作按钮 */}
        <div className="mt-5 flex items-center justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={close} disabled={!!installing}>
            取消
          </Button>
          <Button size="sm" variant="primary" onClick={() => void confirm()} disabled={!!installing}>
            {installing ? '安装中...' : '确认安装'}
          </Button>
        </div>
      </div>
    </div>
  )
}
