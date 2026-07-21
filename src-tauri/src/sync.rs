//! 手机同步客户端（A3）：账号登录 + 证书锁定的实时长连接 + 手机指令回传。
//!
//! ## 传输与安全
//! - 服务器为自签证书。REST（reqwest）与 WSS（tokio-tungstenite）都只信任内嵌的
//!   `SERVER_CERT_PEM` 这一个锚点（`tls_built_in_root_certs(false)` /
//!   仅含该证书的 rustls `RootCertStore`）——即证书锁定，绝不使用
//!   `danger_accept_invalid_certs`。证书带 `SAN = IP:192.210.231.152`，主机名校验对 IP 成立。
//! - access token 仅存内存；refresh token 存 settings 表（key `sync_refresh_token`）。
//!   注：桌面端设置表为本地 SQLite，后续版本可迁移到 Windows 凭据管理器
//!   （Credential Manager）以获得 DPAPI 级别的静态加密。
//!
//! ## 推送挂接（不在热路径做网络 IO）
//! 任务/会话状态变更处、agent-event 发射处只调用 `notify_snapshot()` /
//! `notify_event()`——它们只是向内部 mpsc 通道 `send` 一个信号（非阻塞、无网络）。
//! 真正的组装与网络发送发生在后台 `master_loop` 里：snapshot 变化后 500ms debounce
//! 合并再整体推送；关键 agent 事件即时 `event_append`。
//!
//! ## 连接生命周期
//! `master_loop` 是唯一的常驻任务：账号+开关满足时刷新令牌→确保设备→开 WSS→
//! 推首帧快照→进入收发循环；断线按指数退避（1s→60s）重连；登录/登出/开关变化
//! 通过 watch 通道即时打断当前状态重新评估。

use std::sync::Arc;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::{mpsc, watch, Mutex};

use futures_util::{SinkExt, StreamExt};
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::Connector;

use crate::agent::events::AgentEvent;
use crate::db::{ChatMessageRow, ChatSessionRow, Db};

// ── Constants ─────────────────────────────────────────────────────────────────

/// 官方同步服务器（当前不可改地址；后续版本再开放自建）。
pub const SYNC_BASE_URL: &str = "https://192.210.231.152:8443";
pub const SYNC_WS_URL: &str = "wss://192.210.231.152:8443/ws";

/// 内嵌的服务器自签证书（唯一信任锚）。指纹：
/// `A7:61:DC:CA:0E:5A:B6:C3:27:91:D0:A3:00:65:2C:A6:8A:AE:BB:EA:04:63:7B:86:4D:AD:87:3D:26:6E:DD:FB`
const SERVER_CERT_PEM: &str = "-----BEGIN CERTIFICATE-----
MIIEJjCCAo6gAwIBAgIUEy7k6RSHZYROEUB3hsCAj95XcnIwDQYJKoZIhvcNAQEL
BQAwGjEYMBYGA1UEAwwPMTkyLjIxMC4yMzEuMTUyMB4XDTI2MDcxNDEyMjQ0OFoX
DTM2MDcxMTEyMjQ0OFowGjEYMBYGA1UEAwwPMTkyLjIxMC4yMzEuMTUyMIIBojAN
BgkqhkiG9w0BAQEFAAOCAY8AMIIBigKCAYEA1PXdVqU7Hs8+WPUxF4cLCXKYN2y6
t9UsWXYrK8sXjJOyoEzROF8xUADjxuGS9Vjrjr8RzKWRO2CXHnVwKBhUos9hmV2W
ehfaD3RZGtNZYL8rz7IDFd6vKEVWxKL5GtxzXMM2uXTPWLsCp8iFPaEDZmYBJLZH
88KXy0lPe2zJb//azg194+WY1JKMjANtZAM3hYF6kgHaphkSNMPUVQ2B2AZCud1S
uH/FL+QfX4pn3HJP1imNqtCTaxRHbSLP0otjyTLuVAGK1KKuRx4KQ+M1EuktMniR
VACsnjMEvNoADnMjJjQqWGirNeG4zzDMJ04+zBKjMWoKZ9guopo2ZIkhvmLnAcFW
gRw80e/+xrN6TN9a0G/Hz/syypzIMyWhPJwfmhUFU9b+6K2tmO2gzM8/Qnratw5I
bX+H/fLyMdhRx1XEhLZf9IU8T8xE8/kiqaWbD1oziYt6JiwcJ2Sw9is9SQLC9UAM
DCzUoNvl9iKyI0xDb9wozaBTAzy205pC9s9RAgMBAAGjZDBiMB0GA1UdDgQWBBSD
NK1nS0VoEb2pkyX9TRQPI1OBcDAfBgNVHSMEGDAWgBSDNK1nS0VoEb2pkyX9TRQP
I1OBcDAPBgNVHRMBAf8EBTADAQH/MA8GA1UdEQQIMAaHBMDS55gwDQYJKoZIhvcN
AQELBQADggGBABEpKSVr1WPx4v9101bgNZhhATeZyQqfW4Vv/5x0EQ3V46RMWhPM
B1PQiQUlGk2Nem+KVZgMOEqjAnC107T+cnA4DURVYaUdIc6F7Sq/nJT03oOhIuYi
00KSNgYs7QvnONmbB8++eDLx+syR/g82A9zxIwm8cPaipB/IL+uWrmQ1PAFXAqyK
a9zrQuBRR7+WhWPosDYTi+DnrCL61gmExApraQ5mbLHIjp+REM7WWXbT+yZeC/V3
JFs7x2FnGrL5nSE8zzgJPCaS8tf5eeOTI2uJ5c7evp1vFskzOHPZcifNGRYq3qWw
tRiVIysEtDNbPrYcJe8Plj2Gi9jVwqYFnsSEgskb6bj3L18J5fUcihCc8vyynvEG
eYOmBGKVGs+7jhbkEAcMfBthYtswEMa5gVvprgQKmB0UrklGsi61jg8Vk9nBwbOe
OeXgJla2uabf839jCqt557ghXEXgbpDACat6fviSs5dMxUxPt8fl5SVi4p6aBq7o
iJ0GaLYO2xF/BQ==
-----END CERTIFICATE-----
";

const SNAPSHOT_DEBOUNCE: Duration = Duration::from_millis(500);
const APP_PING_INTERVAL: Duration = Duration::from_secs(25);
const MAX_BACKOFF_SECS: u64 = 60;
const ASSISTANT_SUMMARY_MAX: usize = 200;
/// Max chat messages (across all sessions) carried in one `chat` snapshot.
const CHAT_MESSAGE_SYNC_LIMIT: i64 = 2000;
const E2EE_KEYRING_SERVICE: &str = "com.agentboard.app.iris-remote";
const E2EE_KEYRING_USER: &str = "root-key-v1";

// ── Public status / device types ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceInfo {
    pub id: String,
    pub kind: String,
    pub name: String,
}

/// Snapshot returned to the frontend by the `sync_status` command.
#[derive(Debug, Clone, Serialize)]
pub struct SyncStatusInfo {
    /// Sync switch (settings `sync_enabled`).
    pub enabled: bool,
    /// Whether a refresh token is held (i.e. an account is logged in).
    pub logged_in: bool,
    /// Connection state: `disabled` | `disconnected` | `connecting` | `connected` | `reconnecting`.
    pub state: String,
    pub username: Option<String>,
    pub device_count: usize,
    pub devices: Vec<DeviceInfo>,
    /// Last human-readable error (auth/network/WS), if any.
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct BindCodeResult {
    pub code: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatBinding {
    pub id: String,
    pub platform: String,
    pub chat_id: String,
    pub chat_type: Option<String>,
    pub sender_id: Option<String>,
    pub bound_at: i64,
}

// ── Connection state ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ConnState {
    Disabled,
    Disconnected,
    Connecting,
    Connected,
    Reconnecting,
}

impl Default for ConnState {
    fn default() -> Self {
        ConnState::Disabled
    }
}

impl ConnState {
    fn as_str(&self) -> &'static str {
        match self {
            ConnState::Disabled => "disabled",
            ConnState::Disconnected => "disconnected",
            ConnState::Connecting => "connecting",
            ConnState::Connected => "connected",
            ConnState::Reconnecting => "reconnecting",
        }
    }
}

// ── Internal signals ──────────────────────────────────────────────────────────

/// A relayed agent event to append (already summarized/redacted — no chat text
/// beyond a ≤200-char assistant summary, no secrets).
#[derive(Debug, Clone)]
pub struct EventAppend {
    pub event_type: String,
    pub data: Value,
}

enum Signal {
    /// Task/session rows changed — rebuild+push the snapshot after debounce.
    SnapshotDirty,
    /// A key agent event to relay immediately.
    Event(EventAppend),
    /// Client-encrypted snapshot. The Rust bridge and server treat `data` as
    /// opaque and never inspect the plaintext coding timeline.
    OpaqueSnapshot { kind: String, data: Value },
    /// Direct response to a mobile command (file listing, file content, etc.).
    Response { kind: String, data: Value },
}

// ── Shared inner state ────────────────────────────────────────────────────────

#[derive(Default)]
struct SyncInner {
    enabled: bool,
    username: Option<String>,
    /// In-memory only (never persisted).
    access_token: Option<String>,
    /// Persisted to settings `sync_refresh_token`.
    refresh_token: Option<String>,
    device_id: Option<String>,
    conn_state: ConnState,
    devices: Vec<DeviceInfo>,
    last_error: Option<String>,
}

impl SyncInner {
    fn wants_connection(&self) -> bool {
        self.enabled && self.refresh_token.is_some()
    }
}

// ── SyncManager ───────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct SyncManager {
    inner: Arc<Mutex<SyncInner>>,
    sig_tx: mpsc::UnboundedSender<Signal>,
    /// Control epoch — bumped on login/logout/enable-change to wake `master_loop`.
    ctrl_tx: watch::Sender<u64>,
    /// Receivers handed to the master loop exactly once at `spawn`.
    rx_holder: Arc<std::sync::Mutex<Option<(mpsc::UnboundedReceiver<Signal>, watch::Receiver<u64>)>>>,
}

impl Default for SyncManager {
    fn default() -> Self {
        Self::new()
    }
}

impl SyncManager {
    pub fn new() -> Self {
        let (sig_tx, sig_rx) = mpsc::unbounded_channel();
        let (ctrl_tx, ctrl_rx) = watch::channel(0u64);
        Self {
            inner: Arc::new(Mutex::new(SyncInner::default())),
            sig_tx,
            ctrl_tx,
            rx_holder: Arc::new(std::sync::Mutex::new(Some((sig_rx, ctrl_rx)))),
        }
    }

    /// Cheap, non-blocking: mark the snapshot dirty (coalesced + debounced by the loop).
    pub fn notify_snapshot(&self) {
        let _ = self.sig_tx.send(Signal::SnapshotDirty);
    }

    /// Cheap, non-blocking: relay a key agent event.
    pub fn notify_event(&self, ea: EventAppend) {
        let _ = self.sig_tx.send(Signal::Event(ea));
    }

    pub fn publish_opaque_snapshot(&self, kind: String, data: Value) -> Result<(), String> {
        if !matches!(kind.as_str(), "coding" | "machines" | "crypto") {
            return Err("不允许的加密快照类型".to_string());
        }
        self.sig_tx
            .send(Signal::OpaqueSnapshot { kind, data })
            .map_err(|_| "同步后台未运行".to_string())
    }

    pub fn push_response(&self, kind: &str, data: Value) {
        let _ = self.sig_tx.send(Signal::Response {
            kind: kind.to_string(),
            data,
        });
    }

    fn bump(&self) {
        self.ctrl_tx.send_modify(|v| *v = v.wrapping_add(1));
    }

    /// Start the single long-lived sync task. Loads persisted account/switch
    /// state from settings, then runs `master_loop`. Idempotent (no-op if the
    /// receivers were already taken).
    pub fn spawn(&self, db: Arc<Db>, app: AppHandle) {
        let taken = self.rx_holder.lock().unwrap().take();
        let Some((sig_rx, ctrl_rx)) = taken else {
            return;
        };
        let inner = self.inner.clone();
        tauri::async_runtime::spawn(async move {
            {
                let enabled = db
                    .settings_get("sync_enabled")
                    .ok()
                    .flatten()
                    .map(|s| s == "true")
                    .unwrap_or(false);
                let refresh = db
                    .settings_get("sync_refresh_token")
                    .ok()
                    .flatten()
                    .filter(|s| !s.is_empty());
                let username = db
                    .settings_get("sync_username")
                    .ok()
                    .flatten()
                    .filter(|s| !s.is_empty());
                let device_id = db
                    .settings_get("sync_device_id")
                    .ok()
                    .flatten()
                    .filter(|s| !s.is_empty());

                let mut g = inner.lock().await;
                g.enabled = enabled;
                g.refresh_token = refresh;
                g.username = username;
                g.device_id = device_id;
                g.conn_state = if g.wants_connection() {
                    ConnState::Disconnected
                } else {
                    ConnState::Disabled
                };
            }
            master_loop(inner, db, app, sig_rx, ctrl_rx).await;
        });
    }

    // ── Account commands (called from Tauri commands) ─────────────────────────

    /// Register (`register=true`) or log in, store the session, enable sync and
    /// wake the loop. On failure returns a human-readable Chinese message.
    pub async fn login(
        &self,
        db: &Db,
        username: &str,
        password: &str,
        register: bool,
    ) -> Result<(), String> {
        let client = http_client()?;
        let path = if register { "/api/register" } else { "/api/login" };
        let (status, v) = post_status(&client, path, &json!({"username": username, "password": password}), None)
            .await
            .map_err(|e| format!("网络错误：{e}"))?;
        if status != 200 || v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
            let code = v.get("error").and_then(|x| x.as_str()).unwrap_or("unknown");
            let msg = v.get("message").and_then(|x| x.as_str()).unwrap_or("");
            return Err(friendly_error(code, msg));
        }
        let sess = parse_session(&v)?;
        {
            let mut g = self.inner.lock().await;
            g.username = Some(sess.username.clone());
            g.access_token = Some(sess.access_token.clone());
            g.refresh_token = Some(sess.refresh_token.clone());
            g.enabled = true;
            g.last_error = None;
            g.device_id = None;
            g.devices.clear();
        }
        // Switch to the per-account database (creates it empty on first login).
        crate::db::last_user_write(Some(&sess.username));
        if let Err(e) = db.reopen(Some(&sess.username)) {
            eprintln!("[sync] failed to open user db for {}: {e}", sess.username);
        }
        // Persist auth in the user-specific database.
        let _ = db.settings_set("sync_refresh_token", &sess.refresh_token);
        let _ = db.settings_set("sync_username", &sess.username);
        let _ = db.settings_set("sync_device_id", "");
        let _ = db.settings_set("sync_enabled", "true");
        self.bump();
        Ok(())
    }

    /// Revoke the refresh token server-side (best-effort) and clear all local state.
    pub async fn logout(&self, db: &Db) {
        let (refresh, access) = {
            let g = self.inner.lock().await;
            (g.refresh_token.clone(), g.access_token.clone())
        };
        if let Some(rt) = refresh {
            if let Ok(client) = http_client() {
                let _ = post_status(
                    &client,
                    "/api/logout",
                    &json!({"refresh_token": rt}),
                    access.as_deref(),
                )
                .await;
            }
        }
        clear_creds(&self.inner, db).await;
        self.bump();
    }

    /// Flip the sync switch (persisted) and wake the loop.
    pub async fn set_enabled(&self, db: &Db, enabled: bool) {
        {
            let mut g = self.inner.lock().await;
            g.enabled = enabled;
            if !enabled {
                g.conn_state = ConnState::Disabled;
            }
        }
        let _ = db.settings_set("sync_enabled", if enabled { "true" } else { "false" });
        self.bump();
    }

    pub async fn status(&self) -> SyncStatusInfo {
        let g = self.inner.lock().await;
        let device_count = if g.devices.is_empty() {
            usize::from(g.device_id.is_some())
        } else {
            g.devices.len()
        };
        SyncStatusInfo {
            enabled: g.enabled,
            logged_in: g.refresh_token.is_some(),
            state: g.conn_state.as_str().to_string(),
            username: g.username.clone(),
            device_count,
            devices: g.devices.clone(),
            last_error: g.last_error.clone(),
        }
    }

    /// Return a clone of the current access token, if logged in.
    pub async fn access_token(&self) -> Option<String> {
        self.inner.lock().await.access_token.clone()
    }
}

// ── Credential helpers ────────────────────────────────────────────────────────

async fn clear_creds(inner: &Arc<Mutex<SyncInner>>, db: &Db) {
    {
        let mut g = inner.lock().await;
        g.access_token = None;
        g.refresh_token = None;
        g.device_id = None;
        g.username = None;
        g.devices.clear();
        g.enabled = false;
        g.conn_state = ConnState::Disabled;
    }
    // Switch back to the default (local-mode) database.
    crate::db::last_user_write(None);
    if let Err(e) = db.reopen(None) {
        eprintln!("[sync] failed to reopen default db on logout: {e}");
    }
    let _ = db.settings_set("sync_refresh_token", "");
    let _ = db.settings_set("sync_device_id", "");
    let _ = db.settings_set("sync_username", "");
    let _ = db.settings_set("sync_enabled", "false");
}

async fn set_state(inner: &Arc<Mutex<SyncInner>>, app: &AppHandle, s: ConnState) {
    {
        inner.lock().await.conn_state = s;
    }
    let _ = app.emit("sync-status-changed", s.as_str());
}

async fn set_err(inner: &Arc<Mutex<SyncInner>>, msg: String) {
    eprintln!("[sync] {msg}");
    inner.lock().await.last_error = Some(msg);
}

// ── TLS certificate pinning ────────────────────────────────────────────────────
//
// The sync server presents a self-signed cert that carries `basicConstraints
// CA:TRUE`. rustls' standard webpki verifier (the `RootCertStore` anchor path)
// rejects such a cert when it is also the leaf: `CaUsedAsEndEntity`. The correct
// handling for a pinned self-signed cert is therefore *exact-certificate
// pinning*: we require the peer's leaf cert to be byte-identical to the embedded
// cert AND still verify the TLS handshake signature (proving possession of the
// matching private key). This is strictly stronger than "chains to this root"
// and is NOT `danger_accept_invalid_certs` — an unknown or tampered cert is
// hard-rejected. The one config below is shared by REST (reqwest
// `use_preconfigured_tls`) and WSS (tokio-tungstenite `Connector::Rustls`).

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{DigitallySignedStruct, SignatureScheme};

#[derive(Debug)]
struct PinnedCertVerifier {
    expected: CertificateDer<'static>,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl ServerCertVerifier for PinnedCertVerifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        if end_entity.as_ref() == self.expected.as_ref() {
            Ok(ServerCertVerified::assertion())
        } else {
            Err(rustls::Error::General(
                "服务器证书与锁定证书不匹配（证书锁定校验失败）".to_string(),
            ))
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider.signature_verification_algorithms.supported_schemes()
    }
}

/// Parse the embedded cert into DER once.
fn pinned_cert_der() -> Result<CertificateDer<'static>, String> {
    let mut reader = SERVER_CERT_PEM.as_bytes();
    let der = rustls_pemfile::certs(&mut reader)
        .next()
        .ok_or("内嵌证书为空")?
        .map_err(|e| format!("内嵌证书解析失败：{e}"))?;
    Ok(der.into_owned())
}

/// rustls ClientConfig using the exact-match pinning verifier (ring provider,
/// matching reqwest's provider in the lockfile).
fn rustls_client_config() -> Result<Arc<rustls::ClientConfig>, String> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let verifier = Arc::new(PinnedCertVerifier {
        expected: pinned_cert_der()?,
        provider: provider.clone(),
    });
    let cfg = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| format!("TLS 版本配置失败：{e}"))?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_no_client_auth();
    Ok(Arc::new(cfg))
}

/// reqwest client pinned to the embedded server cert (shares the rustls config),
/// bypassing any system/MITM proxy (a proxy would break pinning).
fn http_client() -> Result<reqwest::Client, String> {
    let cfg = rustls_client_config()?;
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .no_proxy()
        .use_preconfigured_tls((*cfg).clone())
        .build()
        .map_err(|e| format!("HTTP 客户端构建失败：{e}"))
}

fn ws_connector() -> Result<Connector, String> {
    Ok(Connector::Rustls(rustls_client_config()?))
}

// ── REST helpers ──────────────────────────────────────────────────────────────

async fn post_status(
    client: &reqwest::Client,
    path: &str,
    body: &Value,
    bearer: Option<&str>,
) -> Result<(u16, Value), String> {
    let mut req = client.post(format!("{SYNC_BASE_URL}{path}")).json(body);
    if let Some(t) = bearer {
        req = req.bearer_auth(t);
    }
    let resp = req.send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let v = resp.json::<Value>().await.map_err(|e| e.to_string())?;
    Ok((status, v))
}

async fn get_status(
    client: &reqwest::Client,
    path: &str,
    bearer: &str,
) -> Result<(u16, Value), String> {
    let resp = client
        .get(format!("{SYNC_BASE_URL}{path}"))
        .bearer_auth(bearer)
        .send()
        .await
        .map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let v = resp.json::<Value>().await.map_err(|e| e.to_string())?;
    Ok((status, v))
}

struct Session {
    username: String,
    access_token: String,
    refresh_token: String,
}

fn parse_session(v: &Value) -> Result<Session, String> {
    let username = v
        .get("user")
        .and_then(|u| u.get("username"))
        .and_then(|x| x.as_str())
        .ok_or("响应缺少用户名")?
        .to_string();
    let access_token = v
        .get("access_token")
        .and_then(|x| x.as_str())
        .ok_or("响应缺少 access_token")?
        .to_string();
    let refresh_token = v
        .get("refresh_token")
        .and_then(|x| x.as_str())
        .ok_or("响应缺少 refresh_token")?
        .to_string();
    Ok(Session {
        username,
        access_token,
        refresh_token,
    })
}

fn parse_devices(arr: &[Value]) -> Vec<DeviceInfo> {
    arr.iter()
        .filter_map(|d| {
            Some(DeviceInfo {
                id: d.get("id").and_then(|x| x.as_str())?.to_string(),
                kind: d.get("kind").and_then(|x| x.as_str()).unwrap_or("").to_string(),
                name: d.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            })
        })
        .collect()
}

fn friendly_error(code: &str, msg: &str) -> String {
    match code {
        "username_taken" => "用户名已被注册，请换一个".to_string(),
        "bad_credentials" => "用户名或密码错误".to_string(),
        "invalid_input" => {
            if msg.is_empty() {
                "输入不合法：用户名 3-32 位（字母/数字/_.-），密码至少 8 位".to_string()
            } else {
                format!("输入不合法：{msg}")
            }
        }
        "rate_limited" => {
            if msg.is_empty() {
                "操作过于频繁，请稍后再试".to_string()
            } else {
                format!("操作过于频繁，请稍后再试（{msg}）")
            }
        }
        "bad_refresh" => "登录已失效，请重新登录".to_string(),
        "no_token" | "bad_token" => "登录状态无效，请重新登录".to_string(),
        other => {
            if msg.is_empty() {
                format!("请求失败：{other}")
            } else {
                msg.to_string()
            }
        }
    }
}

fn device_name() -> String {
    std::env::var("COMPUTERNAME")
        .ok()
        .or_else(|| std::env::var("HOSTNAME").ok())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .map(|h| format!("{h}（桌面端）"))
        .unwrap_or_else(|| "AgentBoard 桌面端".to_string())
}

// ── Snapshot / event assembly (pure, unit-tested) ─────────────────────────────

/// Filter a stored `attachments_json` array into sync-safe attachment metadata.
///
/// Privacy: image attachments keep only `kind` + `name` — the raw base64
/// `data_url` (potentially multi-MB) is dropped. Text attachments keep their
/// (already textual) `text`. Unparseable input yields an empty array. No
/// credentials ever live in attachments, but this whitelist guarantees only the
/// listed fields cross the wire.
fn filter_attachments_json(raw: &str) -> Value {
    let parsed: Value = match serde_json::from_str(raw) {
        Ok(v) => v,
        Err(_) => return json!([]),
    };
    let Some(arr) = parsed.as_array() else {
        return json!([]);
    };
    let out: Vec<Value> = arr
        .iter()
        .map(|a| {
            let kind = a.get("kind").and_then(|x| x.as_str()).unwrap_or("");
            let mut m = serde_json::Map::new();
            m.insert("kind".to_string(), json!(kind));
            if let Some(name) = a.get("name").and_then(|x| x.as_str()) {
                m.insert("name".to_string(), json!(name));
            }
            if kind == "text" {
                if let Some(t) = a.get("text").and_then(|x| x.as_str()) {
                    m.insert("text".to_string(), json!(t));
                }
            }
            Value::Object(m)
        })
        .collect();
    Value::Array(out)
}

/// Build the `chat` snapshot payload `{ sessions, messages }` from stored rows.
///
/// Message `content` is included in full (the feature is reading chats on the
/// phone), but attachments are reduced to metadata via `filter_attachments_json`
/// and no API keys / credentials are ever serialized (only the whitelisted
/// fields below). `messages` is expected pre-trimmed + chronologically ordered.
/// Pure → unit-tested.
fn build_chat_snapshot(sessions: &[ChatSessionRow], messages: &[ChatMessageRow]) -> Value {
    let sessions_v: Vec<Value> = sessions
        .iter()
        .map(|s| {
            json!({
                "id": s.id,
                "title": s.title,
                "model": s.model,
                "created_at": s.created_at,
                "updated_at": s.updated_at,
            })
        })
        .collect();
    let messages_v: Vec<Value> = messages
        .iter()
        .map(|m| {
            let atts = m
                .attachments_json
                .as_deref()
                .map(filter_attachments_json)
                .unwrap_or_else(|| json!([]));
            json!({
                "id": m.id,
                "session_id": m.session_id,
                "role": m.role,
                "content": m.content,
                "model": m.model,
                "status": m.status,
                "created_at": m.created_at,
                "attachments": atts,
            })
        })
        .collect();
    json!({ "sessions": sessions_v, "messages": messages_v })
}

fn snapshot_frame(kind: &str, data: Value) -> Value {
    json!({ "type": "snapshot_update", "payload": { "kind": kind, "data": data } })
}

fn event_frame(ea: &EventAppend) -> Value {
    json!({ "type": "event_append", "payload": { "type": ea.event_type, "data": ea.data } })
}

fn summarize(text: &str, max: usize) -> String {
    text.trim().chars().take(max).collect()
}

/// Map an agent event to a relayable `event_append`, or `None` if it should not
/// be forwarded. Only these types cross the wire:
/// `assistant_message` (≤200-char summary), `command_run`, `file_edit`,
/// `turn_completed`, `error`. Chat originals and secrets never leave the desktop.
pub fn event_to_append(
    event: &AgentEvent,
    session_id: &str,
    task_id: Option<&str>,
) -> Option<EventAppend> {
    let with_base = |extra: Value| -> Value {
        let mut m = serde_json::Map::new();
        m.insert("session_id".to_string(), json!(session_id));
        if let Some(t) = task_id {
            m.insert("task_id".to_string(), json!(t));
        }
        if let Value::Object(ex) = extra {
            for (k, v) in ex {
                m.insert(k, v);
            }
        }
        Value::Object(m)
    };

    match event {
        AgentEvent::AssistantMessage { text } => Some(EventAppend {
            event_type: "assistant_message".to_string(),
            data: with_base(json!({ "summary": summarize(text, ASSISTANT_SUMMARY_MAX) })),
        }),
        AgentEvent::CommandRun { cmd, exit_code, .. } => Some(EventAppend {
            event_type: "command_run".to_string(),
            data: with_base(json!({ "cmd": cmd, "exit_code": exit_code })),
        }),
        AgentEvent::FileEdit {
            path,
            kind,
            added,
            removed,
            ..
        } => Some(EventAppend {
            event_type: "file_edit".to_string(),
            data: with_base(json!({ "path": path, "kind": kind, "added": added, "removed": removed })),
        }),
        AgentEvent::TurnCompleted {} => Some(EventAppend {
            event_type: "turn_completed".to_string(),
            data: with_base(json!({})),
        }),
        AgentEvent::Error { message } => Some(EventAppend {
            event_type: "error".to_string(),
            data: with_base(json!({ "message": message })),
        }),
        _ => None,
    }
}

// ── Debounce (pure, unit-tested) ──────────────────────────────────────────────

struct Debounce {
    window: Duration,
    deadline: Option<tokio::time::Instant>,
}

impl Debounce {
    fn new(window: Duration) -> Self {
        Self {
            window,
            deadline: None,
        }
    }
    /// Arm the window on the first mark; subsequent marks within the window are
    /// coalesced (deadline unchanged) so a burst pushes once.
    fn mark(&mut self, now: tokio::time::Instant) {
        if self.deadline.is_none() {
            self.deadline = Some(now + self.window);
        }
    }
    fn clear(&mut self) {
        self.deadline = None;
    }
    #[cfg(test)]
    fn is_ready(&self, now: tokio::time::Instant) -> bool {
        matches!(self.deadline, Some(d) if now >= d)
    }
}

// ── Command mapping (pure, unit-tested) ───────────────────────────────────────

#[derive(Debug, PartialEq)]
enum CommandAction {
    CreateTask { title: String },
    DispatchTask { task_id: String },
    AcceptTask { task_id: String },
    ChatPrompt { session_id: String, message: String },
    ListFiles { path: String },
    ReadFile { path: String },
    Unknown(String),
}

fn parse_command(command: &str, data: &Value) -> CommandAction {
    let s = |k: &str| data.get(k).and_then(|x| x.as_str()).unwrap_or("").to_string();
    match command {
        "create_task" => CommandAction::CreateTask { title: s("title") },
        "dispatch_task" => CommandAction::DispatchTask { task_id: s("task_id") },
        "accept_task" => CommandAction::AcceptTask { task_id: s("task_id") },
        "chat_prompt" => CommandAction::ChatPrompt {
            session_id: s("session_id"),
            message: s("message"),
        },
        "list_files" => CommandAction::ListFiles { path: s("path") },
        "read_file" => CommandAction::ReadFile { path: s("path") },
        other => CommandAction::Unknown(other.to_string()),
    }
}

/// Apply an inbound mobile command to the desktop's task state, reusing the
/// existing dispatch/accept state machine (`bridge::do_dispatch` / `do_accept`).
async fn apply_command(action: CommandAction, app: &AppHandle) -> Result<(), String> {
    let st = app.state::<crate::AppState>();
    match action {
        CommandAction::CreateTask { title } => {
            if title.trim().is_empty() {
                return Err("create_task 缺少 title".to_string());
            }
            let workdir = st
                .db
                .settings_get("default_workdir")
                .ok()
                .flatten()
                .unwrap_or_default();
            let id = uuid::Uuid::new_v4().to_string();
            let title: String = title.chars().take(120).collect();
            st.db
                .insert_task_todo(&id, &title, &workdir)
                .map_err(|e| e.to_string())?;
            let _ = app.emit("bridge-task-created", &id);
            st.sync.notify_snapshot();
            Ok(())
        }
        CommandAction::DispatchTask { task_id } => {
            // Route through the same validation the Feishu card path uses.
            let (toast, ok) = crate::bridge::validate_card_action("dispatch", &task_id, &st.db).await?;
            if !ok {
                return Err(toast);
            }
            crate::bridge::do_dispatch(&task_id, &st.db, &st.sessions, &st.trackers, &st.adapter, app)
                .await?;
            st.sync.notify_snapshot();
            Ok(())
        }
        CommandAction::AcceptTask { task_id } => {
            crate::bridge::do_accept(&task_id, &st.db, app).await?;
            st.sync.notify_snapshot();
            Ok(())
        }
        CommandAction::ChatPrompt { session_id, message } => {
            if session_id.trim().is_empty() || message.trim().is_empty() {
                return Err("chat_prompt 缺少 session_id 或 message".to_string());
            }
            let session = st
                .db
                .chat_session_get(&session_id)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| "聊天会话不存在".to_string())?;
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                let state = app.state::<crate::AppState>();
                let result = crate::studio::chat_send_impl(
                    session_id,
                    message,
                    Vec::new(),
                    session.model,
                    None,
                    &state,
                    app.clone(),
                )
                .await;
                if let Err(error) = result {
                    eprintln!("[sync] mobile chat_prompt failed: {error}");
                    state.sync.notify_snapshot();
                }
            });
            Ok(())
        }
        CommandAction::ListFiles { path } => {
            let workdir = if path.is_empty() {
                st.db.settings_get("default_workdir").ok().flatten().unwrap_or_default()
            } else {
                path
            };
            if workdir.is_empty() {
                return Err("无默认工作目录".to_string());
            }
            let root = std::path::PathBuf::from(&workdir);
            let entries = crate::workspace_fs::list_dir_standalone(&root, ".")
                .unwrap_or_default();
            let data = json!({
                "root": workdir,
                "entries": entries,
            });
            st.sync.push_response("files", data);
            Ok(())
        }
        CommandAction::ReadFile { path } => {
            if path.is_empty() {
                return Err("read_file 缺少 path".to_string());
            }
            let workdir = st.db.settings_get("default_workdir").ok().flatten().unwrap_or_default();
            if workdir.is_empty() {
                return Err("无默认工作目录".to_string());
            }
            let root = std::path::PathBuf::from(&workdir);
            let content = crate::workspace_fs::read_file_standalone(&root, &path)
                .unwrap_or_else(|e| crate::workspace_fs::WsFileContent {
                    content: format!("读取失败: {e}"),
                    encoding: "error".to_string(),
                    too_large: false,
                });
            let data = json!({
                "path": path,
                "root": workdir,
                "content": content.content,
                "encoding": content.encoding,
            });
            st.sync.push_response("file_content", data);
            Ok(())
        }
        CommandAction::Unknown(c) => Err(format!("未知命令：{c}")),
    }
}

// ── Master loop ───────────────────────────────────────────────────────────────

enum SessionEnd {
    /// Control epoch changed (login/logout/enable) — re-evaluate, no backoff.
    ControlChanged,
    /// Network/WS failure — reconnect with backoff.
    Disconnected,
}

async fn master_loop(
    inner: Arc<Mutex<SyncInner>>,
    db: Arc<Db>,
    app: AppHandle,
    mut sig_rx: mpsc::UnboundedReceiver<Signal>,
    mut ctrl_rx: watch::Receiver<u64>,
) {
    ctrl_rx.borrow_and_update();
    let mut backoff = 1u64;

    loop {
        let want = { inner.lock().await.wants_connection() };
        if !want {
            {
                let mut g = inner.lock().await;
                g.conn_state = if g.enabled {
                    ConnState::Disconnected
                } else {
                    ConnState::Disabled
                };
            }
            let _ = app.emit("sync-status-changed", "idle");
            if ctrl_rx.changed().await.is_err() {
                return;
            }
            ctrl_rx.borrow_and_update();
            backoff = 1;
            continue;
        }

        match run_session(&inner, &db, &app, &mut sig_rx, &mut ctrl_rx).await {
            SessionEnd::ControlChanged => {
                backoff = 1;
            }
            SessionEnd::Disconnected => {
                set_state(&inner, &app, ConnState::Reconnecting).await;
                tokio::select! {
                    _ = tokio::time::sleep(Duration::from_secs(backoff)) => {}
                    r = ctrl_rx.changed() => {
                        if r.is_err() { return; }
                        ctrl_rx.borrow_and_update();
                        backoff = 1;
                        continue;
                    }
                }
                backoff = (backoff * 2).min(MAX_BACKOFF_SECS);
            }
        }
    }
}

async fn run_session(
    inner: &Arc<Mutex<SyncInner>>,
    db: &Arc<Db>,
    app: &AppHandle,
    sig_rx: &mut mpsc::UnboundedReceiver<Signal>,
    ctrl_rx: &mut watch::Receiver<u64>,
) -> SessionEnd {
    set_state(inner, app, ConnState::Connecting).await;

    let client = match http_client() {
        Ok(c) => c,
        Err(e) => {
            set_err(inner, e).await;
            return SessionEnd::Disconnected;
        }
    };

    // 1) Rotate the refresh token → fresh 15-min access token.
    let refresh = match { inner.lock().await.refresh_token.clone() } {
        Some(r) => r,
        None => return SessionEnd::ControlChanged,
    };
    let sess = match post_status(&client, "/api/refresh", &json!({"refresh_token": refresh}), None).await {
        Err(net) => {
            set_err(inner, format!("刷新令牌网络错误：{net}")).await;
            return SessionEnd::Disconnected;
        }
        Ok((status, v)) => {
            if status == 200 && v.get("ok").and_then(|x| x.as_bool()) == Some(true) {
                match parse_session(&v) {
                    Ok(s) => s,
                    Err(e) => {
                        set_err(inner, e).await;
                        return SessionEnd::Disconnected;
                    }
                }
            } else {
                // Refresh definitively rejected → hard logout (needs password).
                let code = v.get("error").and_then(|x| x.as_str()).unwrap_or("bad_refresh");
                clear_creds(inner, db).await;
                set_err(inner, friendly_error(code, "")).await;
                return SessionEnd::ControlChanged;
            }
        }
    };
    let access = sess.access_token.clone();
    {
        let mut g = inner.lock().await;
        g.access_token = Some(sess.access_token);
        g.refresh_token = Some(sess.refresh_token.clone());
        g.username = Some(sess.username.clone());
    }
    // Persist the rotated refresh token immediately (protocol: keep the newest).
    let _ = db.settings_set("sync_refresh_token", &sess.refresh_token);
    let _ = db.settings_set("sync_username", &sess.username);

    // 2) Ensure a desktop device id (required for command routing to reach us).
    let device_id = match { inner.lock().await.device_id.clone() } {
        Some(d) => d,
        None => match post_status(
            &client,
            "/api/devices",
            &json!({"kind": "desktop", "name": device_name()}),
            Some(&access),
        )
        .await
        {
            Ok((200, v)) => {
                let id = v
                    .get("device")
                    .and_then(|d| d.get("id"))
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                if id.is_empty() {
                    set_err(inner, "设备注册返回缺少 id".to_string()).await;
                    return SessionEnd::Disconnected;
                }
                {
                    inner.lock().await.device_id = Some(id.clone());
                }
                let _ = db.settings_set("sync_device_id", &id);
                id
            }
            Ok((_, v)) => {
                let m = v.get("message").and_then(|x| x.as_str()).unwrap_or("unknown");
                set_err(inner, format!("设备注册失败：{m}")).await;
                return SessionEnd::Disconnected;
            }
            Err(e) => {
                set_err(inner, format!("设备注册网络错误：{e}")).await;
                return SessionEnd::Disconnected;
            }
        },
    };

    // Best-effort device list for the settings UI.
    if let Ok((200, v)) = get_status(&client, "/api/devices", &access).await {
        if let Some(arr) = v.get("devices").and_then(|x| x.as_array()) {
            inner.lock().await.devices = parse_devices(arr);
        }
    }

    // 3) Open the pinned WSS connection.
    let ws_url = format!("{SYNC_WS_URL}?token={access}&device_id={device_id}");
    let connector = match ws_connector() {
        Ok(c) => c,
        Err(e) => {
            set_err(inner, e).await;
            return SessionEnd::Disconnected;
        }
    };
    let ws = match tokio_tungstenite::connect_async_tls_with_config(ws_url, None, false, Some(connector)).await {
        Ok((ws, _)) => ws,
        Err(e) => {
            set_err(inner, format!("WS 连接失败：{e}")).await;
            return SessionEnd::Disconnected;
        }
    };
    {
        let mut g = inner.lock().await;
        g.conn_state = ConnState::Connected;
        g.last_error = None;
    }
    let _ = app.emit("sync-status-changed", "connected");

    let (mut write, mut read) = ws.split();

    // Push the initial full snapshot.
    if push_snapshots(&mut write, db).await.is_err() {
        return SessionEnd::Disconnected;
    }

    // Only future control changes should abort this session.
    ctrl_rx.borrow_and_update();

    let mut debounce = Debounce::new(SNAPSHOT_DEBOUNCE);
    let mut ping = tokio::time::interval(APP_PING_INTERVAL);
    ping.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);

    loop {
        let snap_wait = async {
            match debounce.deadline {
                Some(d) => tokio::time::sleep_until(d).await,
                None => std::future::pending::<()>().await,
            }
        };

        tokio::select! {
            biased;

            _ = ctrl_rx.changed() => {
                ctrl_rx.borrow_and_update();
                let _ = write.close().await;
                return SessionEnd::ControlChanged;
            }

            inbound = read.next() => {
                match inbound {
                    None => {
                        set_err(inner, "WS 连接已关闭".to_string()).await;
                        return SessionEnd::Disconnected;
                    }
                    Some(Err(e)) => {
                        set_err(inner, format!("WS 读取错误：{e}")).await;
                        return SessionEnd::Disconnected;
                    }
                    Some(Ok(msg)) => {
                        if matches!(msg, Message::Close(_)) {
                            return SessionEnd::Disconnected;
                        }
                        handle_inbound(msg, app).await;
                    }
                }
            }

            maybe = sig_rx.recv() => {
                match maybe {
                    None => {}
                    Some(Signal::SnapshotDirty) => {
                        debounce.mark(tokio::time::Instant::now());
                    }
                    Some(Signal::Event(ea)) => {
                        if write.send(Message::Text(event_frame(&ea).to_string())).await.is_err() {
                            set_err(inner, "WS 发送 event 失败".to_string()).await;
                            return SessionEnd::Disconnected;
                        }
                    }
                    Some(Signal::OpaqueSnapshot { kind, data }) => {
                        let frame = snapshot_frame(&kind, data);
                        if write.send(Message::Text(frame.to_string())).await.is_err() {
                            set_err(inner, "WS 发送加密快照失败".to_string()).await;
                            return SessionEnd::Disconnected;
                        }
                    }
                    Some(Signal::Response { kind, data }) => {
                        let frame = snapshot_frame(&kind, data);
                        if write.send(Message::Text(frame.to_string())).await.is_err() {
                            set_err(inner, "WS 发送响应失败".to_string()).await;
                            return SessionEnd::Disconnected;
                        }
                    }
                }
            }

            _ = snap_wait => {
                debounce.clear();
                if push_snapshots(&mut write, db).await.is_err() {
                    set_err(inner, "WS 推送快照失败".to_string()).await;
                    return SessionEnd::Disconnected;
                }
            }

            _ = ping.tick() => {
                let _ = write.send(Message::Text(json!({"type": "ping"}).to_string())).await;
            }
        }
    }
}

type WsWrite = futures_util::stream::SplitSink<
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>,
    Message,
>;

async fn push_snapshots(write: &mut WsWrite, db: &Db) -> Result<(), ()> {
    let tasks = db.list_tasks().unwrap_or_default();
    let sessions = db.list_sessions().unwrap_or_default();
    let tasks_data = serde_json::to_value(&tasks).unwrap_or_else(|_| Value::Array(vec![]));
    let sessions_data = serde_json::to_value(&sessions).unwrap_or_else(|_| Value::Array(vec![]));

    write
        .send(Message::Text(snapshot_frame("tasks", tasks_data).to_string()))
        .await
        .map_err(|_| ())?;
    write
        .send(Message::Text(snapshot_frame("sessions", sessions_data).to_string()))
        .await
        .map_err(|_| ())?;

    // Chat conversations (privacy-filtered: full text, but no API keys and no
    // large image base64 — attachments are reduced to metadata).
    let chat_sessions = db.chat_sessions_list().unwrap_or_default();
    let mut chat_messages = db
        .chat_messages_recent(CHAT_MESSAGE_SYNC_LIMIT)
        .unwrap_or_default();
    chat_messages.reverse(); // newest-first (DB) → chronological for the phone
    let chat_data = build_chat_snapshot(&chat_sessions, &chat_messages);
    write
        .send(Message::Text(snapshot_frame("chat", chat_data).to_string()))
        .await
        .map_err(|_| ())?;
    Ok(())
}

async fn handle_inbound(msg: Message, app: &AppHandle) {
    let text = match msg {
        Message::Text(t) => t,
        _ => return,
    };
    let v: Value = match serde_json::from_str(&text) {
        Ok(v) => v,
        Err(_) => return,
    };
    match v.get("type").and_then(|x| x.as_str()).unwrap_or("") {
        "command" => {
            let p = v.get("payload").cloned().unwrap_or(Value::Null);
            let command = p.get("command").and_then(|x| x.as_str()).unwrap_or("");
            let data = p.get("data").cloned().unwrap_or(Value::Null);
            if command == "e2ee" {
                // Opaque ciphertext: only the paired WebView has the root key.
                // Rust and the relay server deliberately never inspect it.
                let _ = app.emit("sync-encrypted-command", data);
                return;
            }
            let action = parse_command(command, &data);
            if let CommandAction::Unknown(c) = &action {
                eprintln!("[sync] 忽略未知命令：{c}");
                return;
            }
            if let Err(e) = apply_command(action, app).await {
                eprintln!("[sync] 命令执行失败：{e}");
            }
        }
        "error" => {
            let m = v.get("message").and_then(|x| x.as_str()).unwrap_or("");
            eprintln!("[sync] 服务器错误帧：{m}");
        }
        // ready / ack / pong / relayed snapshot_update / event_append: no-op.
        _ => {}
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────────

/// Load the Iris E2EE root key from Windows Credential Manager, migrating a
/// frontend-provided legacy key only when no credential exists yet.
#[tauri::command]
pub(crate) async fn sync_e2ee_key_get_or_create(candidate: String) -> Result<String, String> {
    let entry = keyring::Entry::new(E2EE_KEYRING_SERVICE, E2EE_KEYRING_USER)
        .map_err(|e| format!("无法打开 Iris 加密凭据: {e}"))?;
    match entry.get_password() {
        Ok(key) if !key.trim().is_empty() => Ok(key),
        Ok(_) | Err(keyring::Error::NoEntry) => {
            if candidate.trim().is_empty() {
                return Err("Iris 加密密钥候选值为空".to_string());
            }
            entry
                .set_password(candidate.trim())
                .map_err(|e| format!("无法保存 Iris 加密凭据: {e}"))?;
            Ok(candidate.trim().to_string())
        }
        Err(e) => Err(format!("无法读取 Iris 加密凭据: {e}")),
    }
}

#[tauri::command]
pub(crate) async fn sync_push_notify(
    kind: String,
    session_id: Option<String>,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    if !matches!(kind.as_str(), "approval" | "completion" | "failure" | "input") {
        return Err("不支持的推送通知类型".to_string());
    }
    state.sync.notify_event(EventAppend {
        event_type: "push_notification".to_string(),
        data: json!({ "kind": kind, "session_id": session_id.unwrap_or_default() }),
    });
    Ok(())
}

#[tauri::command]
pub(crate) async fn sync_status(
    state: tauri::State<'_, crate::AppState>,
) -> Result<SyncStatusInfo, String> {
    Ok(state.sync.status().await)
}

#[tauri::command]
pub(crate) async fn sync_register(
    username: String,
    password: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    state.sync.login(&state.db, &username, &password, true).await
}

#[tauri::command]
pub(crate) async fn sync_login(
    username: String,
    password: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    state.sync.login(&state.db, &username, &password, false).await
}

#[tauri::command]
pub(crate) async fn sync_logout(state: tauri::State<'_, crate::AppState>) -> Result<(), String> {
    state.sync.logout(&state.db).await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn sync_set_enabled(
    enabled: bool,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    state.sync.set_enabled(&state.db, enabled).await;
    Ok(())
}

#[tauri::command]
pub(crate) async fn sync_publish_encrypted_snapshot(
    kind: String,
    data: Value,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    state.sync.publish_opaque_snapshot(kind, data)
}

#[tauri::command]
pub(crate) async fn sync_generate_bind_code(
    state: tauri::State<'_, crate::AppState>,
) -> Result<BindCodeResult, String> {
    let token = state.sync.access_token().await
        .ok_or("未登录，请先登录同步账号")?;
    let client = http_client()?;
    let (status, v) = post_status(&client, "/api/bind-code", &json!({}), Some(&token))
        .await
        .map_err(|e| format!("网络错误：{e}"))?;
    if status != 200 || v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
        let msg = v.get("message").and_then(|x| x.as_str()).unwrap_or("未知错误");
        return Err(format!("生成绑定码失败：{msg}"));
    }
    Ok(BindCodeResult {
        code: v.get("code").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        expires_at: v.get("expires_at").and_then(|x| x.as_i64()).unwrap_or(0),
    })
}

#[tauri::command]
pub(crate) async fn sync_list_chat_bindings(
    state: tauri::State<'_, crate::AppState>,
) -> Result<Vec<ChatBinding>, String> {
    let token = state.sync.access_token().await
        .ok_or("未登录，请先登录同步账号")?;
    let client = http_client()?;
    let (status, v) = get_status(&client, "/api/chat-bindings", &token)
        .await
        .map_err(|e| format!("网络错误：{e}"))?;
    if status != 200 || v.get("ok").and_then(|x| x.as_bool()) != Some(true) {
        return Ok(vec![]);
    }
    let bindings = v.get("bindings")
        .and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|b| serde_json::from_value::<ChatBinding>(b.clone()).ok())
                .collect()
        })
        .unwrap_or_default();
    Ok(bindings)
}

#[tauri::command]
pub(crate) async fn sync_delete_chat_binding(
    id: String,
    state: tauri::State<'_, crate::AppState>,
) -> Result<(), String> {
    let token = state.sync.access_token().await
        .ok_or("未登录，请先登录同步账号")?;
    let client = http_client()?;
    let url = format!("{SYNC_BASE_URL}/api/chat-bindings/{id}");
    let resp = client
        .delete(&url)
        .bearer_auth(&token)
        .send()
        .await
        .map_err(|e| format!("网络错误：{e}"))?;
    let status = resp.status().as_u16();
    if status != 200 {
        return Err("解绑失败".to_string());
    }
    Ok(())
}

// ── Unit tests ────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    // ── friendly_error ────────────────────────────────────────────────────────
    #[test]
    fn friendly_error_known_codes() {
        assert!(friendly_error("username_taken", "").contains("已被注册"));
        assert!(friendly_error("bad_credentials", "").contains("密码错误"));
        assert!(friendly_error("bad_refresh", "").contains("重新登录"));
        assert!(friendly_error("rate_limited", "10 分钟").contains("10 分钟"));
        assert!(friendly_error("weird_code", "").contains("weird_code"));
    }

    // ── summarize ─────────────────────────────────────────────────────────────
    #[test]
    fn summarize_truncates_to_max_chars() {
        let long: String = "中".repeat(500);
        assert_eq!(summarize(&long, 200).chars().count(), 200);
        assert_eq!(summarize("  hi  ", 200), "hi");
    }

    // ── parse_command ─────────────────────────────────────────────────────────
    #[test]
    fn parse_command_maps_all_verbs() {
        assert_eq!(
            parse_command("create_task", &json!({"title": "T"})),
            CommandAction::CreateTask { title: "T".to_string() }
        );
        assert_eq!(
            parse_command("dispatch_task", &json!({"task_id": "x"})),
            CommandAction::DispatchTask { task_id: "x".to_string() }
        );
        assert_eq!(
            parse_command("accept_task", &json!({"task_id": "y"})),
            CommandAction::AcceptTask { task_id: "y".to_string() }
        );
        assert_eq!(
            parse_command("chat_prompt", &json!({"session_id": "s", "message": "next"})),
            CommandAction::ChatPrompt {
                session_id: "s".to_string(),
                message: "next".to_string(),
            }
        );
        match parse_command("bogus", &json!({})) {
            CommandAction::Unknown(c) => assert_eq!(c, "bogus"),
            _ => panic!("expected Unknown"),
        }
    }

    // ── chat snapshot: attachment filtering + privacy ─────────────────────────
    #[test]
    fn filter_attachments_drops_image_base64_keeps_metadata_and_text() {
        // Image attachment with a big data_url → keep only kind + name.
        let raw = r#"[
            {"kind":"image","name":"shot.png","data_url":"data:image/png;base64,AAAABBBBCCCCDDDD"},
            {"kind":"text","name":"notes.txt","text":"hello file"}
        ]"#;
        let v = filter_attachments_json(raw);
        let arr = v.as_array().expect("array");
        assert_eq!(arr.len(), 2);
        // image: no data_url leaks, metadata kept
        assert_eq!(arr[0]["kind"], "image");
        assert_eq!(arr[0]["name"], "shot.png");
        assert!(arr[0].get("data_url").is_none(), "image base64 must be stripped");
        // text: keeps textual content
        assert_eq!(arr[1]["kind"], "text");
        assert_eq!(arr[1]["text"], "hello file");
        // no base64 substring anywhere in the serialized output
        assert!(!v.to_string().contains("AAAABBBB"));
    }

    #[test]
    fn filter_attachments_bad_input_is_empty_array() {
        assert_eq!(filter_attachments_json("not json"), json!([]));
        assert_eq!(filter_attachments_json("{\"kind\":\"image\"}"), json!([]));
    }

    #[test]
    fn build_chat_snapshot_shape_and_no_secrets() {
        let sessions = vec![ChatSessionRow {
            id: "cs1".into(),
            title: "重构".into(),
            model: "gpt-5.5".into(),
            created_at: 1,
            updated_at: 2,
        }];
        let messages = vec![
            ChatMessageRow {
                id: "m1".into(),
                session_id: "cs1".into(),
                role: "user".into(),
                content: "看看这张图".into(),
                attachments_json: Some(
                    r#"[{"kind":"image","name":"a.png","data_url":"data:image/png;base64,ZZZZSECRET"}]"#
                        .into(),
                ),
                model: Some("gpt-5.5".into()),
                status: "complete".into(),
                created_at: 1,
            },
            ChatMessageRow {
                id: "m2".into(),
                session_id: "cs1".into(),
                role: "assistant".into(),
                content: "这是一只猫".into(),
                attachments_json: None,
                model: Some("gpt-5.5".into()),
                status: "complete".into(),
                created_at: 2,
            },
        ];
        let snap = build_chat_snapshot(&sessions, &messages);
        assert_eq!(snap["sessions"][0]["id"], "cs1");
        assert_eq!(snap["sessions"][0]["title"], "重构");
        assert_eq!(snap["messages"].as_array().unwrap().len(), 2);
        // full content is synced (feature requirement)
        assert_eq!(snap["messages"][0]["content"], "看看这张图");
        assert_eq!(snap["messages"][1]["content"], "这是一只猫");
        // image base64 never crosses the wire
        assert_eq!(snap["messages"][0]["attachments"][0]["kind"], "image");
        assert!(snap["messages"][0]["attachments"][0].get("data_url").is_none());
        assert!(!snap.to_string().contains("ZZZZSECRET"), "image base64 must not leak");
    }

    // ── snapshot_frame ────────────────────────────────────────────────────────
    #[test]
    fn snapshot_frame_shape_matches_protocol() {
        let f = snapshot_frame("tasks", json!([{"id": "t1"}]));
        assert_eq!(f["type"], "snapshot_update");
        assert_eq!(f["payload"]["kind"], "tasks");
        assert_eq!(f["payload"]["data"][0]["id"], "t1");
    }

    // ── event_to_append ───────────────────────────────────────────────────────
    #[test]
    fn event_to_append_maps_key_events_and_skips_others() {
        // assistant_message → summary, carries session/task ids.
        let ev = AgentEvent::AssistantMessage { text: "x".repeat(400) };
        let ea = event_to_append(&ev, "s1", Some("t1")).expect("assistant maps");
        assert_eq!(ea.event_type, "assistant_message");
        assert_eq!(ea.data["session_id"], "s1");
        assert_eq!(ea.data["task_id"], "t1");
        assert_eq!(ea.data["summary"].as_str().unwrap().chars().count(), 200);

        // command_run / file_edit / turn_completed / error all map.
        assert_eq!(
            event_to_append(&AgentEvent::CommandRun { cmd: "ls".into(), exit_code: 0, output_tail: "".into() }, "s", None)
                .unwrap()
                .event_type,
            "command_run"
        );
        assert_eq!(
            event_to_append(&AgentEvent::FileEdit { path: "a".into(), kind: "update".into(), diff: None, added: 1, removed: 0, snapshot_path: None }, "s", None)
                .unwrap()
                .event_type,
            "file_edit"
        );
        assert_eq!(
            event_to_append(&AgentEvent::TurnCompleted {}, "s", None).unwrap().event_type,
            "turn_completed"
        );
        assert_eq!(
            event_to_append(&AgentEvent::Error { message: "boom".into() }, "s", None).unwrap().event_type,
            "error"
        );

        // Non-key events are dropped (not relayed).
        assert!(event_to_append(&AgentEvent::AssistantDelta { text: "d".into() }, "s", None).is_none());
        assert!(event_to_append(&AgentEvent::Reasoning { text: "r".into() }, "s", None).is_none());
        assert!(event_to_append(&AgentEvent::Usage { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, reasoning_output_tokens: 0 }, "s", None).is_none());
    }

    #[test]
    fn event_to_append_omits_task_id_when_absent() {
        let ea = event_to_append(&AgentEvent::TurnCompleted {}, "s9", None).unwrap();
        assert_eq!(ea.data["session_id"], "s9");
        assert!(ea.data.get("task_id").is_none());
    }

    // ── Debounce coalescing ───────────────────────────────────────────────────
    #[test]
    fn debounce_coalesces_burst_into_single_deadline() {
        let mut d = Debounce::new(Duration::from_millis(500));
        let t0 = tokio::time::Instant::now();
        d.mark(t0);
        let first = d.deadline.expect("armed");
        // A second mark 100ms later must NOT push the deadline out.
        d.mark(t0 + Duration::from_millis(100));
        assert_eq!(d.deadline.unwrap(), first, "burst marks coalesce");
        assert!(!d.is_ready(t0 + Duration::from_millis(400)), "not ready before window");
        assert!(d.is_ready(t0 + Duration::from_millis(500)), "ready at window end");
        d.clear();
        assert!(d.deadline.is_none());
    }

    // ── parse_session ─────────────────────────────────────────────────────────
    #[test]
    fn parse_session_success_and_missing_field() {
        let v = json!({
            "ok": true,
            "user": { "id": 1, "username": "alice" },
            "access_token": "AT",
            "refresh_token": "RT"
        });
        let s = parse_session(&v).unwrap();
        assert_eq!(s.username, "alice");
        assert_eq!(s.access_token, "AT");
        assert_eq!(s.refresh_token, "RT");

        let bad = json!({ "user": { "username": "bob" }, "access_token": "AT" });
        assert!(parse_session(&bad).is_err(), "missing refresh_token → Err");
    }

    // ── TLS config builds with the pinned cert ────────────────────────────────
    #[test]
    fn pinned_tls_configs_build() {
        assert!(http_client().is_ok(), "reqwest pinned client builds");
        assert!(rustls_client_config().is_ok(), "rustls pinned config builds");
    }

    // ── Live end-to-end (ignored; requires network to the sync server) ────────
    //
    // Registers a throwaway account, opens two pinned WSS clients (desktop A +
    // mobile B), verifies A→B snapshot broadcast and B→A command routing, then
    // logs out. The server exposes no account-delete endpoint, so the temp
    // account is left behind (name printed for the controller to clean up).
    #[tokio::test]
    #[ignore]
    async fn live_sync_end_to_end() {
        async fn wait_for<S>(read: &mut S, target: &str, secs: u64) -> bool
        where
            S: StreamExt<Item = Result<Message, tokio_tungstenite::tungstenite::Error>> + Unpin,
        {
            let deadline = tokio::time::Instant::now() + Duration::from_secs(secs);
            loop {
                let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
                if remaining.is_zero() {
                    return false;
                }
                match tokio::time::timeout(remaining, read.next()).await {
                    Err(_) | Ok(None) | Ok(Some(Err(_))) => return false,
                    Ok(Some(Ok(Message::Text(t)))) => {
                        if let Ok(v) = serde_json::from_str::<Value>(&t) {
                            if v.get("type").and_then(|x| x.as_str()) == Some(target) {
                                return true;
                            }
                        }
                    }
                    Ok(Some(Ok(_))) => {}
                }
            }
        }

        let client = http_client().expect("pinned client");
        // Username must be 3-32 chars; keep it short and unique.
        let suffix = uuid::Uuid::new_v4().simple().to_string();
        let uname = format!("ab_live_{}", &suffix[..12]);
        let pwd = "livetest_pw_12345";

        let (s, v) = post_status(&client, "/api/register", &json!({"username": uname, "password": pwd}), None)
            .await
            .expect("register net");
        assert_eq!(s, 200, "register failed: {v}");
        let sess = parse_session(&v).expect("session");
        let access = sess.access_token.clone();

        let (s, va) = post_status(&client, "/api/devices", &json!({"kind": "desktop", "name": "live-A"}), Some(&access))
            .await
            .expect("dev A net");
        assert_eq!(s, 200);
        let dev_a = va["device"]["id"].as_str().unwrap().to_string();

        let (s, vb) = post_status(&client, "/api/devices", &json!({"kind": "mobile", "name": "live-B"}), Some(&access))
            .await
            .expect("dev B net");
        assert_eq!(s, 200);
        let dev_b = vb["device"]["id"].as_str().unwrap().to_string();

        let url_a = format!("{SYNC_WS_URL}?token={access}&device_id={dev_a}");
        let url_b = format!("{SYNC_WS_URL}?token={access}&device_id={dev_b}");
        let (ws_a, _) = tokio_tungstenite::connect_async_tls_with_config(url_a, None, false, Some(ws_connector().unwrap()))
            .await
            .expect("WSS A");
        let (ws_b, _) = tokio_tungstenite::connect_async_tls_with_config(url_b, None, false, Some(ws_connector().unwrap()))
            .await
            .expect("WSS B");
        let (mut wa, mut ra) = ws_a.split();
        let (mut wb, mut rb) = ws_b.split();

        // Desktop A pushes a task snapshot; mobile B must receive the broadcast.
        wa.send(Message::Text(
            snapshot_frame("tasks", json!([{"id": "t1", "title": "live", "status": "todo", "created_at": 1}]))
                .to_string(),
        ))
        .await
        .unwrap();
        assert!(wait_for(&mut rb, "snapshot_update", 6).await, "B did not receive snapshot broadcast");

        // Mobile B sends a command; desktop A must receive it (command routing).
        wb.send(Message::Text(
            json!({"type": "command", "payload": {"command": "create_task", "data": {"title": "from mobile"}}}).to_string(),
        ))
        .await
        .unwrap();
        assert!(wait_for(&mut ra, "command", 6).await, "A did not receive command");

        let _ = post_status(&client, "/api/logout", &json!({"refresh_token": sess.refresh_token}), Some(&access)).await;
        eprintln!("[live] leftover test account (no delete endpoint): {uname}");
    }
}
