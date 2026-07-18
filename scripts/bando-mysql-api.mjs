import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import mysql from "mysql2/promise";

const port = Number(process.env.BANDO_MYSQL_API_PORT || 3010);

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url ?? "/", `http://${request.headers.host ?? "127.0.0.1"}`);
    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, { ok: true });
    }
    if (request.method === "GET" && url.pathname === "/state") {
      return sendJson(response, await listState());
    }
    if (request.method === "POST" && url.pathname === "/orders/insert") {
      return sendJson(response, { ok: await insertOrder(await readJson(request)) });
    }
    if (request.method === "POST" && url.pathname === "/payments/confirm") {
      return sendJson(response, await confirmPayment(await readJson(request)));
    }
    if (request.method === "POST" && url.pathname === "/deliveries/confirm") {
      return sendJson(response, await confirmDelivery(await readJson(request)));
    }
    if (request.method === "PATCH" && url.pathname === "/items") {
      return sendJson(response, await upsertItem(await readJson(request)));
    }
    if (request.method === "POST" && url.pathname === "/items/import-server") {
      return sendJson(response, await importServerItems());
    }

    sendJson(response, { error: "Không tìm thấy." }, 404);
  } catch (error) {
    sendJson(response, { error: error instanceof Error ? error.message : "Lỗi MySQL local của bán đồ." }, 500);
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[bando:mysql-api] listening http://127.0.0.1:${port}`);
});

async function connect() {
  const config = await readMysqlConfig();
  const admin = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    charset: "utf8mb4",
  });
  await admin.execute(`CREATE DATABASE IF NOT EXISTS \`${safeIdentifier(config.database)}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await admin.end();

  const conn = await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    database: config.database,
    charset: "utf8mb4",
  });
  await ensureSchema(conn);
  return { conn, config };
}

async function listState() {
  const { conn } = await connect();
  try {
    const [items] = await conn.query("SELECT * FROM bando_items ORDER BY active DESC, name ASC");
    const [orders] = await conn.query("SELECT * FROM bando_orders ORDER BY id DESC LIMIT 60");
    const [transactions] = await conn.query("SELECT * FROM bando_transactions ORDER BY id DESC LIMIT 60");
    const [events] = await conn.query("SELECT * FROM bando_events ORDER BY id DESC LIMIT 80");
    return {
      items: items.map(mapItem),
      orders: orders.map(mapOrder),
      transactions: transactions.map(mapTransaction),
      events: events.map(mapEvent),
      storage: "mysql",
    };
  } finally {
    await conn.end();
  }
}

async function insertOrder(order) {
  const { conn } = await connect();
  try {
    await conn.execute(
      `INSERT INTO bando_orders (
        order_code, payment_code, character_name, server_name, item_code, item_name,
        quantity, unit_price, total_amount, status, private_message, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        order.orderCode,
        order.paymentCode,
        order.characterName,
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
  } finally {
    await conn.end();
  }
}

async function confirmPayment(body) {
  const paymentCode = String(body.paymentCode ?? "").trim().toUpperCase();
  const amount = Number(body.amount);
  const note = String(body.note ?? "");
  const { conn } = await connect();
  try {
    const [rows] = await conn.query("SELECT * FROM bando_orders WHERE payment_code = ? LIMIT 1", [paymentCode]);
    if (rows.length === 0) {
      await insertTransaction(conn, null, paymentCode, amount, "rejected", note || "Không tìm thấy mã giao dịch");
      return { ok: false, error: "Không tìm thấy mã giao dịch." };
    }
    const order = mapOrder(rows[0]);
    if (order.status === "completed") return { ok: false, error: "Đơn này đã hoàn tất." };
    if (order.totalAmount !== amount) {
      await insertTransaction(conn, order.orderCode, paymentCode, amount, "rejected", note || "Sai số tiền");
      await insertEvent(conn, order.orderCode, "payment_rejected", `Sai số tiền: nhận ${formatVnd(amount)}, cần ${formatVnd(order.totalAmount)}.`);
      return { ok: false, error: `Sai số tiền. Cần thanh toán ${formatVnd(order.totalAmount)}.` };
    }

    const paidAt = new Date().toISOString();
    await conn.execute("UPDATE bando_orders SET status = ?, paid_at = ? WHERE order_code = ?", ["paid", paidAt, order.orderCode]);
    await insertTransaction(conn, order.orderCode, paymentCode, amount, "matched", note || "Đã khớp thanh toán");
    await insertEvent(conn, order.orderCode, "payment_matched", `Đã nhận đúng ${formatVnd(amount)}.`);
    return { ok: true, order: { ...order, status: "paid", paidAt } };
  } finally {
    await conn.end();
  }
}

async function confirmDelivery(body) {
  const orderCode = String(body.orderCode ?? "").trim().toUpperCase();
  const botName = String(body.botName ?? "NinjaBot");
  const { conn } = await connect();
  try {
    const [rows] = await conn.query("SELECT * FROM bando_orders WHERE order_code = ? LIMIT 1", [orderCode]);
    if (rows.length === 0) return { ok: false, error: "Không tìm thấy đơn." };
    const order = mapOrder(rows[0]);
    if (order.status !== "paid") return { ok: false, error: "Chỉ giao hàng khi đơn đã thanh toán đúng." };

    const deliveredAt = new Date().toISOString();
    await conn.execute("UPDATE bando_orders SET status = ?, delivered_at = ? WHERE order_code = ?", ["completed", deliveredAt, orderCode]);
    await conn.execute("UPDATE bando_items SET stock = GREATEST(stock - ?, 0), updated_at = ? WHERE code = ?", [
      order.quantity,
      deliveredAt,
      order.itemCode,
    ]);
    await insertEvent(conn, orderCode, "delivery_completed", `${botName} đã giao ${order.quantity} ${order.itemName}.`);
    return { ok: true, order: { ...order, status: "completed", deliveredAt } };
  } finally {
    await conn.end();
  }
}

async function upsertItem(body) {
  const code = String(body.code ?? "").trim().toLowerCase();
  const buyName = String(body.buyName ?? code).trim().toLowerCase() || code;
  const aliases = normalizeAliases(body.aliases, buyName, code);
  const now = new Date().toISOString();
  const { conn } = await connect();
  try {
    await conn.execute(
      `INSERT INTO bando_items (
        code, item_id, name, buy_name, aliases, unit, sell_price, stock, active, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
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
        body.itemId ?? null,
        String(body.name ?? code),
        buyName,
        JSON.stringify(aliases),
        String(body.unit ?? "cai"),
        Number(body.sellPrice),
        Number(body.stock),
        body.active === false ? 0 : 1,
        now,
      ],
    );
    await insertEvent(conn, null, "price_updated", `Cập nhật ${buyName}: ${formatVnd(Number(body.sellPrice))}, tồn ${Number(body.stock)}.`);
    const [rows] = await conn.query("SELECT * FROM bando_items WHERE code = ? LIMIT 1", [code]);
    return { ok: true, item: rows[0] ? mapItem(rows[0]) : null };
  } finally {
    await conn.end();
  }
}

async function importServerItems() {
  const { conn, config } = await connect();
  try {
    const serverDb = safeIdentifier(config.serverDatabase);
    const [rows] = await conn.query(`SELECT id, name FROM \`${serverDb}\`.\`item\` ORDER BY id ASC`);
    const now = new Date().toISOString();
    let imported = 0;
    for (const row of rows) {
      const itemId = Number(row.id);
      const name = String(row.name ?? "").trim();
      if (!Number.isInteger(itemId) || itemId < 0 || !name) continue;
      await conn.execute(
        `INSERT INTO bando_items (
          code, item_id, name, buy_name, aliases, unit, sell_price, stock, active, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE
          item_id = VALUES(item_id),
          name = VALUES(name),
          updated_at = VALUES(updated_at)`,
        [`item-${itemId}`, itemId, name, `vp${itemId}`, JSON.stringify([`vp${itemId}`, `item-${itemId}`]), "cai", 0, 0, 0, now],
      );
      imported++;
    }
    await insertEvent(conn, null, "server_items_imported", `Đồng bộ ${imported} vật phẩm từ DB server.`);
    return { ok: true, imported };
  } finally {
    await conn.end();
  }
}

async function ensureSchema(conn) {
  await conn.execute(
    `CREATE TABLE IF NOT EXISTS bando_items (
      code VARCHAR(96) PRIMARY KEY,
      item_id INT NULL,
      name VARCHAR(255) NOT NULL,
      buy_name VARCHAR(96) NOT NULL DEFAULT '',
      aliases TEXT NOT NULL,
      unit VARCHAR(32) NOT NULL DEFAULT 'cai',
      sell_price INT NOT NULL DEFAULT 0,
      stock INT NOT NULL DEFAULT 0,
      active TINYINT NOT NULL DEFAULT 1,
      updated_at VARCHAR(40) NOT NULL,
      UNIQUE KEY bando_items_item_id_uq (item_id),
      KEY bando_items_name_idx (name),
      KEY bando_items_buy_name_idx (buy_name)
    ) CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
  );
  await conn.execute(
    `CREATE TABLE IF NOT EXISTS bando_orders (
      id INT AUTO_INCREMENT PRIMARY KEY,
      order_code VARCHAR(64) NOT NULL UNIQUE,
      payment_code VARCHAR(64) NOT NULL UNIQUE,
      character_name VARCHAR(64) NOT NULL,
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
  await ensureColumn(conn, "bando_items", "item_id", "INT NULL");
  await ensureColumn(conn, "bando_items", "buy_name", "VARCHAR(96) NOT NULL DEFAULT ''");

}

async function ensureColumn(conn, table, column, definition) {
  const [rows] = await conn.query(`SHOW COLUMNS FROM \`${safeIdentifier(table)}\` LIKE ?`, [column]);
  if (rows.length > 0) return;
  await conn.execute(`ALTER TABLE \`${safeIdentifier(table)}\` ADD COLUMN \`${safeIdentifier(column)}\` ${definition}`);
}

async function insertEvent(conn, orderCode, type, message) {
  await conn.execute("INSERT INTO bando_events (order_code, type, message, created_at) VALUES (?, ?, ?, ?)", [
    orderCode,
    type,
    message,
    new Date().toISOString(),
  ]);
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

function mapItem(row) {
  const code = String(row.code ?? "");
  const buyName = String(row.buy_name ?? code).trim() || code;
  return {
    code,
    itemId: row.item_id == null ? null : Number(row.item_id),
    name: String(row.name ?? ""),
    buyName,
    aliases: safeAliases(String(row.aliases ?? "[]"), buyName, code),
    unit: String(row.unit ?? "cai"),
    sellPrice: Number(row.sell_price ?? 0),
    stock: Number(row.stock ?? 0),
    active: Boolean(Number(row.active ?? 0)),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function mapOrder(row) {
  return {
    id: Number(row.id ?? 0),
    orderCode: String(row.order_code ?? ""),
    paymentCode: String(row.payment_code ?? ""),
    characterName: String(row.character_name ?? ""),
    serverName: String(row.server_name ?? ""),
    itemCode: String(row.item_code ?? ""),
    itemName: String(row.item_name ?? ""),
    quantity: Number(row.quantity ?? 0),
    unitPrice: Number(row.unit_price ?? 0),
    totalAmount: Number(row.total_amount ?? 0),
    status: String(row.status ?? "awaiting_payment"),
    privateMessage: String(row.private_message ?? ""),
    createdAt: String(row.created_at ?? ""),
    paidAt: row.paid_at == null ? null : String(row.paid_at),
    deliveredAt: row.delivered_at == null ? null : String(row.delivered_at),
  };
}

function mapTransaction(row) {
  return {
    id: Number(row.id ?? 0),
    orderCode: row.order_code == null ? null : String(row.order_code),
    paymentCode: String(row.payment_code ?? ""),
    amount: Number(row.amount ?? 0),
    status: String(row.status ?? "rejected"),
    note: String(row.note ?? ""),
    createdAt: String(row.created_at ?? ""),
  };
}

function mapEvent(row) {
  return {
    id: Number(row.id ?? 0),
    orderCode: row.order_code == null ? null : String(row.order_code),
    type: String(row.type ?? ""),
    message: String(row.message ?? ""),
    createdAt: String(row.created_at ?? ""),
  };
}

function safeAliases(value, buyName, code) {
  try {
    const aliases = JSON.parse(value);
    if (Array.isArray(aliases)) return normalizeAliases(aliases, buyName, code);
  } catch {
  }
  return normalizeAliases([], buyName, code);
}

function normalizeAliases(value, buyName, code) {
  return Array.from(new Set([buyName, code, ...(Array.isArray(value) ? value : [])].map((alias) => String(alias).trim().toLowerCase()).filter(Boolean)));
}

function formatVnd(amount) {
  return `${new Intl.NumberFormat("vi-VN").format(amount)} VND`;
}

function safeIdentifier(value) {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) throw new Error(`Unsafe MySQL identifier: ${value}`);
  return value;
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw ? JSON.parse(raw) : {};
}

function sendJson(response, payload, status = 200) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "http://localhost:3001",
  });
  response.end(JSON.stringify(payload));
}
