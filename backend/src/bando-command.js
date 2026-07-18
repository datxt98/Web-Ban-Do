export const defaultBandoItems = [];
export const COIN_ITEM_CODE = "coin-xu";
export const COIN_ITEM_NAME = "Xu";
export const MIN_COIN_TRADE_AMOUNT = 1_000_000;

export function formatVnd(amount) {
  return `${new Intl.NumberFormat("vi-VN").format(Number(amount) || 0)} VND`;
}

export function formatXu(amount) {
  return `${new Intl.NumberFormat("vi-VN").format(Math.max(0, Math.trunc(Number(amount) || 0)))} xu`;
}

export function parseBandoPrivateChat(message) {
  const normalized = String(message || "").trim().toLowerCase().replace(/\s+/g, " ");
  const match = normalized.match(/^(?:mua\s+)?([a-z0-9_-]+)\s*(?:\+|x|\s)\s*(\d{1,9})$/);

  if (!match) {
    return {
      ok: false,
      error: "Cu phap mua: mua <ten mua> <so luong> hoac <ten mua>+<so luong>. Chat 'xem' de xem hang.",
    };
  }

  const quantity = Number(match[2]);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return {
      ok: false,
      error: "So luong phai la so nguyen lon hon 0.",
    };
  }

  return {
    ok: true,
    itemToken: match[1],
    quantity,
  };
}

export function parseCoinCommand(message) {
  const normalized = normalizeCommandText(message);
  const compact = normalized.replace(/\s+/g, "");

  if (compact === "muaxu" || compact === "banxu" || normalized === "mua xu" || normalized === "ban xu") {
    return {
      ok: false,
      isCoinCommand: true,
      error: compact.startsWith("mua")
        ? "Cu phap mua xu: muaxu <so xu>. Vi du: muaxu 200000."
        : "Cu phap ban xu: banxu <so xu>. Vi du: banxu 260000.",
    };
  }

  const match = normalized.match(/^(mua xu|muaxu|ban xu|banxu)\s*(?:\+|x|\s)\s*([\d.,]{1,16})$/);
  if (!match) return { ok: false, isCoinCommand: false };

  const coinAmount = Number(String(match[2]).replace(/[.,\s]/g, ""));
  if (!Number.isSafeInteger(coinAmount) || coinAmount <= 0 || coinAmount > 2_000_000_000) {
    return {
      ok: false,
      isCoinCommand: true,
      error: "So xu phai la so nguyen lon hon 0 va khong vuot qua 2 ty.",
    };
  }

  const isSellToBot = match[1].includes("ban");
  if (coinAmount < MIN_COIN_TRADE_AMOUNT) {
    return {
      ok: false,
      isCoinCommand: true,
      error: isSellToBot
        ? `So xu toi thieu co the ban cho BOT la ${formatXu(MIN_COIN_TRADE_AMOUNT)}.`
        : `So xu toi thieu co the mua cua BOT la ${formatXu(MIN_COIN_TRADE_AMOUNT)}.`,
    };
  }

  return {
    ok: true,
    isCoinCommand: true,
    type: isSellToBot ? "sell_xu" : "buy_xu",
    coinAmount,
  };
}

export function isPayoutCancelCommand(message) {
  return ["huy", "cancel"].includes(normalizeCommandText(message));
}

export function parsePayoutInfoCommand(message, options = {}) {
  const raw = String(message || "").trim();
  const normalized = normalizeCommandText(raw);
  const hasPrefix = normalized.startsWith("nhantien") || normalized.startsWith("nhan tien");
  if (!hasPrefix && !options.allowBare) return { ok: false, isPayoutInfoCommand: false };

  const rawParts = raw.split(/\s+/).filter(Boolean);
  const firstToken = normalizeCommandText(rawParts[0] || "").replace(/\s+/g, "");
  const secondToken = normalizeCommandText(rawParts[1] || "").replace(/\s+/g, "");
  let content = raw;
  if (hasPrefix) {
    const dropCount = firstToken === "nhantien" ? 1 : (firstToken === "nhan" && secondToken === "tien" ? 2 : 1);
    content = rawParts.slice(dropCount).join(" ");
  }

  let bankName = "";
  let accountNumber = "";
  let accountName = "";

  if (content.includes("|")) {
    const parts = content.split("|").map((part) => part.trim()).filter(Boolean);
    [bankName, accountNumber, accountName] = parts;
  } else {
    const match = content.match(/^(\S+)\s+(\d{5,32})\s+(.+)$/);
    if (match) {
      bankName = match[1];
      accountNumber = match[2];
      accountName = match[3].trim();
    }
  }

  if (!bankName || !accountNumber || !accountName) {
    return {
      ok: false,
      isPayoutInfoCommand: true,
      error: "Sai cu phap tai khoan ngan hang, moi nhap lai: NganHang STK TenTaiKhoan hoac chat Huy de huy.",
    };
  }

  return {
    ok: true,
    isPayoutInfoCommand: true,
    bankName,
    accountNumber,
    accountName,
  };
}

export function findBandoItem(items, token) {
  const normalized = String(token || "").trim().toLowerCase();
  return items.find(
    (item) =>
      item.active &&
      (item.code === normalized ||
        String(item.buyName || "").toLowerCase() === normalized ||
        item.aliases.some((alias) => String(alias).toLowerCase() === normalized)),
  );
}

export function isListCommand(message) {
  const normalized = normalizeCommandText(message);
  return ["xem", "xem hang", "list", "shop", "gia", "bang gia", "banggia"].includes(normalized);
}

export function buildHelpReplies(items) {
  const active = items.filter((item) => item.active && item.sellPrice > 0);
  const examples = active.slice(0, 3).map((item) => `mua ${item.buyName || item.code} 1`);

  if (examples.length === 0) {
    return [
      "Lenh BOT: chat 'xem' de xem bang gia, 'muaxu <so xu>' de mua xu, 'banxu <so xu>' de ban xu cho BOT.",
      "Hien gian hang chua co vat pham. Admin can them item va dat gia tren web.",
    ];
  }

  return [
    "Lenh BOT: chat 'xem' de xem bang gia, 'muaxu <so xu>' de mua xu, 'banxu <so xu>' de ban xu cho BOT.",
    `Mua hang: ${examples[0]} hoac tenmua+soluong. Vi du: ${examples.join(", ")}.`,
    "Sau khi tao don, BOT se tra ma giao dich va so tien can chuyen.",
  ];
}

export function buildCatalogReplies(items, stockByItemId = new Map(), coinTradeConfig = {}, botCoinAmount = 0) {
  const activeItems = items.filter((item) => item.active && item.sellPrice > 0);
  const replies = buildCoinCatalogReplies(coinTradeConfig, botCoinAmount);

  if (activeItems.length === 0) {
    replies.push("Hien BOT chua cau hinh vat pham nao de ban.");
    return replies;
  }

  const lines = activeItems.map((item) => {
    const liveStock = item.itemId == null ? undefined : stockByItemId.get(item.itemId);
    const stock = liveStock ?? item.stock;
    const buyName = item.buyName || item.code;
    return `- ${item.name} - Con: ${stock} ${item.unit} - Gia: ${formatVnd(item.sellPrice)} - Lenh mua: mua ${buyName} <sl>`;
  });

  replies.push("Vat pham dang ban:");
  replies.push(...chunkLines(lines, 180));
  return replies;
}

export function stockMapFromInventory(inventory) {
  const stockByItemId = new Map();
  if (!Array.isArray(inventory)) return stockByItemId;

  for (const entry of inventory) {
    const itemId = Number(entry.itemId);
    const quantity = Number(entry.quantity);
    if (!Number.isInteger(itemId) || itemId < 0 || !Number.isFinite(quantity)) continue;
    stockByItemId.set(itemId, (stockByItemId.get(itemId) ?? 0) + Math.max(0, Math.trunc(quantity)));
  }

  return stockByItemId;
}

export function getAvailableStock(item, stockByItemId = new Map()) {
  if (item.itemId != null && stockByItemId.has(item.itemId)) {
    return stockByItemId.get(item.itemId) ?? 0;
  }
  return item.stock;
}

export function buildOrderReply(args) {
  const reply = [
    `Da tao don ${args.paymentCode} cho ${args.characterName}.`,
    `${args.itemName} x${args.quantity}: ${formatVnd(args.totalAmount)}.`,
    `Noi dung chuyen khoan: ${args.paymentCode}.`,
  ];

  if (args.bankAccount) {
    reply.push(
      `Ngan hang: ${args.bankAccount.bankName}. STK: ${args.bankAccount.accountNumber}. CTK: ${args.bankAccount.accountName}.`,
    );
  } else {
    reply.push("Chua cau hinh tai khoan nhan tien tren web.");
  }

  return reply.join(" ");
}

export function buildCoinBuyOrderReply(args) {
  const reply = [
    `Da tao don ${args.paymentCode} cho ${args.characterName}.`,
    `Mua ${formatXu(args.coinAmount)}: ${formatVnd(args.totalAmount)}.`,
    `Noi dung chuyen khoan: ${args.paymentCode}.`,
  ];

  if (args.bankAccount) {
    reply.push(
      `Ngan hang: ${args.bankAccount.bankName}. STK: ${args.bankAccount.accountNumber}. CTK: ${args.bankAccount.accountName}.`,
    );
  } else {
    reply.push("Chua cau hinh tai khoan nhan tien tren web.");
  }

  reply.push("Sau khi thanh toan dung ma, hay moi giao dich BOT de nhan xu.");
  return reply.join(" ");
}

export function buildCoinSellRequestReply(args) {
  return [
    `Da tao phieu ${args.orderCode}. Ban ${formatXu(args.coinAmount)} cho BOT = ${formatVnd(args.totalAmount)}.`,
    "Hay moi giao dich BOT va dat dung so xu tren.",
    "Sau khi giao xong, BOT se hoi thong tin ngan hang nhan tien.",
  ].join(" ");
}

export function buildCoinSellCompletedReply(args) {
  return [
    `BOT da nhan ${formatXu(args.receivedCoinAmount || args.coinAmount)}.`,
    `So tien ban nhan: ${formatVnd(args.totalAmount)}.`,
    "Gui thong tin nhan tien bang cu phap: NganHang STK TenTaiKhoan.",
    "Vi du: VCB 0123456789 NGUYEN VAN A. Chat Huy de huy.",
  ].join(" ");
}

export function buildPayoutInfoSavedReply(trade) {
  if (!trade) return "Da luu thong tin nhan tien.";
  return `Da luu thong tin nhan tien cho phieu ${trade.orderCode}: ${trade.bankName} - ${trade.accountNumber} - ${trade.accountName}.`;
}

export function buildPayoutInfoCancelReply() {
  return "Da huy nhap thong tin nhan tien. Neu can gui lai, chat: NganHang STK TenTaiKhoan.";
}

export function coinsPer1000Vnd(rate) {
  return Math.max(1, Math.round((Number(rate) || 0) * 100000));
}

export function calculateCustomerPayVnd(coinAmount, rate) {
  return Math.max(1, Math.ceil((Math.max(0, Number(coinAmount) || 0) / coinsPer1000Vnd(rate)) * 1000));
}

export function calculateCustomerReceiveVnd(coinAmount, rate) {
  return Math.max(1, Math.floor((Math.max(0, Number(coinAmount) || 0) / coinsPer1000Vnd(rate)) * 1000));
}

function buildCoinCatalogReplies(coinTradeConfig, botCoinAmount) {
  const sell = coinTradeConfig?.sell ?? {};
  const importXu = coinTradeConfig?.importXu ?? {};
  const replies = [];

  if (sell.enabled !== false) {
    replies.push(
      `Mua xu cua BOT gia: 1.000 VND = ${formatXu(coinsPer1000Vnd(sell.rate))}. Lenh: muaxu <so xu>.`,
    );
  } else {
    replies.push("Mua Xu: dang tat tren web.");
  }

  if (importXu.enabled !== false) {
    replies.push(`Ban xu cho BOT gia: 1.000 VND = ${formatXu(coinsPer1000Vnd(importXu.rate))}. Lenh: banxu <so xu>.`);
  } else {
    replies.push("Ban Xu: dang tat tren web.");
  }

  return replies;
}

function chunkLines(lines, maxLength) {
  const replies = [];
  let current = "";

  for (const line of lines) {
    const safeLine = String(line || "").replace(/\s+/g, " ").trim();
    if (!safeLine) continue;

    const next = current ? `${current}; ${safeLine}` : safeLine;
    if (next.length > maxLength && current) {
      replies.push(current);
      current = safeLine;
    } else {
      current = next;
    }
  }

  if (current) replies.push(current);
  return replies;
}

function normalizeCommandText(message) {
  return String(message || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s.,+|_-]/gu, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}
