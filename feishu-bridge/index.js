'use strict';

// ── 飞书长连接 sidecar ────────────────────────────────────────────────────────
//
// 职责：
//   1. 用 @larksuiteoapi/node-sdk 的 WSClient 维持飞书长连接
//   2. 收到 im.message.receive_v1 事件后解析 text 消息
//   3. POST 到 http://127.0.0.1:${BRIDGE_PORT}/feishu/inbound（Bearer 鉴权）
//
// 非 text 消息忽略；POST 失败重试 1 次后丢弃。
// 未捕获异常打日志后以退出码 1 退出（由桌面端负责重启）。

const lark = require('@larksuiteoapi/node-sdk');
const http = require('http');

// ── 环境变量 ──────────────────────────────────────────────────────────────────

const FEISHU_APP_ID = process.env.FEISHU_APP_ID;
const FEISHU_APP_SECRET = process.env.FEISHU_APP_SECRET;
const BRIDGE_PORT = process.env.BRIDGE_PORT;
const BRIDGE_TOKEN = process.env.BRIDGE_TOKEN;

if (!FEISHU_APP_ID || !FEISHU_APP_SECRET || !BRIDGE_PORT || !BRIDGE_TOKEN) {
  console.error(
    '[feishu-bridge] 启动失败：缺少必要环境变量 FEISHU_APP_ID / FEISHU_APP_SECRET / BRIDGE_PORT / BRIDGE_TOKEN'
  );
  process.exit(1);
}

// ── POST 到本地端点 ────────────────────────────────────────────────────────────

function postInbound(payload, attempt) {
  if (attempt === undefined) attempt = 0;
  const body = JSON.stringify(payload);
  const options = {
    hostname: '127.0.0.1',
    port: Number(BRIDGE_PORT),
    path: '/feishu/inbound',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      Authorization: 'Bearer ' + BRIDGE_TOKEN,
    },
  };

  const req = http.request(options, function (res) {
    if (res.statusCode !== 200) {
      console.error('[feishu-bridge] POST 非 200 响应:', res.statusCode, '(attempt', attempt + 1, ')');
      if (attempt === 0) {
        setTimeout(function () { postInbound(payload, 1); }, 1000);
      }
    }
    // drain response body
    res.resume();
  });

  req.on('error', function (err) {
    console.error('[feishu-bridge] POST 请求错误:', err.message, '(attempt', attempt + 1, ')');
    if (attempt === 0) {
      setTimeout(function () { postInbound(payload, 1); }, 1000);
    }
  });

  req.write(body);
  req.end();
}

// ── 飞书 WSClient ─────────────────────────────────────────────────────────────

const wsClient = new lark.WSClient({
  appId: FEISHU_APP_ID,
  appSecret: FEISHU_APP_SECRET,
  loggerLevel: lark.LoggerLevel.error,
});

wsClient.start({
  eventDispatcher: new lark.EventDispatcher({}).register({
    'im.message.receive_v1': async function (data) {
      try {
        const msg = data.message;
        if (!msg || msg.message_type !== 'text') return;

        let text = '';
        try {
          const parsed = JSON.parse(msg.content || '{}');
          text = (parsed.text || '').trim();
        } catch (_) {
          return;
        }

        if (!text) return;

        postInbound({
          text: text,
          sender_open_id: (data.sender && data.sender.sender_id && data.sender.sender_id.open_id) || '',
          chat_id: msg.chat_id || '',
          message_id: msg.message_id || '',
        });
      } catch (err) {
        console.error('[feishu-bridge] 事件处理异常:', err);
      }
    },
  }),
});

// ── 全局错误处理 ───────────────────────────────────────────────────────────────

process.on('uncaughtException', function (err) {
  console.error('[feishu-bridge] 未捕获异常（退出码 1）:', err);
  process.exit(1);
});

process.on('unhandledRejection', function (reason) {
  console.error('[feishu-bridge] 未处理 Promise 拒绝（退出码 1）:', reason);
  process.exit(1);
});

console.log('[feishu-bridge] 启动成功，APP_ID=' + FEISHU_APP_ID + ' 本地端口=' + BRIDGE_PORT);
