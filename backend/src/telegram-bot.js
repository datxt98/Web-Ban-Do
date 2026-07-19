import { approveBandoOrder, approveCoinTradePayout, cancelBandoRecord, getBandoRevenueStats } from "./bando-storage.js";
import { subscribeBandoEvents } from "./bando-events.js";

const TELEGRAM_API_BASE = "https://api.telegram.org";
const VIETNAM_UTC_OFFSET_MS = 7 * 60 * 60 * 1000;
const VIETQR_BANKS_API_URL = "https://api.vietqr.io/v2/banks";
const VIETQR_BANK_CACHE_MS = 24 * 60 * 60 * 1000;
const VIETQR_BANK_FALLBACKS = new Map([
  ["abb", "970425"],
  ["abbank", "970425"],
  ["acb", "970416"],
  ["bidv", "970418"],
  ["ctg", "970415"],
  ["icb", "970415"],
  ["mb", "970422"],
  ["mbbank", "970422"],
  ["m b bank", "970422"],
  ["msb", "970426"],
  ["ocb", "970448"],
  ["sacombank", "970403"],
  ["scb", "970429"],
  ["seabank", "970440"],
  ["shb", "970443"],
  ["shinhan", "970424"],
  ["shinhanbank", "970424"],
  ["techcombank", "970407"],
  ["tcb", "970407"],
  ["tpb", "970423"],
  ["tpbank", "970423"],
  ["vib", "970441"],
  ["vietcombank", "970436"],
  ["vietinbank", "970415"],
  ["vpbank", "970432"],
  ["vpb", "970432"],
]);

let vietQrBankCache = {
  expiresAt: 0,
  banks: [],
};

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
  const message = await buildTelegramEventMessage(event);
  if (message) await sendToAdminChats(ctx, message);
  const payoutQr = await buildPayoutVietQrNotification(event).catch((error) => {
    console.warn("[bando:telegram] tao VietQR loi:", error instanceof Error ? error.message : error);
    return null;
  });
  if (payoutQr) await sendPhotoToAdminChats(ctx, payoutQr);
}

async function buildTelegramEventMessage(event) {
  const body = buildTelegramEventBody(event);
  if (!body) return null;
  const stats = await buildStatsSection("THỐNG KÊ HÔM NAY", vietnamTodayRange());
  return stats ? `${body}\n\n${stats}` : body;
}

function buildTelegramEventBody(event) {
  const order = event.payload?.order;
  const trade = event.payload?.coinTrade;
  const bank = event.payload?.bankAccount;
  const bankTransaction = event.payload?.bankTransaction;

  if (event.type === "item_order_created" && order) {
    return [
      "🧾 <b>ĐƠN MUA VẬT PHẨM MỚI</b>",
      "",
      `Đơn: <b>${h(order.orderCode)}</b> · Shop bán item cho khách`,
      `Loại: order_payment`,
      `Khách: ${h(order.characterName)} (${h(order.serverName)})`,
      `Game: ${h(order.gameName)}`,
      `Vật phẩm: ${h(order.itemName)}`,
      `Số lượng: ${formatNumber(order.quantity)}`,
      `Thành tiền: <b>${formatVnd(order.totalAmount)}</b>`,
      `Nội dung CK: ${h(order.paymentCode)}`,
      bank ? `TK shop nhận: ${formatBankAccount(bank)}` : "",
      "Reply tin này: <b>ok</b> để duyệt, <b>no</b> để hủy.",
    ].filter(Boolean).join("\n");
  }

  if (event.type === "coin_buy_order_created" && order) {
    return [
      "🪙 <b>ĐƠN MUA XU MỚI</b>",
      "",
      `Đơn: <b>${h(order.orderCode)}</b> · Shop bán xu cho khách`,
      `Loại: order_payment`,
      `Khách: ${h(order.characterName)} (${h(order.serverName)})`,
      `Game: ${h(order.gameName)}`,
      `Số xu: ${formatXu(trade?.coinAmount ?? order.quantity)}`,
      `Thành tiền: <b>${formatVnd(order.totalAmount)}</b>`,
      `Nội dung CK: ${h(order.paymentCode)}`,
      bank ? `TK shop nhận: ${formatBankAccount(bank)}` : "",
      "Reply tin này: <b>ok</b> để duyệt, <b>no</b> để hủy.",
    ].filter(Boolean).join("\n");
  }

  if (event.type === "coin_sell_request_created" && trade) {
    return [
      "📥 <b>KHÁCH BÁN XU CHO SHOP</b>",
      "",
      `Phiếu: <b>${h(trade.orderCode)}</b> · Shop mua xu của khách`,
      `Loại: coin_sell_request`,
      `Khách: ${h(trade.characterName)} (${h(trade.serverName)})`,
      `Game: ${h(trade.gameName)}`,
      `Số xu: ${formatXu(trade.coinAmount)}`,
      `Số tiền cần trả: <b>${formatVnd(trade.totalAmount)}</b>`,
      `Trạng thái: Chờ BOT nhận xu`,
      "Reply tin này: <b>no</b> để hủy phiếu.",
    ].join("\n");
  }

  if (event.type === "coin_payout_info_saved" && trade) {
    return [
      "🏦 <b>KHÁCH ĐÃ GỬI THÔNG TIN NHẬN TIỀN</b>",
      "",
      `Phiếu: <b>${h(trade.orderCode)}</b> · Shop mua xu của khách`,
      `Loại: coin_payout`,
      `Khách: ${h(trade.characterName)} (${h(trade.serverName)})`,
      `Game: ${h(trade.gameName)}`,
      `Đã nhận: ${formatXu(trade.receivedCoinAmount || trade.coinAmount)}`,
      `Số tiền cần trả: <b>${formatVnd(trade.totalAmount)}</b>`,
      `Ngân hàng: ${h(trade.bankName)}`,
      `STK: ${h(trade.accountNumber)}`,
      `Chủ TK: ${h(trade.accountName)}`,
      "Reply tin này: <b>ok</b> nếu đã chuyển tiền, <b>no</b> để hủy phiếu.",
    ].join("\n");
  }

  if (event.type === "order_payment_confirmed" && order) {
    return buildPaymentConfirmedMessage(order, bankTransaction, event.payload?.note || event.payload?.source);
  }

  if (event.type === "order_cancelled" && (order || trade)) {
    return [
      "❌ <b>ĐÃ HỦY GIAO DỊCH</b>",
      "",
      `Mã: <b>${h(order?.orderCode || trade?.orderCode)}</b>`,
      `Khách: ${h(order?.characterName || trade?.characterName || "")}`,
      `Ghi chú: ${h(event.payload?.note || "Admin hủy")}`,
    ].join("\n");
  }

  if (event.type === "coin_payout_approved" && trade) {
    return [
      "✅ <b>ĐÃ XÁC NHẬN TRẢ TIỀN CHO KHÁCH</b>",
      "",
      `Phiếu: <b>${h(trade.orderCode)}</b> · Shop mua xu của khách`,
      `Khách: ${h(trade.characterName)} (${h(trade.serverName)})`,
      `Số tiền đã trả: <b>${formatVnd(trade.totalAmount)}</b>`,
      `STK: ${h(trade.bankName)} · ${h(trade.accountNumber)} · ${h(trade.accountName)}`,
      "BOT sẽ báo khách đã thanh toán.",
    ].join("\n");
  }

  if (event.type === "delivery_completed" && order) {
    return [
      "📦 <b>BOT ĐÃ GIAO HÀNG THÀNH CÔNG</b>",
      "",
      `Đơn: <b>${h(order.orderCode)}</b>`,
      `Khách: ${h(order.characterName)} (${h(order.serverName)})`,
      `Vật phẩm: ${h(order.itemName)}`,
      `Số lượng: ${formatNumber(order.quantity)}`,
    ].join("\n");
  }

  if (event.type === "coin_received" && trade) {
    return [
      "📥 <b>BOT ĐÃ NHẬN XU TỪ KHÁCH</b>",
      "",
      `Phiếu: <b>${h(trade.orderCode)}</b>`,
      `Khách: ${h(trade.characterName)} (${h(trade.serverName)})`,
      `Đã nhận: ${formatXu(trade.receivedCoinAmount || trade.coinAmount)}`,
      "Đang chờ khách gửi thông tin ngân hàng.",
    ].join("\n");
  }

  return null;
}

function buildPaymentConfirmedMessage(order, bankTransaction, note) {
  const isCoinOrder = order.itemCode === "coin-xu";
  const header = bankTransaction ? "💰 <b>BANK ĐÃ NHẬN TIỀN</b>" : "✅ <b>ĐƠN ĐÃ THANH TOÁN OK</b>";
  const lines = [
    header,
    "",
    `Đơn: <b>${h(order.orderCode)}</b> · ${isCoinOrder ? "Shop bán xu cho khách" : "Shop bán item cho khách"}`,
    `Khách: ${h(order.characterName)} (${h(order.serverName)})`,
  ];

  if (isCoinOrder) {
    lines.push(`Số xu: ${formatXu(order.quantity)}`);
  } else {
    lines.push(`Vật phẩm: ${h(order.itemName)}`);
    lines.push(`Số lượng: ${formatNumber(order.quantity)}`);
  }

  lines.push(`Thành tiền: <b>${formatVnd(order.totalAmount)}</b>`);
  lines.push("Trạng thái: Đã nhận thanh toán");
  lines.push(`Nội dung CK: ${h(order.paymentCode)}`);

  if (bankTransaction?.bankAccount) {
    lines.push(`TK shop nhận: ${formatBankAccount(bankTransaction.bankAccount)}`);
  }
  if (bankTransaction?.transactionId) {
    lines.push(`Mã GD bank: ${h(bankTransaction.transactionId)}`);
  }
  if (bankTransaction?.amount) {
    lines.push(`Bank nhận: <b>${formatVnd(bankTransaction.amount)}</b>`);
  }
  if (bankTransaction?.description) {
    lines.push(`Mô tả bank: ${h(bankTransaction.description)}`);
  }
  if (note) {
    lines.push(`Ghi chú: ${h(note)}`);
  }

  return lines.join("\n");
}

async function buildPayoutVietQrNotification(event) {
  if (!isVietQrEnabled()) return null;
  if (event.type !== "coin_payout_info_saved") return null;

  const trade = event.payload?.coinTrade;
  if (!trade?.bankName || !trade?.accountNumber || !trade?.accountName || !trade?.totalAmount) return null;

  const bankId = await resolveVietQrBankId(trade.bankName);
  const accountNo = normalizeVietQrAccountNo(trade.accountNumber);
  const accountName = normalizeVietQrText(trade.accountName, 50);
  const amount = normalizeVietQrAmount(trade.totalAmount);
  const addInfo = normalizeVietQrText(`TRA XU ${trade.orderCode}`, 50);

  if (!bankId || !accountNo || !accountName || !amount || !addInfo) return null;

  const template = normalizeVietQrTemplate(process.env.BANDO_VIETQR_TEMPLATE);
  const imageFormat = normalizeVietQrImageFormat(process.env.BANDO_VIETQR_FORMAT);
  const params = new URLSearchParams({
    amount: String(amount),
    addInfo,
    accountName,
  });
  const photoUrl = `https://img.vietqr.io/image/${encodeURIComponent(bankId)}-${encodeURIComponent(accountNo)}-${template}.${imageFormat}?${params.toString()}`;
  const caption = [
    "<b>QR TRẢ TIỀN CHO KHÁCH</b>",
    "",
    `Phiếu: <b>${h(trade.orderCode)}</b>`,
    "Loại: coin_payout",
    `Khách: ${h(trade.characterName)} (${h(trade.serverName)})`,
    `Số tiền: <b>${formatVnd(amount)}</b>`,
    `Ngân hàng: ${h(trade.bankName)} (${h(bankId)})`,
    `STK: ${h(accountNo)}`,
    `Chủ TK: ${h(accountName)}`,
    `Nội dung: ${h(addInfo)}`,
    "Quét QR để trả tiền, sau đó reply <b>ok</b> vào tin này hoặc tin thông tin nhận tiền.",
  ].join("\n");

  return { photoUrl, caption };
}

function isVietQrEnabled() {
  const raw = process.env.BANDO_VIETQR_ENABLED;
  if (raw == null || String(raw).trim() === "") return true;
  return isEnabled(raw);
}

async function resolveVietQrBankId(bankName) {
  const raw = String(bankName || "").trim();
  const key = normalizeVietQrBankKey(raw);
  if (!key) return "";
  if (/^\d{6}$/.test(key)) return key;

  let banks = [];
  try {
    banks = await listVietQrBanks();
  } catch (error) {
    console.warn("[bando:telegram] khong tai duoc danh sach ngan hang VietQR:", error instanceof Error ? error.message : error);
  }
  const matched = banks.find((bank) => {
    const candidates = [bank.bin, bank.code, bank.shortName, bank.short_name, bank.name].map(normalizeVietQrBankKey);
    return candidates.includes(key);
  });
  if (matched?.bin) return String(matched.bin).trim();

  const looseMatch = banks.find((bank) => {
    const candidates = [bank.code, bank.shortName, bank.short_name].map(normalizeVietQrBankKey);
    return candidates.some((candidate) => candidate && (candidate.includes(key) || key.includes(candidate)));
  });
  if (looseMatch?.bin) return String(looseMatch.bin).trim();

  return VIETQR_BANK_FALLBACKS.get(key) || key.replace(/[^a-z0-9]/g, "");
}

async function listVietQrBanks() {
  const now = Date.now();
  if (vietQrBankCache.expiresAt > now && Array.isArray(vietQrBankCache.banks)) {
    return vietQrBankCache.banks;
  }

  const response = await fetch(VIETQR_BANKS_API_URL);
  if (!response.ok) throw new Error(`VietQR banks HTTP ${response.status}`);
  const payload = await response.json().catch(() => null);
  const banks = Array.isArray(payload?.data) ? payload.data : [];
  vietQrBankCache = {
    expiresAt: now + VIETQR_BANK_CACHE_MS,
    banks,
  };
  return banks;
}

function normalizeVietQrBankKey(value) {
  return stripVietnameseMarks(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function normalizeVietQrAccountNo(value) {
  return String(value || "").replace(/[^a-zA-Z0-9]/g, "").slice(0, 19);
}

function normalizeVietQrAmount(value) {
  const amount = Math.trunc(Number(value) || 0);
  if (amount <= 0) return 0;
  return Number(String(amount).slice(0, 13));
}

function normalizeVietQrText(value, maxLength) {
  return stripVietnameseMarks(value)
    .toUpperCase()
    .replace(/[^A-Z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength)
    .trim();
}

function normalizeVietQrTemplate(value) {
  const template = String(value || "compact2").trim().toLowerCase();
  return ["compact2", "compact", "qr_only", "print", "loax"].includes(template) ? template : "compact2";
}

function normalizeVietQrImageFormat(value) {
  const imageFormat = String(value || "png").trim().toLowerCase();
  return ["png", "jpg", "jpeg"].includes(imageFormat) ? imageFormat : "png";
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
    await sendTelegramMessage(ctx, message.chat.id, `Chat ID: ${h(message.chat.id)}\nUser ID: ${h(message.from?.id || "")}`);
    return;
  }

  if (!isAuthorized(ctx, message.chat?.id, message.from?.id)) {
    await sendTelegramMessage(ctx, message.chat.id, "Bạn không có quyền điều khiển BOT bán đồ.");
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
      message: `Phiếu <b>${h(code)}</b> sẽ tự tiếp tục sau khi BOT nhận đủ xu và khách gửi STK. Nếu muốn hủy hãy reply: <b>no</b>`,
    };
  }

  return { action: "approve", code };
}

function parseCommand(text) {
  const dayCommand = parseDayStatsCommand(text);
  if (dayCommand) return dayCommand;

  const monthCommand = parseMonthStatsCommand(text);
  if (monthCommand) return monthCommand;

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
  if (command.action === "day_stats") {
    return buildStatsSection(`THỐNG KÊ NGÀY ${command.day}/${command.month}/${command.year}`, vietnamDateRange(command.year, command.month, command.day, 1));
  }
  if (command.action === "month_stats") {
    return buildStatsSection(`THỐNG KÊ THÁNG ${command.month}/${command.year}`, vietnamMonthRange(command.month, command.year));
  }

  const actor = formatActor(from);
  if (command.action === "approve") {
    const result = await approveBandoOrder({
      orderCode: command.code,
      note: `Telegram ${actor} duyệt thanh toán`,
    });
    if (!result.ok) return `Duyệt <b>${h(command.code)}</b> thất bại: ${h(result.error)}`;
    return `Đã duyệt thanh toán đơn <b>${h(result.order?.orderCode || command.code)}</b>.`;
  }

  if (command.action === "cancel") {
    const result = await cancelBandoRecord({
      orderCode: command.code,
      note: `Telegram ${actor} hủy đơn`,
    });
    if (!result.ok) return `Hủy <b>${h(command.code)}</b> thất bại: ${h(result.error)}`;
    return `Đã hủy <b>${h(result.order?.orderCode || result.coinTrade?.orderCode || command.code)}</b>.`;
  }

  if (command.action === "payout") {
    const result = await approveCoinTradePayout({
      orderCode: command.code,
      note: `Telegram ${actor} duyệt trả tiền`,
    });
    if (!result.ok) return `Duyệt trả tiền <b>${h(command.code)}</b> thất bại: ${h(result.error)}`;
    return `Đã xác nhận trả tiền phiếu <b>${h(result.coinTrade?.orderCode || command.code)}</b>.`;
  }

  return buildHelpText();
}

async function buildStatsSection(title, range) {
  const stats = await getBandoRevenueStats(range);
  if (!stats?.ok) return "";

  return [
    `<b>${h(title)}</b>`,
    `Bán ra: ${formatNumber(stats.sell.totalOrders)} đơn · <b>${formatVnd(stats.sell.totalAmount)}</b>`,
    `  • Bán xu: ${formatNumber(stats.sell.coinOrders)} đơn · ${formatVnd(stats.sell.coinAmount)}`,
    `  • Bán item: ${formatNumber(stats.sell.itemOrders)} đơn · ${formatVnd(stats.sell.itemAmount)}`,
    `Mua vào: ${formatNumber(stats.buy.totalOrders)} đơn · <b>${formatVnd(stats.buy.totalAmount)}</b>`,
    `  • Mua xu: ${formatNumber(stats.buy.coinOrders)} đơn · ${formatVnd(stats.buy.coinAmount)}`,
    `Chênh lệch: <b>${formatSignedVnd(stats.netAmount)}</b>`,
  ].join("\n");
}

function buildHelpText() {
  return [
    "Lệnh BOT Telegram bán đồ:",
    "/id - lấy chat id và user id",
    "Reply OK vào tin đơn để duyệt thanh toán hoặc xác nhận đã trả tiền.",
    "Reply NO vào tin đơn để hủy đơn/phiếu.",
    "/duyet &lt;mã_đơn&gt; - duyệt thanh toán thủ công",
    "/huy &lt;mã_đơn&gt; - hủy đơn/phiếu xu",
    "/traxu &lt;mã_phiếu&gt; - duyệt đã trả tiền cho khách bán xu",
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

async function sendPhotoToAdminChats(ctx, photo) {
  for (const chatId of ctx.chatIds) {
    try {
      await sendTelegramPhoto(ctx, chatId, photo.photoUrl, photo.caption);
    } catch (error) {
      console.error("[bando:telegram] gui VietQR loi:", error instanceof Error ? error.message : error);
      try {
        await sendTelegramMessage(ctx, chatId, `${photo.caption}\n\nLink QR: ${h(photo.photoUrl)}`);
      } catch (fallbackError) {
        console.error("[bando:telegram] gui link VietQR loi:", fallbackError instanceof Error ? fallbackError.message : fallbackError);
      }
    }
  }
}

async function sendTelegramMessage(ctx, chatId, text, options = null) {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    disable_web_page_preview: true,
  };
  if (options?.reply_to_message_id) {
    payload.reply_to_message_id = options.reply_to_message_id;
  }
  await telegramApi(ctx, "sendMessage", payload);
}

async function sendTelegramPhoto(ctx, chatId, photoUrl, caption) {
  await telegramApi(ctx, "sendPhoto", {
    chat_id: chatId,
    photo: photoUrl,
    caption,
    parse_mode: "HTML",
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

function parseMonthStatsCommand(text) {
  const normalized = stripVietnameseMarks(text).toLowerCase().replace(/@[\w_]+/g, "").replace(/\s+/g, " ").trim();
  const match = normalized.match(/^\/?thang\s*(\d{1,2})$/);
  if (!match) return null;
  const month = Number(match[1]);
  if (!Number.isInteger(month) || month < 1 || month > 12) return null;
  return { action: "month_stats", month, year: vietnamNowParts().year };
}

function parseDayStatsCommand(text) {
  const normalized = stripVietnameseMarks(text).toLowerCase().replace(/@[\w_]+/g, "").replace(/\s+/g, " ").trim();
  const match = normalized.match(/^\/?ngay\s*(\d{1,2})(?:[\/.-](\d{1,2})(?:[\/.-](\d{2,4}))?)?$/);
  if (!match) return null;

  const now = vietnamNowParts();
  const day = Number(match[1]);
  const month = match[2] ? Number(match[2]) : now.month;
  let year = match[3] ? Number(match[3]) : now.year;
  if (year > 0 && year < 100) year += 2000;

  if (!isValidVietnamDate(day, month, year)) return null;
  return { action: "day_stats", day, month, year };
}

function isValidVietnamDate(day, month, year) {
  if (!Number.isInteger(year) || year < 2000 || year > 2100) return false;
  if (!Number.isInteger(month) || month < 1 || month > 12) return false;
  if (!Number.isInteger(day) || day < 1) return false;
  return day <= new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function normalizeDecision(text) {
  const value = stripVietnameseMarks(text).trim().toLowerCase();
  if (["ok", "oke", "yes", "duyet", "dong y"].includes(value)) return "ok";
  if (["no", "ko", "khong", "huy", "cancel"].includes(value)) return "no";
  return null;
}

function extractMessageType(text) {
  const match = text.match(/^(?:Loai|Loại):\s*([A-Za-z0-9_-]+)/im);
  return match ? match[1].trim().toLowerCase() : "";
}

function extractBandoCode(text) {
  const patterns = [
    /(?:Don|Đơn):\s*([A-Za-z0-9_-]{3,64})/iu,
    /(?:Ma|Mã)\s+(?:don|đơn):\s*([A-Za-z0-9_-]{3,64})/iu,
    /(?:Phieu|Phiếu):\s*([A-Za-z0-9_-]{3,64})/iu,
    /(?:Ma|Mã)\s+(?:phieu|phiếu):\s*([A-Za-z0-9_-]{3,64})/iu,
    /Ma:\s*([A-Za-z0-9_-]{3,64})/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return match[1].toUpperCase();
  }
  return "";
}

function vietnamTodayRange() {
  const parts = vietnamNowParts();
  return vietnamDateRange(parts.year, parts.month, parts.day, 1);
}

function vietnamMonthRange(month, year) {
  const startUtc = new Date(Date.UTC(year, month - 1, 1) - VIETNAM_UTC_OFFSET_MS);
  const endUtc = new Date(Date.UTC(month === 12 ? year + 1 : year, month === 12 ? 0 : month, 1) - VIETNAM_UTC_OFFSET_MS);
  return { fromIso: startUtc.toISOString(), toIso: endUtc.toISOString() };
}

function vietnamDateRange(year, month, day, days) {
  const startUtc = new Date(Date.UTC(year, month - 1, day) - VIETNAM_UTC_OFFSET_MS);
  const endUtc = new Date(startUtc.getTime() + days * 24 * 60 * 60 * 1000);
  return { fromIso: startUtc.toISOString(), toIso: endUtc.toISOString() };
}

function vietnamNowParts(date = new Date()) {
  const local = new Date(date.getTime() + VIETNAM_UTC_OFFSET_MS);
  return {
    year: local.getUTCFullYear(),
    month: local.getUTCMonth() + 1,
    day: local.getUTCDate(),
  };
}

function formatActor(from) {
  if (!from) return "admin";
  return from.username ? `@${from.username}` : String(from.id || "admin");
}

function formatBankAccount(bank) {
  return `${h(bank.bankName || bank.bankCode || "")} · ${h(bank.accountNumber || "")} · ${h(bank.accountName || "")}`;
}

function formatNumber(value) {
  return new Intl.NumberFormat("vi-VN").format(Math.max(0, Math.trunc(Number(value) || 0)));
}

function formatVnd(value) {
  return `${formatNumber(value)} VND`;
}

function formatSignedVnd(value) {
  const amount = Math.trunc(Number(value) || 0);
  const sign = amount > 0 ? "+" : amount < 0 ? "-" : "";
  return `${sign}${formatVnd(Math.abs(amount))}`;
}

function formatXu(value) {
  return `${formatNumber(value)} xu`;
}

function h(value) {
  return escapeHtml(value);
}

function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function stripVietnameseMarks(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
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
