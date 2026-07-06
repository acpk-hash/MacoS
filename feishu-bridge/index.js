'use strict';

// ── 飞书长连接 sidecar ────────────────────────────────────────────────────────
//
// 职责：
//   1. 用 @larksuiteoapi/node-sdk 的 WSClient 维持飞书长连接
//   2. 收到 im.message.receive_v1 事件后解析 text 消息
//   3. POST 到 http://127.0.0.1:${BRIDGE_PORT}/feishu/inbound（Bearer 鉴权）
//   4. 收到 card.action.trigger 事件（按钮点击）后：
//      a. POST 到 /feishu/card-action 等待桌面端处理（5s 超时）
//      b. 将返回的 toast 文本作为回调响应回给飞书
//
// 非 text 消息（除卡片回调外）忽略；POST 失败重试 1 次后丢弃。
// 卡片回调需同步等待结果，超时则返回错误 toast。
// 未捕获异常打日志后以退出码 1 退出（由桌面端负责重启）。
//
// SDK 卡片回调 API 说明：
//   - 版本：@larksuiteoapi/node-sdk ^1
//   - card.action.trigger 事件通过 WS 长连接（WSClient）投递，注册方式：
//       EventDispatcher.register({ 'card.action.trigger': async (data) => { ... } })
//   - data 结构：{ operator: { open_id, user_id }, action: { value, tag },
//                  context: { open_chat_id, open_message_id } }
//   - handler 的返回值由 WSClient.handleEventData 自动 base64 编码后经 WS
//     回传给飞书，支持的格式：
//       { toast: { type: 'success'|'info'|'error', content: '...' } }
//     或返回卡片 JSON 进行卡片更新。本实现使用 toast 形式，最简可靠。

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

// ── POST 到本地端点（文本消息） ─────────────────────────────────────────────────

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

// ── POST 到本地端点（卡片按钮回调，需等待结果） ────────────────────────────────

/**
 * 发送卡片动作到桌面端并返回 Promise<{toast, ok}>。
 * 5 秒超时，超时抛出错误。
 *
 * @param {{ action: string, task_id: string, operator_open_id: string }} payload
 * @returns {Promise<{toast: string, ok: boolean}>}
 */
function postCardAction(payload) {
  return new Promise(function (resolve, reject) {
    const body = JSON.stringify(payload);
    const options = {
      hostname: '127.0.0.1',
      port: Number(BRIDGE_PORT),
      path: '/feishu/card-action',
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
        Authorization: 'Bearer ' + BRIDGE_TOKEN,
      },
    };

    const req = http.request(options, function (res) {
      let raw = '';
      res.on('data', function (chunk) { raw += chunk; });
      res.on('end', function () {
        try {
          const parsed = JSON.parse(raw);
          resolve(parsed);
        } catch (_) {
          resolve({ toast: '操作完成', ok: true });
        }
      });
    });

    req.setTimeout(5000, function () {
      req.destroy();
      reject(new Error('card-action 请求超时（5s）'));
    });

    req.on('error', function (err) {
      reject(err);
    });

    req.write(body);
    req.end();
  });
}

// ── 飞书 WSClient ─────────────────────────────────────────────────────────────

const wsClient = new lark.WSClient({
  appId: FEISHU_APP_ID,
  appSecret: FEISHU_APP_SECRET,
  loggerLevel: lark.LoggerLevel.error,
});

wsClient.start({
  eventDispatcher: new lark.EventDispatcher({}).register({
    // ── 文本消息：转发到桌面端建任务 ─────────────────────────────────────────
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

    // ── 卡片按钮点击：同步等待桌面端处理，返回 toast ─────────────────────────
    //
    // SDK 将此 handler 的返回值经由 WS 回传给飞书，支持 toast 和卡片更新。
    // 本实现使用 toast，响应格式：
    //   { toast: { type: 'success'|'info'|'error', content: '...' } }
    //
    // 如果桌面端 5 秒内未响应，返回 error toast 提示用户稍后在电脑端处理。
    'card.action.trigger': async function (data) {
      try {
        const actionValue = (data.action && data.action.value) || {};
        const action = actionValue.action || '';
        const taskId = actionValue.task_id || '';
        const operatorOpenId = (data.operator && data.operator.open_id) || '';

        if (!action || !taskId) {
          return {
            toast: { type: 'error', content: '无效的卡片操作（缺少 action 或 task_id）' },
          };
        }

        const result = await postCardAction({
          action: action,
          task_id: taskId,
          operator_open_id: operatorOpenId,
        });

        const toastType = result.ok ? 'success' : 'info';
        return {
          toast: { type: toastType, content: result.toast || '操作完成' },
        };
      } catch (err) {
        console.error('[feishu-bridge] 卡片回调处理异常:', err);
        return {
          toast: { type: 'error', content: '操作失败，请在电脑端处理' },
        };
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
