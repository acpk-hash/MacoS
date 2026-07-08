# AgentBoard Sync Protocol v1

Server that links the desktop app and the mobile app through a registered account.
Desktop pushes task/session state and progress events; mobile receives them live and
can send commands back (create task, dispatch, accept). The server is an account plus
relay hub: it stores the latest snapshot and a ring of recent events, and fans messages
out between all devices of one account.

This document is the integration contract for **A3 (desktop)** and **A4 (Android)**.

---

## 1. Endpoints and transport

| Property | Value |
|---|---|
| Public base URL | `https://107.174.70.15:8443` |
| WebSocket URL | `wss://107.174.70.15:8443/ws?token=<access_jwt>&device_id=<device_id>` |
| TLS | Self-signed (10y). Clients **must** pin the fingerprint below. Do not rely on system CA trust. |
| Content type | `application/json` (UTF-8) |
| Auth | `Authorization: Bearer <access_token>` on protected REST calls; `?token=` query param on the WS upgrade |

nginx terminates TLS on `:8443` and reverse-proxies to a Node HTTPS/WSS service on
`127.0.0.1:8444`. The port-80 static site is untouched.

### Certificate pinning

Pin this SHA-256 certificate fingerprint on both clients and reject any other:

```
A5:A3:31:44:E9:11:74:09:D5:5F:1F:D0:7A:37:B6:81:15:83:4C:15:E4:F4:43:60:D8:B3:5F:9F:74:93:79:51
```

- Android (OkHttp): `CertificatePinner` with `sha256/<base64 DER SPKI>`, or validate the leaf
  cert fingerprint directly. The cert carries `subjectAltName = IP:107.174.70.15`, so hostname
  verification against the IP passes.
- Desktop (Node/Electron): supply a custom `checkServerIdentity` that compares
  `tlsSocket.getPeerCertificate().fingerprint256` to the value above.

The fingerprint changes only if the cert is regenerated; treat a mismatch as a hard failure.

---

## 2. REST API

All responses are JSON. Success: `{ "ok": true, ... }`. Error: `{ "ok": false, "error": "<code>", "message": "<human text>" }`.

### 2.1 Accounts

**POST `/api/register`**  body `{ "username", "password" }`
- `username`: 3-32 chars, `[A-Za-z0-9_.-]`. `password`: 8-256 chars.
- 200 issues a session (same body as login). 400 invalid input, 409 `username_taken`, 429 `rate_limited`.

**POST `/api/login`**  body `{ "username", "password" }`
```json
{
  "ok": true,
  "user": { "id": 1, "username": "alice" },
  "access_token": "<JWT>",
  "token_type": "Bearer",
  "expires_in": 900,
  "refresh_token": "<jti>.<secret>",
  "refresh_expires_at": 1790000000000
}
```
- Access token: HS256 JWT, 15 min TTL, claims `{ sub, username, aud:"access", iss:"agentboard-sync" }`.
- Refresh token: opaque `"<jti>.<secret>"`, 30 day TTL. 401 `bad_credentials`, 429 `rate_limited`.

**POST `/api/refresh`**  body `{ "refresh_token" }` returns a new session (same shape as login).
- **Rotating**: the presented refresh token is revoked and a fresh one returned. Reusing an old
  (rotated/expired/revoked) token returns 401 `bad_refresh`. Persist the newest refresh token after every call.

**POST `/api/logout`**  body `{ "refresh_token" }` revokes that one token.
Body `{ "all": true }` plus `Authorization: Bearer <access>` revokes **all** refresh tokens for the user.

### 2.2 Devices  (all require `Authorization`)

**POST `/api/devices`**  body `{ "kind": "desktop"|"mobile", "name": "<label>" }` returns
`{ "ok": true, "device": { "id", "user_id", "kind", "name", "created_at", "last_seen" } }`.
`id` is a UUID. Persist it and reuse it as the `device_id` on the WS connection.

**GET `/api/devices`** returns `{ "ok": true, "devices": [ ... ] }`.
**DELETE `/api/devices/:id`** returns `{ "ok": true }` (404 `not_found` if it is not yours).

### 2.3 Sync catch-up  (require `Authorization`)

**GET `/api/snapshot`** returns the latest full state the desktop has pushed:
```json
{ "ok": true, "snapshots": {
    "tasks":    { "data": [ /* Task[] */ ],    "updated_at": 1790000000000 },
    "sessions": { "data": [ /* Session[] */ ], "updated_at": 1790000000000 },
    "chat":     { "data": { /* ChatSnapshot */ }, "updated_at": 1790000000000 }
} }
```
A `kind` is absent until the desktop pushes it at least once.

**GET `/api/events?after_seq=<n>&limit=<m>`** returns events with `seq > n`, ascending
(default limit 1000, max 5000):
```json
{ "ok": true,
  "events": [ { "seq": 42, "from_device": "<uuid>", "type": "task_progress",
                "payload": { }, "created_at": 1790000000000 } ],
  "last_seq": 42 }
```
Reconnect flow: `GET /api/snapshot` to rebuild state, then `GET /api/events?after_seq=<last seq seen>`
to fill the gap, then open the WS for live updates.

---

## 3. WebSocket channel

Connect: `wss://.../ws?token=<access_jwt>&device_id=<device_id>`.
- Bad/expired token: upgrade rejected `401`. `device_id` not owned by the user: `403`.
  `device_id` is optional but strongly recommended (it sets `from_device` on your messages and
  is required for command routing to reach the desktop).
- All devices of one account share a **room**; messages are relayed between them, never to other accounts.

Every frame is JSON `{ "type", ... }`. Server-relayed frames add `"from_device"` (the origin device id).

### 3.1 Client to Server

| type | payload | effect |
|---|---|---|
| `snapshot_update` | `{ "kind": "tasks" \| "sessions" \| "chat", "data": <array/object> }` | Overwrites the stored snapshot for that kind; broadcast to the other devices on the account. Sent by desktop. |
| `event_append` | `{ "type": "<event_type>", "data": <object> }` | Appended to the event log with a server-assigned `seq`; broadcast to other devices; sender gets an `ack`. Sent by desktop. |
| `command` | `{ "command": "<name>", "data": <object> }` | Appended to the event log as `command:<name>`; relayed to **desktop** devices only; sender gets an `ack`. Sent by mobile. |
| `ping` | none | Server replies `pong` (app-level, separate from WS protocol ping frames). |

### 3.2 Server to Client

| type | shape |
|---|---|
| `ready` | `{ "payload": { "device_id", "server_time" } }` sent right after connect. |
| `snapshot_update` | `{ "from_device", "payload": { "kind", "data", "updated_at" } }` |
| `event_append` | `{ "from_device", "seq", "payload": { "type", "data", "created_at" } }` |
| `command` | `{ "from_device", "seq", "payload": { "command", "data", "created_at" } }` |
| `ack` | `{ "payload": { "of": "event_append" or "command", "seq" } }` echoed to the sender. |
| `error` | `{ "code", "message" }` |
| `pong` | `{ "payload": { "server_time" } }` |

### 3.3 Heartbeat and reconnect
- Server sends a WS **ping frame every 30s**; a peer that fails to pong is terminated. Clients
  should also send an app-level `ping` (or rely on transport pong) to keep NAT mappings alive.
- Reconnect is the client responsibility (exponential backoff suggested). Because the access token
  lives 15 min, refresh it via `/api/refresh` before reconnecting when needed.
- After every reconnect, run the catch-up flow in section 2.3 before trusting live frames.

---

## 4. Data shapes (aligned with the desktop model)

These are **client conventions**. The server stores snapshots/events opaquely and does **not**
validate the inner shape.

### Task (snapshot kind `tasks` = `Task[]`)
```json
{ "id": "t1", "title": "Ship sync server", "status": "todo|in_progress|done",
  "created_at": 1790000000000 }
```

### Session (snapshot kind `sessions` = `Session[]`)
```json
{ "id": "s1", "task_id": "t1", "engine": "codex|claude", "thread_id": "abc123" }
```

### Chat (snapshot kind `chat` = `ChatSnapshot`, one object)
The desktop chat/studio conversations, pushed so the mobile app can **read** them.
The snapshot is a single object with two arrays:
```json
{
  "sessions": [
    { "id": "cs1", "title": "重构同步层", "model": "gpt-5.5",
      "created_at": 1790000000000, "updated_at": 1790000000000 }
  ],
  "messages": [
    { "id": "m1", "session_id": "cs1", "role": "user|assistant",
      "content": "消息正文（明文，供手机查看）", "model": "gpt-5.5",
      "status": "complete|streaming|stopped|error",
      "created_at": 1790000000000,
      "attachments": [ { "kind": "image", "name": "shot.png" },
                       { "kind": "text",  "name": "notes.txt", "text": "内联文本" } ] }
  ]
}
```
Privacy rules the **desktop enforces before sending** (the server relays verbatim):
- Message `content` is synced in full (the point of the feature is reading chats on the phone).
- **API keys / credentials are never included** — chat rows do not hold them, and only the
  whitelisted fields above are serialized.
- Attachments are reduced to **metadata only**: image `data_url` (large base64) is dropped,
  keeping `kind` + `name`; text attachments keep their (already textual) `text`.
- `messages` is capped to the most recent N across all sessions (desktop-side limit).

### Event `type` vocabulary (suggested)
`task_progress`, `task_status`, `session_started`, `session_output`, `session_ended`.
`payload.data` is free-form but should reference `task_id` / `session_id` where relevant.

### Command `command` vocabulary
`create_task` (`data: { title, ... }`), `dispatch_task` (`data: { task_id, target, ... }`),
`accept_task` (`data: { task_id, ... }`). Add more as needed; the desktop is the authority
that interprets and applies them.

### Security convention (enforced by clients, not the server)
**Never** place passwords, API keys, tokens, or other secrets inside any `snapshot`, `event`,
or `command` payload. The server relays payloads verbatim and does not scrub them.

---

## 5. Error codes

| HTTP | `error` | meaning |
|---|---|---|
| 400 | `invalid_input` | validation failed |
| 401 | `no_token` / `bad_token` | missing / invalid-or-expired access token |
| 401 | `bad_credentials` | wrong username or password |
| 401 | `bad_refresh` | refresh token unknown/expired/revoked/rotated |
| 403 | (WS upgrade) | `device_id` not owned by the authenticated user |
| 404 | `not_found` | no such device / endpoint |
| 409 | `username_taken` | username already registered |
| 429 | `rate_limited` | register 5/hour/IP, login failures 10/10min/IP (message carries a retry hint) |

WS error frames use codes: `bad_json`, `bad_message`, `bad_kind`, `bad_event`, `bad_command`, `unknown_type`.

---

## 6. Limits
- Event ring buffer: newest **5000 events per account**; older ones are pruned. Do not rely on
  events older than that, reconcile via `/api/snapshot`.
- Max message / body size: 4 MB (nginx allows up to 8 MB on the wire).
- Access token 15 min, refresh token 30 days (rotating).
