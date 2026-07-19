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

  const unsubscribe = subscribeBandoEvents((event) => notifyTelegramEvent(ctx, event));
  const timer = setInterval(() => pollTelegram(ctx), pollMs);
  deleteTelegramWebhook(ctx).finally(() => pollTelegram(ctx));

  console.log(`[bando:telegram] Bot Telegram dang chay polling moi ${pollMs}ms.`);
  if (chatIds.length === 0) {
    console.warn("[bando:telegram] Chua co BANDO_TELEGRAM_CHAT_IDS, bot se khong gui thong bao ve group.");
  }

  return {
    stop() {
      clearInterval(timer);
      unsubscribe();
    },
  };
}

async function notifyTelegramEvent(ctx, event) {
  if (!ctx.chatIds.length) return;
  const message = buildTelegramEventMessage(event);
  if (!message) return;
  await sendToAdminChats(ctx, message);
}

function buildTelegramEventMessage(event) {
  const order = event.payload?.order;
  const trade = event.payload?.coinTrade;
  const bank = event.payload?.bankAccount;

  if (event.type === "item_order_created" && order) {
    return [
      "CO DON MUA VAT PHAM MOI",
      `Loai: order_payment`,
      `Ma don: ${order.orderCode}`,
      `Ma CK: ${order.paymentCode}`,
      `Nhan vat: ${order.characterName}`,
      `Game/SV: ${order.gameName} / ${order.serverName}`,
      `Vat pham: ${order.itemName}`,
      `So luong: ${formatNumber(order.quantity)}`,
      `So tien: ${formatVnd(order.totalAmount)}`,
      bank ? `Nhan tien: ${bank.bankName} - ${bank.accountNumber} - ${bank.accountName}` : "",
      "Tra loi tin nay: ok = duyet thanh toan, no = huy don.",
    ].filter(Boolean).join("\n");
  }

  if (event.type === "coin_buy_order_created" && order) {
    return [
      "CO DON MUA XU MOI",
      `Loai: order_payment`,
      `Ma don: ${order.orderCode}`,
      `Ma CK: ${order.paymentCode}`,
      `Nhan vat: ${order.characterName}`,
      `Game/SV: ${order.gameName} / ${order.serverName}`,
      `So xu: ${formatXu(trade?.coinAmount ?? order.quantity)}`,
      `So tien: ${formatVnd(order.totalAmount)}`,
      bank ? `Nhan tien: ${bank.bankName} - ${bank.accountNumber} - ${bank.accountName}` : "",
      "Tra loi tin nay: ok = duyet thanh toan, no = huy don.",
    ].filter(Boolean).join("\n");
  }

  if (event.type === "coin_sell_request_created" && trade) {
    return [
      "CO PHIEU KHACH BAN XU MOI",
      `Loai: coin_sell_request`,
      `Ma phieu: ${trade.orderCode}`,
      `Nhan vat: ${trade.characterName}`,
      `Game/SV: ${trade.gameName} / ${trade.serverName}`,
      `Khach ban: ${formatXu(trade.coinAmount)}`,
      `Can tra: ${formatVnd(trade.totalAmount)}`,
      "Phieu nay se tiep tuc sau khi BOT nhan du xu va khach gui STK.",
      "Tra loi tin nay: no = huy phieu.",
    ].join("\n");
  }

  if (event.type === "coin_payout_info_saved" && trade) {
    return [
      "CAN TRA TIEN CHO KHACH BAN XU",
      `Loai: coin_payout`,
      `Ma phieu: ${trade.orderCode}`,
      `Nhan vat: ${trade.characterName}`,
      `Game/SV: ${trade.gameName} / ${trade.serverName}`,
      `Da nhan: ${formatXu(trade.receivedCoinAmount || trade.coinAmount)}`,
      `So tien tra: ${formatVnd(trade.totalAmount)}`,
      `Ngan hang: ${trade.bankName}`,
      `STK: ${trade.accountNumber}`,
      `Chu TK: ${trade.accountName}`,
      "Tra loi tin nay: ok = da chuyen tien, no = huy phieu.",
    ].join("\n");
  }

  if (event.type === "order_payment_confirmed" && order) {
    return [
      "DA THANH TOAN THANH CONG",
      `Ma don: ${order.orderCode}`,
      `Ma CK: ${order.paymentCode}`,
      `Nhan vat: ${order.characterName}`,
      `So tien: ${formatVnd(order.totalAmount)}`,
      `Nguon: ${event.payload?.source || "he thong"}`,
      "BOT se giao hang khi khach moi giao dich.",
    ].join("\n");
  }

  if (event.type === "order_cancelled" && (order || trade)) {
    return [
      "DA HUY GIAO DICH",
      `Ma: ${order?.orderCode || trade?.orderCode}`,
      `Nhan vat: ${order?.characterName || trade?.characterName || ""}`,
      `Ly do: ${event.payload?.note || "Admin huy"}`,
    ].join("\n");
  }

  if (event.type === "coin_payout_approved" && trade) {
    return [
      "DA XAC NHAN TRA TIEN CHO KHACH",
      `Ma phieu: ${trade.orderCode}`,
      `Nhan vat: ${trade.characterName}`,
      `So tien: ${formatVnd(trade.totalAmount)}`,
      "BOT se bao khach da thanh toan.",
    ].join("\n");
  }

  if (event.type === "delivery_completed" && order) {
    return [
      "BOT DA GIAO HANG THANH CONG",
      `Ma don: ${order.orderCode}`,
      `Nhan vat: ${order.characterName}`,
      `Vat pham: ${order.itemName}`,
      `So luong: ${formatNumber(order.quantity)}`,
    ].join("\n");
  }

  if (event.type === "coin_received" && trade) {
    return [
      "BOT DA NHAN XU TU KHACH",
      `Ma phieu: ${trade.orderCode}`,
      `Nhan vat: ${trade.characterName}`,
      `Da nhan: ${formatXu(trade.receivedCoinAmount || trade.coinAmount)}`,
      "Dang cho khach gui thong tin ngan hang.",
    ].join("\n");
  }

  return null;
}

async function pollTelegram(ctx) {
  if (ctx.polling) return;
  ctx.polling = true;
  try {
    const allowedUpdates = encodeURIComponent(JSON.stringify(["message"]));
    const url = `${TELEGRAM_API_BASE}/bot${ctx.token}/getUpdates?timeout=0&offset=${ctx.offset}&allowed_updates=${allowedUpdates}`;
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

  const replyCommand = parseReplyDecision(text, message.reply_to_message);
  if (replyCommand) {
    const resultText = await runCommand(replyCommand, message.from);
    await sendTelegramMessage(ctx, message.chat.id, resultText, { reply_to_message_id: message.message_id });
    return;
  }

  const command = parseCommand(text);
  if (!command) return;

  const resultText = await runCommand(command, message.from);
  await sendTelegramMessage(ctx, message.chat.id, resultText);
}

function parseReplyDecision(text, repliedMessage) {
  if (!repliedMessage) return null;
  const decision = normalizeDecision(text);
  if (!decision) return null;

  const repliedText = String(repliedMessage.text || repliedMessage.caption || "");
  const code = extractBandoCode(repliedText);
  if (!code) return null;

  const type = extractMessageType(repliedText);
  if (decision === "no") return { action: "cancel", code };

  if (type === "coin_payout") return { action: "payout", code };
  if (type === "order_payment") return { action: "approve", code };
  if (type === "coin_sell_request") {
    return {
      action: "info",
      code,
      message: `Phieu ${code} se tu dong tiep tuc sau khi BOT nhan du xu va khach gui STK. Neu muon huy hay reply: no`,
    };
  }

  return { action: "approve", code };
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
  if (command.action === "info") return command.message || buildHelpText();

  const actor = formatActor(from);
  if (command.action === "approve") {
    const result = await approveBandoOrder({
      orderCode: command.code,
      note: `Telegram ${actor} duyet thanh toan`,
    });
    if (!result.ok) return `Duyet ${command.code} that bai: ${result.error}`;
    return `Da duyet thanh toan don ${result.order?.orderCode || command.code}.`;
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
    return `Da xac nhan tra tien phieu ${result.coinTrade?.orderCode || command.code}.`;
  }

  return buildHelpText();
}

function buildHelpText() {
  return [
    "Lenh BOT Telegram ban do:",
    "/id - lay chat id va user id",
    "Reply OK vao tin don de duyet thanh toan hoac xac nhan da tra tien.",
    "Reply NO vao tin don de huy don/phieu.",
    "/duyet <ma_don> - duyet thanh toan thu cong",
    "/huy <ma_don> - huy don/phieu xu",
    "/traxu <ma_phieu> - duyet da tra tien cho khach ban xu",
  ].join("\n");
}

async function sendToAdminChats(ctx, text) {
  for (const chatId of ctx.chatIds) {
    try {
      await sendTelegramMessage(ctx, chatId, text);
    } catch (error) {
      console.error("[bando:telegram] gui thong bao loi:", error instanceof Error ? error.message : error);
    }
  }
}

async function sendTelegramMessage(ctx, chatId, text, options = null) {
  const payload = {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
  };
  if (options?.reply_to_message_id) {
    payload.reply_to_message_id = options.reply_to_message_id;
  }
  await telegramApi(ctx, "sendMessage", payload);
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

function normalizeDecision(text) {
  const value = text.trim().toLowerCase();
  if (["ok", "oke", "yes", "duyet", "dong y"].includes(value)) return "ok";
  if (["no", "ko", "khong", "huy", "cancel"].includes(value)) return "no";
  return null;
}

function extractMessageType(text) {
  const match = text.match(/^Loai:\s*([A-Za-z0-9_-]+)/im);
  return match ? match[1].trim().toLowerCase() : "";
}

function extractBandoCode(text) {
  const patterns = [
    /Ma\s+don:\s*([A-Za-z0-9_-]{3,64})/i,
    /Ma\s+phieu:\s*([A-Za-z0-9_-]{3,64})/i,
    /Ma:\s*([A-Za-z0-9_-]{3,64})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return "";
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
