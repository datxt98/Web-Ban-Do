import { readFile } from "node:fs/promises";
import mysql from "mysql2/promise";
import { COIN_ITEM_CODE, COIN_ITEM_NAME, buildCoinSellCompletedReply, formatVnd } from "./bando-command.js";

const MYSQL_DISABLED_MS = 10_000;
const EVENT_PRUNE_INTERVAL_MS = 60_000;
const NOISY_EVENT_TYPES = new Set(["inventory_synced"]);
const DEFAULT_GAME_NAME = "Ninja Mobile";
const NINJA_2D_GAME_NAME = "Ninja 2D";
let mysqlDisabledUntil = 0;
let lastEventPruneAt = 0;
const itemSyncCache = new Map();

export async function listBandoStateMysql(args = {}) {
  return withBandoConnection(async (conn) => {
    const gameName = normalizeGameName(args.gameName);
    const serverName = String(args.serverName || "").trim();
    const characterName = String(args.characterName || "").trim();
    const itemSync = serverName ? await syncItemsFromConfiguredServer(conn, gameName, serverName, { force: args.forceItemSync }) : null;
    const itemRows = await listItemsForServer(conn, gameName, serverName);
    const [orderRows] = await conn.query(
      `SELECT * FROM bando_orders
       WHERE game_name = ? AND (? = '' OR server_name = ?)
       ORDER BY id DESC LIMIT 60`,
      [gameName, serverName, serverName],
    );
    const [coinTradeRows] = await conn.query(
      `SELECT * FROM bando_coin_trades
       WHERE game_name = ? AND (? = '' OR server_name = ?)
       ORDER BY id DESC LIMIT 100`,
      [gameName, serverName, serverName],
    );
    const [transactionRows] = await conn.query("SELECT * FROM bando_transactions ORDER BY id DESC LIMIT 60");
    const [eventRows] = await conn.query("SELECT * FROM bando_events ORDER BY id DESC LIMIT 80");
    const [bankAccountRows] = await conn.query("SELECT * FROM bando_bank_accounts ORDER BY active DESC, id DESC");
    const [gameServerRows] = await conn.query("SELECT * FROM game_servers ORDER BY game_name ASC, display_order ASC, id ASC");
    const liveStockByItemId = await listInventoryTotals(conn, gameName, serverName, characterName);

    return {
      items: itemRows.map((row) => applyLiveStock(mapItem(row), liveStockByItemId)),
      orders: orderRows.map(mapOrder),
      coinTrades: coinTradeRows.map(mapCoinTrade),
      transactions: transactionRows.map(mapTransaction),
      events: eventRows.map(mapEvent),
      bankAccounts: bankAccountRows.map(mapBankAccount),
      gameServers: gameServerRows.map(mapPublicGameServer),
      itemSync,
      storage: "mysql",
    };
  });
}

export async function getBandoRevenueStatsMysql(args = {}) {
  return withBandoConnection(async (conn) => {
    const fromIso = String(args.fromIso || "").trim();
    const toIso = String(args.toIso || "").trim();
    if (!fromIso || !toIso) return { ok: false, error: "Thieu khoang thoi gian thong ke." };

    const [sellRows] = await conn.query(
      `SELECT
         COUNT(*) AS total_orders,
         COALESCE(SUM(total_amount), 0) AS total_amount,
         COALESCE(SUM(CASE WHEN item_code = ? THEN 1 ELSE 0 END), 0) AS coin_orders,
         COALESCE(SUM(CASE WHEN item_code = ? THEN total_amount ELSE 0 END), 0) AS coin_amount,
         COALESCE(SUM(CASE WHEN item_code <> ? THEN 1 ELSE 0 END), 0) AS item_orders,
         COALESCE(SUM(CASE WHEN item_code <> ? THEN total_amount ELSE 0 END), 0) AS item_amount
       FROM bando_orders
       WHERE status IN ('paid', 'completed')
         AND COALESCE(NULLIF(paid_at, ''), created_at) >= ?
         AND COALESCE(NULLIF(paid_at, ''), created_at) < ?`,
      [COIN_ITEM_CODE, COIN_ITEM_CODE, COIN_ITEM_CODE, COIN_ITEM_CODE, fromIso, toIso],
    );

    const [buyRows] = await conn.query(
      `SELECT
         COUNT(*) AS coin_orders,
         COALESCE(SUM(total_amount), 0) AS coin_amount
       FROM bando_coin_trades
       WHERE type = 'sell_xu'
         AND status IN ('awaiting_payout_info', 'completed', 'payout_completed')
         AND COALESCE(NULLIF(completed_at, ''), NULLIF(paid_at, ''), created_at) >= ?
         AND COALESCE(NULLIF(completed_at, ''), NULLIF(paid_at, ''), created_at) < ?`,
      [fromIso, toIso],
    );

    return buildRevenueStatsResult(fromIso, toIso, sellRows[0], buyRows[0]);
  });
}

export async function insertBandoOrderMysql(order) {
  return withBandoConnection(async (conn) => {
    await conn.execute(
      `INSERT INTO bando_orders (
        order_code, payment_code, character_name, game_name, server_name, item_code, item_name,
        quantity, unit_price, total_amount, status, private_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        order.orderCode,
        order.paymentCode,
        order.characterName,
        normalizeGameName(order.gameName),
        order.serverName,
        order.itemCode,
        order.itemName,
        order.quantity,
        order.unitPrice,
        order.totalAmount,
        order.status,
        order.privateMessage,
        order.createdAt,
      ],
    );
    await insertEvent(conn, order.orderCode, "order_created", `${order.characterName} tạo đơn ${order.orderCode} từ chat riêng.`);
    return true;
  });
}

export async function insertBandoCoinTradeMysql(trade) {
  return withBandoConnection(async (conn) => {
    await conn.execute(
      `INSERT INTO bando_coin_trades (
        order_code, payment_code, character_name, game_name, server_name, type, coin_amount,
        received_coin_amount, rate, total_amount, status, bank_name, account_number,
        account_name, created_at, paid_at, completed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        trade.orderCode,
        trade.paymentCode || null,
        trade.characterName,
        normalizeGameName(trade.gameName),
        trade.serverName,
        trade.type,
        trade.coinAmount,
        trade.receivedCoinAmount || 0,
        trade.rate,
        trade.totalAmount,
        trade.status,
        trade.bankName || "",
        trade.accountNumber || "",
        trade.accountName || "",
        trade.createdAt,
        trade.paidAt || null,
        trade.completedAt || null,
      ],
    );
    await insertEvent(conn, trade.orderCode, trade.type === "buy_xu" ? "coin_buy_created" : "coin_sell_requested", `${trade.characterName} tao phieu ${trade.type} ${trade.coinAmount} xu.`);
    return true;
  });
}

export async function confirmPaymentMysql(paymentCode, amount, note) {
  return withBandoConnection(async (conn) => {
    const [rows] = await conn.query(
      `SELECT o.*, i.item_id
       FROM bando_orders o
       LEFT JOIN bando_items i ON i.code = o.item_code
       WHERE o.payment_code = ?
       LIMIT 1`,
      [paymentCode],
    );

    if (rows.length === 0) {
      await insertTransaction(conn, null, paymentCode, amount, "rejected", note || "Không tìm thấy mã giao dịch");
      return { ok: false, error: "Không tìm thấy mã giao dịch." };
    }

    const order = mapOrder(rows[0]);
    if (order.status === "completed") {
      if (order.totalAmount === amount) {
        return { ok: true, order, alreadyCompleted: true };
      }
      return { ok: false, error: "Đơn này đã hoàn tất." };
    }

    if (order.status === "paid" && order.totalAmount === amount) {
      return { ok: true, order, alreadyPaid: true };
    }

    if (order.totalAmount !== amount) {
      await insertTransaction(conn, order.orderCode, paymentCode, amount, "rejected", note || "Sai số tiền");
      await insertEvent(
        conn,
        order.orderCode,
        "payment_rejected",
        `Sai số tiền: nhận ${formatVnd(amount)}, cần ${formatVnd(order.totalAmount)}.`,
      );
      return { ok: false, error: `Sai số tiền. Cần thanh toán ${formatVnd(order.totalAmount)}.` };
    }

    const paidAt = new Date().toISOString();
    await conn.execute("UPDATE bando_orders SET status = ?, paid_at = ? WHERE order_code = ?", [
      "paid",
      paidAt,
      order.orderCode,
    ]);
    await conn.execute("UPDATE bando_coin_trades SET status = ?, paid_at = ? WHERE order_code = ?", [
      "paid",
      paidAt,
      order.orderCode,
    ]);
    await insertTransaction(conn, order.orderCode, paymentCode, amount, "matched", note || "Đã khớp thanh toán");
    await insertEvent(conn, order.orderCode, "payment_matched", `Đã nhận đúng ${formatVnd(amount)}.`);

    return { ok: true, order: { ...order, status: "paid", paidAt } };
  });
}

export async function approveBandoOrderMysql(orderCode, note) {
  return withBandoConnection(async (conn) => {
    const [rows] = await conn.query(
      `SELECT o.*, i.item_id
       FROM bando_orders o
       LEFT JOIN bando_items i ON i.code = o.item_code
       WHERE o.order_code = ?
       LIMIT 1`,
      [orderCode],
    );
    if (rows.length === 0) {
      return { ok: false, error: "Không tìm thấy đơn." };
    }

    const order = mapOrder(rows[0]);
    if (order.status === "completed") {
      return { ok: false, error: "Đơn này đã giao xong." };
    }
    if (order.status === "paid") {
      return { ok: true, order, alreadyPaid: true };
    }

    const paidAt = new Date().toISOString();
    await conn.execute("UPDATE bando_orders SET status = ?, paid_at = ? WHERE order_code = ?", [
      "paid",
      paidAt,
      orderCode,
    ]);
    await conn.execute("UPDATE bando_coin_trades SET status = ?, paid_at = ? WHERE order_code = ?", [
      "paid",
      paidAt,
      orderCode,
    ]);
    await insertTransaction(conn, order.orderCode, order.paymentCode, order.totalAmount, "manual_approved", note || "Admin duyệt thanh toán thủ công");
    await insertEvent(conn, order.orderCode, "payment_manual_approved", `Admin duyệt tay đơn ${order.orderCode}.`);

    return { ok: true, order: { ...order, status: "paid", paidAt } };
  });
}

export async function cancelBandoRecordMysql(code, note) {
  return withBandoConnection(async (conn) => {
    const lookupCode = String(code || "").trim().toUpperCase();
    if (!lookupCode) return { ok: false, error: "Thieu ma don." };

    const [orderRows] = await conn.query(
      `SELECT *
       FROM bando_orders
       WHERE order_code = ? OR payment_code = ?
       LIMIT 1`,
      [lookupCode, lookupCode],
    );
    if (orderRows.length > 0) {
      const order = mapOrder(orderRows[0]);
      if (order.status === "completed") {
        return { ok: false, error: "Don nay da giao xong, khong the huy." };
      }
      if (order.status === "cancelled") {
        return { ok: true, order };
      }

      const cancelledAt = new Date().toISOString();
      await conn.execute("UPDATE bando_orders SET status = ? WHERE order_code = ?", [
        "cancelled",
        order.orderCode,
      ]);
      await conn.execute("UPDATE bando_coin_trades SET status = ? WHERE order_code = ?", [
        "cancelled",
        order.orderCode,
      ]);
      await insertTransaction(conn, order.orderCode, order.paymentCode, order.totalAmount, "cancelled", note || "Admin huy don");
      await insertEvent(conn, order.orderCode, "order_cancelled", note || `Admin huy don ${order.orderCode}.`);
      return { ok: true, order: { ...order, status: "cancelled", cancelledAt } };
    }

    const [tradeRows] = await conn.query("SELECT * FROM bando_coin_trades WHERE order_code = ? LIMIT 1", [lookupCode]);
    if (tradeRows.length === 0) {
      return { ok: false, error: "Khong tim thay don hoac phieu xu." };
    }

    const trade = mapCoinTrade(tradeRows[0]);
    if (trade.status === "payout_completed") {
      return { ok: false, error: "Phieu xu da duyet tra tien, khong the huy." };
    }
    if (trade.status === "cancelled") {
      return { ok: true, coinTrade: trade };
    }

    await conn.execute("UPDATE bando_coin_trades SET status = ? WHERE order_code = ?", ["cancelled", trade.orderCode]);
    await insertEvent(conn, trade.orderCode, "coin_trade_cancelled", note || `Admin huy phieu xu ${trade.orderCode}.`);
    return { ok: true, coinTrade: { ...trade, status: "cancelled" } };
  });
}

export async function listPendingDeliveriesMysql(args = {}) {
  return withBandoConnection(async (conn) => {
    const gameName = normalizeGameName(args.gameName);
    const serverName = String(args.serverName || "").trim();
    const [rows] = await conn.query(
      `SELECT o.*, i.item_id
       FROM bando_orders o
       LEFT JOIN bando_items i ON i.code = o.item_code
       WHERE o.status = 'paid'
         AND o.game_name = ?
         AND (? = '' OR o.server_name = ?)
       ORDER BY o.paid_at ASC, o.id ASC
       LIMIT 30`,
      [gameName, serverName, serverName],
    );
    const deliveries = rows.map((row) => ({
      ...mapOrder(row),
      itemId: row.item_id == null ? itemIdFromCode(row.item_code) : toNumber(row.item_id, -1),
    }));

    const [coinRows] = await conn.query(
      `SELECT *
       FROM bando_coin_trades
       WHERE type = 'sell_xu'
         AND status = 'awaiting_trade'
         AND game_name = ?
         AND (? = '' OR server_name = ?)
       ORDER BY created_at ASC, id ASC
       LIMIT 30`,
      [gameName, serverName, serverName],
    );
    deliveries.push(...coinRows.map((row) => toCoinReceiveDeliveryJob(mapCoinTrade(row))));
    return deliveries;
  });
}

export async function listPendingBotNotificationsMysql(args = {}) {
  return withBandoConnection(async (conn) => {
    const gameName = normalizeGameName(args.gameName);
    const serverName = String(args.serverName || "").trim();
    const [rows] = await conn.query(
      `SELECT *
       FROM bando_coin_trades
       WHERE type = 'sell_xu'
         AND status = 'payout_completed'
         AND payout_notified_at IS NULL
         AND game_name = ?
         AND (? = '' OR server_name = ?)
       ORDER BY id ASC
       LIMIT 30`,
      [gameName, serverName, serverName],
    );
    return rows.map((row) => toPayoutCompletedNotification(mapCoinTrade(row)));
  });
}

export async function confirmBotNotificationMysql(orderCode, type) {
  return withBandoConnection(async (conn) => {
    if (type !== "payout_completed") {
      return { ok: false, error: "Loại thông báo không hỗ trợ." };
    }
    const notifiedAt = new Date().toISOString();
    const [result] = await conn.execute(
      "UPDATE bando_coin_trades SET payout_notified_at = ? WHERE order_code = ? AND status = 'payout_completed'",
      [notifiedAt, orderCode],
    );
    if (result.affectedRows === 0) {
      return { ok: false, error: "Không tìm thấy thông báo cần xác nhận." };
    }
    await insertEvent(conn, orderCode, "coin_payout_notified", `BOT đã báo khách phiếu ${orderCode} đã thanh toán.`);
    return { ok: true, orderCode, type, notifiedAt };
  });
}

export async function confirmDeliveryMysql(orderCode, botName, extra = {}) {
  return withBandoConnection(async (conn) => {
    const [rows] = await conn.query("SELECT * FROM bando_orders WHERE order_code = ? LIMIT 1", [orderCode]);
    if (rows.length === 0) return confirmCoinReceiveMysql(conn, orderCode, botName, extra);

    if (rows.length === 0) {
      return { ok: false, error: "Không tìm thấy đơn." };
    }

    const order = mapOrder(rows[0]);
    if (order.status !== "paid") {
      return { ok: false, error: "Chỉ giao hàng khi đơn đã thanh toán đúng." };
    }

    const deliveredAt = new Date().toISOString();
    await conn.execute("UPDATE bando_orders SET status = ?, delivered_at = ? WHERE order_code = ?", [
      "completed",
      deliveredAt,
      orderCode,
    ]);
    await conn.execute("UPDATE bando_items SET stock = GREATEST(stock - ?, 0), updated_at = ? WHERE code = ?", [
      order.quantity,
      deliveredAt,
      order.itemCode,
    ]);
    await conn.execute("UPDATE bando_coin_trades SET status = ?, completed_at = ? WHERE order_code = ?", [
      "completed",
      deliveredAt,
      orderCode,
    ]);
    await insertEvent(conn, orderCode, "delivery_completed", `${botName} đã giao ${order.quantity} ${order.itemName}.`);

    return { ok: true, order: { ...order, status: "completed", deliveredAt } };
  });
}

async function confirmCoinReceiveMysql(conn, orderCode, botName, extra = {}) {
  const [rows] = await conn.query("SELECT * FROM bando_coin_trades WHERE order_code = ? LIMIT 1", [orderCode]);
  if (rows.length === 0) {
    return { ok: false, error: "Khong tim thay don." };
  }

  const trade = mapCoinTrade(rows[0]);
  if (trade.type !== "sell_xu" || trade.status !== "awaiting_trade") {
    return { ok: false, error: "Phieu ban xu khong o trang thai cho giao dich." };
  }

  const receivedCoinAmount = Math.max(0, Math.trunc(Number(extra.receivedCoinAmount) || 0));
  if (receivedCoinAmount < trade.coinAmount) {
    return { ok: false, error: `BOT moi nhan ${receivedCoinAmount} xu, chua du ${trade.coinAmount} xu.` };
  }

  const completedAt = new Date().toISOString();
  await conn.execute(
    "UPDATE bando_coin_trades SET status = ?, received_coin_amount = ?, completed_at = ? WHERE order_code = ?",
    ["awaiting_payout_info", receivedCoinAmount, completedAt, orderCode],
  );
  await insertEvent(conn, orderCode, "coin_sell_completed", `${botName} da nhan ${receivedCoinAmount} xu tu ${trade.characterName}.`);

  const nextTrade = { ...trade, status: "awaiting_payout_info", receivedCoinAmount, completedAt };
  return { ok: true, coinTrade: nextTrade, reply: buildCoinSellCompletedReply(nextTrade) };
}

export async function updateCoinTradePayoutInfoMysql(args) {
  return withBandoConnection(async (conn) => {
    const characterName = String(args.characterName || "").trim();
    const gameName = normalizeGameName(args.gameName);
    const serverName = String(args.serverName || "").trim();
    const bankName = String(args.bankName || "").trim();
    const accountNumber = String(args.accountNumber || "").trim();
    const accountName = String(args.accountName || "").trim();
    if (!characterName || !bankName || !accountNumber || !accountName) {
      return { ok: false, error: "Thieu thong tin nhan tien." };
    }

    const [rows] = await conn.query(
      `SELECT *
       FROM bando_coin_trades
       WHERE type = 'sell_xu'
         AND character_name = ?
         AND game_name = ?
         AND (? = '' OR server_name = ?)
         AND status IN ('awaiting_payout_info', 'payout_info_cancelled', 'completed')
       ORDER BY id DESC
       LIMIT 1`,
      [characterName, gameName, serverName, serverName],
    );
    if (rows.length === 0) {
      return { ok: false, error: "Chua tim thay phieu ban xu cua ban de luu thong tin nhan tien." };
    }

    const orderCode = String(rows[0].order_code ?? "");
    await conn.execute(
      "UPDATE bando_coin_trades SET bank_name = ?, account_number = ?, account_name = ?, status = ? WHERE order_code = ?",
      [bankName, accountNumber, accountName, "completed", orderCode],
    );
    await insertEvent(conn, orderCode, "coin_payout_info_saved", `${characterName} da gui thong tin nhan tien.`);

    const [nextRows] = await conn.query("SELECT * FROM bando_coin_trades WHERE order_code = ? LIMIT 1", [orderCode]);
    return { ok: true, coinTrade: nextRows[0] ? mapCoinTrade(nextRows[0]) : null };
  });
}

export async function cancelCoinTradePayoutInfoMysql(args) {
  return withBandoConnection(async (conn) => {
    const name = String(args.characterName || "").trim();
    const gameName = normalizeGameName(args.gameName);
    const serverName = String(args.serverName || "").trim();
    if (!name) {
      return { ok: false, error: "Thieu ten nhan vat." };
    }

    const [rows] = await conn.query(
      `SELECT *
       FROM bando_coin_trades
       WHERE type = 'sell_xu'
         AND character_name = ?
         AND game_name = ?
         AND (? = '' OR server_name = ?)
         AND status = 'awaiting_payout_info'
       ORDER BY id DESC
       LIMIT 1`,
      [name, gameName, serverName, serverName],
    );
    if (rows.length === 0) {
      return { ok: false, error: "Khong co phien nhap thong tin nhan tien de huy." };
    }

    const orderCode = String(rows[0].order_code ?? "");
    await conn.execute("UPDATE bando_coin_trades SET status = ? WHERE order_code = ?", [
      "payout_info_cancelled",
      orderCode,
    ]);
    await insertEvent(conn, orderCode, "coin_payout_info_cancelled", `${name} da huy nhap thong tin nhan tien.`);

    const [nextRows] = await conn.query("SELECT * FROM bando_coin_trades WHERE order_code = ? LIMIT 1", [orderCode]);
    return { ok: true, coinTrade: nextRows[0] ? mapCoinTrade(nextRows[0]) : null };
  });
}

export async function approveCoinTradePayoutMysql(orderCode, note) {
  return withBandoConnection(async (conn) => {
    const [rows] = await conn.query("SELECT * FROM bando_coin_trades WHERE order_code = ? LIMIT 1", [orderCode]);
    if (rows.length === 0) {
      return { ok: false, error: "Không tìm thấy phiếu xu." };
    }

    const trade = mapCoinTrade(rows[0]);
    if (trade.type !== "sell_xu") {
      return { ok: false, error: "Chỉ duyệt trả tiền cho phiếu khách bán xu." };
    }
    if (trade.status !== "completed") {
      return { ok: false, error: "Chỉ duyệt trả tiền sau khi BOT đã nhận xu." };
    }
    if (!trade.bankName || !trade.accountNumber || !trade.accountName) {
      return { ok: false, error: "Khách chưa gửi đủ thông tin nhận tiền." };
    }

    await conn.execute("UPDATE bando_coin_trades SET status = ?, payout_notified_at = NULL WHERE order_code = ?", [
      "payout_completed",
      orderCode,
    ]);
    await insertEvent(conn, orderCode, "coin_payout_approved", note || `Admin duyệt trả ${formatVnd(trade.totalAmount)} cho ${trade.characterName}.`);

    const [nextRows] = await conn.query("SELECT * FROM bando_coin_trades WHERE order_code = ? LIMIT 1", [orderCode]);
    return { ok: true, coinTrade: nextRows[0] ? mapCoinTrade(nextRows[0]) : null };
  });
}

export async function updateBandoItemMysql(args) {
  return withBandoConnection(async (conn) => {
    const now = new Date().toISOString();
    const gameName = normalizeGameName(args.gameName);
    const serverName = normalizeServerName(args.serverName) || "default";
    const code = String(args.code || "").trim().toLowerCase();
    const buyName = String(args.buyName || code).trim().toLowerCase() || code;
    const aliases = normalizeAliases(args.aliases, buyName, code);

    await conn.execute(
      `INSERT INTO bando_items (
        code, game_name, server_name, item_id, name, buy_name, aliases, unit, sell_price, stock, active, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        game_name = VALUES(game_name),
        server_name = VALUES(server_name),
        item_id = VALUES(item_id),
        name = VALUES(name),
        buy_name = VALUES(buy_name),
        aliases = VALUES(aliases),
        unit = VALUES(unit),
        sell_price = VALUES(sell_price),
        stock = VALUES(stock),
        active = VALUES(active),
        updated_at = VALUES(updated_at)`,
      [
        code,
        gameName,
        serverName,
        args.itemId ?? null,
        String(args.name || code).trim(),
        buyName,
        JSON.stringify(aliases),
        String(args.unit || "cái").trim(),
        args.sellPrice,
        args.stock,
        args.active === false ? 0 : 1,
        now,
      ],
    );
    await insertEvent(conn, null, "price_updated", `Cập nhật ${buyName}: ${formatVnd(args.sellPrice)}, tồn ${args.stock}.`);

    const [rows] = await conn.query("SELECT * FROM bando_items WHERE code = ? LIMIT 1", [code]);
    return { ok: true, item: rows[0] ? mapItem(rows[0]) : null };
  });
}

export async function upsertBandoBankAccountMysql(args) {
  return withBandoConnection(async (conn) => {
    const id = Number(args.id);
    const bankName = String(args.bankName || "").trim();
    const bankCode = String(args.bankCode || "").trim().toUpperCase();
    const accountNumber = String(args.accountNumber || "").trim();
    const accountName = String(args.accountName || "").trim();
    const paymentPrefix = normalizePaymentPrefix(args.paymentPrefix);
    const callbackSignature = String(args.callbackSignature || "").trim();
    const active = args.active !== false;
    const now = new Date().toISOString();

    if (!bankName || !accountNumber || !accountName) {
      return { ok: false, error: "Thiếu ngân hàng, số tài khoản hoặc chủ tài khoản." };
    }

    if (active) {
      await conn.execute("UPDATE bando_bank_accounts SET active = 0, updated_at = ?", [now]);
    }

    if (Number.isInteger(id) && id > 0) {
      await conn.execute(
        `UPDATE bando_bank_accounts
         SET bank_name = ?, bank_code = ?, account_number = ?, account_name = ?, payment_prefix = ?, callback_signature = ?, active = ?, updated_at = ?
         WHERE id = ?`,
        [bankName, bankCode, accountNumber, accountName, paymentPrefix, callbackSignature, active ? 1 : 0, now, id],
      );
    } else {
      const [result] = await conn.execute(
        `INSERT INTO bando_bank_accounts (
          bank_name, bank_code, account_number, account_name, payment_prefix,
          callback_signature, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [bankName, bankCode, accountNumber, accountName, paymentPrefix, callbackSignature, active ? 1 : 0, now, now],
      );
      args.id = result.insertId;
    }

    await insertEvent(conn, null, "bank_account_updated", `Cập nhật tài khoản nhận tiền ${bankName} - ${accountNumber}.`);
    const [rows] = await conn.query("SELECT * FROM bando_bank_accounts WHERE id = ? LIMIT 1", [args.id || id]);
    return { ok: true, bankAccount: rows[0] ? mapBankAccount(rows[0]) : null };
  });
}

export async function deleteBandoBankAccountMysql(id) {
  return withBandoConnection(async (conn) => {
    const accountId = Number(id);
    if (!Number.isInteger(accountId) || accountId <= 0) {
      return { ok: false, error: "Thiếu ID tài khoản nhận tiền." };
    }

    await conn.execute("DELETE FROM bando_bank_accounts WHERE id = ?", [accountId]);
    await insertEvent(conn, null, "bank_account_deleted", `Xóa tài khoản nhận tiền #${accountId}.`);
    return { ok: true, id: accountId };
  });
}

export async function countBandoAdminUsersMysql() {
  return withBandoConnection(async (conn) => {
    const [rows] = await conn.query("SELECT COUNT(*) AS count FROM bando_admin_users");
    return { ok: true, count: toNumber(rows[0]?.count, 0), storage: "mysql" };
  });
}

export async function findBandoAdminUserByUsernameMysql(username) {
  return withBandoConnection(async (conn) => {
    const [rows] = await conn.query("SELECT * FROM bando_admin_users WHERE username = ? AND active = 1 LIMIT 1", [
      String(username || "").trim().toLowerCase(),
    ]);
    return { ok: true, user: rows[0] ? mapAdminUser(rows[0]) : null, storage: "mysql" };
  });
}

export async function insertBandoAdminUserMysql(user) {
  return withBandoConnection(async (conn) => {
    const now = new Date().toISOString();
    const username = String(user.username || "").trim().toLowerCase();
    try {
      const [result] = await conn.execute(
        `INSERT INTO bando_admin_users (
          username, password_hash, password_salt, role, active, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [
          username,
          String(user.passwordHash || ""),
          String(user.passwordSalt || ""),
          String(user.role || "admin"),
          user.active === false ? 0 : 1,
          now,
          now,
        ],
      );
      const [rows] = await conn.query("SELECT * FROM bando_admin_users WHERE id = ? LIMIT 1", [result.insertId]);
      return { ok: true, user: rows[0] ? mapAdminUser(rows[0]) : null, storage: "mysql" };
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        return { ok: false, error: "Tên đăng nhập đã tồn tại." };
      }
      throw error;
    }
  });
}

export async function listBandoGameServersMysql() {
  return withBandoConnection(async (conn) => {
    const [rows] = await conn.query("SELECT * FROM game_servers ORDER BY game_name ASC, display_order ASC, id ASC");
    return { ok: true, gameServers: rows.map(mapGameServer), storage: "mysql" };
  });
}

export async function upsertBandoGameServerMysql(server) {
  return withBandoConnection(async (conn) => {
    const now = new Date().toISOString();
    const id = Number(server.id);
    const values = gameServerValues(server);
    try {
      if (Number.isInteger(id) && id > 0) {
        await conn.execute(
          `UPDATE game_servers
           SET game_name = ?, name = ?, code = ?, status = ?, db_host = ?, db_port = ?,
               db_user = ?, db_password = ?, db_game_database = ?, db_player_database = ?,
               socket_host = ?, socket_port = ?, socket_key = ?, socket_port_web = ?,
               socket_key_web = ?, is_default = ?, display_order = ?, day_open = ?, updated_at = ?
           WHERE id = ?`,
          [...values, now, id],
        );
      } else {
        const [result] = await conn.execute(
          `INSERT INTO game_servers (
            game_name, name, code, status, db_host, db_port, db_user, db_password,
            db_game_database, db_player_database, socket_host, socket_port, socket_key,
            socket_port_web, socket_key_web, is_default, display_order, day_open,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [...values, now, now],
        );
        server.id = result.insertId;
      }

      if (server.isDefault) {
        await conn.execute("UPDATE game_servers SET is_default = 0 WHERE game_name = ? AND id <> ?", [
          values[0],
          Number(server.id) || id,
        ]);
      }

      const [rows] = await conn.query("SELECT * FROM game_servers WHERE id = ? LIMIT 1", [server.id || id]);
      await insertEvent(conn, null, "game_server_updated", `Cap nhat DB server ${values[0]} / ${values[1]}.`);
      return { ok: true, gameServer: rows[0] ? mapGameServer(rows[0]) : null, storage: "mysql" };
    } catch (error) {
      if (error?.code === "ER_DUP_ENTRY") {
        return { ok: false, error: "Ma server da ton tai trong game nay." };
      }
      throw error;
    }
  });
}

export async function deleteBandoGameServerMysql(id) {
  return withBandoConnection(async (conn) => {
    const serverId = Number(id);
    if (!Number.isInteger(serverId) || serverId <= 0) {
      return { ok: false, error: "Thieu ID server." };
    }
    await conn.execute("DELETE FROM game_servers WHERE id = ?", [serverId]);
    await insertEvent(conn, null, "game_server_deleted", `Xoa cau hinh DB server #${serverId}.`);
    return { ok: true, id: serverId };
  });
}

export async function importServerItemsMysql(args = {}) {
  return withBandoConnection(async (conn, config) => {
    const gameName = normalizeGameName(args.gameName);
    const serverName = normalizeServerName(args.serverName);
    if (serverName) {
      return syncItemsFromConfiguredServer(conn, gameName, serverName, { force: true, failWhenMissing: true });
    }

    let rows = [];
    let sourceDatabase = "";
    {
      const serverDb = safeIdentifier(config.serverDatabase);
      [rows] = await conn.query(`SELECT id, name FROM \`${serverDb}\`.\`item\` ORDER BY id ASC`);
      sourceDatabase = serverDb;
    }
    const result = await upsertImportedItems(conn, { gameName, serverName: serverName || "default", rows, sourceDatabase });
    await insertEvent(conn, null, "server_items_imported", `Đồng bộ ${result.imported} vật phẩm từ DB server.`);
    return result;
  });
}

export async function updateBandoInventoryMysql(args) {
  return withBandoConnection(async (conn) => {
    const gameName = normalizeGameName(args.gameName);
    const serverName = String(args.serverName || "default").trim() || "default";
    const characterName = String(args.characterName || "BOT").trim() || "BOT";
    const inventory = normalizeInventory(args.inventory);
    const now = new Date().toISOString();

    for (const item of inventory) {
      await conn.execute(
        `INSERT INTO bando_inventory (
          game_name, server_name, character_name, item_id, name, quantity, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          name = VALUES(name),
          quantity = VALUES(quantity),
          updated_at = VALUES(updated_at)`,
        [gameName, serverName, characterName, item.itemId, item.name, item.quantity, now],
      );
    }
    await conn.execute("DELETE FROM bando_inventory WHERE game_name = ? AND server_name = ? AND character_name = ? AND updated_at <> ?", [
      gameName,
      serverName,
      characterName,
      now,
    ]);

    await pruneEvents(conn);
    return { ok: true, count: inventory.length, updatedAt: now };
  });
}

export async function getBandoBotConfigMysql() {
  return withBandoConnection(async (conn) => {
    const [rows] = await conn.query("SELECT config_json, updated_at FROM bando_bot_config WHERE id = 1 LIMIT 1");
    if (rows.length === 0) return null;

    try {
      const rawConfig = rows[0].config_json;
      const config = rawConfig && typeof rawConfig === "object" && !Buffer.isBuffer(rawConfig)
        ? rawConfig
        : JSON.parse(Buffer.isBuffer(rawConfig) ? rawConfig.toString("utf8") : String(rawConfig || "{}"));
      return {
        config,
        updatedAt: String(rows[0].updated_at ?? ""),
      };
    } catch {
      return null;
    }
  });
}

export async function updateBandoBotConfigMysql(config) {
  return withBandoConnection(async (conn) => {
    const now = new Date().toISOString();
    await conn.execute(
      `INSERT INTO bando_bot_config (id, config_json, updated_at)
       VALUES (1, ?, ?)
       ON DUPLICATE KEY UPDATE
         config_json = VALUES(config_json),
         updated_at = VALUES(updated_at)`,
      [JSON.stringify(config), now],
    );
    await insertEvent(conn, null, "bot_config_updated", "Cập nhật cấu hình BOT bán đồ từ web.");
    return { ok: true, config, updatedAt: now };
  });
}

async function withBandoConnection(action) {
  if (process.env.BANDO_DISABLE_MYSQL === "1") return null;
  if (Date.now() < mysqlDisabledUntil) return null;

  let conn = null;
  try {
    const config = await readMysqlConfig();
    await ensureDatabase(config);
    conn = await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      charset: "utf8mb4",
    });

    await ensureBandoMysqlSchema(conn);
    return await action(conn, config);
  } catch (error) {
    mysqlDisabledUntil = Date.now() + MYSQL_DISABLED_MS;
    console.warn("[bando:mysql] temporarily using memory storage:", error instanceof Error ? error.message : error);
    return null;
  } finally {
    if (conn) await conn.end().catch(() => undefined);
  }
}

async function ensureDatabase(config) {
  const admin = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    charset: "utf8mb4",
  });
  try {
    await admin.execute(
      `CREATE DATABASE IF NOT EXISTS \`${safeIdentifier(config.database)}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
}

async function ensureBandoMysqlSchema(conn) {
  await conn.execute(
    `CREATE TABLE IF NOT EXISTS bando_items (
      code VARCHAR(96) PRIMARY KEY,
      game_name VARCHAR(64) NOT NULL DEFAULT 'Ninja Mobile',
      server_name VARCHAR(96) NOT NULL DEFAULT 'default',
      item_id INT NULL,
      name VARCHAR(255) NOT NULL,
      buy_name VARCHAR(96) NOT NULL DEFAULT '',
      aliases TEXT NOT NULL,
      unit VARCHAR(32) NOT NULL DEFAULT 'cái',
      sell_price INT NOT NULL DEFAULT 0,
      stock INT NOT NULL DEFAULT 0,
      active TINYINT NOT NULL DEFAULT 1,
      updated_at VARCHAR(40) NOT NULL,
      UNIQUE KEY bando_items_game_server_item_uq (game_name, server_name, item_id),
      KEY bando_items_game_server_idx (game_name, server_name),
      KEY bando_items_name_idx (name),
      KEY bando_items_buy_name_idx (buy_name)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await conn.execute(
    `CREATE TABLE IF NOT EXISTS bando_admin_users (
      id INT AUTO_INCREMENT PRIMARY KEY,
      username VARCHAR(64) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      password_salt VARCHAR(64) NOT NULL,
      role VARCHAR(32) NOT NULL DEFAULT 'admin',
      active TINYINT NOT NULL DEFAULT 1,
      created_at VARCHAR(40) NOT NULL,
      updated_at VARCHAR(40) NOT NULL,
      KEY bando_admin_users_active_idx (active)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await conn.execute(
    `CREATE TABLE IF NOT EXISTS game_servers (
      id INT AUTO_INCREMENT PRIMARY KEY,
      game_name VARCHAR(64) NOT NULL DEFAULT 'Ninja Mobile',
      name VARCHAR(100) NOT NULL,
      code VARCHAR(50) NOT NULL,
      status VARCHAR(32) NULL DEFAULT 'offline',
      db_host VARCHAR(255) NOT NULL,
      db_port INT NOT NULL DEFAULT 3306,
      db_user VARCHAR(100) NOT NULL,
      db_password VARCHAR(255) NULL,
      db_game_database VARCHAR(100) NOT NULL,
      db_player_database VARCHAR(100) NOT NULL,
      socket_host VARCHAR(255) NOT NULL DEFAULT '',
      socket_port INT NOT NULL DEFAULT 5900,
      socket_key VARCHAR(255) NOT NULL DEFAULT '',
      socket_port_web VARCHAR(255) NULL,
      socket_key_web VARCHAR(255) NULL,
      is_default TINYINT(1) NULL DEFAULT 0,
      display_order INT NULL DEFAULT 0,
      created_at VARCHAR(40) NOT NULL,
      updated_at VARCHAR(40) NOT NULL,
      day_open VARCHAR(40) NULL,
      UNIQUE KEY game_servers_game_code_uq (game_name, code),
      KEY game_servers_game_name_idx (game_name, name),
      KEY game_servers_status_idx (status)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await conn.execute(
    `CREATE TABLE IF NOT EXISTS bando_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_code VARCHAR(64) NOT NULL UNIQUE,
      payment_code VARCHAR(64) NOT NULL UNIQUE,
      character_name VARCHAR(64) NOT NULL,
      game_name VARCHAR(64) NOT NULL DEFAULT 'Ninja Mobile',
      server_name VARCHAR(96) NOT NULL DEFAULT 'default',
      item_code VARCHAR(96) NOT NULL,
      item_name VARCHAR(255) NOT NULL,
      quantity INT NOT NULL,
      unit_price INT NOT NULL,
      total_amount INT NOT NULL,
      status VARCHAR(32) NOT NULL DEFAULT 'awaiting_payment',
      private_message TEXT NOT NULL,
      created_at VARCHAR(40) NOT NULL,
      paid_at VARCHAR(40) NULL,
      delivered_at VARCHAR(40) NULL,
      KEY bando_orders_status_idx (status),
      KEY bando_orders_game_server_idx (game_name, server_name),
      KEY bando_orders_character_idx (character_name)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await conn.execute(
    `CREATE TABLE IF NOT EXISTS bando_transactions (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_code VARCHAR(64) NULL,
      payment_code VARCHAR(64) NOT NULL,
      amount INT NOT NULL,
      status VARCHAR(32) NOT NULL,
      note TEXT NOT NULL,
      created_at VARCHAR(40) NOT NULL,
      KEY bando_transactions_payment_code_idx (payment_code)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await conn.execute(
    `CREATE TABLE IF NOT EXISTS bando_events (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_code VARCHAR(64) NULL,
      type VARCHAR(64) NOT NULL,
      message TEXT NOT NULL,
      created_at VARCHAR(40) NOT NULL,
      KEY bando_events_created_at_idx (created_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await conn.execute(
    `CREATE TABLE IF NOT EXISTS bando_inventory (
      id INT AUTO_INCREMENT PRIMARY KEY,
      game_name VARCHAR(64) NOT NULL DEFAULT 'Ninja Mobile',
      server_name VARCHAR(96) NOT NULL DEFAULT 'default',
      character_name VARCHAR(64) NOT NULL,
      item_id INT NOT NULL,
      name VARCHAR(255) NOT NULL DEFAULT '',
      quantity INT NOT NULL DEFAULT 0,
      updated_at VARCHAR(40) NOT NULL,
      UNIQUE KEY bando_inventory_game_source_item_uq (game_name, server_name, character_name, item_id),
      KEY bando_inventory_item_id_idx (item_id),
      KEY bando_inventory_game_server_idx (game_name, server_name),
      KEY bando_inventory_updated_at_idx (updated_at)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await conn.execute(
    `CREATE TABLE IF NOT EXISTS bando_bank_accounts (
      id INT AUTO_INCREMENT PRIMARY KEY,
      bank_name VARCHAR(96) NOT NULL,
      bank_code VARCHAR(32) NOT NULL DEFAULT '',
      account_number VARCHAR(64) NOT NULL,
      account_name VARCHAR(128) NOT NULL,
      payment_prefix VARCHAR(32) NOT NULL DEFAULT '',
      callback_signature VARCHAR(255) NOT NULL DEFAULT '',
      active TINYINT NOT NULL DEFAULT 1,
      created_at VARCHAR(40) NOT NULL,
      updated_at VARCHAR(40) NOT NULL,
      KEY bando_bank_accounts_active_idx (active)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await conn.execute(
    `CREATE TABLE IF NOT EXISTS bando_coin_trades (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_code VARCHAR(64) NOT NULL UNIQUE,
      payment_code VARCHAR(64) NULL,
      character_name VARCHAR(64) NOT NULL,
      game_name VARCHAR(64) NOT NULL DEFAULT 'Ninja Mobile',
      server_name VARCHAR(96) NOT NULL DEFAULT 'default',
      type VARCHAR(32) NOT NULL,
      coin_amount INT NOT NULL,
      received_coin_amount INT NOT NULL DEFAULT 0,
      rate DECIMAL(10,3) NOT NULL DEFAULT 0,
      total_amount INT NOT NULL DEFAULT 0,
      status VARCHAR(32) NOT NULL DEFAULT 'awaiting_payment',
      bank_name VARCHAR(96) NOT NULL DEFAULT '',
      account_number VARCHAR(64) NOT NULL DEFAULT '',
      account_name VARCHAR(128) NOT NULL DEFAULT '',
      created_at VARCHAR(40) NOT NULL,
      paid_at VARCHAR(40) NULL,
      completed_at VARCHAR(40) NULL,
      payout_notified_at VARCHAR(40) NULL,
      KEY bando_coin_trades_character_idx (character_name),
      KEY bando_coin_trades_game_server_idx (game_name, server_name),
      KEY bando_coin_trades_status_idx (status),
      KEY bando_coin_trades_type_idx (type)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await conn.execute(
    `CREATE TABLE IF NOT EXISTS bando_bot_config (
      id TINYINT PRIMARY KEY,
      config_json JSON NOT NULL,
      updated_at VARCHAR(40) NOT NULL
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );

  await ensureColumn(conn, "bando_items", "item_id", "INT NULL");
  await ensureIndex(conn, "bando_events", "bando_events_type_idx", "type");
  await ensureColumn(conn, "bando_items", "game_name", "VARCHAR(64) NOT NULL DEFAULT 'Ninja Mobile'");
  await ensureColumn(conn, "bando_items", "server_name", "VARCHAR(96) NOT NULL DEFAULT 'default'");
  await ensureColumn(conn, "bando_items", "buy_name", "VARCHAR(96) NOT NULL DEFAULT ''");
  await ensureColumn(conn, "bando_orders", "game_name", "VARCHAR(64) NOT NULL DEFAULT 'Ninja Mobile'");
  await ensureColumn(conn, "bando_inventory", "game_name", "VARCHAR(64) NOT NULL DEFAULT 'Ninja Mobile'");
  await ensureColumn(conn, "bando_coin_trades", "game_name", "VARCHAR(64) NOT NULL DEFAULT 'Ninja Mobile'");
  await ensureColumn(conn, "bando_coin_trades", "received_coin_amount", "INT NOT NULL DEFAULT 0");
  await ensureColumn(conn, "bando_coin_trades", "bank_name", "VARCHAR(96) NOT NULL DEFAULT ''");
  await ensureColumn(conn, "bando_coin_trades", "account_number", "VARCHAR(64) NOT NULL DEFAULT ''");
  await ensureColumn(conn, "bando_coin_trades", "account_name", "VARCHAR(128) NOT NULL DEFAULT ''");
  await ensureColumn(conn, "bando_coin_trades", "payout_notified_at", "VARCHAR(40) NULL");
  await ensureColumn(conn, "bando_bank_accounts", "bank_code", "VARCHAR(32) NOT NULL DEFAULT ''");
  await ensureColumn(conn, "bando_bank_accounts", "payment_prefix", "VARCHAR(32) NOT NULL DEFAULT ''");
  await ensureColumn(conn, "bando_bank_accounts", "callback_signature", "VARCHAR(255) NOT NULL DEFAULT ''");
  await ensureColumn(conn, "game_servers", "game_name", "VARCHAR(64) NOT NULL DEFAULT 'Ninja Mobile'");
  await migrateLegacyGameServerGameNames(conn);
  await ensureColumn(conn, "game_servers", "socket_port_web", "VARCHAR(255) NULL");
  await ensureColumn(conn, "game_servers", "socket_key_web", "VARCHAR(255) NULL");
  await ensureColumn(conn, "game_servers", "day_open", "VARCHAR(40) NULL");
  await dropIndexIfExists(conn, "bando_items", "bando_items_item_id_uq");
  await dropIndexIfExists(conn, "game_servers", "code");
  await ensureIndex(conn, "bando_items", "bando_items_game_server_idx", "game_name, server_name");
  await ensureUniqueIndex(conn, "bando_items", "bando_items_game_server_item_uq", "game_name, server_name, item_id");
  await ensureUniqueIndex(conn, "game_servers", "game_servers_game_code_uq", "game_name, code");
  await ensureIndex(conn, "game_servers", "game_servers_game_name_idx", "game_name, name");
  await dropIndexIfExists(conn, "bando_inventory", "bando_inventory_source_item_uq");
  await ensureIndex(conn, "bando_orders", "bando_orders_game_server_idx", "game_name, server_name");
  await ensureIndex(conn, "bando_inventory", "bando_inventory_game_server_idx", "game_name, server_name");
  await ensureUniqueIndex(conn, "bando_inventory", "bando_inventory_game_source_item_uq", "game_name, server_name, character_name, item_id");
  await ensureIndex(conn, "bando_coin_trades", "bando_coin_trades_game_server_idx", "game_name, server_name");
}

async function listInventoryTotals(conn, gameName = DEFAULT_GAME_NAME, serverName = "", characterName = "") {
  const normalizedGameName = normalizeGameName(gameName);
  let rows;
  if (serverName && characterName) {
    [rows] = await conn.query(
      `SELECT item_id, SUM(quantity) AS quantity, MAX(updated_at) AS updated_at
       FROM bando_inventory
       WHERE game_name = ? AND server_name = ? AND character_name = ?
       GROUP BY item_id`,
      [normalizedGameName, serverName, characterName],
    );
  } else if (serverName) {
    [rows] = await conn.query(
      `SELECT item_id, SUM(quantity) AS quantity, MAX(updated_at) AS updated_at
       FROM bando_inventory
       WHERE game_name = ? AND server_name = ?
       GROUP BY item_id`,
      [normalizedGameName, serverName],
    );
  } else if (characterName) {
    [rows] = await conn.query(
      `SELECT item_id, SUM(quantity) AS quantity, MAX(updated_at) AS updated_at
       FROM bando_inventory
       WHERE game_name = ? AND character_name = ?
       GROUP BY item_id`,
      [normalizedGameName, characterName],
    );
  } else {
    [rows] = await conn.query(
      "SELECT item_id, SUM(quantity) AS quantity, MAX(updated_at) AS updated_at FROM bando_inventory WHERE game_name = ? GROUP BY item_id",
      [normalizedGameName],
    );
  }
  const stockByItemId = new Map();
  for (const row of rows) {
    const itemId = toNumber(row.item_id, -1);
    if (itemId < 0) continue;
    stockByItemId.set(itemId, {
      quantity: toNumber(row.quantity, 0),
      updatedAt: String(row.updated_at ?? ""),
    });
  }
  return stockByItemId;
}

async function ensureColumn(conn, table, column, definition) {
  const [rows] = await conn.query(`SHOW COLUMNS FROM \`${safeIdentifier(table)}\` LIKE ?`, [column]);
  if (rows.length > 0) return;
  await conn.execute(`ALTER TABLE \`${safeIdentifier(table)}\` ADD COLUMN \`${safeIdentifier(column)}\` ${definition}`);
}

async function ensureIndex(conn, table, indexName, column) {
  const [rows] = await conn.query(`SHOW INDEX FROM \`${safeIdentifier(table)}\` WHERE Key_name = ?`, [indexName]);
  if (rows.length > 0) return;
  await conn.execute(
    `ALTER TABLE \`${safeIdentifier(table)}\` ADD KEY \`${safeIdentifier(indexName)}\` (${formatIndexColumns(column)})`,
  );
}

async function ensureUniqueIndex(conn, table, indexName, column) {
  const [rows] = await conn.query(`SHOW INDEX FROM \`${safeIdentifier(table)}\` WHERE Key_name = ?`, [indexName]);
  if (rows.length > 0) return;
  await conn.execute(
    `ALTER TABLE \`${safeIdentifier(table)}\` ADD UNIQUE KEY \`${safeIdentifier(indexName)}\` (${formatIndexColumns(column)})`,
  );
}

async function dropIndexIfExists(conn, table, indexName) {
  const [rows] = await conn.query(`SHOW INDEX FROM \`${safeIdentifier(table)}\` WHERE Key_name = ?`, [indexName]);
  if (rows.length === 0) return;
  await conn.execute(`ALTER TABLE \`${safeIdentifier(table)}\` DROP INDEX \`${safeIdentifier(indexName)}\``);
}

async function migrateLegacyGameServerGameNames(conn) {
  await conn.execute(
    `UPDATE game_servers
     SET game_name = ?
     WHERE LOWER(COALESCE(db_user, '')) LIKE '%2d%'
        OR LOWER(COALESCE(db_game_database, '')) LIKE '%2d%'
        OR LOWER(COALESCE(db_player_database, '')) LIKE '%2d%'`,
    [NINJA_2D_GAME_NAME],
  );
  await conn.execute(
    `UPDATE game_servers
     SET game_name = ?
     WHERE game_name IS NULL OR TRIM(game_name) = ''`,
    [DEFAULT_GAME_NAME],
  );
}

async function insertEvent(conn, orderCode, type, message) {
  if (NOISY_EVENT_TYPES.has(type)) {
    await pruneEvents(conn);
    return;
  }

  await conn.execute("INSERT INTO bando_events (order_code, type, message, created_at) VALUES (?, ?, ?, ?)", [
    orderCode,
    type,
    message,
    new Date().toISOString(),
  ]);
  await pruneEvents(conn);
}

async function pruneEvents(conn) {
  const now = Date.now();
  if (now - lastEventPruneAt < EVENT_PRUNE_INTERVAL_MS) return;
  lastEventPruneAt = now;

  await conn.execute("DELETE FROM bando_events WHERE type = 'inventory_synced'");

  const retentionDays = readIntegerEnv("BANDO_EVENT_RETENTION_DAYS", 30, 0, 3650);
  if (retentionDays > 0) {
    const cutoff = new Date(now - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    await conn.execute("DELETE FROM bando_events WHERE created_at < ?", [cutoff]);
  }

  const maxRows = readIntegerEnv("BANDO_EVENT_MAX_ROWS", 1000, 100, 100000);
  const [rows] = await conn.query(`SELECT id FROM bando_events ORDER BY id DESC LIMIT 1 OFFSET ${maxRows}`);
  if (rows.length > 0) {
    await conn.execute("DELETE FROM bando_events WHERE id <= ?", [rows[0].id]);
  }
}

async function insertTransaction(conn, orderCode, paymentCode, amount, status, note) {
  await conn.execute(
    "INSERT INTO bando_transactions (order_code, payment_code, amount, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [orderCode, paymentCode, amount, status, note, new Date().toISOString()],
  );
}

async function readMysqlConfig() {
  const props = await readServerMysqlProperties(process.env.NSO_SERVER_MYSQL_PROPERTIES);
  return {
    host: process.env.BANDO_DB_HOST || props["nsoz.database.main.host"] || "127.0.0.1",
    port: Number(process.env.BANDO_DB_PORT || props["nsoz.database.main.port"] || 3306),
    user: process.env.BANDO_DB_USER || props["nsoz.database.main.user"] || "root",
    password: process.env.BANDO_DB_PASS ?? props["nsoz.database.main.pass"] ?? "",
    database: process.env.BANDO_DB_NAME || "bando",
    serverDatabase: process.env.NSO_SERVER_DB_NAME || props["nsoz.database.server.name"] || "ninja_game_server1",
  };
}

async function readServerMysqlProperties(explicitPath) {
  const result = {};
  const propertiesPath = explicitPath || "C:/Users/PC/Desktop/Code/nso-server/mysql.properties";
  try {
    const raw = await readFile(propertiesPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const index = trimmed.indexOf("=");
      if (index < 0) continue;
      result[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim();
    }
  } catch {
  }
  return result;
}

async function listItemsForServer(conn, gameName, serverName) {
  const normalizedGameName = normalizeGameName(gameName);
  const normalizedServerName = normalizeServerName(serverName);
  if (normalizedServerName) {
    const [specificRows] = await conn.query(
      `SELECT * FROM bando_items
       WHERE game_name = ? AND server_name = ?
       ORDER BY active DESC, name ASC`,
      [normalizedGameName, normalizedServerName],
    );
    return specificRows;
  }

  const [rows] = await conn.query(
    `SELECT * FROM bando_items
     WHERE game_name = ?
     ORDER BY active DESC, server_name ASC, name ASC`,
    [normalizedGameName],
  );
  return rows;
}

async function syncItemsFromConfiguredServer(conn, gameName, serverName, options = {}) {
  const normalizedGameName = normalizeGameName(gameName);
  const normalizedServerName = normalizeServerName(serverName);
  if (!normalizedServerName) {
    return { ok: true, skipped: true, reason: "missing-server", gameName: normalizedGameName, serverName: "" };
  }

  const intervalMs = readIntegerEnv("BANDO_SERVER_ITEM_SYNC_MS", 0, 0, 3_600_000);
  const cacheKey = `${normalizedGameName.toLowerCase()}::${normalizedServerName.toLowerCase()}`;
  const cachedAt = itemSyncCache.get(cacheKey) || 0;
  if (!options.force && intervalMs > 0 && Date.now() - cachedAt < intervalMs) {
    return { ok: true, skipped: true, reason: "cached", gameName: normalizedGameName, serverName: normalizedServerName };
  }

  const gameServer = await findGameServerForImport(conn, normalizedGameName, normalizedServerName);
  if (!gameServer) {
    const result = {
      ok: false,
      skipped: true,
      reason: "missing-config",
      error: `Chưa cấu hình DB cho game '${normalizedGameName}' / server '${normalizedServerName}'. Hãy import file game_servers.sql vào bảng game_servers của DB bando.`,
      gameName: normalizedGameName,
      serverName: normalizedServerName,
    };
    return options.failWhenMissing ? result : { ...result, ok: true };
  }

  const sourceResult = await readItemsFromGameServer(gameServer);
  if (!sourceResult.ok) {
    return options.failWhenMissing ? sourceResult : { ...sourceResult, skipped: true };
  }

  const result = await upsertImportedItems(conn, {
    gameName: normalizedGameName,
    serverName: normalizedServerName,
    rows: sourceResult.rows,
    sourceDatabase: sourceResult.sourceDatabase,
  });
  itemSyncCache.set(cacheKey, Date.now());
  return result;
}

async function upsertImportedItems(conn, { gameName, serverName, rows, sourceDatabase }) {
  const normalizedGameName = normalizeGameName(gameName);
  const normalizedServerName = normalizeServerName(serverName) || "default";
  const now = new Date().toISOString();
  let imported = 0;

  for (const row of rows) {
    const itemId = Number(row.id);
    const name = String(row.name ?? "").trim();
    if (!Number.isInteger(itemId) || itemId < 0 || !name) continue;

    await conn.execute(
      `INSERT INTO bando_items (
        code, game_name, server_name, item_id, name, buy_name, aliases, unit, sell_price, stock, active, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        item_id = VALUES(item_id),
        name = VALUES(name),
        updated_at = VALUES(updated_at)`,
      [
        createScopedItemCode(normalizedGameName, normalizedServerName, itemId),
        normalizedGameName,
        normalizedServerName,
        itemId,
        name,
        `vp${itemId}`,
        JSON.stringify([`vp${itemId}`, `item-${itemId}`]),
        "cái",
        0,
        0,
        0,
        now,
      ],
    );
    imported++;
  }

  return { ok: true, imported, gameName: normalizedGameName, serverName: normalizedServerName, sourceDatabase };
}

async function findGameServerForImport(conn, gameName, serverName) {
  const [rows] = await conn.query(
    `SELECT *
     FROM game_servers
     WHERE name = ? AND game_name = ?
     ORDER BY is_default DESC, display_order ASC, id ASC
     LIMIT 1`,
    [serverName, normalizeGameName(gameName)],
  );
  if (rows.length > 0) return mapGameServer(rows[0]);
  return null;
}

async function readItemsFromGameServer(gameServer) {
  let sourceConn = null;
  try {
    sourceConn = await mysql.createConnection({
      host: gameServer.dbHost,
      port: Number(gameServer.dbPort) || 3306,
      user: gameServer.dbUser,
      password: gameServer.dbPassword || "",
      database: safeIdentifier(gameServer.dbGameDatabase),
      charset: "utf8mb4",
    });
    const [rows] = await sourceConn.query("SELECT id, name FROM `item` ORDER BY id ASC");
    return { ok: true, rows, sourceDatabase: gameServer.dbGameDatabase };
  } catch (error) {
    return {
      ok: false,
      error: `Khong ket noi duoc DB game cua server '${gameServer.name}': ${error instanceof Error ? error.message : error}`,
    };
  } finally {
    if (sourceConn) await sourceConn.end().catch(() => undefined);
  }
}

function gameServerValues(server) {
  return [
    normalizeGameName(server.gameName),
    String(server.name || "").trim(),
    String(server.code || "").trim(),
    normalizeGameServerStatus(server.status),
    String(server.dbHost || "").trim(),
    Math.max(1, Math.trunc(Number(server.dbPort) || 3306)),
    String(server.dbUser || "").trim(),
    String(server.dbPassword ?? "").trim(),
    String(server.dbGameDatabase || "").trim(),
    String(server.dbPlayerDatabase || "").trim(),
    String(server.socketHost || "").trim(),
    Math.max(1, Math.trunc(Number(server.socketPort) || 5900)),
    String(server.socketKey || "").trim(),
    String(server.socketPortWeb ?? "").trim() || null,
    String(server.socketKeyWeb ?? "").trim() || null,
    server.isDefault ? 1 : 0,
    Math.trunc(Number(server.displayOrder) || 0),
    String(server.dayOpen ?? "").trim() || null,
  ];
}

function mapAdminUser(row) {
  return {
    id: toNumber(row.id, 0),
    username: String(row.username ?? ""),
    passwordHash: String(row.password_hash ?? ""),
    passwordSalt: String(row.password_salt ?? ""),
    role: String(row.role ?? "admin"),
    active: Boolean(toNumber(row.active, 0)),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function mapGameServer(row) {
  return {
    id: toNumber(row.id, 0),
    gameName: normalizeGameName(row.game_name),
    name: String(row.name ?? ""),
    code: String(row.code ?? ""),
    status: String(row.status ?? "offline"),
    dbHost: String(row.db_host ?? ""),
    dbPort: toNumber(row.db_port, 3306),
    dbUser: String(row.db_user ?? ""),
    dbPassword: String(row.db_password ?? ""),
    dbGameDatabase: String(row.db_game_database ?? ""),
    dbPlayerDatabase: String(row.db_player_database ?? ""),
    socketHost: String(row.socket_host ?? ""),
    socketPort: toNumber(row.socket_port, 5900),
    socketKey: String(row.socket_key ?? ""),
    socketPortWeb: row.socket_port_web == null ? "" : String(row.socket_port_web),
    socketKeyWeb: row.socket_key_web == null ? "" : String(row.socket_key_web),
    isDefault: Boolean(toNumber(row.is_default, 0)),
    displayOrder: toNumber(row.display_order, 0),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
    dayOpen: row.day_open == null ? "" : String(row.day_open),
  };
}

function mapPublicGameServer(row) {
  const server = mapGameServer(row);
  return {
    id: server.id,
    gameName: server.gameName,
    name: server.name,
    code: server.code,
    status: server.status,
    isDefault: server.isDefault,
    displayOrder: server.displayOrder,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    dayOpen: server.dayOpen,
  };
}

function mapItem(row) {
  const code = String(row.code ?? "");
  const buyName = String(row.buy_name ?? row.buyName ?? code).trim() || code;
  return {
    code,
    gameName: normalizeGameName(row.game_name),
    serverName: normalizeServerName(row.server_name) || "default",
    itemId: row.item_id == null ? null : toNumber(row.item_id, 0),
    name: String(row.name ?? ""),
    buyName,
    aliases: safeAliases(String(row.aliases ?? "[]"), buyName, code),
    unit: String(row.unit ?? "cái"),
    sellPrice: toNumber(row.sell_price, 0),
    stock: toNumber(row.stock, 0),
    active: Boolean(toNumber(row.active, 0)),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function applyLiveStock(item, liveStockByItemId) {
  if (item.itemId == null) return item;
  if (!liveStockByItemId.has(item.itemId)) {
    return {
      ...item,
      stock: 0,
      stockSource: "inventory",
      stockUpdatedAt: null,
    };
  }
  const liveStock = liveStockByItemId.get(item.itemId);
  return {
    ...item,
    stock: liveStock.quantity,
    stockSource: "inventory",
    stockUpdatedAt: liveStock.updatedAt,
  };
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

function mapOrder(row) {
  return {
    id: toNumber(row.id, 0),
    orderCode: String(row.order_code ?? ""),
    paymentCode: String(row.payment_code ?? ""),
    characterName: String(row.character_name ?? ""),
    gameName: normalizeGameName(row.game_name),
    serverName: String(row.server_name ?? ""),
    itemCode: String(row.item_code ?? ""),
    itemId: row.item_id == null ? itemIdFromCode(row.item_code) : toNumber(row.item_id, -1),
    itemName: String(row.item_name ?? ""),
    quantity: toNumber(row.quantity, 0),
    unitPrice: toNumber(row.unit_price, 0),
    totalAmount: toNumber(row.total_amount, 0),
    status: String(row.status ?? "awaiting_payment"),
    privateMessage: String(row.private_message ?? ""),
    createdAt: String(row.created_at ?? ""),
    paidAt: row.paid_at == null ? null : String(row.paid_at),
    deliveredAt: row.delivered_at == null ? null : String(row.delivered_at),
  };
}

function mapCoinTrade(row) {
  return {
    id: toNumber(row.id, 0),
    orderCode: String(row.order_code ?? ""),
    paymentCode: row.payment_code == null ? "" : String(row.payment_code),
    characterName: String(row.character_name ?? ""),
    gameName: normalizeGameName(row.game_name),
    serverName: String(row.server_name ?? ""),
    type: String(row.type ?? ""),
    coinAmount: toNumber(row.coin_amount, 0),
    receivedCoinAmount: toNumber(row.received_coin_amount, 0),
    rate: toNumber(row.rate, 0),
    totalAmount: toNumber(row.total_amount, 0),
    status: String(row.status ?? ""),
    bankName: String(row.bank_name ?? ""),
    accountNumber: String(row.account_number ?? ""),
    accountName: String(row.account_name ?? ""),
    createdAt: String(row.created_at ?? ""),
    paidAt: row.paid_at == null ? null : String(row.paid_at),
    completedAt: row.completed_at == null ? null : String(row.completed_at),
    payoutNotifiedAt: row.payout_notified_at == null ? null : String(row.payout_notified_at),
  };
}

function toCoinReceiveDeliveryJob(trade) {
  return {
    type: "receive_coin",
    orderCode: trade.orderCode,
    paymentCode: trade.paymentCode || "",
    characterName: trade.characterName,
    gameName: trade.gameName,
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
    gameName: trade.gameName,
    serverName: trade.serverName,
    message: `Da thanh toan so tien ${formatVnd(trade.totalAmount)} cho don ${trade.orderCode}.`,
  };
}

function mapTransaction(row) {
  return {
    id: toNumber(row.id, 0),
    orderCode: row.order_code == null ? null : String(row.order_code),
    paymentCode: String(row.payment_code ?? ""),
    amount: toNumber(row.amount, 0),
    status: String(row.status ?? "rejected"),
    note: String(row.note ?? ""),
    createdAt: String(row.created_at ?? ""),
  };
}

function buildRevenueStatsResult(fromIso, toIso, sellRow = {}, buyRow = {}) {
  const sell = {
    totalOrders: toNumber(sellRow.total_orders, 0),
    totalAmount: toNumber(sellRow.total_amount, 0),
    coinOrders: toNumber(sellRow.coin_orders, 0),
    coinAmount: toNumber(sellRow.coin_amount, 0),
    itemOrders: toNumber(sellRow.item_orders, 0),
    itemAmount: toNumber(sellRow.item_amount, 0),
  };
  const buy = {
    totalOrders: toNumber(buyRow.coin_orders, 0),
    totalAmount: toNumber(buyRow.coin_amount, 0),
    coinOrders: toNumber(buyRow.coin_orders, 0),
    coinAmount: toNumber(buyRow.coin_amount, 0),
  };

  return {
    ok: true,
    fromIso,
    toIso,
    sell,
    buy,
    netAmount: sell.totalAmount - buy.totalAmount,
    storage: "mysql",
  };
}

function mapEvent(row) {
  return {
    id: toNumber(row.id, 0),
    orderCode: row.order_code == null ? null : String(row.order_code),
    type: String(row.type ?? ""),
    message: String(row.message ?? ""),
    createdAt: String(row.created_at ?? ""),
  };
}

function mapBankAccount(row) {
  return {
    id: toNumber(row.id, 0),
    bankName: String(row.bank_name ?? ""),
    bankCode: String(row.bank_code ?? ""),
    accountNumber: String(row.account_number ?? ""),
    accountName: String(row.account_name ?? ""),
    paymentPrefix: String(row.payment_prefix ?? ""),
    callbackSignature: String(row.callback_signature ?? ""),
    active: Boolean(toNumber(row.active, 0)),
    createdAt: String(row.created_at ?? ""),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function itemIdFromCode(code) {
  const match = String(code ?? "").match(/(?:^|-)item-(\d+)$/);
  return match ? Number(match[1]) : -1;
}

function safeAliases(value, buyName, code) {
  try {
    const aliases = JSON.parse(value);
    if (Array.isArray(aliases)) return normalizeAliases(aliases.map(String), buyName, code);
  } catch {
  }
  return normalizeAliases([], buyName, code);
}

function normalizeAliases(value, buyName, code) {
  return Array.from(
    new Set([buyName, code, ...(value ?? [])].map((alias) => String(alias).trim().toLowerCase()).filter(Boolean)),
  );
}

function toNumber(value, fallback) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function readIntegerEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function normalizeGameName(value) {
  return String(value || DEFAULT_GAME_NAME).trim() || DEFAULT_GAME_NAME;
}

function normalizeServerName(value) {
  return String(value || "").trim();
}

function normalizeGameServerStatus(value) {
  const status = String(value || "offline").trim().toLowerCase();
  return ["online", "offline", "maintenance", "new"].includes(status) ? status : "offline";
}

function createScopedItemCode(gameName, serverName, itemId) {
  const gamePart = slugPart(gameName, "game");
  const serverPart = slugPart(serverName, "server");
  return `${gamePart}-${serverPart}-item-${itemId}`.slice(0, 96);
}

function slugPart(value, fallback) {
  const text = String(value || fallback)
    .trim()
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return (text || fallback).slice(0, 28);
}

function normalizePaymentPrefix(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

function formatIndexColumns(value) {
  return String(value)
    .split(",")
    .map((column) => `\`${safeIdentifier(column.trim())}\``)
    .join(", ");
}

function safeIdentifier(value) {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) {
    throw new Error(`Tên MySQL không an toàn: ${value}`);
  }
  return value;
}
