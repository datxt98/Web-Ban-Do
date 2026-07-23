import { confirmBandoPayment } from "./bando-storage.js";
import { emitBandoEvent } from "./bando-events.js";
import { recordBandoBankUnmatchedEventMysql } from "./bando-mysql.js";

const PAYMENT_CODE_GLOBAL_PATTERN = /BD[A-Z0-9]{4,10}\b/gi;
const PAYMENT_CODE_EXACT_PATTERN = /^BD[A-Z0-9]{4,10}$/;
const PAYMENT_CODE_TOTAL_LENGTHS = [7, 8, 6, 9, 10, 11, 12];
const UNMATCHED_BANK_CACHE_MS = 6 * 60 * 60 * 1000;
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
const SENDER_BANK_KEYS = [
  "senderBankName",
  "senderBank",
  "fromBank",
  "remitterBank",
  "counterAccountBankName",
  "bankName",
  "bankCode",
  "bank",
];
const SENDER_ACCOUNT_KEYS = [
  "senderAccount",
  "senderAccountNo",
  "fromAccount",
  "fromAccountNo",
  "debitAccount",
  "counterAccountNumber",
  "remitterAccount",
];
const SENDER_NAME_KEYS = [
  "senderName",
  "fromName",
  "remitterName",
  "counterAccountName",
  "payerName",
];
const RECEIVER_ACCOUNT_KEYS = [
  "accountNo",
  "accountNumber",
  "beneficiaryAccount",
  "toAccount",
  "receiverAccount",
];

const unmatchedBankTransactionCache = new Map();

export function validateBankWebhookAuth(req, options = {}) {
  const expected = String(process.env.BANDO_BANK_WEBHOOK_TOKEN || "").trim();
  const bankSignatures = Array.isArray(options.bankAccounts)
    ? options.bankAccounts
        .map((account) => String(account.callbackSignature || "").trim())
        .filter(Boolean)
    : [];

  if (!expected && bankSignatures.length === 0) return null;

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
  const signature = String(req.headers.signature || "").trim();

  if (expected && supplied === expected) return null;
  if (signature && bankSignatures.includes(signature)) return null;

  return "Webhook ngan hang khong hop le.";
}

export async function handleBankPaymentPayload(payload, options = {}) {
  const transactions = normalizeBankTransactions(payload, options);
  const seen = new Set();
  const results = [];
  let matched = 0;
  let rejected = 0;
  let ignored = 0;

  for (const transaction of transactions) {
    const dedupeKey = transaction.transactionId || `${transaction.paymentCodes.join(",")}|${transaction.amount}|${transaction.description}`;
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
      notifyUnmatchedIncomingTransaction(transaction, "Khong tim thay ma don BD trong noi dung.");
      continue;
    }

    if (!Number.isFinite(transaction.amount) || transaction.amount <= 0) {
      ignored += 1;
      results.push(toPublicTransactionResult(transaction, "ignored", "So tien khong hop le."));
      continue;
    }

    const result = await confirmTransactionPayment(transaction);

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
      results.push(toPublicTransactionResult({ ...transaction, paymentCode: result.paymentCode || transaction.paymentCode }, "rejected", result.error));
      if (isMissingPaymentCodeResult(result)) {
        notifyUnmatchedIncomingTransaction({ ...transaction, paymentCode: result.paymentCode || transaction.paymentCode }, result.error);
      }
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

export function normalizeBankTransactions(payload, options = {}) {
  const candidates = collectTransactionCandidates(payload);
  return candidates.map((entry) => normalizeBankTransaction(entry, options)).filter(Boolean);
}

function normalizeBankTransaction(entry, options = {}) {
  if (!isPlainObject(entry)) return null;

  const amount = parseVndAmount(pickFirst(entry, AMOUNT_KEYS));
  const description = buildDescriptionText(entry);
  const type = String(pickFirst(entry, TYPE_KEYS) ?? "").trim();
  const transactionId = String(pickFirst(entry, ID_KEYS) ?? "").trim();
  const paymentCodes = extractPaymentCodeCandidates(entry, description, options.bankAccounts);
  const paymentCode = paymentCodes[0] || "";
  const bankAccount = matchBankAccount(entry, description, paymentCode, options.bankAccounts, options);
  const senderBankName = String(pickFirst(entry, SENDER_BANK_KEYS) ?? "").trim();
  const senderAccount = String(pickFirst(entry, SENDER_ACCOUNT_KEYS) ?? "").trim();
  const senderName = String(pickFirst(entry, SENDER_NAME_KEYS) ?? "").trim();
  const receiverAccount = String(pickFirst(entry, RECEIVER_ACCOUNT_KEYS) ?? "").trim();

  return {
    transactionId,
    paymentCode,
    paymentCodes,
    amount,
    description,
    type,
    bankAccount,
    senderBankName,
    senderAccount,
    senderName,
    receiverAccount,
    incoming: isIncomingTransaction(type, amount, entry),
    raw: entry,
  };
}

async function confirmTransactionPayment(transaction) {
  const paymentCodes = transaction.paymentCodes.length > 0 ? transaction.paymentCodes : [transaction.paymentCode].filter(Boolean);
  let missingResult = null;

  for (const paymentCode of paymentCodes) {
    const attempt = { ...transaction, paymentCode };
    const result = await confirmBandoPayment({
      paymentCode,
      amount: transaction.amount,
      note: buildBankNote(attempt),
      bankTransaction: {
        transactionId: transaction.transactionId,
        paymentCode,
        amount: transaction.amount,
        description: transaction.description,
        type: transaction.type,
        bankAccount: transaction.bankAccount,
      },
    });

    if (result.ok) {
      return { ...result, paymentCode };
    }

    if (isMissingPaymentCodeResult(result)) {
      missingResult = { ...result, paymentCode };
      continue;
    }

    return { ...result, paymentCode };
  }

  return missingResult || { ok: false, error: "Khong tim thay ma giao dich.", paymentCode: transaction.paymentCode };
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

function extractPaymentCodeCandidates(entry, description, bankAccounts = []) {
  const candidates = [];
  const direct = String(pickFirst(entry, ["paymentCode", "orderCode", "code"]) ?? "").trim();
  const searchableText = buildSearchableTransactionText(entry, description);
  addPaymentCodeMatches(candidates, direct);
  addPaymentCodeMatches(candidates, searchableText);
  addPaymentCodeCandidate(candidates, extractPrefixedPaymentCode(direct, bankAccounts));
  addPaymentCodeCandidate(candidates, extractPrefixedPaymentCode(description, bankAccounts));
  return candidates;
}

function buildSearchableTransactionText(entry, description) {
  return [description, ...collectScalarText(entry)].map((value) => String(value || "").trim()).filter(Boolean).join(" | ");
}

function collectScalarText(value, depth = 0) {
  if (depth > 3 || value == null) return [];
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  if (typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap((entry) => collectScalarText(entry, depth + 1));
  return Object.values(value).flatMap((entry) => collectScalarText(entry, depth + 1));
}

function addPaymentCodeMatches(candidates, text) {
  const source = String(text || "");
  if (!source) return;

  for (const match of source.matchAll(PAYMENT_CODE_GLOBAL_PATTERN)) {
    addPaymentCodeCandidate(candidates, match[0]);
  }

  addEmbeddedPaymentCodeMatches(candidates, source);
}

function addEmbeddedPaymentCodeMatches(candidates, text) {
  const source = String(text || "").toUpperCase();
  for (let index = 0; index < source.length - 5; index += 1) {
    if (source[index] !== "B" || source[index + 1] !== "D") continue;

    for (const length of PAYMENT_CODE_TOTAL_LENGTHS) {
      const code = source.slice(index, index + length);
      if (code.length !== length) continue;
      if (!PAYMENT_CODE_EXACT_PATTERN.test(code)) continue;
      addPaymentCodeCandidate(candidates, code);
    }
  }
}

function addPaymentCodeCandidate(candidates, value) {
  const code = String(value || "").trim().toUpperCase();
  if (!code || candidates.includes(code)) return;
  candidates.push(code);
}

function extractPrefixedPaymentCode(text, bankAccounts = []) {
  const source = String(text || "");
  if (!source) return "";

  for (const account of bankAccounts) {
    const prefix = normalizePaymentPrefix(account?.paymentPrefix);
    if (!prefix) continue;

    const index = source.toUpperCase().indexOf(prefix);
    if (index < 0) continue;

    const rest = source.slice(index + prefix.length).trim();
    const match = rest.match(/([A-Za-z0-9]{3,16})/);
    if (match) return `${prefix}${match[1]}`.toUpperCase();

    const directMatch = source.slice(index).match(new RegExp(`${escapeRegExp(prefix)}[A-Za-z0-9]{3,16}`, "i"));
    if (directMatch) return directMatch[0].toUpperCase();
  }

  return "";
}

function matchBankAccount(entry, description, paymentCode, bankAccounts = [], options = {}) {
  const accounts = Array.isArray(bankAccounts) ? bankAccounts.filter(Boolean) : [];
  if (accounts.length === 0) return null;

  const bankSignature = String(options.bankSignature || "").trim();
  if (bankSignature) {
    const signatureMatches = accounts.filter((account) => String(account.callbackSignature || "").trim() === bankSignature);
    if (signatureMatches.length === 1) return publicBankAccount(signatureMatches[0]);
  }

  const directReceiverText = RECEIVER_ACCOUNT_KEYS
    .map((key) => pickCaseInsensitive(entry, key))
    .map((value) => String(value || ""))
    .join(" ");
  const byDirectReceiver = findBankAccountByNumber(accounts, directReceiverText);
  if (byDirectReceiver) return byDirectReceiver;

  const accountText = [directReceiverText, description].map((value) => String(value || "")).join(" ");
  const byAccountNumber = findBankAccountByNumber(accounts, accountText);
  if (byAccountNumber) return byAccountNumber;

  const source = `${description || ""} ${paymentCode || ""}`.toUpperCase();
  for (const account of accounts) {
    const prefix = normalizePaymentPrefix(account?.paymentPrefix);
    if (prefix.length >= 4 && source.includes(prefix)) return publicBankAccount(account);
  }

  if (accounts.length === 1) return publicBankAccount(accounts[0]);
  return null;
}

function findBankAccountByNumber(accounts, text) {
  const sourceDigits = normalizeAccountNumber(text);
  if (!sourceDigits) return null;

  for (const account of accounts) {
    const accountNumber = normalizeAccountNumber(account.accountNumber);
    if (accountNumber && sourceDigits.includes(accountNumber)) return publicBankAccount(account);
  }

  return null;
}

function publicBankAccount(account) {
  if (!account) return null;
  return {
    bankName: String(account.bankName || ""),
    bankCode: String(account.bankCode || ""),
    accountNumber: String(account.accountNumber || ""),
    accountName: String(account.accountName || ""),
  };
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
    paymentCodes: transaction.paymentCodes,
    amount: transaction.amount,
    type: transaction.type,
    description: transaction.description,
    bankAccount: transaction.bankAccount,
    senderBankName: transaction.senderBankName,
    senderAccount: transaction.senderAccount,
    senderName: transaction.senderName,
    receiverAccount: transaction.receiverAccount,
  };
}

function notifyUnmatchedIncomingTransaction(transaction, reason) {
  if (!transaction?.incoming) return;
  if (!Number.isFinite(transaction.amount) || transaction.amount <= 0) return;

  const key = unmatchedBankTransactionKey(transaction);
  if (!key || hasRecentUnmatchedBankTransaction(key)) return;
  rememberUnmatchedBankTransaction(key);

  const payload = {
    reason,
    bankTransaction: {
      transactionId: transaction.transactionId,
      paymentCode: transaction.paymentCode,
      amount: transaction.amount,
      description: transaction.description,
      type: transaction.type,
      bankAccount: transaction.bankAccount,
      senderBankName: transaction.senderBankName,
      senderAccount: transaction.senderAccount,
      senderName: transaction.senderName,
      receiverAccount: transaction.receiverAccount,
    },
  };

  emitBandoEvent("bank_unmatched_payment", {
    ...payload,
  });
  recordBandoBankUnmatchedEventMysql(payload).catch((error) => {
    console.warn("[bando:bank] luu event tien khong khop loi:", error instanceof Error ? error.message : error);
  });
}

function isMissingPaymentCodeResult(result) {
  const text = String(result?.error || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  return text.includes("khong tim thay ma giao dich");
}

function unmatchedBankTransactionKey(transaction) {
  return (
    transaction.transactionId ||
    [
      transaction.amount,
      transaction.description,
      transaction.senderBankName,
      transaction.senderAccount,
      transaction.receiverAccount,
    ].map((value) => String(value || "").trim()).join("|")
  );
}

function hasRecentUnmatchedBankTransaction(key) {
  pruneUnmatchedBankTransactionCache();
  return unmatchedBankTransactionCache.has(key);
}

function rememberUnmatchedBankTransaction(key) {
  unmatchedBankTransactionCache.set(key, Date.now());
  pruneUnmatchedBankTransactionCache();
}

function pruneUnmatchedBankTransactionCache() {
  const cutoff = Date.now() - UNMATCHED_BANK_CACHE_MS;
  for (const [key, createdAt] of unmatchedBankTransactionCache.entries()) {
    if (createdAt < cutoff) unmatchedBankTransactionCache.delete(key);
  }
  while (unmatchedBankTransactionCache.size > 1000) {
    const firstKey = unmatchedBankTransactionCache.keys().next().value;
    if (!firstKey) break;
    unmatchedBankTransactionCache.delete(firstKey);
  }
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

function normalizePaymentPrefix(value) {
  return String(value || "")
    .trim()
    .replace(/[^A-Za-z0-9]/g, "")
    .toUpperCase();
}

function normalizeAccountNumber(value) {
  return String(value || "").replace(/\D/g, "");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isPlainObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
