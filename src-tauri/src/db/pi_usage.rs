//! pi 用量持久化（`pi_usage` 表）— pivot-codex-app 的用量落库层。
//!
//! 与版本化迁移（PRAGMA user_version）解耦：表用 `CREATE TABLE IF NOT
//! EXISTS` 在每次写入/查询路径上惰性自建，不占迁移版本号，避免与并行
//! 开发中的 KB 迁移相互踩踏。
//!
//! 每行对应 pi RPC 流中一条 `message_end`（`message.role == "assistant"`
//! 且带 `usage`）的计量记录；聚合查询全部按本地时区归日。

use rusqlite::{params, Connection, Result as SqlResult};
use serde::Serialize;

use super::{now_ms, Db};

// ── Schema（惰性自建，不走版本迁移） ─────────────────────────────────────────

const PI_USAGE_DDL: &str = r#"
CREATE TABLE IF NOT EXISTS pi_usage (
    id          TEXT PRIMARY KEY,
    session_id  TEXT NOT NULL,
    model       TEXT NOT NULL DEFAULT '',
    provider    TEXT NOT NULL DEFAULT '',
    input       INTEGER NOT NULL DEFAULT 0,
    output      INTEGER NOT NULL DEFAULT 0,
    cache_read  INTEGER NOT NULL DEFAULT 0,
    cache_write INTEGER NOT NULL DEFAULT 0,
    cost        REAL NOT NULL DEFAULT 0,
    ts          INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_pi_usage_ts      ON pi_usage(ts);
CREATE INDEX IF NOT EXISTS idx_pi_usage_session ON pi_usage(session_id);
"#;

fn ensure_table(conn: &Connection) -> SqlResult<()> {
    conn.execute_batch(PI_USAGE_DDL)
}

// ── Row / aggregate types ─────────────────────────────────────────────────────

/// 一条待写入的用量记录（`ts` 由写入方法补当前时间）。
pub struct NewPiUsage<'a> {
    pub id: &'a str,
    pub session_id: &'a str,
    pub model: &'a str,
    pub provider: &'a str,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub cost: f64,
}

/// `pi_usage_overview` 返回值：全量累计 + 会话/记录计数。
#[derive(Debug, Clone, Serialize)]
pub struct PiUsageOverview {
    pub total_input: i64,
    pub total_output: i64,
    pub total_cache_read: i64,
    pub total_cache_write: i64,
    pub total_cost: f64,
    pub sessions: i64,
    pub rows: i64,
}

/// 按本地日聚合的一格（`day` 形如 YYYY-MM-DD）。
#[derive(Debug, Clone, Serialize)]
pub struct PiUsageDay {
    pub day: String,
    pub input: i64,
    pub output: i64,
    pub cost: f64,
    pub rows: i64,
}

/// 按模型聚合的一行。
#[derive(Debug, Clone, Serialize)]
pub struct PiUsageModel {
    pub model: String,
    pub input: i64,
    pub output: i64,
    pub cost: f64,
    pub rows: i64,
}

/// 一条原始用量记录（`pi_usage_recent` 返回值）。
#[derive(Debug, Clone, Serialize)]
pub struct PiUsageRecord {
    pub id: String,
    pub session_id: String,
    pub model: String,
    pub provider: String,
    pub input: i64,
    pub output: i64,
    pub cache_read: i64,
    pub cache_write: i64,
    pub cost: f64,
    pub ts: i64,
}

// ── Db methods ────────────────────────────────────────────────────────────────

impl Db {
    /// 写入一条 pi 用量记录（首次写入时自建表）。
    pub fn pi_usage_insert(&self, r: &NewPiUsage<'_>) -> SqlResult<()> {
        let conn = self.conn.lock().unwrap();
        ensure_table(&conn)?;
        conn.execute(
            "INSERT INTO pi_usage \
             (id, session_id, model, provider, input, output, cache_read, cache_write, cost, ts) \
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
            params![
                r.id,
                r.session_id,
                r.model,
                r.provider,
                r.input,
                r.output,
                r.cache_read,
                r.cache_write,
                r.cost,
                now_ms()
            ],
        )?;
        Ok(())
    }

    /// 全量累计（token 各项 + 费用 + 会话/记录计数）。
    pub fn pi_usage_overview(&self) -> SqlResult<PiUsageOverview> {
        let conn = self.conn.lock().unwrap();
        ensure_table(&conn)?;
        conn.query_row(
            "SELECT COALESCE(SUM(input), 0), COALESCE(SUM(output), 0), \
                    COALESCE(SUM(cache_read), 0), COALESCE(SUM(cache_write), 0), \
                    COALESCE(SUM(cost), 0.0), COUNT(DISTINCT session_id), COUNT(*) \
             FROM pi_usage",
            [],
            |row| {
                Ok(PiUsageOverview {
                    total_input: row.get(0)?,
                    total_output: row.get(1)?,
                    total_cache_read: row.get(2)?,
                    total_cache_write: row.get(3)?,
                    total_cost: row.get(4)?,
                    sessions: row.get(5)?,
                    rows: row.get(6)?,
                })
            },
        )
    }

    /// 近 `days` 个自然日（本地时区）的按日序列，升序。
    pub fn pi_usage_series(&self, days: u32) -> SqlResult<Vec<PiUsageDay>> {
        let cutoff = now_ms() - i64::from(days) * 86_400_000;
        let conn = self.conn.lock().unwrap();
        ensure_table(&conn)?;
        let mut stmt = conn.prepare(
            "SELECT date(ts / 1000, 'unixepoch', 'localtime') AS day, \
                    COALESCE(SUM(input), 0), COALESCE(SUM(output), 0), \
                    COALESCE(SUM(cost), 0.0), COUNT(*) \
             FROM pi_usage WHERE ts >= ?1 \
             GROUP BY day ORDER BY day ASC",
        )?;
        let rows = stmt.query_map(params![cutoff], |row| {
            Ok(PiUsageDay {
                day: row.get(0)?,
                input: row.get(1)?,
                output: row.get(2)?,
                cost: row.get(3)?,
                rows: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    /// 按模型聚合（token 大头在前）。
    pub fn pi_usage_by_model(&self) -> SqlResult<Vec<PiUsageModel>> {
        let conn = self.conn.lock().unwrap();
        ensure_table(&conn)?;
        let mut stmt = conn.prepare(
            "SELECT model, COALESCE(SUM(input), 0), COALESCE(SUM(output), 0), \
                    COALESCE(SUM(cost), 0.0), COUNT(*) \
             FROM pi_usage GROUP BY model \
             ORDER BY SUM(input) + SUM(output) DESC",
        )?;
        let rows = stmt.query_map([], |row| {
            Ok(PiUsageModel {
                model: row.get(0)?,
                input: row.get(1)?,
                output: row.get(2)?,
                cost: row.get(3)?,
                rows: row.get(4)?,
            })
        })?;
        rows.collect()
    }

    /// 最近 `limit` 条原始记录（新在前）。
    pub fn pi_usage_recent(&self, limit: i64) -> SqlResult<Vec<PiUsageRecord>> {
        let conn = self.conn.lock().unwrap();
        ensure_table(&conn)?;
        let mut stmt = conn.prepare(
            "SELECT id, session_id, model, provider, input, output, \
                    cache_read, cache_write, cost, ts \
             FROM pi_usage ORDER BY ts DESC, id DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map(params![limit], |row| {
            Ok(PiUsageRecord {
                id: row.get(0)?,
                session_id: row.get(1)?,
                model: row.get(2)?,
                provider: row.get(3)?,
                input: row.get(4)?,
                output: row.get(5)?,
                cache_read: row.get(6)?,
                cache_write: row.get(7)?,
                cost: row.get(8)?,
                ts: row.get(9)?,
            })
        })?;
        rows.collect()
    }
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn row<'a>(id: &'a str, sid: &'a str, model: &'a str, i: i64, o: i64) -> NewPiUsage<'a> {
        NewPiUsage {
            id,
            session_id: sid,
            model,
            provider: "agentboard",
            input: i,
            output: o,
            cache_read: 10,
            cache_write: 5,
            cost: 0.25,
        }
    }

    #[test]
    fn insert_overview_and_recent() {
        let db = Db::open_in_memory().unwrap();
        // 表未建时查询也不能炸（惰性自建）。
        let ov0 = db.pi_usage_overview().unwrap();
        assert_eq!(ov0.rows, 0);
        assert_eq!(ov0.total_cost, 0.0);

        db.pi_usage_insert(&row("u1", "s1", "gpt-5.5", 100, 20)).unwrap();
        db.pi_usage_insert(&row("u2", "s1", "gpt-5.5", 200, 30)).unwrap();
        db.pi_usage_insert(&row("u3", "s2", "mini", 50, 5)).unwrap();

        let ov = db.pi_usage_overview().unwrap();
        assert_eq!(ov.total_input, 350);
        assert_eq!(ov.total_output, 55);
        assert_eq!(ov.total_cache_read, 30);
        assert_eq!(ov.total_cache_write, 15);
        assert!((ov.total_cost - 0.75).abs() < 1e-9);
        assert_eq!(ov.sessions, 2);
        assert_eq!(ov.rows, 3);

        let recent = db.pi_usage_recent(2).unwrap();
        assert_eq!(recent.len(), 2);
        assert_eq!(recent[0].provider, "agentboard");
    }

    #[test]
    fn series_and_by_model_aggregate() {
        let db = Db::open_in_memory().unwrap();
        db.pi_usage_insert(&row("u1", "s1", "gpt-5.5", 100, 20)).unwrap();
        db.pi_usage_insert(&row("u2", "s2", "mini", 900, 90)).unwrap();

        let series = db.pi_usage_series(7).unwrap();
        assert_eq!(series.len(), 1, "同一天的记录应聚合为一格");
        assert_eq!(series[0].input, 1000);
        assert_eq!(series[0].output, 110);
        assert_eq!(series[0].rows, 2);
        assert_eq!(series[0].day.len(), 10); // YYYY-MM-DD

        let models = db.pi_usage_by_model().unwrap();
        assert_eq!(models.len(), 2);
        assert_eq!(models[0].model, "mini", "token 大头在前");
        assert_eq!(models[0].rows, 1);
        assert_eq!(models[1].model, "gpt-5.5");
    }
}
