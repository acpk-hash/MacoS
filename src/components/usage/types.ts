// 用量板块类型 — 与 src-tauri/src/stats.rs、sediment.rs（RunSummary）逐字段对应。

export interface StatsOverview {
  total_runs: number
  board_tasks: number
  workbench_sessions: number
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  total_tokens: number
  active_days: number
  avg_tokens_per_run: number
}

export interface TokenSeriesPoint {
  date: string // YYYY-MM-DD（本地时区）
  input: number
  output: number
  total: number
  runs: number
}

export interface ModelStat {
  model: string
  runs: number
  input: number
  output: number
  total: number
}

/** 后端 sediment::RunSummary（stats_recent_runs 返回值）。 */
export interface RecentRun {
  id: string
  kind: 'board' | 'workbench'
  title: string
  cwd: string
  model?: string
  total_tokens?: number
  files_changed: number
  duration_ms?: number
  status: string
  created_at: number
}
