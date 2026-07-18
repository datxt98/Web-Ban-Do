import {
  buildOrderReply,
  buildCatalogReplies,
  buildHelpReplies,
  defaultBandoItems,
  findBandoItem,
  formatVnd,
  getAvailableStock,
  isListCommand,
  parseBandoPrivateChat,
  stockMapFromInventory,
} from "./bando-command";
import {
  confirmDeliveryMysql,
  confirmPaymentMysql,
  importServerItemsMysql,
  insertBandoOrderMysql,
  listBandoStateMysql,
  updateBandoItemMysql,
} from "./bando-mysql";
import type {
  BandoDeliveryJob,
  BandoEvent,
  BandoInventoryItem,
  BandoItem,
  BandoOrder,
  BandoState,
  BandoTransaction,
} from "./bando-types";

type RuntimeEnv = {
  DB?: D1Database;
  BANDO_BOT_TOKEN?: string;
};

type OrderRow = {
  id: number;
  order_code: string;
  payment_code: string;
  character_name: string;
  server_name: string;
  item_code: string;
  item_name: string;
  quantity: number;
  unit_price: number;
  total_amount: number;
  status: BandoOrder["status"];
  private_message: string;
  created_at: string;
  paid_at: string | null;
  delivered_at: string | null;
};

type ItemRow = {
  code: string;
  item_id: number | null;
  name: string;
  buy_name: string;
  aliases: string;
  unit: string;
  sell_price: number;
  stock: number;
  active: number;
  updated_at: string;
};

type TransactionRow = {
  id: number;
  order_code: string | null;
  payment_code: string;
  amount: number;
  status: BandoTransaction["status"];
  note: string;
  created_at: string;
};

type EventRow = {
  id: number;
  order_code: string | null;
  type: string;
  message: string;
  created_at: string;
};

const memoryState: BandoState = {
  items: defaultBandoItems.map((item) => ({ ...item, aliases: [...item.aliases] })),
  orders: [],
  transactions: [],
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

let memoryOrderId = 1;
let memoryTransactionId = 1;
let memoryEventId = 2;

async function getRuntimeEnv(): Promise<RuntimeEnv> {
  try {
    const runtime = (await import("cloudflare:workers")) as { env?: RuntimeEnv };
    return runtime.env ?? {};
  } catch {
    return {};
  }
}

export async function getConfiguredBotToken() {
  const runtimeEnv = await getRuntimeEnv();
  return runtimeEnv.BANDO_BOT_TOKEN?.trim() ?? "";
}

export async function authorizeBandoBot(request: Request) {
  const expected = await getConfiguredBotToken();
  if (!expected) {
    return null;
  }

  const auth = request.headers.get("authorization") ?? "";
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const supplied = request.headers.get("x-bando-token") ?? bearer;

  if (supplied === expected) {
    return null;
  }

  return Response.json({ error: "Yêu cầu BOT không được phép." }, { status: 401 });
}

export async function listBandoState(): Promise<BandoState> {
  const mysqlState = await listBandoStateMysql();
  if (mysqlState) return mysqlState;

  const runtimeEnv = await getRuntimeEnv();
  const db = runtimeEnv.DB;
  if (!db) {
    return cloneMemoryState();
  }

  await ensureBandoSchema(db);
  const [itemRows, orderRows, transactionRows, eventRows] = await Promise.all([
    db.prepare("SELECT * FROM bando_items ORDER BY name").all<ItemRow>(),
    db.prepare("SELECT * FROM bando_orders ORDER BY id DESC LIMIT 60").all<OrderRow>(),
    db.prepare("SELECT * FROM bando_transactions ORDER BY id DESC LIMIT 60").all<TransactionRow>(),
    db.prepare("SELECT * FROM bando_events ORDER BY id DESC LIMIT 80").all<EventRow>(),
  ]);

  return {
    items: itemRows.results.map(mapItem),
    orders: orderRows.results.map(mapOrder),
    transactions: transactionRows.results.map(mapTransaction),
    events: eventRows.results.map(mapEvent),
    storage: "d1",
  };
}

export async function createBandoOrderFromChat(args: {
  characterName: string;
  privateMessage: string;
  serverName?: string;
  inventory?: BandoInventoryItem[];
}) {
  const characterName = args.characterName.trim();
  const privateMessage = args.privateMessage.trim();
  const serverName = args.serverName?.trim() || "default";

  if (!characterName) {
    return { ok: false as const, error: "Thiếu tên nhân vật." };
  }

  const state = await listBandoState();
  const stockByItemId = stockMapFromInventory(args.inventory);

  if (isListCommand(privateMessage)) {
    return { ok: true as const, replies: buildCatalogReplies(state.items, stockByItemId) };
  }

  const parsed = parseBandoPrivateChat(privateMessage);
  if (!parsed.ok) {
    return { ok: true as const, replies: buildHelpReplies(state.items), reply: buildHelpReplies(state.items).join(" ") };
  }

  const item = findBandoItem(state.items, parsed.itemToken);
  if (!item) {
    return { ok: false as const, error: `Vật phẩm '${parsed.itemToken}' chưa có trong bảng giá web.` };
  }

  const availableStock = getAvailableStock(item, stockByItemId);
  if (parsed.quantity > availableStock) {
    return { ok: false as const, error: `Tồn kho ${item.name} chỉ còn ${availableStock} ${item.unit}.` };
  }

  const orderCode = createOrderCode();
  const totalAmount = parsed.quantity * item.sellPrice;
  const now = new Date().toISOString();
  const order: BandoOrder = {
    orderCode,
    paymentCode: orderCode,
    characterName,
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
    return {
      ok: true as const,
      order,
      reply: buildOrderReply({
        characterName,
        itemName: item.name,
        quantity: parsed.quantity,
        totalAmount,
        paymentCode: orderCode,
      }),
    };
  }

  const runtimeEnv = await getRuntimeEnv();
  const db = runtimeEnv.DB;
  if (db) {
    await ensureBandoSchema(db);
    await db
      .prepare(
        `INSERT INTO bando_orders (
          order_code, payment_code, character_name, server_name, item_code, item_name,
          quantity, unit_price, total_amount, status, private_message, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
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
      )
      .run();
    await insertEvent(db, orderCode, "order_created", `${characterName} tạo đơn ${orderCode} từ chat riêng.`);
  } else {
    order.id = memoryOrderId++;
    memoryState.orders.unshift(order);
    pushMemoryEvent(orderCode, "order_created", `${characterName} tạo đơn ${orderCode} từ chat riêng.`);
  }

  return {
    ok: true as const,
    order,
    reply: buildOrderReply({
      characterName,
      itemName: item.name,
      quantity: parsed.quantity,
      totalAmount,
      paymentCode: orderCode,
    }),
  };
}

export async function confirmBandoPayment(args: {
  paymentCode: string;
  amount: number;
  note?: string;
}) {
  const paymentCode = args.paymentCode.trim().toUpperCase();
  const amount = Number(args.amount);
  const note = args.note?.trim() ?? "";

  if (!paymentCode || !Number.isFinite(amount) || amount <= 0) {
    return { ok: false as const, error: "Thiếu mã giao dịch hoặc số tiền hợp lệ." };
  }

  const mysqlResult = await confirmPaymentMysql(paymentCode, amount, note);
  if (mysqlResult) {
    if (!mysqlResult.ok) return mysqlResult;
    return {
      ...mysqlResult,
      deliveryJob: toDeliveryJob(mysqlResult.order),
    };
  }

  const runtimeEnv = await getRuntimeEnv();
  const db = runtimeEnv.DB;
  if (!db) {
    return confirmPaymentMemory(paymentCode, amount, note);
  }

  await ensureBandoSchema(db);
  const row = await db
    .prepare("SELECT * FROM bando_orders WHERE payment_code = ? LIMIT 1")
    .bind(paymentCode)
    .first<OrderRow>();

  if (!row) {
    await insertTransaction(db, null, paymentCode, amount, "rejected", note || "Không tìm thấy mã giao dịch");
    return { ok: false as const, error: "Không tìm thấy mã giao dịch." };
  }

  const order = mapOrder(row);
  if (order.status === "completed") {
    return { ok: false as const, error: "Đơn này đã hoàn tất." };
  }

  if (order.totalAmount !== amount) {
    await insertTransaction(db, order.orderCode, paymentCode, amount, "rejected", note || "Sai số tiền");
    await insertEvent(
      db,
      order.orderCode,
      "payment_rejected",
      `Sai số tiền: nhận ${formatVnd(amount)}, cần ${formatVnd(order.totalAmount)}.`,
    );
    return { ok: false as const, error: `Sai số tiền. Cần thanh toán ${formatVnd(order.totalAmount)}.` };
  }

  const paidAt = new Date().toISOString();
  await db
    .prepare("UPDATE bando_orders SET status = ?, paid_at = ? WHERE order_code = ?")
    .bind("paid", paidAt, order.orderCode)
    .run();
  await insertTransaction(db, order.orderCode, paymentCode, amount, "matched", note || "Đã khớp thanh toán");
  await insertEvent(db, order.orderCode, "payment_matched", `Đã nhận đúng ${formatVnd(amount)}.`);

  const paidOrder = { ...order, status: "paid" as const, paidAt };
  return {
    ok: true as const,
    order: paidOrder,
    deliveryJob: toDeliveryJob(paidOrder),
  };
}

export async function confirmBandoDelivery(args: {
  orderCode: string;
  botName?: string;
}) {
  const orderCode = args.orderCode.trim().toUpperCase();
  const botName = args.botName?.trim() || "NinjaBot";

  if (!orderCode) {
    return { ok: false as const, error: "Thiếu mã đơn." };
  }

  const mysqlResult = await confirmDeliveryMysql(orderCode, botName);
  if (mysqlResult) return mysqlResult;

  const runtimeEnv = await getRuntimeEnv();
  const db = runtimeEnv.DB;
  if (!db) {
    return confirmDeliveryMemory(orderCode, botName);
  }

  await ensureBandoSchema(db);
  const row = await db
    .prepare("SELECT * FROM bando_orders WHERE order_code = ? LIMIT 1")
    .bind(orderCode)
    .first<OrderRow>();

  if (!row) {
    return { ok: false as const, error: "Không tìm thấy đơn." };
  }

  const order = mapOrder(row);
  if (order.status !== "paid") {
    return { ok: false as const, error: "Chỉ giao hàng khi đơn đã thanh toán đúng." };
  }

  const deliveredAt = new Date().toISOString();
  await db
    .prepare("UPDATE bando_orders SET status = ?, delivered_at = ? WHERE order_code = ?")
    .bind("completed", deliveredAt, orderCode)
    .run();
  await db
    .prepare("UPDATE bando_items SET stock = MAX(stock - ?, 0), updated_at = ? WHERE code = ?")
    .bind(order.quantity, deliveredAt, order.itemCode)
    .run();
  await insertEvent(db, orderCode, "delivery_completed", `${botName} đã giao ${order.quantity} ${order.itemName}.`);

  return {
    ok: true as const,
    order: { ...order, status: "completed" as const, deliveredAt },
  };
}

export async function updateBandoPrice(args: {
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
  const code = args.code.trim().toLowerCase();
  const itemId = args.itemId == null || Number.isNaN(Number(args.itemId)) ? null : Number(args.itemId);
  const name = args.name?.trim() || code;
  const buyName = args.buyName?.trim().toLowerCase() || code;
  const aliases = normalizeAliases(args.aliases, buyName, code);
  const unit = args.unit?.trim() || "cai";
  const sellPrice = Number(args.sellPrice);
  const stock = Number(args.stock);
  const active = args.active !== false;

  if (!code || !Number.isInteger(sellPrice) || sellPrice <= 0 || !Number.isInteger(stock) || stock < 0) {
    return { ok: false as const, error: "Thiếu mã item, đơn giá hoặc số lượng hợp lệ." };
  }

  const now = new Date().toISOString();
  const mysqlResult = await updateBandoItemMysql({
    code,
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

  const runtimeEnv = await getRuntimeEnv();
  const db = runtimeEnv.DB;
  if (!db) {
    const item = memoryState.items.find((entry) => entry.code === code);
    if (!item) {
      const newItem: BandoItem = {
        code,
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
      return { ok: true as const, item: newItem };
    }
    item.itemId = itemId;
    item.name = name;
    item.buyName = buyName;
    item.aliases = aliases;
    item.unit = unit;
    item.sellPrice = sellPrice;
    item.stock = stock;
    item.active = active;
    item.updatedAt = now;
    pushMemoryEvent(null, "price_updated", `Cập nhật ${item.name}: ${formatVnd(sellPrice)}, tồn ${stock}.`);
    return { ok: true as const, item };
  }

  await ensureBandoSchema(db);
  await db
    .prepare(
      `INSERT INTO bando_items (
        code, item_id, name, buy_name, aliases, unit, sell_price, stock, active, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET
        item_id = excluded.item_id,
        name = excluded.name,
        buy_name = excluded.buy_name,
        aliases = excluded.aliases,
        unit = excluded.unit,
        sell_price = excluded.sell_price,
        stock = excluded.stock,
        active = excluded.active,
        updated_at = excluded.updated_at`,
    )
    .bind(code, itemId, name, buyName, JSON.stringify(aliases), unit, sellPrice, stock, active ? 1 : 0, now)
    .run();

  await insertEvent(db, null, "price_updated", `Cập nhật ${code}: ${formatVnd(sellPrice)}, tồn ${stock}.`);
  const item = await db
    .prepare("SELECT * FROM bando_items WHERE code = ? LIMIT 1")
    .bind(code)
    .first<ItemRow>();

  return { ok: true as const, item: item ? mapItem(item) : null };
}

export async function importBandoItemsFromServer() {
  const result = await importServerItemsMysql();
  if (!result) {
    return {
      ok: false as const,
      error: "Không kết nối được MySQL local. Hãy bật MySQL và kiểm tra mysql.properties của nso-server.",
    };
  }
  return result;
}

async function ensureBandoSchema(db: D1Database) {
  await db.batch([
    db.prepare(
      `CREATE TABLE IF NOT EXISTS bando_items (
        code TEXT PRIMARY KEY,
        item_id INTEGER,
        name TEXT NOT NULL,
        buy_name TEXT NOT NULL DEFAULT '',
        aliases TEXT NOT NULL,
        unit TEXT NOT NULL DEFAULT 'cai',
        sell_price INTEGER NOT NULL,
        stock INTEGER NOT NULL DEFAULT 0,
        active INTEGER NOT NULL DEFAULT 1,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS bando_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_code TEXT NOT NULL UNIQUE,
        payment_code TEXT NOT NULL UNIQUE,
        character_name TEXT NOT NULL,
        server_name TEXT NOT NULL DEFAULT 'default',
        item_code TEXT NOT NULL,
        item_name TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        unit_price INTEGER NOT NULL,
        total_amount INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'awaiting_payment',
        private_message TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        paid_at TEXT,
        delivered_at TEXT
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS bando_transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_code TEXT,
        payment_code TEXT NOT NULL,
        amount INTEGER NOT NULL,
        status TEXT NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    ),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS bando_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        order_code TEXT,
        type TEXT NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      )`,
    ),
    db.prepare("CREATE INDEX IF NOT EXISTS bando_orders_status_idx ON bando_orders (status)"),
    db.prepare("CREATE INDEX IF NOT EXISTS bando_orders_character_idx ON bando_orders (character_name)"),
    db.prepare("CREATE INDEX IF NOT EXISTS bando_transactions_payment_code_idx ON bando_transactions (payment_code)"),
    db.prepare("CREATE INDEX IF NOT EXISTS bando_events_created_at_idx ON bando_events (created_at)"),
  ]);
  await addD1ColumnIfMissing(db, "bando_items", "item_id", "INTEGER");
  await addD1ColumnIfMissing(db, "bando_items", "buy_name", "TEXT NOT NULL DEFAULT ''");

}

async function addD1ColumnIfMissing(db: D1Database, table: string, column: string, definition: string) {
  try {
    await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`).run();
  } catch {
  }
}

function mapItem(row: ItemRow): BandoItem {
  const buyName = row.buy_name?.trim() || row.code;
  return {
    code: row.code,
    itemId: row.item_id ?? null,
    name: row.name,
    buyName,
    aliases: safeAliases(row.aliases, buyName, row.code),
    unit: row.unit,
    sellPrice: row.sell_price,
    stock: row.stock,
    active: Boolean(row.active),
    updatedAt: row.updated_at,
  };
}

function mapOrder(row: OrderRow): BandoOrder {
  return {
    id: row.id,
    orderCode: row.order_code,
    paymentCode: row.payment_code,
    characterName: row.character_name,
    serverName: row.server_name,
    itemCode: row.item_code,
    itemName: row.item_name,
    quantity: row.quantity,
    unitPrice: row.unit_price,
    totalAmount: row.total_amount,
    status: row.status,
    privateMessage: row.private_message,
    createdAt: row.created_at,
    paidAt: row.paid_at,
    deliveredAt: row.delivered_at,
  };
}

function mapTransaction(row: TransactionRow): BandoTransaction {
  return {
    id: row.id,
    orderCode: row.order_code,
    paymentCode: row.payment_code,
    amount: row.amount,
    status: row.status,
    note: row.note,
    createdAt: row.created_at,
  };
}

function mapEvent(row: EventRow): BandoEvent {
  return {
    id: row.id,
    orderCode: row.order_code,
    type: row.type,
    message: row.message,
    createdAt: row.created_at,
  };
}

function safeAliases(value: string, buyName: string, code: string) {
  try {
    const aliases = JSON.parse(value);
    return Array.isArray(aliases) ? normalizeAliases(aliases.map(String), buyName, code) : normalizeAliases([], buyName, code);
  } catch {
    return normalizeAliases([], buyName, code);
  }
}

function normalizeAliases(value: string[] | undefined, buyName: string, code: string) {
  return Array.from(
    new Set([buyName, code, ...(value ?? [])].map((alias) => alias.trim().toLowerCase()).filter(Boolean)),
  );
}

async function insertEvent(db: D1Database, orderCode: string | null, type: string, message: string) {
  await db
    .prepare("INSERT INTO bando_events (order_code, type, message, created_at) VALUES (?, ?, ?, ?)")
    .bind(orderCode, type, message, new Date().toISOString())
    .run();
}

async function insertTransaction(
  db: D1Database,
  orderCode: string | null,
  paymentCode: string,
  amount: number,
  status: BandoTransaction["status"],
  note: string,
) {
  await db
    .prepare(
      "INSERT INTO bando_transactions (order_code, payment_code, amount, status, note, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .bind(orderCode, paymentCode, amount, status, note, new Date().toISOString())
    .run();
}

function cloneMemoryState(): BandoState {
  return {
    items: memoryState.items.map((item) => ({ ...item, aliases: [...item.aliases] })),
    orders: memoryState.orders.map((order) => ({ ...order })),
    transactions: memoryState.transactions.map((transaction) => ({ ...transaction })),
    events: memoryState.events.map((event) => ({ ...event })),
    storage: "memory",
  };
}

function confirmPaymentMemory(paymentCode: string, amount: number, note: string) {
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
    return { ok: false as const, error: "Không tìm thấy mã giao dịch." };
  }

  if (order.status === "completed") {
    return { ok: false as const, error: "Đơn này đã hoàn tất." };
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
    return { ok: false as const, error: `Sai số tiền. Cần thanh toán ${formatVnd(order.totalAmount)}.` };
  }

  order.status = "paid";
  order.paidAt = new Date().toISOString();
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
  return { ok: true as const, order: { ...order }, deliveryJob: toDeliveryJob(order) };
}

function confirmDeliveryMemory(orderCode: string, botName: string) {
  const order = memoryState.orders.find((entry) => entry.orderCode === orderCode);
  if (!order) {
    return { ok: false as const, error: "Không tìm thấy đơn." };
  }

  if (order.status !== "paid") {
    return { ok: false as const, error: "Chỉ giao hàng khi đơn đã thanh toán đúng." };
  }

  const item = memoryState.items.find((entry) => entry.code === order.itemCode);
  if (item) {
    item.stock = Math.max(item.stock - order.quantity, 0);
    item.updatedAt = new Date().toISOString();
  }

  order.status = "completed";
  order.deliveredAt = new Date().toISOString();
  pushMemoryEvent(orderCode, "delivery_completed", `${botName} đã giao ${order.quantity} ${order.itemName}.`);
  return { ok: true as const, order: { ...order } };
}

function pushMemoryEvent(orderCode: string | null, type: string, message: string) {
  memoryState.events.unshift({
    id: memoryEventId++,
    orderCode,
    type,
    message,
    createdAt: new Date().toISOString(),
  });
}

function toDeliveryJob(order: BandoOrder): BandoDeliveryJob {
  return {
    type: "deliver_item",
    orderCode: order.orderCode,
    paymentCode: order.paymentCode,
    characterName: order.characterName,
    serverName: order.serverName,
    itemCode: order.itemCode,
    itemName: order.itemName,
    quantity: order.quantity,
  };
}

function createOrderCode() {
  const stamp = Date.now().toString(36).toUpperCase();
  const random = Math.random().toString(36).slice(2, 6).toUpperCase();
  return `BD${stamp.slice(-6)}${random}`;
}
