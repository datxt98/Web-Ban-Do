import type { BandoItem } from "./bando-types";

export const defaultBandoItems: BandoItem[] = [];

export function formatVnd(amount: number) {
  return `${new Intl.NumberFormat("vi-VN").format(amount)} VND`;
}

export function parseBandoPrivateChat(message: string) {
  const normalized = message.trim().toLowerCase().replace(/\s+/g, " ");
  const match = normalized.match(/^(?:mua\s+)?([a-z0-9_-]+)\s*(?:\+|x|\s)\s*(\d{1,9})$/);

  if (!match) {
    return {
      ok: false as const,
      error: "Cú pháp mua: mua <tên mua> <số lượng> hoặc <tên mua>+<số lượng>. Chat 'xem' để xem hàng.",
    };
  }

  const quantity = Number(match[2]);
  if (!Number.isInteger(quantity) || quantity <= 0) {
    return {
      ok: false as const,
      error: "Số lượng phải là số nguyên lớn hơn 0.",
    };
  }

  return {
    ok: true as const,
    itemToken: match[1],
    quantity,
  };
}

export function findBandoItem(items: BandoItem[], token: string) {
  const normalized = token.trim().toLowerCase();
  return items.find(
    (item) =>
      item.active &&
      (item.code === normalized ||
        item.buyName.toLowerCase() === normalized ||
        item.aliases.some((alias) => alias.toLowerCase() === normalized)),
  );
}

export function isListCommand(message: string) {
  const normalized = message.trim().toLowerCase();
  return normalized === "xem" || normalized === "list" || normalized === "shop";
}

export function buildHelpReplies(items: BandoItem[]) {
  const active = items.filter((item) => item.active && item.sellPrice > 0);
  const examples = active.slice(0, 3).map((item) => `mua ${item.buyName || item.code} 1`);
  if (examples.length === 0) {
    return [
      "Lệnh BOT: chat 'xem' để xem vật phẩm đang bán.",
      "Hiện gian hàng chưa có vật phẩm. Admin cần thêm item và đặt giá trên web.",
    ];
  }
  return [
    "Lệnh BOT: chat 'xem' để xem vật phẩm đang bán.",
    `Mua hàng: ${examples[0]} hoặc tenmua+soluong. Ví dụ: ${examples.join(", ")}.`,
    "Sau khi tạo đơn, BOT sẽ trả mã giao dịch và số tiền cần chuyển.",
  ];
}

export function buildCatalogReplies(items: BandoItem[], stockByItemId = new Map<number, number>()) {
  const activeItems = items.filter((item) => item.active && item.sellPrice > 0);
  if (activeItems.length === 0) {
    return ["Hiện BOT chưa cấu hình vật phẩm nào để bán."];
  }

  const lines = activeItems.map((item) => {
    const liveStock = item.itemId == null ? undefined : stockByItemId.get(item.itemId);
    const stock = liveStock ?? item.stock;
    const buyName = item.buyName || item.code;
    return `${item.name} - Còn: ${stock} ${item.unit} - Đơn giá: ${formatVnd(item.sellPrice)} - lệnh mua: mua ${buyName} <số lượng>`;
  });

  return chunkLines(lines, 480);
}

export function stockMapFromInventory(inventory: Array<{ itemId: number; quantity: number }> | undefined) {
  const stockByItemId = new Map<number, number>();
  if (!Array.isArray(inventory)) return stockByItemId;

  for (const entry of inventory) {
    const itemId = Number(entry.itemId);
    const quantity = Number(entry.quantity);
    if (!Number.isInteger(itemId) || itemId < 0 || !Number.isFinite(quantity)) continue;
    stockByItemId.set(itemId, (stockByItemId.get(itemId) ?? 0) + Math.max(0, Math.trunc(quantity)));
  }

  return stockByItemId;
}

export function getAvailableStock(item: BandoItem, stockByItemId = new Map<number, number>()) {
  if (item.itemId != null && stockByItemId.has(item.itemId)) {
    return stockByItemId.get(item.itemId) ?? 0;
  }
  return item.stock;
}

export function buildOrderReply(args: {
  characterName: string;
  itemName: string;
  quantity: number;
  totalAmount: number;
  paymentCode: string;
}) {
  return [
    `Đã tạo đơn cho ${args.characterName}.`,
    `${args.itemName} x${args.quantity}: ${formatVnd(args.totalAmount)}.`,
    `Nội dung chuyển khoản: ${args.paymentCode}.`,
  ].join(" ");
}

function chunkLines(lines: string[], maxLength: number) {
  const replies: string[] = [];
  let current = "";

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLength && current) {
      replies.push(current);
      current = line;
    } else {
      current = next;
    }
  }

  if (current) replies.push(current);
  return replies;
}
