import { sql } from "drizzle-orm";
import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const bandoItems = sqliteTable(
  "bando_items",
  {
    code: text("code").primaryKey(),
    itemId: integer("item_id"),
    name: text("name").notNull(),
    buyName: text("buy_name").notNull().default(""),
    aliases: text("aliases").notNull(),
    unit: text("unit").notNull().default("cai"),
    sellPrice: integer("sell_price").notNull(),
    stock: integer("stock").notNull().default(0),
    active: integer("active", { mode: "boolean" }).notNull().default(true),
    updatedAt: text("updated_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    nameIdx: index("bando_items_name_idx").on(table.name),
  }),
);

export const bandoOrders = sqliteTable(
  "bando_orders",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderCode: text("order_code").notNull(),
    paymentCode: text("payment_code").notNull(),
    characterName: text("character_name").notNull(),
    serverName: text("server_name").notNull().default("default"),
    itemCode: text("item_code").notNull(),
    itemName: text("item_name").notNull(),
    quantity: integer("quantity").notNull(),
    unitPrice: integer("unit_price").notNull(),
    totalAmount: integer("total_amount").notNull(),
    status: text("status").notNull().default("awaiting_payment"),
    privateMessage: text("private_message").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
    paidAt: text("paid_at"),
    deliveredAt: text("delivered_at"),
  },
  (table) => ({
    orderCodeIdx: uniqueIndex("bando_orders_order_code_idx").on(table.orderCode),
    paymentCodeIdx: uniqueIndex("bando_orders_payment_code_idx").on(table.paymentCode),
    statusIdx: index("bando_orders_status_idx").on(table.status),
    characterIdx: index("bando_orders_character_idx").on(table.characterName),
  }),
);

export const bandoTransactions = sqliteTable(
  "bando_transactions",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderCode: text("order_code"),
    paymentCode: text("payment_code").notNull(),
    amount: integer("amount").notNull(),
    status: text("status").notNull(),
    note: text("note").notNull().default(""),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    paymentCodeIdx: index("bando_transactions_payment_code_idx").on(table.paymentCode),
    orderCodeIdx: index("bando_transactions_order_code_idx").on(table.orderCode),
  }),
);

export const bandoEvents = sqliteTable(
  "bando_events",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    orderCode: text("order_code"),
    type: text("type").notNull(),
    message: text("message").notNull(),
    createdAt: text("created_at").notNull().default(sql`CURRENT_TIMESTAMP`),
  },
  (table) => ({
    orderCodeIdx: index("bando_events_order_code_idx").on(table.orderCode),
    createdAtIdx: index("bando_events_created_at_idx").on(table.createdAt),
  }),
);
