import {
  COIN_ITEM_CODE,
  COIN_ITEM_NAME,
  buildCoinBuyOrderReply,
  buildCoinSellCompletedReply,
  buildCoinSellRequestReply,
  buildCatalogReplies,
  buildHelpReplies,
  buildOrderReply,
  buildPayoutInfoCancelReply,
  buildPayoutInfoSavedReply,
  calculateCustomerPayVnd,
  calculateCustomerReceiveVnd,
  defaultBandoItems,
  findBandoItem,
  formatVnd,
  getAvailableStock,
  isListCommand,
  isPayoutCancelCommand,
  parseBandoPrivateChat,
  parseCoinCommand,
  parsePayoutInfoCommand,
  stockMapFromInventory,
} from "./bando-command.js";
import {
  approveBandoOrderMysql,
  approveCoinTradePayoutMysql,
  cancelBandoRecordMysql,
  cancelCoinTradePayoutInfoMysql,
  confirmBotNotificationMysql,
  confirmDeliveryMysql,
  confirmPaymentMysql,
  countBandoAdminUsersMysql,
  deleteBandoBankAccountMysql,
  deleteBandoGameServerMysql,
  findBandoAdminUserByUsernameMysql,
  getBandoBotConfigMysql,
  getBandoRevenueStatsMysql,
  importServerItemsMysql,
  insertBandoAdminUserMysql,
  insertBandoCoinTradeMysql,
  insertBandoOrderMysql,
  listBandoGameServersMysql,
  listPendingBotNotificationsMysql,
  listPendingDeliveriesMysql,
  listBandoStateMysql,
  updateCoinTradePayoutInfoMysql,
  upsertBandoBankAccountMysql,
  upsertBandoGameServerMysql,
  updateBandoBotConfigMysql,
  updateBandoInventoryMysql,
  updateBandoItemMysql,
} from "./bando-mysql.js";
import { createAuthToken, createPasswordRecord, verifyAuthToken, verifyPassword } from "./bando-auth.js";
import { emitBandoEvent } from "./bando-events.js";

const memoryState = {
  items: defaultBandoItems.map((item) => ({ ...item, aliases: [...item.aliases] })),
  orders: [],
  coinTrades: [],
  transactions: [],
  bankAccounts: [],
  gameServers: [],
  adminUsers: [],
  events: [
    {
      id: 1,
      orderCode: null,
      type: "system",
      message: "Bán đồ sẵn sàng. Đơn hàng chỉ được tạo từ chat riêng trong game.",
      createdAt: new Date().toISOString(),
    },
  ],
  storage: "memory",
};

const memoryInventoryByItemId = new Map();
const DEFAULT_GAME_NAME = "Ninja Mobile";
const memoryEventLimit = 200;
let memoryBotConfig = createDefaultBotConfig();
let memoryBotConfigUpdatedAt = new Date().toISOString();
let memoryOrderId = 1;
let memoryCoinTradeId = 1;
let memoryTransactionId = 1;
let memoryBankAccountId = 1;
let memoryGameServerId = 1;
let memoryAdminUserId = 1;
let memoryEventId = 2;

export function getConfiguredBotToken() {
  return process.env.BANDO_BOT_TOKEN?.trim() ?? "";
}

export function validateBandoBotAuth(headers) {
  const expected = getConfiguredBotToken();
  if (!expected) return null;

  const auth = headers.authorization ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const supplied = headers["x-bando-token"] ?? bearer;

  return supplied === expected ? null : "Yêu cầu BOT không được phép.";
}

export async function getBandoAuthStatus(headers = {}) {
  const hasUsers = await hasAdminUsers();
  const auth = await validateBandoAdminAuth(headers, { optional: true });
  return { ok: true, hasUsers, user: auth.ok ? publicAdminUser(auth.user) : null };
}

export async function registerBandoAdmin(args = {}, headers = {}) {
  const username = normalizeUsername(args.username);
  const password = String(args.password || "");
  if (!username || password.length < 4) {
    return { ok: false, error: "Tên đăng nhập và mật khẩu tối thiểu 4 ký tự." };
  }

  const hasUsers = await hasAdminUsers();
  if (hasUsers && process.env.BANDO_ALLOW_PUBLIC_REGISTER !== "1") {
    const auth = await validateBandoAdminAuth(headers);
    if (!auth.ok) {
      return { ok: false, error: "Đã có tài khoản quản trị. Hãy đăng nhập trước để tạo thêm tài khoản." };
    }
  }

  const passwordRecord = createPasswordRecord(password);
  const mysqlResult = await insertBandoAdminUserMysql({
    username,
    ...passwordRecord,
    role: "admin",
    active: true,
  });
  if (mysqlResult) {
    if (!mysqlResult.ok) return mysqlResult;
    const token = createAuthToken(mysqlResult.user);
    return { ok: true, user: publicAdminUser(mysqlResult.user), token, storage: "mysql" };
  }

  if (memoryState.adminUsers.some((user) => user.username === username)) {
    return { ok: false, error: "Tên đăng nhập đã tồn tại." };
  }
  const now = new Date().toISOString();
  const user = {
    id: memoryAdminUserId++,
    username,
    ...passwordRecord,
    role: "admin",
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  memoryState.adminUsers.push(user);
  const token = createAuthToken(user);
  return { ok: true, user: publicAdminUser(user), token, storage: "memory" };
}

export async function loginBandoAdmin(args = {}) {
  const username = normalizeUsername(args.username);
  const password = String(args.password || "");
  if (!username || !password) return { ok: false, error: "Thiếu tên đăng nhập hoặc mật khẩu." };

  const mysqlResult = await findBandoAdminUserByUsernameMysql(username);
  if (mysqlResult) {
    if (!mysqlResult.user || !verifyPassword(password, mysqlResult.user)) {
      return { ok: false, error: "Sai tên đăng nhập hoặc mật khẩu." };
    }
    const token = createAuthToken(mysqlResult.user);
    return { ok: true, user: publicAdminUser(mysqlResult.user), token, storage: "mysql" };
  }

  const user = memoryState.adminUsers.find((entry) => entry.username === username && entry.active);
  if (!user || !verifyPassword(password, user)) {
    return { ok: false, error: "Sai tên đăng nhập hoặc mật khẩu." };
  }
  const token = createAuthToken(user);
  return { ok: true, user: publicAdminUser(user), token, storage: "memory" };
}

export async function validateBandoAdminAuth(headers = {}, options = {}) {
  if (process.env.BANDO_DISABLE_ADMIN_AUTH === "1") {
    return { ok: true, user: { id: 0, username: "dev", role: "admin" } };
  }

  const auth = String(headers.authorization || "");
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const supplied = String(headers["x-bando-admin-token"] || bearer || "").trim();
  if (!supplied) {
    return options.optional ? { ok: false, error: "" } : { ok: false, error: "Chưa đăng nhập quản trị." };
  }

  const payload = verifyAuthToken(supplied);
  if (!payload) {
    return options.optional ? { ok: false, error: "" } : { ok: false, error: "Phiên đăng nhập hết hạn hoặc không hợp lệ." };
  }

  return {
    ok: true,
    user: {
      id: Number(payload.sub) || 0,
      username: String(payload.username || ""),
      role: String(payload.role || "admin"),
    },
  };
}

export async function listBandoState(args = {}) {
  const gameName = normalizeGameName(args.gameName);
  const serverName = normalizeServerName(args.serverName);
  const characterName = await resolveInventoryCharacterName(gameName, serverName);
  const mysqlState = await listBandoStateMysql({ gameName, serverName, characterName });
  if (mysqlState) return mysqlState;
  return applyMemoryInventory(filterMemoryStateByServer(cloneMemoryState(), gameName, serverName), gameName, serverName, characterName);
}

export async function getBandoRevenueStats(args = {}) {
  const fromIso = String(args.fromIso || "").trim();
  const toIso = String(args.toIso || "").trim();
  if (!fromIso || !toIso) return { ok: false, error: "Thieu khoang thoi gian thong ke." };

  const mysqlResult = await getBandoRevenueStatsMysql({ fromIso, toIso });
  if (mysqlResult) return mysqlResult;

  return buildRevenueStatsFromMemory(fromIso, toIso);
}

export async function getBandoBotConfig() {
  const mysqlResult = await getBandoBotConfigMysql();
  if (mysqlResult?.config) {
    return {
      ok: true,
      config: normalizeBotConfig(mysqlResult.config),
      updatedAt: mysqlResult.updatedAt,
      storage: "mysql",
    };
  }

  return {
    ok: true,
    config: cloneBotConfig(memoryBotConfig),
    updatedAt: memoryBotConfigUpdatedAt,
    storage: "memory",
  };
}

export async function updateBandoBotConfig(patch) {
  const current = await getBandoBotConfig();
  const config = normalizeBotConfig(mergeBotConfig(current.config, patch));
  const mysqlResult = await updateBandoBotConfigMysql(config);
  if (mysqlResult) {
    return {
      ...mysqlResult,
      config: normalizeBotConfig(mysqlResult.config),
      storage: "mysql",
    };
  }

  memoryBotConfig = cloneBotConfig(config);
  memoryBotConfigUpdatedAt = new Date().toISOString();
  pushMemoryEvent(null, "bot_config_updated", "Cập nhật cấu hình BOT bán đồ từ web.");
  return { ok: true, config: cloneBotConfig(memoryBotConfig), updatedAt: memoryBotConfigUpdatedAt, storage: "memory" };
}

export async function resolveBandoBotConfig(args) {
  const characterName = String(args.characterName || "").trim();
  const gameName = normalizeGameName(args.gameName);
  const serverName = String(args.serverName || "").trim();
  if (!characterName) return { ok: false, error: "Game chưa gửi tên nhân vật BOT." };

  const result = await getBandoBotConfig();
  const config = result.config;
  const profile = findBotServerProfile(config, gameName, serverName, characterName);
  if (profile) {
    const expectedProfileName = String(profile.characterName || "").trim();
    if (!profile.enabled) return { ok: false, error: `BOT server '${profile.serverName}' đang tắt trên web.` };
    if (!expectedProfileName) return { ok: false, error: `Server '${profile.serverName}' chưa nhập tên nhân vật BOT.` };
    if (expectedProfileName.toLowerCase() !== characterName.toLowerCase()) {
      return {
        ok: false,
        error: `Sai nhân vật BOT. Server '${profile.serverName}' đang cấu hình '${expectedProfileName}', game hiện tại là '${characterName}'.`,
        expectedCharacterName: expectedProfileName,
        characterName,
      };
    }

    return {
      ok: true,
      config: {
        ...profile,
        characterName,
        gameName: profile.gameName || gameName || DEFAULT_GAME_NAME,
        serverName: profile.serverName || serverName || "nso-local",
      },
      updatedAt: result.updatedAt,
      storage: result.storage,
    };
  }

  if (Array.isArray(config.serverProfiles) && config.serverProfiles.length > 0) {
    return { ok: false, error: `Chưa cấu hình game '${gameName}' / server '${serverName || "không tên"}' trên web.` };
  }

  const expectedName = String(config.characterName || "").trim();
  if (!config.enabled) return { ok: false, error: "BOT đang tắt trên web." };
  if (!expectedName) return { ok: false, error: "Chưa nhập tên nhân vật BOT trên web." };
  if (expectedName.toLowerCase() !== characterName.toLowerCase()) {
    return {
      ok: false,
      error: `Sai nhân vật BOT. Web đang cấu hình '${expectedName}', game hiện tại là '${characterName}'.`,
      expectedCharacterName: expectedName,
      characterName,
    };
  }

  return {
    ok: true,
    config: {
      ...config,
      characterName,
      gameName: config.gameName || gameName || DEFAULT_GAME_NAME,
      serverName: config.serverName || serverName || "nso-local",
    },
    updatedAt: result.updatedAt,
    storage: result.storage,
  };
}

export async function createBandoOrderFromChat(args) {
  const characterName = String(args.characterName || "").trim();
  const privateMessage = String(args.privateMessage || "").trim();
  const gameName = normalizeGameName(args.gameName);
  const serverName = String(args.serverName || "").trim() || "default";
  const botCoinAmount = normalizeBotCoinAmount(args.coin ?? args.xu);

  if (!characterName) {
    return { ok: false, error: "Thiếu tên nhân vật." };
  }

  const state = await listBandoState({ gameName, serverName });
  const botConfigPayload = await getBandoBotConfig();
  const botConfig = selectBotConfigForServer(botConfigPayload.config, gameName, serverName);
  const stockByItemId = stockMapFromInventory(args.inventory);
  const pendingPayoutInfoTrade = findPendingPayoutInfoTrade(state.coinTrades, characterName, gameName, serverName);

  if (pendingPayoutInfoTrade) {
    if (isPayoutCancelCommand(privateMessage)) {
      return cancelCoinTradePayoutInfoFromChat({ characterName, gameName, serverName });
    }
    const payoutInfo = parsePayoutInfoCommand(privateMessage, { allowBare: true });
    if (!payoutInfo.ok) return { ok: false, error: payoutInfo.error };
    return saveCoinTradePayoutInfoFromChat({
      state,
      characterName,
      gameName,
      serverName,
      ...payoutInfo,
    });
  }

  if (isListCommand(privateMessage)) {
    const replies = buildCatalogReplies(state.items, stockByItemId, botConfig.coinTrade, botCoinAmount);
    return { ok: true, replies, reply: replies.join(" | ") };
  }

  const payoutInfo = parsePayoutInfoCommand(privateMessage);
  if (payoutInfo.isPayoutInfoCommand) {
    if (!payoutInfo.ok) return { ok: false, error: payoutInfo.error };
    return saveCoinTradePayoutInfoFromChat({
      state,
      characterName,
      gameName,
      serverName,
      ...payoutInfo,
    });
  }

  const coinCommand = parseCoinCommand(privateMessage);
  if (coinCommand.isCoinCommand) {
    if (!coinCommand.ok) return { ok: false, error: coinCommand.error };
    if (coinCommand.type === "buy_xu") {
      return createCoinBuyOrderFromChat({
        state,
        botConfig,
        characterName,
        gameName,
        serverName,
        privateMessage,
        botCoinAmount,
        coinAmount: coinCommand.coinAmount,
      });
    }
    return createCoinSellRequestFromChat({
      state,
      botConfig,
      characterName,
      gameName,
      serverName,
      privateMessage,
      coinAmount: coinCommand.coinAmount,
    });
  }

  const parsed = parseBandoPrivateChat(privateMessage);
  if (!parsed.ok) {
    const replies = buildHelpReplies(state.items);
    return { ok: true, replies, reply: replies.join(" ") };
  }

  const item = findBandoItem(state.items, parsed.itemToken);
  if (!item) {
    return { ok: false, error: `Vật phẩm '${parsed.itemToken}' chưa có trong bảng giá web.` };
  }

  const availableStock = getAvailableStock(item, stockByItemId);
  if (parsed.quantity > availableStock) {
    return { ok: false, error: `Tồn kho ${item.name} chỉ còn ${availableStock} ${item.unit}.` };
  }

  const bankAccount = selectPaymentBankAccount(state.bankAccounts);
  const orderCode = createOrderCode(state.orders);
  const paymentCode = orderCode;
  const totalAmount = parsed.quantity * item.sellPrice;
  const now = new Date().toISOString();
  const order = {
    orderCode,
    paymentCode,
    characterName,
    gameName,
    serverName,
    itemCode: item.code,
    itemName: item.name,
    quantity: parsed.quantity,
    unitPrice: item.sellPrice,
    totalAmount,
    status: "awaiting_payment",
    privateMessage,
    createdAt: now,
    paidAt: null,
    deliveredAt: null,
  };

  if (state.storage === "mysql" && (await insertBandoOrderMysql(order))) {
    const result = {
      ok: true,
      order,
      reply: buildOrderReply({
        characterName,
        itemName: item.name,
        quantity: parsed.quantity,
        totalAmount,
        paymentCode,
        bankAccount,
      }),
    };
    notifyOrderCreated("item_order_created", { order, bankAccount });
    return result;
  }

  order.id = memoryOrderId++;
  memoryState.orders.unshift(order);
  pushMemoryEvent(orderCode, "order_created", `${characterName} tạo đơn ${orderCode} từ chat riêng.`);

  const result = {
    ok: true,
    order,
    reply: buildOrderReply({
      characterName,
      itemName: item.name,
      quantity: parsed.quantity,
      totalAmount,
      paymentCode,
      bankAccount,
    }),
  };
  notifyOrderCreated("item_order_created", { order, bankAccount });
  return result;
}

async function createCoinBuyOrderFromChat(args) {
  const sellConfig = args.botConfig?.coinTrade?.sell ?? {};
  if (sellConfig.enabled === false) {
    return { ok: false, error: "Muc mua xu dang tat tren web." };
  }

  if (args.botCoinAmount < args.coinAmount) {
    return {
      ok: false,
      error: "BOT khong du xu de tao don nay.",
    };
  }

  const bankAccount = selectPaymentBankAccount(args.state.bankAccounts);
  const orderCode = createOrderCode(args.state.orders);
  const paymentCode = orderCode;
  const totalAmount = calculateCustomerPayVnd(args.coinAmount, sellConfig.rate);
  const now = new Date().toISOString();
  const order = {
    orderCode,
    paymentCode,
    characterName: args.characterName,
    gameName: args.gameName,
    serverName: args.serverName,
    itemCode: COIN_ITEM_CODE,
    itemName: COIN_ITEM_NAME,
    quantity: args.coinAmount,
    unitPrice: totalAmount,
    totalAmount,
    status: "awaiting_payment",
    privateMessage: args.privateMessage,
    createdAt: now,
    paidAt: null,
    deliveredAt: null,
  };
  const coinTrade = {
    orderCode,
    paymentCode,
    characterName: args.characterName,
    gameName: args.gameName,
    serverName: args.serverName,
    type: "buy_xu",
    coinAmount: args.coinAmount,
    receivedCoinAmount: 0,
    rate: Number(sellConfig.rate) || 0,
    totalAmount,
    status: "awaiting_payment",
    bankName: bankAccount?.bankName ?? "",
    accountNumber: bankAccount?.accountNumber ?? "",
    accountName: bankAccount?.accountName ?? "",
    createdAt: now,
    paidAt: null,
    completedAt: null,
  };

  if (args.state.storage === "mysql" && (await insertBandoOrderMysql(order))) {
    await insertBandoCoinTradeMysql(coinTrade);
    const result = {
      ok: true,
      order,
      coinTrade,
      reply: buildCoinBuyOrderReply({
        characterName: args.characterName,
        coinAmount: args.coinAmount,
        totalAmount,
        paymentCode,
        bankAccount,
      }),
    };
    notifyOrderCreated("coin_buy_order_created", { order, coinTrade, bankAccount });
    return result;
  }

  order.id = memoryOrderId++;
  coinTrade.id = memoryCoinTradeId++;
  memoryState.orders.unshift(order);
  memoryState.coinTrades.unshift(coinTrade);
  pushMemoryEvent(orderCode, "coin_buy_created", `${args.characterName} tao don mua ${args.coinAmount} xu.`);

  const result = {
    ok: true,
    order,
    coinTrade,
    reply: buildCoinBuyOrderReply({
      characterName: args.characterName,
      coinAmount: args.coinAmount,
      totalAmount,
      paymentCode,
      bankAccount,
    }),
  };
  notifyOrderCreated("coin_buy_order_created", { order, coinTrade, bankAccount });
  return result;
}

async function createCoinSellRequestFromChat(args) {
  const importConfig = args.botConfig?.coinTrade?.importXu ?? {};
  if (importConfig.enabled === false) {
    return { ok: false, error: "Muc ban xu cho BOT dang tat tren web." };
  }

  const orderCode = createCoinTradeCode(args.state.coinTrades, "SX");
  const totalAmount = calculateCustomerReceiveVnd(args.coinAmount, importConfig.rate);
  const now = new Date().toISOString();
  const coinTrade = {
    orderCode,
    paymentCode: "",
    characterName: args.characterName,
    gameName: args.gameName,
    serverName: args.serverName,
    type: "sell_xu",
    coinAmount: args.coinAmount,
    receivedCoinAmount: 0,
    rate: Number(importConfig.rate) || 0,
    totalAmount,
    status: "awaiting_trade",
    bankName: "",
    accountNumber: "",
    accountName: "",
    createdAt: now,
    paidAt: null,
    completedAt: null,
    privateMessage: args.privateMessage,
  };

  if (args.state.storage === "mysql" && (await insertBandoCoinTradeMysql(coinTrade))) {
    const result = {
      ok: true,
      coinTrade,
      reply: buildCoinSellRequestReply(coinTrade),
    };
    notifyOrderCreated("coin_sell_request_created", { coinTrade });
    return result;
  }

  coinTrade.id = memoryCoinTradeId++;
  memoryState.coinTrades.unshift(coinTrade);
  pushMemoryEvent(orderCode, "coin_sell_requested", `${args.characterName} tao phieu ban ${args.coinAmount} xu cho BOT.`);

  const result = {
    ok: true,
    coinTrade,
    reply: buildCoinSellRequestReply(coinTrade),
  };
  notifyOrderCreated("coin_sell_request_created", { coinTrade });
  return result;
}

function notifyOrderCreated(type, payload) {
  notifyBandoEvent(type, payload);
}

function notifyBandoEvent(type, payload) {
  emitBandoEvent(type, payload);
}

function notifyDeliveryEvent(result) {
  if (result?.order) {
    notifyBandoEvent("delivery_completed", { order: result.order });
    return;
  }
  if (result?.coinTrade) {
    notifyBandoEvent("coin_received", { coinTrade: result.coinTrade });
  }
}

async function saveCoinTradePayoutInfoFromChat(args) {
  const payload = {
    characterName: args.characterName,
    gameName: args.gameName,
    serverName: args.serverName,
    bankName: args.bankName,
    accountNumber: args.accountNumber,
    accountName: args.accountName,
  };
  const mysqlResult = await updateCoinTradePayoutInfoMysql(payload);
  if (mysqlResult) {
    if (!mysqlResult.ok) return mysqlResult;
    const result = { ok: true, coinTrade: mysqlResult.coinTrade, reply: buildPayoutInfoSavedReply(mysqlResult.coinTrade) };
    notifyBandoEvent("coin_payout_info_saved", { coinTrade: result.coinTrade });
    return result;
  }

  const trade = memoryState.coinTrades.find(
    (entry) =>
      entry.type === "sell_xu" &&
      entry.characterName.toLowerCase() === args.characterName.toLowerCase() &&
      matchesGame(entry.gameName, args.gameName) &&
      matchesServer(entry.serverName, args.serverName) &&
      ["awaiting_payout_info", "payout_info_cancelled", "completed"].includes(entry.status),
  );
  if (!trade) {
    return { ok: false, error: "Chua tim thay phieu ban xu cua ban de luu thong tin nhan tien." };
  }
  trade.bankName = args.bankName;
  trade.accountNumber = args.accountNumber;
  trade.accountName = args.accountName;
  trade.status = "completed";
  pushMemoryEvent(trade.orderCode, "coin_payout_info_saved", `${args.characterName} da gui thong tin nhan tien.`);
  const result = { ok: true, coinTrade: { ...trade }, reply: buildPayoutInfoSavedReply(trade) };
  notifyBandoEvent("coin_payout_info_saved", { coinTrade: result.coinTrade });
  return result;
}

async function cancelCoinTradePayoutInfoFromChat(args) {
  const characterName = String(args.characterName || "").trim();
  const gameName = normalizeGameName(args.gameName);
  const serverName = normalizeServerName(args.serverName);
  const mysqlResult = await cancelCoinTradePayoutInfoMysql({ characterName, gameName, serverName });
  if (mysqlResult) {
    if (!mysqlResult.ok) return mysqlResult;
    return { ok: true, coinTrade: mysqlResult.coinTrade, reply: buildPayoutInfoCancelReply() };
  }

  const trade = findPendingPayoutInfoTrade(memoryState.coinTrades, characterName, gameName, serverName);
  if (!trade) {
    return { ok: false, error: "Khong co phien nhap thong tin nhan tien de huy." };
  }

  trade.status = "payout_info_cancelled";
  pushMemoryEvent(trade.orderCode, "coin_payout_info_cancelled", `${characterName} da huy nhap thong tin nhan tien.`);
  return { ok: true, coinTrade: { ...trade }, reply: buildPayoutInfoCancelReply() };
}

function findPendingPayoutInfoTrade(coinTrades = [], characterName = "", gameName = DEFAULT_GAME_NAME, serverName = "") {
  const normalizedName = String(characterName || "").trim().toLowerCase();
  if (!normalizedName) return null;
  return coinTrades.find(
    (trade) =>
      trade &&
      trade.type === "sell_xu" &&
      trade.status === "awaiting_payout_info" &&
      matchesGame(trade.gameName, gameName) &&
      matchesServer(trade.serverName, serverName) &&
      String(trade.characterName || "").toLowerCase() === normalizedName,
  );
}

export async function confirmBandoPayment(args) {
  const paymentCode = String(args.paymentCode || "").trim().toUpperCase();
  const amount = Number(args.amount);
  const note = String(args.note || "").trim();
  const bankTransaction = args.bankTransaction || null;

  if (!paymentCode || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false, error: "Thiếu mã giao dịch hoặc số tiền hợp lệ." };
  }

  const mysqlResult = await confirmPaymentMysql(paymentCode, amount, note);
  if (mysqlResult) {
    if (!mysqlResult.ok) return mysqlResult;
    if (mysqlResult.alreadyCompleted) return mysqlResult;
    const result = {
      ...mysqlResult,
      deliveryJob: toDeliveryJob(mysqlResult.order),
    };
    if (!mysqlResult.alreadyPaid) {
      notifyBandoEvent("order_payment_confirmed", {
        order: mysqlResult.order,
        bankTransaction,
        note,
        source: bankTransaction ? "bank webhook" : (note || "bank"),
      });
    }
    return result;
  }

  const memoryResult = confirmPaymentMemory(paymentCode, amount, note);
  if (memoryResult.ok && !memoryResult.alreadyPaid && !memoryResult.alreadyCompleted) {
    notifyBandoEvent("order_payment_confirmed", {
      order: memoryResult.order,
      bankTransaction,
      note,
      source: bankTransaction ? "bank webhook" : (note || "bank"),
    });
  }
  return memoryResult;
}

export async function approveBandoOrder(args) {
  const orderCode = String(args.orderCode || "").trim().toUpperCase();
  const note = String(args.note || "").trim();

  if (!orderCode) {
    return { ok: false, error: "Thiếu mã đơn." };
  }

  const mysqlResult = await approveBandoOrderMysql(orderCode, note);
  if (mysqlResult) {
    if (!mysqlResult.ok) return mysqlResult;
    const result = {
      ...mysqlResult,
      deliveryJob: toDeliveryJob(mysqlResult.order),
    };
    if (!mysqlResult.alreadyPaid) {
      notifyBandoEvent("order_payment_confirmed", {
        order: mysqlResult.order,
        note,
        source: "telegram/admin",
      });
    }
    return result;
  }

  const memoryResult = approveOrderMemory(orderCode, note);
  if (memoryResult.ok && !memoryResult.alreadyPaid) {
    notifyBandoEvent("order_payment_confirmed", {
      order: memoryResult.order,
      note,
      source: "telegram/admin",
    });
  }
  return memoryResult;
}

export async function cancelBandoRecord(args) {
  const code = String(args.orderCode || args.paymentCode || args.code || "").trim().toUpperCase();
  const note = String(args.note || "").trim();
  if (!code) {
    return { ok: false, error: "Thieu ma don." };
  }

  const mysqlResult = await cancelBandoRecordMysql(code, note);
  if (mysqlResult) {
    if (mysqlResult.ok) {
      notifyBandoEvent("order_cancelled", {
        order: mysqlResult.order,
        coinTrade: mysqlResult.coinTrade,
        note,
      });
    }
    return mysqlResult;
  }

  const order = memoryState.orders.find((entry) => entry.orderCode === code || entry.paymentCode === code);
  if (order) {
    if (order.status === "completed") {
      return { ok: false, error: "Don nay da giao xong, khong the huy." };
    }
    if (order.status !== "cancelled") {
      order.status = "cancelled";
      memoryState.transactions.unshift({
        id: memoryTransactionId++,
        orderCode: order.orderCode,
        paymentCode: order.paymentCode,
        amount: order.totalAmount,
        status: "cancelled",
        note: note || "Admin huy don",
        createdAt: new Date().toISOString(),
      });
      const coinTrade = memoryState.coinTrades.find((entry) => entry.orderCode === order.orderCode);
      if (coinTrade) coinTrade.status = "cancelled";
      pushMemoryEvent(order.orderCode, "order_cancelled", note || `Admin huy don ${order.orderCode}.`);
    }
    const result = { ok: true, order: { ...order } };
    notifyBandoEvent("order_cancelled", { order: result.order, note });
    return result;
  }

  const trade = memoryState.coinTrades.find((entry) => entry.orderCode === code);
  if (!trade) return { ok: false, error: "Khong tim thay don hoac phieu xu." };
  if (trade.status === "payout_completed") {
    return { ok: false, error: "Phieu xu da duyet tra tien, khong the huy." };
  }
  if (trade.status !== "cancelled") {
    trade.status = "cancelled";
    pushMemoryEvent(trade.orderCode, "coin_trade_cancelled", note || `Admin huy phieu xu ${trade.orderCode}.`);
  }
  const result = { ok: true, coinTrade: { ...trade } };
  notifyBandoEvent("order_cancelled", { coinTrade: result.coinTrade, note });
  return result;
}

export async function approveCoinTradePayout(args) {
  const orderCode = String(args.orderCode || "").trim().toUpperCase();
  const note = String(args.note || "").trim();

  if (!orderCode) {
    return { ok: false, error: "Thiếu mã phiếu xu." };
  }

  const mysqlResult = await approveCoinTradePayoutMysql(orderCode, note);
  if (mysqlResult) {
    if (mysqlResult.ok) notifyBandoEvent("coin_payout_approved", { coinTrade: mysqlResult.coinTrade });
    return mysqlResult;
  }

  const trade = memoryState.coinTrades.find((entry) => entry.orderCode === orderCode);
  if (!trade) {
    return { ok: false, error: "Không tìm thấy phiếu xu." };
  }
  if (trade.type !== "sell_xu") {
    return { ok: false, error: "Chỉ duyệt trả tiền cho phiếu khách bán xu." };
  }
  if (trade.status !== "completed") {
    return { ok: false, error: "Chỉ duyệt trả tiền sau khi BOT đã nhận xu." };
  }
  if (!trade.bankName || !trade.accountNumber || !trade.accountName) {
    return { ok: false, error: "Khách chưa gửi đủ thông tin nhận tiền." };
  }

  trade.status = "payout_completed";
  trade.completedAt = trade.completedAt || new Date().toISOString();
  trade.payoutNotifiedAt = null;
  pushMemoryEvent(orderCode, "coin_payout_approved", note || `Admin duyệt trả ${formatVnd(trade.totalAmount)} cho ${trade.characterName}.`);
  const result = { ok: true, coinTrade: { ...trade } };
  notifyBandoEvent("coin_payout_approved", { coinTrade: result.coinTrade });
  return result;
}

export async function listPendingBandoDeliveries(args = {}) {
  const gameName = normalizeGameName(args.gameName);
  const serverName = normalizeServerName(args.serverName);
  const mysqlResult = await listPendingDeliveriesMysql({ gameName, serverName });
  if (mysqlResult) {
    const notifications = (await listPendingBotNotificationsMysql({ gameName, serverName })) ?? [];
    return {
      ok: true,
      deliveries: mysqlResult.map(toDeliveryJob),
      notifications,
      storage: "mysql",
    };
  }

  const itemsByCode = new Map(memoryState.items.map((item) => [item.code, item]));
  return {
    ok: true,
    deliveries: [
      ...memoryState.orders
      .filter((order) => order.status === "paid" && matchesGame(order.gameName, gameName) && matchesServer(order.serverName, serverName))
      .map((order) => toDeliveryJob({ ...order, itemId: itemsByCode.get(order.itemCode)?.itemId ?? itemIdFromCode(order.itemCode) })),
      ...memoryState.coinTrades
        .filter((trade) => trade.type === "sell_xu" && trade.status === "awaiting_trade" && matchesGame(trade.gameName, gameName) && matchesServer(trade.serverName, serverName))
        .map(toCoinReceiveDeliveryJob),
    ],
    notifications: memoryState.coinTrades
      .filter((trade) => trade.type === "sell_xu" && trade.status === "payout_completed" && !trade.payoutNotifiedAt && matchesGame(trade.gameName, gameName) && matchesServer(trade.serverName, serverName))
      .map(toPayoutCompletedNotification),
    storage: "memory",
  };
}

export async function confirmBandoBotNotification(args) {
  const orderCode = String(args.orderCode || "").trim().toUpperCase();
  const type = String(args.type || "").trim();
  if (!orderCode || !type) {
    return { ok: false, error: "Thiếu mã thông báo." };
  }

  const mysqlResult = await confirmBotNotificationMysql(orderCode, type);
  if (mysqlResult) return mysqlResult;

  const trade = memoryState.coinTrades.find((entry) => entry.orderCode === orderCode);
  if (!trade) return { ok: false, error: "Không tìm thấy thông báo." };
  if (type === "payout_completed") {
    trade.payoutNotifiedAt = new Date().toISOString();
    return { ok: true, coinTrade: { ...trade } };
  }
  return { ok: false, error: "Loại thông báo không hỗ trợ." };
}

export async function confirmBandoDelivery(args) {
  const orderCode = String(args.orderCode || "").trim().toUpperCase();
  const botName = String(args.botName || "NinjaBot").trim();
  const receivedCoinAmount = Math.max(0, Math.trunc(Number(args.receivedCoinAmount) || 0));

  if (!orderCode) {
    return { ok: false, error: "Thiếu mã đơn." };
  }

  const mysqlResult = await confirmDeliveryMysql(orderCode, botName, { receivedCoinAmount });
  if (mysqlResult) {
    if (mysqlResult.ok) notifyDeliveryEvent(mysqlResult);
    return mysqlResult;
  }

  const memoryResult = confirmDeliveryMemory(orderCode, botName, { receivedCoinAmount });
  if (memoryResult.ok) notifyDeliveryEvent(memoryResult);
  return memoryResult;
}

export async function updateBandoPrice(args) {
  const gameName = normalizeGameName(args.gameName);
  const serverName = normalizeServerName(args.serverName) || "default";
  const code = String(args.code || "").trim().toLowerCase();
  const itemId = args.itemId == null || Number.isNaN(Number(args.itemId)) ? null : Number(args.itemId);
  const name = String(args.name || code).trim() || code;
  const buyName = String(args.buyName || code).trim().toLowerCase() || code;
  const aliases = normalizeAliases(args.aliases, buyName, code);
  const unit = String(args.unit || "cái").trim();
  const sellPrice = Number(args.sellPrice);
  const stock = Number(args.stock);
  const active = args.active !== false;

  if (!code || !Number.isInteger(sellPrice) || sellPrice <= 0 || !Number.isInteger(stock) || stock < 0) {
    return { ok: false, error: "Thiếu mã item, đơn giá hoặc số lượng hợp lệ." };
  }

  const mysqlResult = await updateBandoItemMysql({
    code,
    gameName,
    serverName,
    itemId,
    name,
    buyName,
    aliases,
    unit,
    sellPrice,
    stock,
    active,
  });
  if (mysqlResult) return mysqlResult;

  const now = new Date().toISOString();
  const item = memoryState.items.find((entry) => entry.code === code);
  if (!item) {
    const newItem = {
      code,
      gameName,
      serverName,
      itemId,
      name,
      buyName,
      aliases,
      unit,
      sellPrice,
      stock,
      active,
      updatedAt: now,
    };
    memoryState.items.push(newItem);
    pushMemoryEvent(null, "price_updated", `Thêm ${name}: ${formatVnd(sellPrice)}, tồn ${stock}.`);
    return { ok: true, item: newItem };
  }

  item.itemId = itemId;
  item.gameName = gameName;
  item.serverName = serverName;
  item.name = name;
  item.buyName = buyName;
  item.aliases = aliases;
  item.unit = unit;
  item.sellPrice = sellPrice;
  item.stock = stock;
  item.active = active;
  item.updatedAt = now;
  pushMemoryEvent(null, "price_updated", `Cập nhật ${item.name}: ${formatVnd(sellPrice)}, tồn ${stock}.`);
  return { ok: true, item };
}

export async function upsertBandoBankAccount(args) {
  const bankAccount = normalizeBankAccount(args);
  if (!bankAccount.ok) return bankAccount;

  const mysqlResult = await upsertBandoBankAccountMysql(bankAccount);
  if (mysqlResult) return mysqlResult;

  const now = new Date().toISOString();
  if (bankAccount.active) {
    for (const account of memoryState.bankAccounts) account.active = false;
  }

  if (bankAccount.id) {
    const existing = memoryState.bankAccounts.find((account) => account.id === bankAccount.id);
    if (existing) {
      Object.assign(existing, {
        ...bankAccount,
        updatedAt: now,
      });
      pushMemoryEvent(null, "bank_account_updated", `Cập nhật tài khoản nhận tiền ${bankAccount.bankName}.`);
      return { ok: true, bankAccount: { ...existing } };
    }
  }

  const nextAccount = {
    id: memoryBankAccountId++,
    bankName: bankAccount.bankName,
    bankCode: bankAccount.bankCode,
    accountNumber: bankAccount.accountNumber,
    accountName: bankAccount.accountName,
    paymentPrefix: bankAccount.paymentPrefix,
    callbackSignature: bankAccount.callbackSignature,
    active: bankAccount.active,
    createdAt: now,
    updatedAt: now,
  };
  memoryState.bankAccounts.unshift(nextAccount);
  pushMemoryEvent(null, "bank_account_updated", `Thêm tài khoản nhận tiền ${bankAccount.bankName}.`);
  return { ok: true, bankAccount: { ...nextAccount } };
}

export async function deleteBandoBankAccount(id) {
  const mysqlResult = await deleteBandoBankAccountMysql(id);
  if (mysqlResult) return mysqlResult;

  const accountId = Number(id);
  if (!Number.isInteger(accountId) || accountId <= 0) {
    return { ok: false, error: "Thiếu ID tài khoản nhận tiền." };
  }

  const before = memoryState.bankAccounts.length;
  memoryState.bankAccounts = memoryState.bankAccounts.filter((account) => account.id !== accountId);
  if (memoryState.bankAccounts.length === before) {
    return { ok: false, error: "Không tìm thấy tài khoản nhận tiền." };
  }
  pushMemoryEvent(null, "bank_account_deleted", `Xóa tài khoản nhận tiền #${accountId}.`);
  return { ok: true, id: accountId };
}

export async function listBandoGameServers() {
  const mysqlResult = await listBandoGameServersMysql();
  if (mysqlResult) return mysqlResult;
  return {
    ok: true,
    gameServers: memoryState.gameServers.map((server) => ({ ...server })),
    storage: "memory",
  };
}

export async function upsertBandoGameServer(args) {
  const normalized = normalizeGameServer(args);
  if (!normalized.ok) return normalized;

  const mysqlResult = await upsertBandoGameServerMysql(normalized.gameServer);
  if (mysqlResult) return mysqlResult;

  const now = new Date().toISOString();
  const existing = normalized.gameServer.id
    ? memoryState.gameServers.find((server) => server.id === normalized.gameServer.id)
    : null;
  if (normalized.gameServer.isDefault) {
    for (const server of memoryState.gameServers) {
      if (matchesGame(server.gameName, normalized.gameServer.gameName)) server.isDefault = false;
    }
  }
  if (existing) {
    Object.assign(existing, normalized.gameServer, { updatedAt: now });
    return { ok: true, gameServer: { ...existing }, storage: "memory" };
  }

  const gameServer = {
    ...normalized.gameServer,
    id: memoryGameServerId++,
    createdAt: now,
    updatedAt: now,
  };
  memoryState.gameServers.push(gameServer);
  return { ok: true, gameServer: { ...gameServer }, storage: "memory" };
}

export async function deleteBandoGameServer(id) {
  const mysqlResult = await deleteBandoGameServerMysql(id);
  if (mysqlResult) return mysqlResult;

  const serverId = Number(id);
  if (!Number.isInteger(serverId) || serverId <= 0) return { ok: false, error: "Thieu ID server." };
  const before = memoryState.gameServers.length;
  memoryState.gameServers = memoryState.gameServers.filter((server) => server.id !== serverId);
  if (before === memoryState.gameServers.length) return { ok: false, error: "Khong tim thay server." };
  return { ok: true, id: serverId, storage: "memory" };
}

export async function importBandoItemsFromServer(args = {}) {
  const result = await importServerItemsMysql({
    gameName: args.gameName,
    serverName: args.serverName,
  });
  if (!result) {
    return {
      ok: false,
      error: "Không kết nối được MySQL local. Hãy bật MySQL và kiểm tra mysql.properties của nso-server.",
    };
  }
  return result;
}

export async function updateBandoInventory(args) {
  const source = await validateInventorySource(args);
  if (!source.ok) return source;

  const mysqlResult = await updateBandoInventoryMysql({
    ...args,
    gameName: source.gameName,
    characterName: source.characterName,
    serverName: source.serverName,
  });
  if (mysqlResult) return mysqlResult;

  const inventory = normalizeInventory(args.inventory);
  const gameName = source.gameName;
  const serverName = source.serverName;
  const characterName = source.characterName;
  const now = new Date().toISOString();
  const prefix = memoryInventoryPrefix(gameName, serverName, characterName);
  for (const key of memoryInventoryByItemId.keys()) {
    if (key.startsWith(prefix)) {
      memoryInventoryByItemId.delete(key);
    }
  }
  for (const item of inventory) {
    memoryInventoryByItemId.set(memoryInventoryKey(gameName, serverName, characterName, item.itemId), {
      quantity: item.quantity,
      updatedAt: now,
    });
  }
  return { ok: true, count: inventory.length, updatedAt: now };
}

function cloneMemoryState() {
  return {
    items: memoryState.items.map((item) => ({ ...item, aliases: [...item.aliases] })),
    orders: memoryState.orders.map((order) => ({ ...order })),
    coinTrades: memoryState.coinTrades.map((trade) => ({ ...trade })),
    transactions: memoryState.transactions.map((transaction) => ({ ...transaction })),
    bankAccounts: memoryState.bankAccounts.map((account) => ({ ...account })),
    gameServers: memoryState.gameServers.map((server) => ({ ...server })),
    events: memoryState.events.map((event) => ({ ...event })),
    storage: "memory",
  };
}

function buildRevenueStatsFromMemory(fromIso, toIso) {
  const sell = {
    totalOrders: 0,
    totalAmount: 0,
    coinOrders: 0,
    coinAmount: 0,
    itemOrders: 0,
    itemAmount: 0,
  };
  const buy = {
    totalOrders: 0,
    totalAmount: 0,
    coinOrders: 0,
    coinAmount: 0,
  };

  for (const order of memoryState.orders) {
    if (!["paid", "completed"].includes(order.status)) continue;
    if (!isIsoInRange(order.paidAt || order.createdAt, fromIso, toIso)) continue;

    const amount = Math.max(0, Math.trunc(Number(order.totalAmount) || 0));
    sell.totalOrders += 1;
    sell.totalAmount += amount;
    if (order.itemCode === COIN_ITEM_CODE) {
      sell.coinOrders += 1;
      sell.coinAmount += amount;
    } else {
      sell.itemOrders += 1;
      sell.itemAmount += amount;
    }
  }

  for (const trade of memoryState.coinTrades) {
    if (trade.type !== "sell_xu") continue;
    if (!["awaiting_payout_info", "completed", "payout_completed"].includes(trade.status)) continue;
    if (!isIsoInRange(trade.completedAt || trade.paidAt || trade.createdAt, fromIso, toIso)) continue;

    const amount = Math.max(0, Math.trunc(Number(trade.totalAmount) || 0));
    buy.totalOrders += 1;
    buy.totalAmount += amount;
    buy.coinOrders += 1;
    buy.coinAmount += amount;
  }

  return {
    ok: true,
    fromIso,
    toIso,
    sell,
    buy,
    netAmount: sell.totalAmount - buy.totalAmount,
    storage: "memory",
  };
}

function isIsoInRange(value, fromIso, toIso) {
  const text = String(value || "");
  return text >= fromIso && text < toIso;
}

function filterMemoryStateByServer(state, gameName, serverName) {
  if (!gameName && !serverName) return state;
  const gameItems = state.items.filter((item) => matchesGame(item.gameName, gameName));
  const scopedItems = serverName ? gameItems.filter((item) => matchesServer(item.serverName, serverName)) : gameItems;
  const legacyItems = serverName
    ? gameItems.filter((item) => !normalizeServerName(item.serverName) || matchesServer(item.serverName, "default"))
    : gameItems;
  return {
    ...state,
    items: serverName && scopedItems.length > 0 ? scopedItems : legacyItems,
    orders: state.orders.filter((order) => matchesGame(order.gameName, gameName) && matchesServer(order.serverName, serverName)),
    coinTrades: state.coinTrades.filter((trade) => matchesGame(trade.gameName, gameName) && matchesServer(trade.serverName, serverName)),
  };
}

async function hasAdminUsers() {
  const mysqlResult = await countBandoAdminUsersMysql();
  if (mysqlResult) return mysqlResult.count > 0;
  return memoryState.adminUsers.length > 0;
}

function publicAdminUser(user) {
  if (!user) return null;
  return {
    id: Number(user.id) || 0,
    username: String(user.username || ""),
    role: String(user.role || "admin"),
  };
}

function normalizeUsername(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_.-]/g, "")
    .slice(0, 64);
}

function normalizeGameServer(args = {}) {
  const id = Number(args.id);
  const gameName = normalizeGameName(args.gameName);
  const name = normalizeServerName(args.name);
  const code = String(args.code || name).trim();
  const status = normalizeGameServerStatus(args.status);
  const dbHost = String(args.dbHost || "").trim();
  const dbPort = Math.max(1, Math.trunc(Number(args.dbPort) || 3306));
  const dbUser = String(args.dbUser || "").trim();
  const dbPassword = String(args.dbPassword ?? "").trim();
  const dbGameDatabase = String(args.dbGameDatabase || "").trim();
  const dbPlayerDatabase = String(args.dbPlayerDatabase || "").trim();

  if (!name || !code || !dbHost || !dbUser || !dbGameDatabase || !dbPlayerDatabase) {
    return { ok: false, error: "Thieu ten server, ma server hoac thong tin DB game/player." };
  }

  return {
    ok: true,
    gameServer: {
      id: Number.isInteger(id) && id > 0 ? id : null,
      gameName,
      name,
      code,
      status,
      dbHost,
      dbPort,
      dbUser,
      dbPassword,
      dbGameDatabase,
      dbPlayerDatabase,
      socketHost: String(args.socketHost || "").trim(),
      socketPort: Math.max(1, Math.trunc(Number(args.socketPort) || 5900)),
      socketKey: String(args.socketKey || "").trim(),
      socketPortWeb: String(args.socketPortWeb ?? "").trim(),
      socketKeyWeb: String(args.socketKeyWeb ?? "").trim(),
      isDefault: Boolean(args.isDefault),
      displayOrder: Math.trunc(Number(args.displayOrder) || 0),
      dayOpen: String(args.dayOpen ?? "").trim(),
    },
  };
}

function normalizeGameServerStatus(value) {
  const status = String(value || "offline").trim().toLowerCase();
  return ["online", "offline", "maintenance", "new"].includes(status) ? status : "offline";
}

function normalizeGameName(value) {
  return String(value || DEFAULT_GAME_NAME).trim() || DEFAULT_GAME_NAME;
}

function normalizeServerName(value) {
  return String(value || "").trim();
}

function matchesGame(value, expectedGameName) {
  if (!expectedGameName) return true;
  return normalizeGameName(value).toLowerCase() === normalizeGameName(expectedGameName).toLowerCase();
}

function matchesServer(value, expectedServerName) {
  if (!expectedServerName) return true;
  return String(value || "").trim().toLowerCase() === expectedServerName.toLowerCase();
}

function findBotServerProfile(config, gameName, serverName, characterName = "") {
  const profiles = Array.isArray(config?.serverProfiles) ? config.serverProfiles : [];
  const gameKey = normalizeGameName(gameName).toLowerCase();
  const serverKey = normalizeServerName(serverName).toLowerCase();
  if (serverKey) {
    return profiles.find((profile) =>
      normalizeGameName(profile.gameName).toLowerCase() === gameKey &&
      normalizeServerName(profile.serverName).toLowerCase() === serverKey
    ) || null;
  }

  const characterKey = String(characterName || "").trim().toLowerCase();
  if (characterKey) {
    return profiles.find((profile) =>
      normalizeGameName(profile.gameName).toLowerCase() === gameKey &&
      String(profile.characterName || "").trim().toLowerCase() === characterKey
    ) || null;
  }

  return null;
}

function selectBotConfigForServer(config, gameName, serverName) {
  return findBotServerProfile(config, gameName, serverName) || config;
}

async function resolveInventoryCharacterName(gameName = DEFAULT_GAME_NAME, serverName = "") {
  const normalizedServerName = normalizeServerName(serverName);
  if (!normalizedServerName) return "";

  const result = await getBandoBotConfig();
  const config = result.config;
  const characterName = configuredCharacterForServer(config, gameName, normalizedServerName);
  if (characterName) return characterName;

  return hasConfiguredServerProfiles(config) ? "__bando_no_configured_bot__" : "";
}

async function validateInventorySource(args) {
  const gameName = normalizeGameName(args.gameName);
  const serverName = normalizeServerName(args.serverName) || "default";
  const characterName = String(args.characterName || "BOT").trim() || "BOT";
  const result = await getBandoBotConfig();
  const config = result.config;
  const profile = findBotServerProfile(config, gameName, serverName);

  if (profile) {
    const expectedName = String(profile.characterName || "").trim();
    if (!profile.enabled) return { ok: false, error: `BOT server '${profile.serverName}' đang tắt trên web.` };
    if (!expectedName) return { ok: false, error: `Server '${profile.serverName}' chưa nhập tên nhân vật BOT.` };
    if (expectedName.toLowerCase() !== characterName.toLowerCase()) {
      return {
        ok: false,
        error: `Sai nhân vật BOT. Server '${profile.serverName}' đang cấu hình '${expectedName}', game hiện tại là '${characterName}'.`,
      };
    }
    return { ok: true, gameName: profile.gameName || gameName, serverName: profile.serverName || serverName, characterName: expectedName };
  }

  if (hasConfiguredServerProfiles(config)) {
    return { ok: false, error: `Chưa cấu hình game '${gameName}' / server '${serverName}' trên web.` };
  }

  return { ok: true, gameName, serverName, characterName };
}

function hasConfiguredServerProfiles(config) {
  return Array.isArray(config?.serverProfiles) && config.serverProfiles.length > 0;
}

function configuredCharacterForServer(config, gameName, serverName) {
  const profile = findBotServerProfile(config, gameName, serverName);
  if (profile) return String(profile.characterName || "").trim();
  if (matchesGame(config?.gameName, gameName) && matchesServer(config?.serverName, serverName)) return String(config.characterName || "").trim();
  return "";
}

function applyMemoryInventory(state, gameName = DEFAULT_GAME_NAME, serverName = "", characterName = "") {
  state.items = state.items.map((item) => {
    if (item.itemId == null) return item;
    const liveStock = getMemoryLiveStock(gameName, serverName, characterName, item.itemId);
    if (!liveStock) {
      return {
        ...item,
        stock: 0,
        stockSource: "inventory",
        stockUpdatedAt: null,
      };
    }
    return {
      ...item,
      stock: liveStock.quantity,
      stockSource: "inventory",
      stockUpdatedAt: liveStock.updatedAt,
    };
  });
  return state;
}

function getMemoryLiveStock(gameName, serverName, characterName, itemId) {
  const normalizedGameName = normalizeGameName(gameName);
  const normalizedServerName = normalizeServerName(serverName);
  const normalizedCharacterName = String(characterName || "").trim();
  if (normalizedGameName && normalizedServerName && normalizedCharacterName) {
    return memoryInventoryByItemId.get(memoryInventoryKey(normalizedGameName, normalizedServerName, normalizedCharacterName, itemId)) || null;
  }

  let quantity = 0;
  let updatedAt = null;
  let found = false;
  const gamePrefix = normalizedGameName ? `${normalizedGameName.toLowerCase()}|` : "";
  const serverPart = normalizedServerName ? `|${normalizedServerName.toLowerCase()}|` : "";
  const characterPart = normalizedCharacterName ? `|${normalizedCharacterName.toLowerCase()}|` : "";
  const suffix = `|${itemId}`;
  for (const [key, value] of memoryInventoryByItemId.entries()) {
    if (gamePrefix && !key.startsWith(gamePrefix)) continue;
    if (serverPart && !key.includes(serverPart)) continue;
    if (characterPart && !key.includes(characterPart)) continue;
    if (!key.endsWith(suffix)) continue;
    found = true;
    quantity += Number(value.quantity) || 0;
    if (!updatedAt || String(value.updatedAt || "") > updatedAt) updatedAt = value.updatedAt;
  }
  return found ? { quantity, updatedAt } : null;
}

function memoryInventoryPrefix(gameName, serverName, characterName) {
  return `${normalizeGameName(gameName).toLowerCase()}|${(normalizeServerName(serverName) || "default").toLowerCase()}|${String(characterName || "BOT").trim().toLowerCase()}|`;
}

function memoryInventoryKey(gameName, serverName, characterName, itemId) {
  return `${memoryInventoryPrefix(gameName, serverName, characterName)}${itemId}`;
}

function confirmPaymentMemory(paymentCode, amount, note) {
  const order = memoryState.orders.find((entry) => entry.paymentCode === paymentCode);
  if (!order) {
    memoryState.transactions.unshift({
      id: memoryTransactionId++,
      orderCode: null,
      paymentCode,
      amount,
      status: "rejected",
      note: note || "Không tìm thấy mã giao dịch",
      createdAt: new Date().toISOString(),
    });
    return { ok: false, error: "Không tìm thấy mã giao dịch." };
  }

  if (order.status === "completed") {
    if (order.totalAmount === amount) {
      return { ok: true, order: { ...order }, alreadyCompleted: true };
    }
    return { ok: false, error: "Đơn này đã hoàn tất." };
  }

  if (order.status === "paid" && order.totalAmount === amount) {
    return { ok: true, order: { ...order }, deliveryJob: toDeliveryJob(order), alreadyPaid: true };
  }

  if (order.totalAmount !== amount) {
    memoryState.transactions.unshift({
      id: memoryTransactionId++,
      orderCode: order.orderCode,
      paymentCode,
      amount,
      status: "rejected",
      note: note || "Sai số tiền",
      createdAt: new Date().toISOString(),
    });
    pushMemoryEvent(order.orderCode, "payment_rejected", `Sai số tiền: nhận ${formatVnd(amount)}, cần ${formatVnd(order.totalAmount)}.`);
    return { ok: false, error: `Sai số tiền. Cần thanh toán ${formatVnd(order.totalAmount)}.` };
  }

  order.status = "paid";
  order.paidAt = new Date().toISOString();
  const coinTrade = memoryState.coinTrades.find((entry) => entry.orderCode === order.orderCode);
  if (coinTrade) {
    coinTrade.status = "paid";
    coinTrade.paidAt = order.paidAt;
  }
  memoryState.transactions.unshift({
    id: memoryTransactionId++,
    orderCode: order.orderCode,
    paymentCode,
    amount,
    status: "matched",
    note: note || "Đã khớp thanh toán",
    createdAt: new Date().toISOString(),
  });
  pushMemoryEvent(order.orderCode, "payment_matched", `Đã nhận đúng ${formatVnd(amount)}.`);
  return { ok: true, order: { ...order }, deliveryJob: toDeliveryJob(order) };
}

function approveOrderMemory(orderCode, note) {
  const order = memoryState.orders.find((entry) => entry.orderCode === orderCode);
  if (!order) {
    return { ok: false, error: "Không tìm thấy đơn." };
  }
  if (order.status === "completed") {
    return { ok: false, error: "Đơn này đã giao xong." };
  }
  if (order.status === "paid") {
    return { ok: true, order: { ...order }, deliveryJob: toDeliveryJob(order), alreadyPaid: true };
  }
  if (order.status !== "paid") {
    order.status = "paid";
    order.paidAt = new Date().toISOString();
    const coinTrade = memoryState.coinTrades.find((entry) => entry.orderCode === order.orderCode);
    if (coinTrade) {
      coinTrade.status = "paid";
      coinTrade.paidAt = order.paidAt;
    }
    memoryState.transactions.unshift({
      id: memoryTransactionId++,
      orderCode: order.orderCode,
      paymentCode: order.paymentCode,
      amount: order.totalAmount,
      status: "manual_approved",
      note: note || "Admin duyệt thanh toán thủ công",
      createdAt: new Date().toISOString(),
    });
    pushMemoryEvent(order.orderCode, "payment_manual_approved", `Admin duyệt tay đơn ${order.orderCode}.`);
  }
  return { ok: true, order: { ...order }, deliveryJob: toDeliveryJob(order) };
}

function confirmDeliveryMemory(orderCode, botName, extra = {}) {
  const order = memoryState.orders.find((entry) => entry.orderCode === orderCode);
  if (!order) return confirmCoinReceiveMemory(orderCode, botName, extra);
  if (!order) {
    return { ok: false, error: "Không tìm thấy đơn." };
  }

  if (order.status !== "paid") {
    return { ok: false, error: "Chỉ giao hàng khi đơn đã thanh toán đúng." };
  }

  const item = memoryState.items.find((entry) => entry.code === order.itemCode);
  if (item && order.itemCode !== COIN_ITEM_CODE) {
    item.stock = Math.max(item.stock - order.quantity, 0);
    item.updatedAt = new Date().toISOString();
  }

  order.status = "completed";
  order.deliveredAt = new Date().toISOString();
  const coinTrade = memoryState.coinTrades.find((entry) => entry.orderCode === order.orderCode);
  if (coinTrade) {
    coinTrade.status = "completed";
    coinTrade.completedAt = order.deliveredAt;
  }
  pushMemoryEvent(orderCode, "delivery_completed", `${botName} đã giao ${order.quantity} ${order.itemName}.`);
  return { ok: true, order: { ...order } };
}

function confirmCoinReceiveMemory(orderCode, botName, extra = {}) {
  const trade = memoryState.coinTrades.find((entry) => entry.orderCode === orderCode);
  if (!trade) {
    return { ok: false, error: "Không tìm thấy đơn." };
  }
  if (trade.type !== "sell_xu" || trade.status !== "awaiting_trade") {
    return { ok: false, error: "Phiếu bán xu không ở trạng thái chờ giao dịch." };
  }
  const receivedCoinAmount = Math.max(0, Math.trunc(Number(extra.receivedCoinAmount) || 0));
  if (receivedCoinAmount < trade.coinAmount) {
    return { ok: false, error: `BOT mới nhận ${receivedCoinAmount} xu, chưa đủ ${trade.coinAmount} xu.` };
  }
  trade.status = "awaiting_payout_info";
  trade.receivedCoinAmount = receivedCoinAmount;
  trade.completedAt = new Date().toISOString();
  pushMemoryEvent(orderCode, "coin_sell_completed", `${botName} đã nhận ${receivedCoinAmount} xu từ ${trade.characterName}.`);
  return { ok: true, coinTrade: { ...trade }, reply: buildCoinSellCompletedReply(trade) };
}

function pushMemoryEvent(orderCode, type, message) {
  if (type === "inventory_synced") return;

  memoryState.events.unshift({
    id: memoryEventId++,
    orderCode,
    type,
    message,
    createdAt: new Date().toISOString(),
  });
  if (memoryState.events.length > memoryEventLimit) {
    memoryState.events.length = memoryEventLimit;
  }
}

function toDeliveryJob(order) {
  if (order.type === "receive_coin") return order;
  if (order.itemCode === COIN_ITEM_CODE) {
    return {
      type: "deliver_coin",
      orderCode: order.orderCode,
      paymentCode: order.paymentCode,
      characterName: order.characterName,
      gameName: order.gameName || DEFAULT_GAME_NAME,
      serverName: order.serverName,
      itemCode: order.itemCode,
      itemId: -1,
      itemName: COIN_ITEM_NAME,
      quantity: order.quantity,
      coinAmount: order.quantity,
      totalAmount: order.totalAmount,
    };
  }

  const memoryItem = memoryState.items.find((item) => item.code === order.itemCode);
  const itemId = Number.isInteger(order.itemId) && order.itemId >= 0
    ? order.itemId
    : (memoryItem?.itemId ?? itemIdFromCode(order.itemCode));
  return {
    type: "deliver_item",
    orderCode: order.orderCode,
    paymentCode: order.paymentCode,
    characterName: order.characterName,
    gameName: order.gameName || DEFAULT_GAME_NAME,
    serverName: order.serverName,
    itemCode: order.itemCode,
    itemId,
    itemName: order.itemName,
    quantity: order.quantity,
  };
}

function toCoinReceiveDeliveryJob(trade) {
  return {
    type: "receive_coin",
    orderCode: trade.orderCode,
    paymentCode: trade.paymentCode || "",
    characterName: trade.characterName,
    gameName: trade.gameName || DEFAULT_GAME_NAME,
    serverName: trade.serverName,
    itemCode: COIN_ITEM_CODE,
    itemId: -1,
    itemName: COIN_ITEM_NAME,
    quantity: trade.coinAmount,
    coinAmount: trade.coinAmount,
    totalAmount: trade.totalAmount,
    rate: trade.rate,
  };
}

function toPayoutCompletedNotification(trade) {
  return {
    type: "payout_completed",
    orderCode: trade.orderCode,
    characterName: trade.characterName,
    gameName: trade.gameName || DEFAULT_GAME_NAME,
    serverName: trade.serverName,
    message: `Da thanh toan so tien ${formatVnd(trade.totalAmount)} cho don ${trade.orderCode}.`,
  };
}

function itemIdFromCode(code) {
  const match = String(code ?? "").match(/^item-(\d+)$/);
  return match ? Number(match[1]) : -1;
}

function normalizeBotCoinAmount(value) {
  const coinAmount = Number(value);
  if (!Number.isFinite(coinAmount) || coinAmount < 0) return 0;
  return Math.trunc(coinAmount);
}

function createCoinTradeCode(existingTrades = [], prefix = "SX") {
  const used = new Set(existingTrades.map((trade) => String(trade.orderCode || "").toUpperCase()));
  for (let i = 0; i < 30; i++) {
    const timePart = (Date.now() % 46656).toString(36).toUpperCase().padStart(3, "0");
    const randomPart = Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, "0");
    const code = `${prefix}${timePart}${randomPart}`;
    if (!used.has(code)) return code;
  }

  return `${prefix}${Math.floor(Math.random() * 1679616).toString(36).toUpperCase().padStart(4, "0")}`;
}

function normalizeAliases(value, buyName, code) {
  return Array.from(
    new Set([buyName, code, ...(Array.isArray(value) ? value : [])].map((alias) => String(alias).trim().toLowerCase()).filter(Boolean)),
  );
}

function normalizeInventory(inventory) {
  const counts = new Map();
  if (!Array.isArray(inventory)) return [];

  for (const entry of inventory) {
    const itemId = Number(entry.itemId);
    const quantity = Number(entry.quantity);
    if (!Number.isInteger(itemId) || itemId < 0 || !Number.isFinite(quantity) || quantity <= 0) continue;
    const current = counts.get(itemId) || {
      itemId,
      name: String(entry.name || "").trim(),
      quantity: 0,
    };
    if (!current.name && entry.name) current.name = String(entry.name).trim();
    current.quantity += Math.trunc(quantity);
    counts.set(itemId, current);
  }

  return Array.from(counts.values());
}

function normalizeBankAccount(args) {
  const id = Number(args.id);
  const bankName = String(args.bankName || "").trim();
  const bankCode = String(args.bankCode || "").trim().toUpperCase();
  const accountNumber = String(args.accountNumber || "").trim();
  const accountName = String(args.accountName || "").trim();
  const paymentPrefix = normalizePaymentPrefix(args.paymentPrefix);
  const callbackSignature = String(args.callbackSignature || "").trim();

  if (!bankName || !accountNumber || !accountName) {
    return { ok: false, error: "Thiếu ngân hàng, số tài khoản hoặc chủ tài khoản." };
  }

  return {
    ok: true,
    id: Number.isInteger(id) && id > 0 ? id : null,
    bankName,
    bankCode,
    accountNumber,
    accountName,
    paymentPrefix,
    callbackSignature,
    active: args.active !== false,
  };
}

function selectPaymentBankAccount(bankAccounts) {
  if (!Array.isArray(bankAccounts) || bankAccounts.length === 0) return null;
  return bankAccounts.find((account) => account.active) || bankAccounts[0];
}

function createOrderCode(existingOrders = []) {
  const used = new Set(
    existingOrders.flatMap((order) => [
      String(order.orderCode || "").toUpperCase(),
      String(order.paymentCode || "").toUpperCase(),
    ]),
  );
  for (let i = 0; i < 30; i++) {
    const timePart = (Date.now() % 46656).toString(36).toUpperCase().padStart(3, "0");
    const randomPart = Math.floor(Math.random() * 1296).toString(36).toUpperCase().padStart(2, "0");
    const code = `BD${timePart}${randomPart}`;
    if (!used.has(code)) return code;
  }

  return `BD${Math.floor(Math.random() * 1679616).toString(36).toUpperCase().padStart(4, "0")}`;
}

function normalizePaymentPrefix(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

function createDefaultBotConfig() {
  return {
    enabled: true,
    characterName: "ADMIN",
    webBaseUrl: "http://localhost:5001",
    botToken: "",
    gameName: DEFAULT_GAME_NAME,
    serverName: "nso-local",
    custom: false,
    replyPrivate: true,
    inventorySyncMs: 15000,
    adminNames: [],
    stand: {
      enabled: false,
      mapId: -1,
      zoneId: -1,
      x: 300,
      y: 336,
      tolerance: 12,
      intervalMs: 1500,
    },
    autoChat: {
      enabled: false,
      text: "Bán đồ tự động, chat riêng 'xem' để xem hàng.",
      intervalMs: 60000,
      community: true,
      communityText: "Bán đồ tự động, chat riêng 'xem' để xem hàng.",
      communityIntervalMs: 60000,
      world: false,
      worldText: "Bán đồ tự động, chat riêng 'xem' để xem hàng.",
      worldIntervalMs: 60000,
    },
    coinTrade: {
      sell: {
        enabled: true,
        rate: 2.6,
      },
      importXu: {
        enabled: true,
        rate: 2.6,
      },
    },
    serverProfiles: [],
  };
}

function mergeBotConfig(base, patch) {
  const nextPatch = patch && typeof patch === "object" ? patch : {};
  return {
    ...base,
    ...nextPatch,
    stand: {
      ...(base?.stand ?? {}),
      ...(nextPatch.stand ?? {}),
    },
    autoChat: {
      ...(base?.autoChat ?? {}),
      ...(nextPatch.autoChat ?? {}),
    },
    coinTrade: {
      ...(base?.coinTrade ?? {}),
      ...(nextPatch.coinTrade ?? {}),
      sell: {
        ...(base?.coinTrade?.sell ?? {}),
        ...(nextPatch.coinTrade?.sell ?? {}),
      },
      importXu: {
        ...(base?.coinTrade?.importXu ?? {}),
        ...(nextPatch.coinTrade?.importXu ?? {}),
      },
    },
    serverProfiles: Array.isArray(nextPatch.serverProfiles)
      ? nextPatch.serverProfiles
      : Array.isArray(base?.serverProfiles)
        ? base.serverProfiles
        : [],
  };
}

function normalizeBotConfig(value) {
  const defaults = createDefaultBotConfig();
  const source = mergeBotConfig(defaults, value);
  const normalized = {
    enabled: source.enabled !== false,
    characterName: String(source.characterName || "").trim(),
    webBaseUrl: String(source.webBaseUrl || defaults.webBaseUrl).trim() || defaults.webBaseUrl,
    botToken: String(source.botToken || "").trim(),
    gameName: normalizeGameName(source.gameName || defaults.gameName),
    serverName: String(source.serverName || defaults.serverName).trim() || defaults.serverName,
    custom: Boolean(source.custom),
    replyPrivate: source.replyPrivate !== false,
    inventorySyncMs: clampInteger(source.inventorySyncMs, 5000, 3600000, defaults.inventorySyncMs),
    adminNames: normalizeStringArray(source.adminNames),
    stand: {
      enabled: Boolean(source.stand?.enabled),
      mapId: clampInteger(source.stand?.mapId, -1, 9999, defaults.stand.mapId),
      zoneId: clampInteger(source.stand?.zoneId, -1, 999, defaults.stand.zoneId),
      x: clampInteger(source.stand?.x, 0, 9999, defaults.stand.x),
      y: clampInteger(source.stand?.y, 0, 9999, defaults.stand.y),
      tolerance: clampInteger(source.stand?.tolerance, 0, 999, defaults.stand.tolerance),
      intervalMs: clampInteger(source.stand?.intervalMs, 200, 60000, defaults.stand.intervalMs),
    },
    autoChat: {
      enabled: Boolean(source.autoChat?.enabled),
      text: String(source.autoChat?.text || defaults.autoChat.text).trim() || defaults.autoChat.text,
      intervalMs: clampInteger(source.autoChat?.intervalMs, 5000, 3600000, defaults.autoChat.intervalMs),
      community: source.autoChat?.community !== false,
      communityText: String(source.autoChat?.communityText || source.autoChat?.text || defaults.autoChat.communityText).trim() || defaults.autoChat.communityText,
      communityIntervalMs: clampInteger(source.autoChat?.communityIntervalMs ?? source.autoChat?.intervalMs, 5000, 3600000, defaults.autoChat.communityIntervalMs),
      world: Boolean(source.autoChat?.world),
      worldText: String(source.autoChat?.worldText || source.autoChat?.text || defaults.autoChat.worldText).trim() || defaults.autoChat.worldText,
      worldIntervalMs: clampInteger(source.autoChat?.worldIntervalMs ?? source.autoChat?.intervalMs, 5000, 3600000, defaults.autoChat.worldIntervalMs),
    },
    coinTrade: {
      sell: {
        enabled: source.coinTrade?.sell?.enabled !== false,
        rate: clampNumber(source.coinTrade?.sell?.rate, 0.01, 1000, defaults.coinTrade.sell.rate),
      },
      importXu: {
        enabled: source.coinTrade?.importXu?.enabled !== false,
        rate: clampNumber(source.coinTrade?.importXu?.rate, 0.01, 1000, defaults.coinTrade.importXu.rate),
      },
    },
    serverProfiles: [],
  };
  normalized.serverProfiles = normalizeServerProfiles(source.serverProfiles, normalized);
  return normalized;
}

function cloneBotConfig(config) {
  return normalizeBotConfig(JSON.parse(JSON.stringify(config)));
}

function normalizeServerProfiles(value, parentConfig) {
  if (!Array.isArray(value)) return [];
  const seen = new Set();
  const profiles = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const profile = normalizeBotConfig(mergeBotConfig(parentConfig, { ...entry, serverProfiles: [] }));
    const serverKey = `${profile.gameName.toLowerCase()}|${profile.serverName.toLowerCase()}`;
    if (!serverKey || seen.has(serverKey)) continue;
    seen.add(serverKey);
    profiles.push({ ...profile, serverProfiles: [] });
  }
  return profiles;
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(/[;,|]/).map((entry) => entry.trim()).filter(Boolean);
  }
  return [];
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  const integer = Math.trunc(parsed);
  if (integer < min) return min;
  if (integer > max) return max;
  return integer;
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  if (parsed < min) return min;
  if (parsed > max) return max;
  return parsed;
}
