import { approveBandoOrder, approveCoinTradePayout, cancelBandoRecord } from "./bando-storage.js";
import { subscribeBandoEvents } from "./bando-events.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";

export function startTelegramBot() {
  if (!isEnabled(process.env.BANDO_TELEGRAM_ENABLED)) return null;

  const token = String(process.env.BANDO_TELEGRAM_BOT_TOKEN || "").trim();
  if (!token) {
    console.warn("[bando:telegram] BANDO_TELEGRAM_ENABLED=1 nhung chua co BANDO_TELEGRAM_BOT_TOKEN.");
    return null;
  }

  const chatIds = splitList(process.env.BANDO_TELEGRAM_CHAT_IDS);
  const allowedUserIds = splitList(process.env.BANDO_TELEGRAM_ALLOWED_USER_IDS);
  const pollMs = readIntegerEnv("BANDO_TELEGRAM_POLL_MS", 2500, 1000, 60000);
  const ctx = {
    token,
    chatIds,
    allowedUserIds,
    offset: 0,
    polling: false,
  };

  const unsubscribe = subscribeBandoEvents((event) => notifyTelegramOrderEvent(ctx, event));
  const timer = setInterval(() => pollTelegram(ctx), pollMs);
  deleteTelegramWebhook(ctx).finally(() => pollTelegram(ctx));

  console.log(`[bando:telegram] Bot Telegram dang chay polling moi ${pollMs}ms.`);
  if (chatIds.length === 0) {
    console.warn("[bando:telegram] Chua co BANDO_TELEGRAM_CHAT_IDS, bot se khong gui thong bao don moi.");
  }

  return {
    stop() {
      clearInterval(timer);
      unsubscribe();
    },
  };
}

async function notifyTelegramOrderEvent(ctx, event) {
  if (!ctx.chatIds.length) return;
  if (!["item_order_created", "coin_buy_order_created", "coin_sell_request_created"].includes(event.type)) return;

  const message = buildOrderEventMessage(event);
  const replyMarkup = buildOrderEventKeyboard(event);
  await sendToAdminChats(ctx, message, replyMarkup);
}

function buildOrderEventMessage(event) {
  const order = event.payload?.order;
  const trade = event.payload?.coinTrade;
  const bank = event.payload?.bankAccount;

  if (event.type === "coin_sell_request_created" && trade) {
    return [
      "CO PHIEU BAN XU MOI",
      `Ma phieu: ${trade.orderCode}`,
      `Nhan vat: ${trade.characterName}`,
      `Game/SV: ${trade.gameName} / ${trade.serverName}`,
      `Khach ban: ${formatXu(trade.coinAmount)}`,
      `Can tra: ${formatVnd(trade.totalAmount)}`,
      "Lenh: /huy " + trade.orderCode,
    ].join("\n");
  }

  if (!order) return "Co don moi nhung thieu du lieu.";
  const isCoinOrder = event.type === "coin_buy_order_created";
  const lines = [
    isCoinOrder ? "CO DON MUA XU MOI" : "CO DON MUA VAT PHAM MOI",
    `Ma don: ${order.orderCode}`,
    `Ma CK: ${order.paymentCode}`,
    `Nhan vat: ${order.characterName}`,
    `Game/SV: ${order.gameName} / ${order.serverName}`,
  ];

  if (isCoinOrder && trade) {
    lines.push(`So xu: ${formatXu(trade.coinAmount)}`);
  } else {
    lines.push(`Vat pham: ${order.itemName}`);
    lines.push(`So luong: ${formatNumber(order.quantity)}`);
  }

  lines.push(`So tien: ${formatVnd(order.totalAmount)}`);
  if (bank) {
    lines.push(`Nhan tien: ${bank.bankName} - ${bank.accountNumber} - ${bank.accountName}`);
  }
  lines.push(`Lenh: /duyet ${order.orderCode} hoac /huy ${order.orderCode}`);
  return lines.join("\n");
}

function buildOrderEventKeyboard(event) {
  const order = event.payload?.order;
  const trade = event.payload?.coinTrade;
  if (event.type === "coin_sell_request_created" && trade?.orderCode) {
    return {
      inline_keyboard: [
        [
          { text: "Huy phieu", callback_data: `bando:cancel:${trade.orderCode}` },
        ],
      ],
    };
  }

  if (!order?.orderCode) return null;
  return {
    inline_keyboard: [
      [
        { text: "Duyet thanh toan", callback_data: `bando:approve:${order.orderCode}` },
        { text: "Huy don", callback_data: `bando:cancel:${order.orderCode}` },
      ],
    ],
  };
}

async function pollTelegram(ctx) {
  if (ctx.polling) return;
  ctx.polling = true;
  try {
    const url = `${TELEGRAM_API_BASE}/bot${ctx.token}/getUpdates?timeout=0&offset=${ctx.offset}&allowed_updates=${encodeURIComponent(JSON.stringify(["message", "callback_query"]))}`;
    const response = await fetch(url);
    const payload = await response.json();
    if (!payload.ok || !Array.isArray(payload.result)) {
      console.warn("[bando:telegram] getUpdates loi:", payload.description || response.status);
      return;
    }

    for (const update of payload.result) {
      ctx.offset = Math.max(ctx.offset, Number(update.update_id || 0) + 1);
      await handleTelegramUpdate(ctx, update);
    }
  } catch (error) {
    console.error("[bando:telegram] polling error:", error instanceof Error ? error.message : error);
  } finally {
    ctx.polling = false;
  }
}

async function handleTelegramUpdate(ctx, update) {
  if (update.callback_query) {
    await handleCallbackQuery(ctx, update.callback_query);
    return;
  }

  const message = update.message;
  if (!message) return;
  const text = String(message.text || "").trim();
  if (!text) return;

  if (isIdCommand(text)) {
    await sendTelegramMessage(ctx, message.chat.id, `Chat ID: ${message.chat.id}\nUser ID: ${message.from?.id || ""}`);
    return;
  }

  if (!isAuthorized(ctx, message.chat?.id, message.from?.id)) {
    await sendTelegramMessage(ctx, message.chat.id, "Ban khong co quyen dieu khien BOT ban do.");
    return;
  }

  const command = parseCommand(text);
  if (!command) {
    await sendTelegramMessage(ctx, message.chat.id, buildHelpText());
    return;
  }

  const resultText = await runCommand(command, message.from);
  await sendTelegramMessage(ctx, message.chat.id, resultText);
}

async function handleCallbackQuery(ctx, query) {
  const message = query.message;
  const chatId = message?.chat?.id;
  if (!chatId) return;

  if (!isAuthorized(ctx, chatId, query.from?.id)) {
    await answerCallback(ctx, query.id, "Khong co quyen.");
    return;
  }

  const match = String(query.data || "").match(/^bando:(approve|cancel|payout):([A-Za-z0-9_-]{3,64})$/);
  if (!match) {
    await answerCallback(ctx, query.id, "Lenh khong hop le.");
    return;
  }

  const resultText = await runCommand({ action: match[1], code: match[2].toUpperCase() }, query.from);
  await answerCallback(ctx, query.id, "Da xu ly.");
  await sendTelegramMessage(ctx, chatId, resultText);
}

function parseCommand(text) {
  const normalized = text.trim().replace(/\s+/g, " ");
  const [rawCommand, rawCode] = normalized.split(" ");
  const command = rawCommand.toLowerCase().replace(/@[\w_]+$/, "");
  const code = String(rawCode || "").trim().toUpperCase();
  if (!code) return null;

  if (["/duyet", "duyet", "/approve", "approve"].includes(command)) return { action: "approve", code };
  if (["/huy", "huy", "/cancel", "cancel"].includes(command)) return { action: "cancel", code };
  if (["/traxu", "traxu", "/payout", "payout"].includes(command)) return { action: "payout", code };
  return null;
}

async function runCommand(command, from) {
  const actor = formatActor(from);
  if (command.action === "approve") {
    const result = await approveBandoOrder({
      orderCode: command.code,
      note: `Telegram ${actor} duyet thanh toan`,
    });
    if (!result.ok) return `Duyet ${command.code} that bai: ${result.error}`;
    return `Da duyet thanh toan don ${result.order?.orderCode || command.code}. BOT se giao hang khi khach moi giao dich.`;
  }

  if (command.action === "cancel") {
    const result = await cancelBandoRecord({
      orderCode: command.code,
      note: `Telegram ${actor} huy don`,
    });
    if (!result.ok) return `Huy ${command.code} that bai: ${result.error}`;
    return `Da huy ${result.order?.orderCode || result.coinTrade?.orderCode || command.code}.`;
  }

  if (command.action === "payout") {
    const result = await approveCoinTradePayout({
      orderCode: command.code,
      note: `Telegram ${actor} duyet tra tien`,
    });
    if (!result.ok) return `Duyet tra tien ${command.code} that bai: ${result.error}`;
    return `Da duyet tra tien phieu ${result.coinTrade?.orderCode || command.code}. BOT se bao khach da thanh toan.`;
  }

  return buildHelpText();
}

function buildHelpText() {
  return [
    "Lenh BOT Telegram ban do:",
    "/id - lay chat id va user id",
    "/duyet <ma_don> - duyet thanh toan thu cong",
    "/huy <ma_don> - huy don/phieu xu",
    "/traxu <ma_phieu> - duyet da tra tien cho khach ban xu",
  ].join("\n");
}

async function sendToAdminChats(ctx, text, replyMarkup = null) {
  for (const chatId of ctx.chatIds) {
    try {
      await sendTelegramMessage(ctx, chatId, text, replyMarkup);
    } catch (error) {
      console.error("[bando:telegram] gui thong bao loi:", error instanceof Error ? error.message : error);
    }
  }
}

async function sendTelegramMessage(ctx, chatId, text, replyMarkup = null) {
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (replyMarkup) payload.reply_markup = replyMarkup;
  await telegramApi(ctx, "sendMessage", payload);
}

async function answerCallback(ctx, callbackQueryId, text) {
  await telegramApi(ctx, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    text,
    show_alert: false,
  });
}

async function deleteTelegramWebhook(ctx) {
  try {
    await telegramApi(ctx, "deleteWebhook", { drop_pending_updates: false });
  } catch (error) {
    console.warn("[bando:telegram] deleteWebhook loi:", error instanceof Error ? error.message : error);
  }
}

async function telegramApi(ctx, method, payload) {
  const response = await fetch(`${TELEGRAM_API_BASE}/bot${ctx.token}/${method}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => null);
  if (!response.ok || !data?.ok) {
    throw new Error(data?.description || `Telegram ${method} HTTP ${response.status}`);
  }
  return data;
}

function isAuthorized(ctx, chatId, userId) {
  const chat = String(chatId || "");
  const user = String(userId || "");
  if (ctx.chatIds.length > 0 && !ctx.chatIds.includes(chat)) return false;
  if (ctx.allowedUserIds.length > 0 && !ctx.allowedUserIds.includes(user)) return false;
  return ctx.chatIds.length > 0 || ctx.allowedUserIds.length > 0;
}

function isIdCommand(text) {
  return ["/id", "id", "/chatid", "chatid"].includes(text.trim().toLowerCase());
}

function formatActor(from) {
  if (!from) return "admin";
  return from.username ? `@${from.username}` : String(from.id || "admin");
}

function formatNumber(value) {
  return new Intl.NumberFormat("vi-VN").format(Math.max(0, Math.trunc(Number(value) || 0)));
}

function formatVnd(value) {
  return `${formatNumber(value)} VND`;
}

function formatXu(value) {
  return `${formatNumber(value)} xu`;
}

function splitList(value) {
  return String(value || "")
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function isEnabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function readIntegerEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
