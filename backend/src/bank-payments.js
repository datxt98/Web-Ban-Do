import { confirmBandoPayment } from "./bando-storage.js";

const PAYMENT_CODE_PATTERN = /\bBD[A-Z0-9]{4,10}\b/i;
const ARRAY_KEYS = [
  "TranList",
  "tranList",
  "transactionList",
  "data",
  "transactions",
  "transactionHistory",
  "history",
  "items",
  "rows",
  "records",
  "result",
];
const AMOUNT_KEYS = [
  "amount",
  "money",
  "creditAmount",
  "credit_amount",
  "receiveAmount",
  "receivedAmount",
  "transactionAmount",
  "transAmount",
  "paymentAmount",
  "value",
  "SoTien",
  "soTien",
];
const DESCRIPTION_KEYS = [
  "description",
  "content",
  "note",
  "remark",
  "memo",
  "message",
  "transactionDescription",
  "addDescription",
  "transferContent",
  "bankContent",
  "paymentCode",
  "orderCode",
  "NoiDung",
  "noiDung",
];
const ID_KEYS = [
  "transactionID",
  "transactionId",
  "transaction_id",
  "tranId",
  "transId",
  "refNo",
  "reference",
  "referenceNumber",
  "tid",
  "id",
  "traceNo",
  "bankTransactionId",
];
const TYPE_KEYS = ["type", "transactionType", "txnType", "direction", "creditDebitIndicator", "cd", "sign"];

export function validateBankWebhookAuth(req) {
  const expected = String(process.env.BANDO_BANK_WEBHOOK_TOKEN || "").trim();
  if (!expected) return null;

  const auth = String(req.headers.authorization || "");
  const bearer = auth.toLowerCase().startsWith("bearer ") ? auth.slice(7).trim() : "";
  const supplied = String(
    req.headers["x-bando-bank-token"] ||
      req.headers["x-api-key"] ||
      req.headers["x-api-token"] ||
      req.query?.token ||
      bearer ||
      "",
  ).trim();

  return supplied === expected ? null : "Webhook ngan hang khong hop le.";
}

export async function handleBankPaymentPayload(payload) {
  const transactions = normalizeBankTransactions(payload);
  const seen = new Set();
  const results = [];
  let matched = 0;
  let rejected = 0;
  let ignored = 0;

  for (const transaction of transactions) {
    const dedupeKey = transaction.transactionId || `${transaction.paymentCode}|${transaction.amount}|${transaction.description}`;
    if (dedupeKey && seen.has(dedupeKey)) continue;
    if (dedupeKey) seen.add(dedupeKey);

    if (!transaction.incoming) {
      ignored += 1;
      results.push(toPublicTransactionResult(transaction, "ignored", "Khong phai giao dich nhan tien."));
      continue;
    }

    if (!transaction.paymentCode) {
      ignored += 1;
      results.push(toPublicTransactionResult(transaction, "ignored", "Khong tim thay ma don BD trong noi dung."));
      continue;
    }

    if (!Number.isFinite(transaction.amount) || transaction.amount <= 0) {
      ignored += 1;
      results.push(toPublicTransactionResult(transaction, "ignored", "So tien khong hop le."));
      continue;
    }

    const result = await confirmBandoPayment({
      paymentCode: transaction.paymentCode,
      amount: transaction.amount,
      note: buildBankNote(transaction),
    });

    if (result.ok) {
      matched += 1;
      results.push({
        ...toPublicTransactionResult(
          transaction,
          result.alreadyCompleted ? "already_completed" : result.alreadyPaid ? "already_paid" : "matched",
        ),
        order: result.order,
        deliveryJob: result.deliveryJob,
      });
    } else {
      rejected += 1;
      results.push(toPublicTransactionResult(transaction, "rejected", result.error));
    }
  }

  return {
    ok: true,
    received: transactions.length,
    matched,
    rejected,
    ignored,
    results,
  };
}

export function normalizeBankTransactions(payload) {
  const candidates = collectTransactionCandidates(payload);
  return candidates.map(normalizeBankTransaction).filter(Boolean);
}

function normalizeBankTransaction(entry) {
  if (!isPlainObject(entry)) return null;

  const amount = parseVndAmount(pickFirst(entry, AMOUNT_KEYS));
  const description = buildDescriptionText(entry);
  const type = String(pickFirst(entry, TYPE_KEYS) ?? "").trim();
  const transactionId = String(pickFirst(entry, ID_KEYS) ?? "").trim();
  const paymentCode = extractPaymentCode(entry, description);

  return {
    transactionId,
    paymentCode,
    amount,
    description,
    type,
    incoming: isIncomingTransaction(type, amount, entry),
    raw: entry,
  };
}

function collectTransactionCandidates(payload, depth = 0) {
  if (depth > 4) return [];
  if (Array.isArray(payload)) {
    return payload.flatMap((entry) => collectTransactionCandidates(entry, depth + 1));
  }
  if (!isPlainObject(payload)) return [];

  const nested = [];
  for (const key of ARRAY_KEYS) {
    const value = pickCaseInsensitive(payload, key);
    if (Array.isArray(value)) {
      nested.push(...value.flatMap((entry) => collectTransactionCandidates(entry, depth + 1)));
    } else if (isPlainObject(value)) {
      nested.push(...collectTransactionCandidates(value, depth + 1));
    }
  }
  return nested.length > 0 ? nested : [payload];
}

function extractPaymentCode(entry, description) {
  const direct = String(pickFirst(entry, ["paymentCode", "orderCode", "code"]) ?? "").trim();
  const directMatch = direct.match(PAYMENT_CODE_PATTERN);
  if (directMatch) return directMatch[0].toUpperCase();

  const descriptionMatch = String(description || "").match(PAYMENT_CODE_PATTERN);
  return descriptionMatch ? descriptionMatch[0].toUpperCase() : "";
}

function buildDescriptionText(entry) {
  return DESCRIPTION_KEYS
    .map((key) => pickCaseInsensitive(entry, key))
    .filter((value) => value != null && typeof value !== "object")
    .map((value) => String(value).trim())
    .filter(Boolean)
    .join(" | ");
}

function buildBankNote(transaction) {
  const parts = ["bank"];
  if (transaction.transactionId) parts.push(`id=${transaction.transactionId}`);
  if (transaction.type) parts.push(`type=${transaction.type}`);
  if (transaction.description) parts.push(transaction.description.slice(0, 180));
  return parts.join(" | ");
}

function toPublicTransactionResult(transaction, status, reason = "") {
  return {
    status,
    reason,
    transactionId: transaction.transactionId,
    paymentCode: transaction.paymentCode,
    amount: transaction.amount,
    type: transaction.type,
    description: transaction.description,
  };
}

function isIncomingTransaction(type, amount, entry) {
  const debitAmount = parseVndAmount(pickFirst(entry, ["debitAmount", "debit_amount", "withdrawAmount", "outAmount"]));
  if (debitAmount > 0) return false;

  const normalizedType = normalizeType(type);
  if (!normalizedType) return amount > 0;

  if (/(out|debit|dr|withdraw|payment|minus|chi|ra|tru|-)/i.test(normalizedType)) return false;
  if (/(in|credit|cr|deposit|receive|plus|thu|vao|nhan|\+)/i.test(normalizedType)) return true;
  return amount > 0;
}

function parseVndAmount(value) {
  if (typeof value === "number") return Number.isFinite(value) ? Math.trunc(value) : 0;
  if (typeof value !== "string") return 0;

  const trimmed = value.trim();
  if (!trimmed) return 0;
  const negative = /^-/.test(trimmed);
  const compact = trimmed.replace(/[^\d,.-]/g, "");
  const digits = amountIntegerDigits(compact);
  if (!digits) return 0;
  const amount = Number.parseInt(digits, 10);
  if (!Number.isFinite(amount)) return 0;
  return negative ? -amount : amount;
}

function amountIntegerDigits(value) {
  const text = String(value || "").replace(/^-/, "");
  if (!text) return "";

  const lastComma = text.lastIndexOf(",");
  const lastDot = text.lastIndexOf(".");
  const decimalIndex = Math.max(lastComma, lastDot);
  if (decimalIndex > 0) {
    const decimalPart = text.slice(decimalIndex + 1).replace(/[^\d]/g, "");
    if (decimalPart.length > 0 && decimalPart.length <= 2) {
      return text.slice(0, decimalIndex).replace(/[^\d]/g, "");
    }
  }

  return text.replace(/[^\d]/g, "");
}

function pickFirst(entry, keys) {
  for (const key of keys) {
    const value = pickCaseInsensitive(entry, key);
    if (value != null && value !== "") return value;
  }
  return null;
}

function pickCaseInsensitive(entry, key) {
  if (!isPlainObject(entry)) return null;
  if (Object.prototype.hasOwnProperty.call(entry, key)) return entry[key];
  const lowerKey = key.toLowerCase();
  const found = Object.keys(entry).find((entryKey) => entryKey.toLowerCase() === lowerKey);
  return found ? entry[found] : null;
}

function normalizeType(type) {
  return String(type || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
