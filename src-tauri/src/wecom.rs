//! 企业微信推送通知模块
//!
//! - access_token 获取与缓存（提前 5 分钟过期重取，Mutex 保护）
//! - send: POST /cgi-bin/message/send，msgtype=textcard
//! - 消息模板：完成、失败、测试
//! - 失败只写环形日志，不 panic，不阻塞事件管线
//! - spawn_send: fire-and-forget tokio 任务

use serde_json::json;
use std::collections::{HashMap, VecDeque};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

// ── Ring log ──────────────────────────────────────────────────────────────────

const LOG_CAP: usize = 50;

static PUSH_LOG: OnceLock<Mutex<VecDeque<String>>> = OnceLock::new();

fn push_log() -> &'static Mutex<VecDeque<String>> {
    PUSH_LOG.get_or_init(|| Mutex::new(VecDeque::with_capacity(LOG_CAP + 1)))
}

fn append_log(entry: String) {
    let mut log = push_log().lock().unwrap();
    log.push_front(entry);
    if log.len() > LOG_CAP {
        log.truncate(LOG_CAP);
    }
}

/// Return recent push log entries (newest first, max 50).
pub fn recent_logs() -> Vec<String> {
    push_log().lock().unwrap().iter().cloned().collect()
}

// ── Token cache ───────────────────────────────────────────────────────────────

struct CachedToken {
    token: String,
    expires_at: Instant,
}

/// Thread-safe token store with 5-minute early-refresh buffer.
///
/// Exposed as `pub(crate)` so unit tests can construct an independent instance
/// without touching the process-wide global.
pub(crate) struct TokenStore {
    inner: Mutex<Option<CachedToken>>,
}

impl TokenStore {
    pub(crate) fn new() -> Self {
        Self { inner: Mutex::new(None) }
    }

    /// Return the cached token if it is still valid; `None` if empty or expired.
    pub(crate) fn get_cached(&self) -> Option<String> {
        let guard = self.inner.lock().unwrap();
        guard.as_ref().and_then(|ct| {
            if ct.expires_at > Instant::now() {
                Some(ct.token.clone())
            } else {
                None
            }
        })
    }

    /// Store a freshly fetched token.  `expire_secs` is the server-reported TTL;
    /// we cache with a 5-minute (300 s) early-refresh buffer.
    pub(crate) fn store(&self, token: String, expire_secs: u64) {
        let mut guard = self.inner.lock().unwrap();
        *guard = Some(CachedToken {
            token,
            expires_at: Instant::now()
                + Duration::from_secs(expire_secs.saturating_sub(300)),
        });
    }
}

static TOKEN_STORE: OnceLock<TokenStore> = OnceLock::new();

fn global_token_store() -> &'static TokenStore {
    TOKEN_STORE.get_or_init(TokenStore::new)
}

// ── HTTP client factory ───────────────────────────────────────────────────────

fn build_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|e| format!("HTTP client build error: {e}"))
}

// ── Token acquisition ─────────────────────────────────────────────────────────

/// Obtain a valid access_token, re-fetching only when the cache is stale.
///
/// API: GET https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid=&corpsecret=
async fn get_token(corpid: &str, corpsecret: &str) -> Result<String, String> {
    let store = global_token_store();
    if let Some(cached) = store.get_cached() {
        return Ok(cached);
    }

    let client = build_client()?;
    let url = format!(
        "https://qyapi.weixin.qq.com/cgi-bin/gettoken?corpid={}&corpsecret={}",
        corpid, corpsecret
    );

    let resp = client
        .get(&url)
        .send()
        .await
        .map_err(|e| format!("token fetch failed: {e}"))?;

    let data: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("token response parse error: {e}"))?;

    let errcode = data["errcode"].as_i64().unwrap_or(-1);
    if errcode != 0 {
        return Err(format!(
            "企业微信 token 获取失败 (errcode={}): {}",
            errcode,
            data["errmsg"].as_str().unwrap_or("unknown")
        ));
    }

    let token = data["access_token"]
        .as_str()
        .ok_or_else(|| "响应缺少 access_token 字段".to_string())?
        .to_string();
    let expire_secs = data["expires_in"].as_u64().unwrap_or(7200);

    store.store(token.clone(), expire_secs);
    Ok(token)
}

// ── Config ────────────────────────────────────────────────────────────────────

/// WeChat Work notification config extracted from the settings table.
#[derive(Debug, Clone)]
pub struct WecomConfig {
    pub corpid: String,
    pub corpsecret: String,
    /// Agent ID (integer stored as string in settings)
    pub agentid: i64,
    /// Recipient: `"@all"` or a specific member ID
    pub touser: String,
}

/// Extract wecom config from a settings map.
/// Returns `None` if `wecom_enabled != "true"` or any required field is blank/invalid.
pub fn load_config(settings: &HashMap<String, String>) -> Option<WecomConfig> {
    if settings.get("wecom_enabled").map(|s| s.as_str()) != Some("true") {
        return None;
    }
    let corpid = settings.get("wecom_corpid")?.trim().to_string();
    let corpsecret = settings.get("wecom_corpsecret")?.trim().to_string();
    let agentid_str = settings.get("wecom_agentid")?.trim().to_string();

    if corpid.is_empty() || corpsecret.is_empty() || agentid_str.is_empty() {
        return None;
    }

    let agentid = agentid_str.parse::<i64>().ok()?;

    let touser = settings
        .get("wecom_touser")
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "@all".to_string());

    Some(WecomConfig { corpid, corpsecret, agentid, touser })
}

// ── Message builders ──────────────────────────────────────────────────────────

const DETAIL_URL: &str = "http://107.174.70.15/";

fn fmt_elapsed(secs: u64) -> String {
    let m = secs / 60;
    let s = secs % 60;
    if m > 0 {
        format!("{} 分 {} 秒", m, s)
    } else {
        format!("{} 秒", s)
    }
}

/// 任务完成消息（textcard）。
///
/// Fields: 工作目录、耗时、文件改动数、token 用量。
pub fn msg_completed(
    config: &WecomConfig,
    title: &str,
    workdir: &str,
    elapsed_secs: u64,
    file_count: i64,
    input_tokens: u64,
    output_tokens: u64,
) -> serde_json::Value {
    let description = format!(
        "工作目录：{}\n耗时：{}\n文件改动：{} 个\nToken：输入 {} / 输出 {}",
        workdir,
        fmt_elapsed(elapsed_secs),
        file_count,
        input_tokens,
        output_tokens,
    );
    json!({
        "touser": config.touser,
        "msgtype": "textcard",
        "agentid": config.agentid,
        "textcard": {
            "title": format!("✅ 任务完成：{}", title),
            "description": description,
            "url": DETAIL_URL,
            "btntxt": "详情"
        }
    })
}

/// 任务失败消息（textcard）。错误摘要截取前 200 字。
pub fn msg_failed(config: &WecomConfig, title: &str, error_summary: &str) -> serde_json::Value {
    let summary: String = error_summary.chars().take(200).collect();
    json!({
        "touser": config.touser,
        "msgtype": "textcard",
        "agentid": config.agentid,
        "textcard": {
            "title": format!("❌ 任务失败：{}", title),
            "description": format!("错误摘要：{}", summary),
            "url": DETAIL_URL,
            "btntxt": "详情"
        }
    })
}

/// 测试消息（textcard）。
pub fn msg_test(config: &WecomConfig) -> serde_json::Value {
    json!({
        "touser": config.touser,
        "msgtype": "textcard",
        "agentid": config.agentid,
        "textcard": {
            "title": "AgentBoard 通知测试成功",
            "description": "企业微信推送配置正常，任务完成/失败时将自动通知。",
            "url": DETAIL_URL,
            "btntxt": "详情"
        }
    })
}

// ── Send ──────────────────────────────────────────────────────────────────────

/// Send a textcard message via WeChat Work IM API.
///
/// API: POST /cgi-bin/message/send?access_token=<token>
pub async fn send(config: &WecomConfig, body: serde_json::Value) -> Result<(), String> {
    let token = get_token(&config.corpid, &config.corpsecret).await?;

    let client = build_client()?;
    let url = format!(
        "https://qyapi.weixin.qq.com/cgi-bin/message/send?access_token={}",
        token
    );

    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("send request failed: {e}"))?;

    let resp_json: serde_json::Value = resp
        .json()
        .await
        .map_err(|e| format!("send response parse error: {e}"))?;

    let errcode = resp_json["errcode"].as_i64().unwrap_or(-1);
    if errcode != 0 {
        return Err(format!(
            "企业微信消息发送失败 (errcode={}): {}",
            errcode,
            resp_json["errmsg"].as_str().unwrap_or("unknown")
        ));
    }

    Ok(())
}

/// Fire-and-forget: spawn a tokio task to send `body`, log the result.
/// Errors are written to the ring log; they never panic or block the caller.
pub fn spawn_send(config: WecomConfig, body: serde_json::Value, label: String) {
    tokio::spawn(async move {
        let result = send(&config, body).await;
        let ts = utc_hms();
        let entry = match result {
            Ok(()) => format!("[{}] OK  {}", ts, label),
            Err(e) => format!("[{}] ERR {} — {}", ts, label, e),
        };
        append_log(entry);
    });
}

fn utc_hms() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let day_secs = secs % 86400;
    format!("{:02}:{:02}:{:02}", day_secs / 3600, (day_secs % 3600) / 60, day_secs % 60)
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn base_config() -> WecomConfig {
        WecomConfig {
            corpid: "ww_test".to_string(),
            corpsecret: "secret".to_string(),
            agentid: 1000002,
            touser: "@all".to_string(),
        }
    }

    // ── Token cache ───────────────────────────────────────────────────────────

    #[test]
    fn token_store_empty_initially() {
        let store = TokenStore::new();
        assert!(store.get_cached().is_none(), "fresh store should be empty");
    }

    #[test]
    fn token_store_returns_token_within_ttl() {
        let store = TokenStore::new();
        // TTL 7200s → buffer 7200-300=6900s still in the future
        store.store("tok_valid".to_string(), 7200);
        assert_eq!(store.get_cached().as_deref(), Some("tok_valid"));
    }

    #[test]
    fn token_store_expired_when_ttl_le_buffer() {
        let store = TokenStore::new();
        // TTL 200s → saturating_sub(300) = 0 → expires_at = now + 0 → already past
        store.store("tok_dead".to_string(), 200);
        assert!(
            store.get_cached().is_none(),
            "token with TTL ≤ 300 s (buffer) should be treated as expired"
        );
    }

    #[test]
    fn token_store_second_store_replaces_first() {
        let store = TokenStore::new();
        store.store("tok_first".to_string(), 7200);
        store.store("tok_second".to_string(), 7200);
        assert_eq!(store.get_cached().as_deref(), Some("tok_second"));
    }

    // ── Message JSON structure ────────────────────────────────────────────────

    #[test]
    fn msg_completed_structure() {
        let cfg = base_config();
        let msg = msg_completed(&cfg, "测试任务", "/tmp/work", 125, 3, 1000, 500);
        assert_eq!(msg["msgtype"].as_str(), Some("textcard"));
        assert_eq!(msg["agentid"].as_i64(), Some(1000002));
        assert_eq!(msg["touser"].as_str(), Some("@all"));
        let title = msg["textcard"]["title"].as_str().unwrap();
        assert!(title.contains("✅"), "title should contain checkmark");
        assert!(title.contains("测试任务"), "title should include task name");
        let desc = msg["textcard"]["description"].as_str().unwrap();
        assert!(desc.contains("/tmp/work"), "description should include workdir");
        assert!(desc.contains("3"), "description should include file count");
        assert_eq!(msg["textcard"]["btntxt"].as_str(), Some("详情"));
        assert_eq!(msg["textcard"]["url"].as_str(), Some(DETAIL_URL));
    }

    #[test]
    fn msg_completed_elapsed_formats_minutes() {
        let cfg = base_config();
        let msg = msg_completed(&cfg, "T", "/", 90, 0, 0, 0);
        let desc = msg["textcard"]["description"].as_str().unwrap();
        assert!(desc.contains("分"), "90s should show minutes");
    }

    #[test]
    fn msg_completed_elapsed_formats_seconds_only() {
        let cfg = base_config();
        let msg = msg_completed(&cfg, "T", "/", 45, 0, 0, 0);
        let desc = msg["textcard"]["description"].as_str().unwrap();
        assert!(desc.contains("45 秒"), "45s should show seconds");
        assert!(!desc.contains("分"), "45s should not show minutes");
    }

    #[test]
    fn msg_failed_structure_and_truncation() {
        let cfg = base_config();
        let long_err = "e".repeat(300);
        let msg = msg_failed(&cfg, "失败任务", &long_err);
        assert_eq!(msg["msgtype"].as_str(), Some("textcard"));
        let title = msg["textcard"]["title"].as_str().unwrap();
        assert!(title.contains("❌"), "title should contain cross mark");
        assert!(title.contains("失败任务"), "title should include task name");
        let desc = msg["textcard"]["description"].as_str().unwrap();
        let e_count = desc.chars().filter(|&c| c == 'e').count();
        assert!(
            e_count <= 200,
            "error summary should be truncated to 200 chars: got {}",
            e_count
        );
    }

    #[test]
    fn msg_test_structure() {
        let cfg = base_config();
        let msg = msg_test(&cfg);
        assert_eq!(msg["msgtype"].as_str(), Some("textcard"));
        assert_eq!(
            msg["textcard"]["title"].as_str(),
            Some("AgentBoard 通知测试成功")
        );
        assert_eq!(msg["textcard"]["btntxt"].as_str(), Some("详情"));
        assert_eq!(msg["touser"].as_str(), Some("@all"));
    }

    // ── Config loading ────────────────────────────────────────────────────────

    #[test]
    fn load_config_disabled_returns_none() {
        let mut s = HashMap::new();
        s.insert("wecom_enabled".to_string(), "false".to_string());
        s.insert("wecom_corpid".to_string(), "ww_corp".to_string());
        s.insert("wecom_corpsecret".to_string(), "sec".to_string());
        s.insert("wecom_agentid".to_string(), "1000002".to_string());
        assert!(load_config(&s).is_none(), "disabled → None");
    }

    #[test]
    fn load_config_missing_fields_returns_none() {
        let mut s = HashMap::new();
        s.insert("wecom_enabled".to_string(), "true".to_string());
        // no corpid, corpsecret, agentid
        assert!(load_config(&s).is_none(), "missing required fields → None");
    }

    #[test]
    fn load_config_blank_corpid_returns_none() {
        let mut s = HashMap::new();
        s.insert("wecom_enabled".to_string(), "true".to_string());
        s.insert("wecom_corpid".to_string(), "   ".to_string());
        s.insert("wecom_corpsecret".to_string(), "sec".to_string());
        s.insert("wecom_agentid".to_string(), "1000002".to_string());
        assert!(load_config(&s).is_none(), "blank corpid → None");
    }

    #[test]
    fn load_config_invalid_agentid_returns_none() {
        let mut s = HashMap::new();
        s.insert("wecom_enabled".to_string(), "true".to_string());
        s.insert("wecom_corpid".to_string(), "ww_corp".to_string());
        s.insert("wecom_corpsecret".to_string(), "sec".to_string());
        s.insert("wecom_agentid".to_string(), "not_a_number".to_string());
        assert!(load_config(&s).is_none(), "invalid agentid → None");
    }

    #[test]
    fn load_config_complete_returns_some() {
        let mut s = HashMap::new();
        s.insert("wecom_enabled".to_string(), "true".to_string());
        s.insert("wecom_corpid".to_string(), "ww_corp".to_string());
        s.insert("wecom_corpsecret".to_string(), "secret_xyz".to_string());
        s.insert("wecom_agentid".to_string(), "1000002".to_string());
        let cfg = load_config(&s).expect("complete config → Some");
        assert_eq!(cfg.corpid, "ww_corp");
        assert_eq!(cfg.agentid, 1000002);
        assert_eq!(cfg.touser, "@all", "touser defaults to @all when absent");
    }

    #[test]
    fn load_config_custom_touser() {
        let mut s = HashMap::new();
        s.insert("wecom_enabled".to_string(), "true".to_string());
        s.insert("wecom_corpid".to_string(), "ww_corp".to_string());
        s.insert("wecom_corpsecret".to_string(), "sec".to_string());
        s.insert("wecom_agentid".to_string(), "1000002".to_string());
        s.insert("wecom_touser".to_string(), "user_abc".to_string());
        let cfg = load_config(&s).expect("complete config → Some");
        assert_eq!(cfg.touser, "user_abc");
    }

    #[test]
    fn load_config_blank_touser_defaults_to_at_all() {
        let mut s = HashMap::new();
        s.insert("wecom_enabled".to_string(), "true".to_string());
        s.insert("wecom_corpid".to_string(), "ww_corp".to_string());
        s.insert("wecom_corpsecret".to_string(), "sec".to_string());
        s.insert("wecom_agentid".to_string(), "1000002".to_string());
        s.insert("wecom_touser".to_string(), "   ".to_string());
        let cfg = load_config(&s).expect("complete config → Some");
        assert_eq!(cfg.touser, "@all", "blank touser should default to @all");
    }

    // ── Notification gate (disabled → no spawn) ───────────────────────────────

    #[test]
    fn wecom_disabled_load_config_returns_none_so_no_spawn() {
        // When wecom_enabled is not "true", load_config returns None.
        // The caller in make_emit_fn_with_db only calls spawn_send when
        // load_config returns Some — so zero HTTP calls are made.
        let settings = HashMap::new(); // empty → wecom_enabled not "true"
        assert!(
            load_config(&settings).is_none(),
            "no wecom_enabled=true → zero notifications spawned"
        );
    }
}
