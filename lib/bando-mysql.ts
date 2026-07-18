import { formatVnd } from "./bando-command";
import type { BandoEvent, BandoItem, BandoOrder, BandoState, BandoTransaction } from "./bando-types";

type MysqlConnection = {
  execute<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown]>;
  query<T = unknown>(sql: string, values?: unknown[]): Promise<[T, unknown]>;
  end(): Promise<void>;
};

type MysqlConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  serverDatabase: string;
};

const MYSQL_DISABLED_MS = 10_000;
let mysqlDisabledUntil = 0;

export async function listBandoStateMysql(): Promise<BandoState | null> {
  const direct = await withBandoConnection(async (conn) => {
    const [itemRows] = await conn.query<Record<string, unknown>[]>(
      "SELECT * FROM bando_items ORDER BY active DESC, name ASC",
    );
    const [orderRows] = await conn.query<Record<string, unknown>[]>(
      "SELECT * FROM bando_orders ORDER BY id DESC LIMIT 60",
    );
    const [transactionRows] = await conn.query<Record<string, unknown>[]>(
      "SELECT * FROM bando_transactions ORDER BY id DESC LIMIT 60",
    );
    const [eventRows] = await conn.query<Record<string, unknown>[]>(
      "SELECT * FROM bando_events ORDER BY id DESC LIMIT 80",
    );

    return {
      items: itemRows.map(mapItem),
      orders: orderRows.map(mapOrder),
      transactions: transactionRows.map(mapTransaction),
      events: eventRows.map(mapEvent),
      storage: "mysql" as const,
    };
  });
  return direct ?? callLocalMysqlApi<BandoState>("/state", { method: "GET" });
}

export async function insertBandoOrderMysql(order: BandoOrder) {
  const direct = await withBandoConnection(async (conn) => {
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
  });
  if (direct != null) return direct;
  const result = await callLocalMysqlApi<{ ok: boolean }>("/orders/insert", {
    method: "POST",
    body: JSON.stringify(order),
  });
  return result?.ok ?? null;
}

export async function confirmPaymentMysql(paymentCode: string, amount: number, note: string) {
  const direct = await withBandoConnection(async (conn) => {
    const [rows] = await conn.query<Record<string, unknown>[]>(
      "SELECT * FROM bando_orders WHERE payment_code = ? LIMIT 1",
      [paymentCode],
    );

    if (rows.length === 0) {
      await insertTransaction(conn, null, paymentCode, amount, "rejected", note || "Không tìm thấy mã giao dịch");
      return { ok: false as const, error: "Không tìm thấy mã giao dịch." };
    }

    const order = mapOrder(rows[0]);
    if (order.status === "completed") {
      return { ok: false as const, error: "Đơn này đã hoàn tất." };
    }

    if (order.totalAmount !== amount) {
      await insertTransaction(conn, order.orderCode, paymentCode, amount, "rejected", note || "Sai số tiền");
      await insertEvent(
        conn,
        order.orderCode,
        "payment_rejected",
        `Sai số tiền: nhận ${formatVnd(amount)}, cần ${formatVnd(order.totalAmount)}.`,
      );
      return { ok: false as const, error: `Sai số tiền. Cần thanh toán ${formatVnd(order.totalAmount)}.` };
    }

    const paidAt = new Date().toISOString();
    await conn.execute("UPDATE bando_orders SET status = ?, paid_at = ? WHERE order_code = ?", [
      "paid",
      paidAt,
      order.orderCode,
    ]);
    await insertTransaction(conn, order.orderCode, paymentCode, amount, "matched", note || "Đã khớp thanh toán");
    await insertEvent(conn, order.orderCode, "payment_matched", `Đã nhận đúng ${formatVnd(amount)}.`);

    return { ok: true as const, order: { ...order, status: "paid" as const, paidAt } };
  });
  return direct ?? callLocalMysqlApi<Awaited<typeof direct>>("/payments/confirm", {
    method: "POST",
    body: JSON.stringify({ paymentCode, amount, note }),
  });
}

export async function confirmDeliveryMysql(orderCode: string, botName: string) {
  const direct = await withBandoConnection(async (conn) => {
    const [rows] = await conn.query<Record<string, unknown>[]>(
      "SELECT * FROM bando_orders WHERE order_code = ? LIMIT 1",
      [orderCode],
    );

    if (rows.length === 0) {
      return { ok: false as const, error: "Không tìm thấy đơn." };
    }

    const order = mapOrder(rows[0]);
    if (order.status !== "paid") {
      return { ok: false as const, error: "Chỉ giao hàng khi đơn đã thanh toán đúng." };
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
    await insertEvent(conn, orderCode, "delivery_completed", `${botName} đã giao ${order.quantity} ${order.itemName}.`);

    return { ok: true as const, order: { ...order, status: "completed" as const, deliveredAt } };
  });
  return direct ?? callLocalMysqlApi<Awaited<typeof direct>>("/deliveries/confirm", {
    method: "POST",
    body: JSON.stringify({ orderCode, botName }),
  });
}

export async function updateBandoItemMysql(args: {
  code: string;
  itemId?: number | null;
  name?: string;
  buyName?: string;
  aliases?: string[];
  unit?: string;
  sellPrice: number;
  stock: number;
  active?: boolean;
}) {
  const direct = await withBandoConnection(async (conn) => {
    const now = new Date().toISOString();
    const code = args.code.trim().toLowerCase();
    const buyName = args.buyName?.trim().toLowerCase() || code;
    const aliases = normalizeAliases(args.aliases, buyName, code);

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
        args.itemId ?? null,
        args.name?.trim() || code,
        buyName,
        JSON.stringify(aliases),
        args.unit?.trim() || "cai",
        args.sellPrice,
        args.stock,
        args.active === false ? 0 : 1,
        now,
      ],
    );
    await insertEvent(conn, null, "price_updated", `Cập nhật ${buyName}: ${formatVnd(args.sellPrice)}, tồn ${args.stock}.`);

    const [rows] = await conn.query<Record<string, unknown>[]>("SELECT * FROM bando_items WHERE code = ? LIMIT 1", [code]);
    return { ok: true as const, item: rows[0] ? mapItem(rows[0]) : null };
  });
  return direct ?? callLocalMysqlApi<Awaited<typeof direct>>("/items", {
    method: "PATCH",
    body: JSON.stringify(args),
  });
}

export async function importServerItemsMysql() {
  const direct = await withBandoConnection(async (conn, config) => {
    const serverDb = safeIdentifier(config.serverDatabase);
    const [rows] = await conn.query<Record<string, unknown>[]>(
      `SELECT id, name FROM \`${serverDb}\`.\`item\` ORDER BY id ASC`,
    );

    const now = new Date().toISOString();
    let imported = 0;
    for (const row of rows) {
      const itemId = toNumber(row.id, -1);
      const name = String(row.name ?? "").trim();
      if (itemId < 0 || !name) continue;

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
    return { ok: true as const, imported };
  });
  return direct ?? callLocalMysqlApi<Awaited<typeof direct>>("/items/import-server", { method: "POST" });
}

async function withBandoConnection<T>(
  action: (conn: MysqlConnection, config: MysqlConfig) => Promise<T>,
): Promise<T | null> {
  if (getProcessEnv().BANDO_DISABLE_MYSQL === "1") return null;
  if (Date.now() < mysqlDisabledUntil) return null;

  let conn: MysqlConnection | null = null;
  try {
    const config = await readMysqlConfig();
    if (!config) return null;
    const mysql = await importMysqlModule();
    if (!mysql) return null;

    await ensureDatabase(mysql, config);
    conn = (await mysql.createConnection({
      host: config.host,
      port: config.port,
      user: config.user,
      password: config.password,
      database: config.database,
      charset: "utf8mb4",
    })) as MysqlConnection;

    await ensureBandoMysqlSchema(conn);
    return await action(conn, config);
  } catch (error) {
    mysqlDisabledUntil = Date.now() + MYSQL_DISABLED_MS;
    console.warn("[bando:mysql] fallback to memory:", error instanceof Error ? error.message : error);
    return null;
  } finally {
    if (conn) await conn.end().catch(() => undefined);
  }
}

async function callLocalMysqlApi<T>(path: string, init: RequestInit): Promise<T | null> {
  if (getProcessEnv().BANDO_DISABLE_MYSQL === "1") return null;
  const baseUrl = getProcessEnv().BANDO_MYSQL_API || "http://127.0.0.1:3010";
  try {
    const headers = new Headers(init.headers);
    if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
    const response = await fetch(`${baseUrl}${path}`, {
      ...init,
      headers,
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

async function ensureDatabase(mysql: { createConnection(config: unknown): Promise<MysqlConnection> }, config: MysqlConfig) {
  const admin = (await mysql.createConnection({
    host: config.host,
    port: config.port,
    user: config.user,
    password: config.password,
    charset: "utf8mb4",
  })) as MysqlConnection;
  try {
    await admin.execute(
      `CREATE DATABASE IF NOT EXISTS \`${safeIdentifier(config.database)}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    );
  } finally {
    await admin.end().catch(() => undefined);
  }
}

async function ensureBandoMysqlSchema(conn: MysqlConnection) {
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

async function ensureColumn(conn: MysqlConnection, table: string, column: string, definition: string) {
  const [rows] = await conn.query<Record<string, unknown>[]>(
    `SHOW COLUMNS FROM \`${safeIdentifier(table)}\` LIKE ?`,
    [column],
  );
  if (rows.length > 0) return;
  await conn.execute(`ALTER TABLE \`${safeIdentifier(table)}\` ADD COLUMN \`${safeIdentifier(column)}\` ${definition}`);
}

async function insertEvent(conn: MysqlConnection, orderCode: string | null, type: string, message: string) {
  await conn.execute("INSERT INTO bando_events (order_code, type, message, created_at) VALUES (?, ?, ?, ?)", [
    orderCode,
    type,
    message,
    new Date().toISOString(),
  ]);
}

async function insertTransaction(
  conn: MysqlConnection,
  orderCode: string | null,
  paymentCode: string,
  amount: number,
  status: BandoTransaction["status"],
  note: string,
) {
  await conn.execute(
    "INSERT INTO bando_transactions (order_code, payment_code, amount, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    [orderCode, paymentCode, amount, status, note, new Date().toISOString()],
  );
}

async function readMysqlConfig(): Promise<MysqlConfig | null> {
  const env = getProcessEnv();
  const props = await readServerMysqlProperties(env.NSO_SERVER_MYSQL_PROPERTIES);

  return {
    host: env.BANDO_DB_HOST || props["nsoz.database.main.host"] || "127.0.0.1",
    port: Number(env.BANDO_DB_PORT || props["nsoz.database.main.port"] || 3306),
    user: env.BANDO_DB_USER || props["nsoz.database.main.user"] || "root",
    password: env.BANDO_DB_PASS ?? props["nsoz.database.main.pass"] ?? "",
    database: env.BANDO_DB_NAME || "bando",
    serverDatabase: env.NSO_SERVER_DB_NAME || props["nsoz.database.server.name"] || "ninja_game_server1",
  };
}

async function readServerMysqlProperties(explicitPath?: string) {
  const result: Record<string, string> = {};
  const propertiesPath = explicitPath || "C:\\Users\\PC\\Desktop\\Code\\nso-server\\mysql.properties";
  try {
    const fs = (await hiddenImport("node:fs/promises")) as { readFile(path: string, encoding: string): Promise<string> };
    const raw = await fs.readFile(propertiesPath, "utf8");
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

async function importMysqlModule() {
  try {
    return (await hiddenImport("mysql2/promise")) as { createConnection(config: unknown): Promise<MysqlConnection> };
  } catch {
    return null;
  }
}

function hiddenImport(moduleName: string) {
  const importer = new Function("moduleName", "return import(moduleName)") as (name: string) => Promise<unknown>;
  return importer(moduleName);
}

function getProcessEnv() {
  if (typeof process === "undefined") return {} as Record<string, string | undefined>;
  return process.env as Record<string, string | undefined>;
}

function mapItem(row: Record<string, unknown>): BandoItem {
  const code = String(row.code ?? "");
  const buyName = String(row.buy_name ?? row.buyName ?? code).trim() || code;
  return {
    code,
    itemId: row.item_id == null ? null : toNumber(row.item_id, 0),
    name: String(row.name ?? ""),
    buyName,
    aliases: safeAliases(String(row.aliases ?? "[]"), buyName, code),
    unit: String(row.unit ?? "cai"),
    sellPrice: toNumber(row.sell_price, 0),
    stock: toNumber(row.stock, 0),
    active: Boolean(toNumber(row.active, 0)),
    updatedAt: String(row.updated_at ?? ""),
  };
}

function mapOrder(row: Record<string, unknown>): BandoOrder {
  return {
    id: toNumber(row.id, 0),
    orderCode: String(row.order_code ?? ""),
    paymentCode: String(row.payment_code ?? ""),
    characterName: String(row.character_name ?? ""),
    serverName: String(row.server_name ?? ""),
    itemCode: String(row.item_code ?? ""),
    itemName: String(row.item_name ?? ""),
    quantity: toNumber(row.quantity, 0),
    unitPrice: toNumber(row.unit_price, 0),
    totalAmount: toNumber(row.total_amount, 0),
    status: String(row.status ?? "awaiting_payment") as BandoOrder["status"],
    privateMessage: String(row.private_message ?? ""),
    createdAt: String(row.created_at ?? ""),
    paidAt: row.paid_at == null ? null : String(row.paid_at),
    deliveredAt: row.delivered_at == null ? null : String(row.delivered_at),
  };
}

function mapTransaction(row: Record<string, unknown>): BandoTransaction {
  return {
    id: toNumber(row.id, 0),
    orderCode: row.order_code == null ? null : String(row.order_code),
    paymentCode: String(row.payment_code ?? ""),
    amount: toNumber(row.amount, 0),
    status: String(row.status ?? "rejected") as BandoTransaction["status"],
    note: String(row.note ?? ""),
    createdAt: String(row.created_at ?? ""),
  };
}

function mapEvent(row: Record<string, unknown>): BandoEvent {
  return {
    id: toNumber(row.id, 0),
    orderCode: row.order_code == null ? null : String(row.order_code),
    type: String(row.type ?? ""),
    message: String(row.message ?? ""),
    createdAt: String(row.created_at ?? ""),
  };
}

function safeAliases(value: string, buyName: string, code: string) {
  try {
    const aliases = JSON.parse(value);
    if (Array.isArray(aliases)) return normalizeAliases(aliases.map(String), buyName, code);
  } catch {
  }
  return normalizeAliases([], buyName, code);
}

function normalizeAliases(value: string[] | undefined, buyName: string, code: string) {
  return Array.from(
    new Set([buyName, code, ...(value ?? [])].map((alias) => alias.trim().toLowerCase()).filter(Boolean)),
  );
}

function toNumber(value: unknown, fallback: number) {
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : fallback;
}

function safeIdentifier(value: string) {
  if (!/^[a-zA-Z0-9_]+$/.test(value)) {
    throw new Error(`Unsafe MySQL identifier: ${value}`);
  }
  return value;
}
