//! M2 运行统计: read-only aggregation over runs + token usage that other
//! features already collected. This module NEVER writes to any table and
//! NEVER adds schema — it only reads `tasks` (codex 看板) and
//! `workbench_sessions` / `workbench_stats` (pi 工作台) to power the
//! dashboard (概览) page: KPI totals, a per-day token time series, and a
//! per-model breakdown.
//!
//! Note on cost: `workbench_stats` stores token counts only (no cost column),
//! so no monetary aggregation is exposed here.

use rusqlite::{Connection, Result as SqlResult};
use serde::Serialize;

use crate::db::Db;

// ── Public row types ──────────────────────────────────────────────────────────

/// Aggregate KPI numbers for the dashboard header cards.
#[derive(Debug, Clone, Serialize)]
pub struct StatsOverview {
    /// Board tasks + workbench sessions combined.
    pub total_runs: i64,
    pub board_tasks: i64,
    pub workbench_sessions: i64,
    /// Token sums over all `workbench_stats` rows (board runs record token
    /// usage only in raw events, so they are not included here).
    pub input_tokens: i64,
    pub output_tokens: i64,
    pub cache_read_tokens: i64,
    pub cache_write_tokens: i64,
    pub total_tokens: i64,
    /// Distinct local calendar days with at least one run (board or workbench).
    pub active_days: i64,
    /// `total_tokens / #sessions-with-stats` (0 when nothing recorded yet).
    pub avg_tokens_per_run: i64,
}

/// One per-day bucket of the token consumption time series.
#[derive(Debug, Clone, Serialize)]
pub struct TokenSeriesPoint {
    /// Local calendar day, `YYYY-MM-DD`.
    pub date: String,
    pub input: i64,
    pub output: i64,
    pub total: i64,
    /// Workbench sessions started that day (with or without stats).
    pub runs: i64,
}

/// Token usage + run count grouped by workbench model.
#[derive(Debug, Clone, Serialize)]
pub struct ModelStat {
    /// Model name as recorded on the session (may be empty for old rows).
    pub model: String,
    pub runs: i64,
    pub input: i64,
    pub output: i64,
    pub total: i64,
}

// ── Overview ──────────────────────────────────────────────────────────────────

/// KPI totals for the dashboard header.
pub fn overview(db: &Db) -> Result<StatsOverview, String> {
    let conn = db.conn.lock().unwrap();
    overview_inner(&conn).map_err(|e| e.to_string())
}

fn overview_inner(conn: &Connection) -> SqlResult<StatsOverview> {
    let board_tasks: i64 =
        conn.query_row("SELECT COUNT(*) FROM tasks", [], |r| r.get(0))?;
    let workbench_sessions: i64 =
        conn.query_row("SELECT COUNT(*) FROM workbench_sessions", [], |r| r.get(0))?;

    type TokenSums = (i64, i64, i64, i64, i64, i64);
    let (input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, total_tokens, stat_rows): TokenSums =
        conn.query_row(
            "SELECT COALESCE(SUM(input), 0), COALESCE(SUM(output), 0), \
                    COALESCE(SUM(cache_read), 0), COALESCE(SUM(cache_write), 0), \
                    COALESCE(SUM(total), 0), COUNT(*) \
             FROM workbench_stats",
            [],
            |r| {
                Ok((
                    r.get(0)?,
                    r.get(1)?,
                    r.get(2)?,
                    r.get(3)?,
                    r.get(4)?,
                    r.get(5)?,
                ))
            },
        )?;

    // Distinct local calendar days that saw a board task or workbench session.
    let active_days: i64 = conn.query_row(
        "SELECT COUNT(*) FROM ( \
           SELECT date(created_at / 1000, 'unixepoch', 'localtime') AS d \
           FROM workbench_sessions \
           UNION \
           SELECT date(created_at / 1000, 'unixepoch', 'localtime') \
           FROM tasks \
         )",
        [],
        |r| r.get(0),
    )?;

    let avg_tokens_per_run = if stat_rows > 0 { total_tokens / stat_rows } else { 0 };

    Ok(StatsOverview {
        total_runs: board_tasks + workbench_sessions,
        board_tasks,
        workbench_sessions,
        input_tokens,
        output_tokens,
        cache_read_tokens,
        cache_write_tokens,
        total_tokens,
        active_days,
        avg_tokens_per_run,
    })
}

// ── Token time series ─────────────────────────────────────────────────────────

/// Per-day token consumption series (ascending by date). `bucket` currently
/// only supports `"day"` (the default when `None`).
pub fn token_series(db: &Db, bucket: Option<&str>) -> Result<Vec<TokenSeriesPoint>, String> {
    match bucket {
        None | Some("day") => {}
        Some(other) => {
            return Err(format!("不支持的时间粒度: {other}（目前仅支持 day）"));
        }
    }
    let conn = db.conn.lock().unwrap();
    token_series_by_day(&conn).map_err(|e| e.to_string())
}

fn token_series_by_day(conn: &Connection) -> SqlResult<Vec<TokenSeriesPoint>> {
    let mut stmt = conn.prepare(
        "SELECT date(ws.created_at / 1000, 'unixepoch', 'localtime') AS day, \
                COALESCE(SUM(st.input), 0), \
                COALESCE(SUM(st.output), 0), \
                COALESCE(SUM(st.total), 0), \
                COUNT(*) \
         FROM workbench_sessions ws \
         LEFT JOIN workbench_stats st ON st.session_id = ws.id \
         GROUP BY day \
         ORDER BY day ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(TokenSeriesPoint {
            date: r.get(0)?,
            input: r.get(1)?,
            output: r.get(2)?,
            total: r.get(3)?,
            runs: r.get(4)?,
        })
    })?;
    rows.collect()
}

// ── Per-model breakdown ───────────────────────────────────────────────────────

/// Token usage + run count grouped by workbench model, biggest consumer first.
pub fn by_model(db: &Db) -> Result<Vec<ModelStat>, String> {
    let conn = db.conn.lock().unwrap();
    by_model_inner(&conn).map_err(|e| e.to_string())
}

fn by_model_inner(conn: &Connection) -> SqlResult<Vec<ModelStat>> {
    let mut stmt = conn.prepare(
        "SELECT ws.model, \
                COUNT(*), \
                COALESCE(SUM(st.input), 0), \
                COALESCE(SUM(st.output), 0), \
                COALESCE(SUM(st.total), 0) AS total \
         FROM workbench_sessions ws \
         LEFT JOIN workbench_stats st ON st.session_id = ws.id \
         GROUP BY ws.model \
         ORDER BY total DESC, COUNT(*) DESC, ws.model ASC",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok(ModelStat {
            model: r.get(0)?,
            runs: r.get(1)?,
            input: r.get(2)?,
            output: r.get(3)?,
            total: r.get(4)?,
        })
    })?;
    rows.collect()
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn new_db() -> Db {
        Db::open_in_memory().expect("in-memory DB")
    }

    /// Force a specific created_at on a workbench session (bypasses now_ms()).
    fn set_wb_created(db: &Db, id: &str, created: i64) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE workbench_sessions SET created_at = ?1 WHERE id = ?2",
                params![created, id],
            )
            .unwrap();
    }

    fn set_task_created(db: &Db, id: &str, created: i64) {
        db.conn
            .lock()
            .unwrap()
            .execute(
                "UPDATE tasks SET created_at = ?1 WHERE id = ?2",
                params![created, id],
            )
            .unwrap();
    }

    // Fixed mid-range base timestamp; day separation uses whole-day offsets so
    // the assertions hold in any local timezone.
    const BASE: i64 = 1_700_000_000_000;
    const DAY: i64 = 86_400_000;

    // ── empty-database tolerance ──────────────────────────────────────────────

    #[test]
    fn empty_db_yields_zeroed_overview_and_empty_lists() {
        let db = new_db();

        let ov = overview(&db).unwrap();
        assert_eq!(ov.total_runs, 0);
        assert_eq!(ov.board_tasks, 0);
        assert_eq!(ov.workbench_sessions, 0);
        assert_eq!(ov.total_tokens, 0);
        assert_eq!(ov.active_days, 0);
        assert_eq!(ov.avg_tokens_per_run, 0, "no runs must give avg 0, not div-by-zero");

        assert!(token_series(&db, None).unwrap().is_empty());
        assert!(by_model(&db).unwrap().is_empty());
    }

    // ── overview aggregation ──────────────────────────────────────────────────

    #[test]
    fn overview_sums_tokens_and_counts_runs() {
        let db = new_db();

        // Board task shares wb1's timestamp so both land on one local day.
        db.insert_task("bt1", "看板任务", "/board").unwrap();
        set_task_created(&db, "bt1", BASE);

        db.workbench_session_create("wb1", "/w1", "p", "gpt-5.5").unwrap();
        db.workbench_stats_upsert("wb1", 100, 20, 5, 3, 128).unwrap();
        set_wb_created(&db, "wb1", BASE);

        // Second session three days later, different model.
        db.workbench_session_create("wb2", "/w2", "p", "sonnet").unwrap();
        db.workbench_stats_upsert("wb2", 200, 50, 0, 0, 250).unwrap();
        set_wb_created(&db, "wb2", BASE + 3 * DAY);

        // Session without a stats row must not break the sums.
        db.workbench_session_create("wb3", "/w3", "p", "gpt-5.5").unwrap();
        set_wb_created(&db, "wb3", BASE);

        let ov = overview(&db).unwrap();
        assert_eq!(ov.board_tasks, 1);
        assert_eq!(ov.workbench_sessions, 3);
        assert_eq!(ov.total_runs, 4);
        assert_eq!(ov.input_tokens, 300);
        assert_eq!(ov.output_tokens, 70);
        assert_eq!(ov.cache_read_tokens, 5);
        assert_eq!(ov.cache_write_tokens, 3);
        assert_eq!(ov.total_tokens, 378);
        // BASE-day (bt1 + wb1 + wb3) and BASE+3d (wb2) make exactly 2 days.
        assert_eq!(ov.active_days, 2);
        // 378 total over 2 sessions with stats -> 189.
        assert_eq!(ov.avg_tokens_per_run, 189);
    }

    // ── token series bucketing ────────────────────────────────────────────────

    #[test]
    fn token_series_buckets_by_day_ascending() {
        let db = new_db();

        db.workbench_session_create("wb1", "/w", "p", "m1").unwrap();
        db.workbench_stats_upsert("wb1", 100, 20, 0, 0, 120).unwrap();
        set_wb_created(&db, "wb1", BASE);

        // Same day as wb1, no stats row: counts as a run with 0 tokens.
        db.workbench_session_create("wb2", "/w", "p", "m1").unwrap();
        set_wb_created(&db, "wb2", BASE);

        // Three days later.
        db.workbench_session_create("wb3", "/w", "p", "m2").unwrap();
        db.workbench_stats_upsert("wb3", 40, 10, 0, 0, 50).unwrap();
        set_wb_created(&db, "wb3", BASE + 3 * DAY);

        let series = token_series(&db, Some("day")).unwrap();
        assert_eq!(series.len(), 2, "two distinct days expected");

        // Ascending: first bucket is the BASE day (2 runs, wb1's tokens only).
        assert!(series[0].date < series[1].date);
        assert_eq!(series[0].runs, 2);
        assert_eq!(series[0].input, 100);
        assert_eq!(series[0].output, 20);
        assert_eq!(series[0].total, 120);

        assert_eq!(series[1].runs, 1);
        assert_eq!(series[1].total, 50);
    }

    #[test]
    fn token_series_rejects_unknown_bucket() {
        let db = new_db();
        let err = token_series(&db, Some("week")).unwrap_err();
        assert!(err.contains("week"), "error should name the bad bucket: {err}");
    }

    // ── per-model grouping ────────────────────────────────────────────────────

    #[test]
    fn by_model_groups_and_orders_by_total_desc() {
        let db = new_db();

        db.workbench_session_create("a1", "/w", "p", "gpt-5.5").unwrap();
        db.workbench_stats_upsert("a1", 10, 5, 0, 0, 15).unwrap();
        db.workbench_session_create("a2", "/w", "p", "gpt-5.5").unwrap();
        db.workbench_stats_upsert("a2", 20, 5, 0, 0, 25).unwrap();

        db.workbench_session_create("b1", "/w", "p", "sonnet").unwrap();
        db.workbench_stats_upsert("b1", 500, 100, 0, 0, 600).unwrap();

        // Old row with empty model and no stats: its own zero-token group.
        db.workbench_session_create("c1", "/w", "p", "").unwrap();

        let models = by_model(&db).unwrap();
        assert_eq!(models.len(), 3);

        assert_eq!(models[0].model, "sonnet");
        assert_eq!(models[0].runs, 1);
        assert_eq!(models[0].total, 600);

        assert_eq!(models[1].model, "gpt-5.5");
        assert_eq!(models[1].runs, 2);
        assert_eq!(models[1].input, 30);
        assert_eq!(models[1].output, 10);
        assert_eq!(models[1].total, 40);

        assert_eq!(models[2].model, "");
        assert_eq!(models[2].runs, 1);
        assert_eq!(models[2].total, 0);
    }
}
