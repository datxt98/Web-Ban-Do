import { handleBankPaymentPayload } from "./bank-payments.js";

export function startBankPaymentSync() {
  if (!isEnabled(process.env.BANDO_BANK_SYNC_ENABLED)) return null;

  const apiUrl = String(process.env.BANDO_BANK_API_URL || "").trim();
  if (!apiUrl) {
    console.warn("[bando:bank] BANDO_BANK_SYNC_ENABLED=1 nhung chua co BANDO_BANK_API_URL.");
    return null;
  }

  const intervalMs = readIntegerEnv("BANDO_BANK_POLL_MS", 10000, 3000, 3600000);
  let running = false;

  async function tick() {
    if (running) return;
    running = true;
    try {
      const payload = await fetchBankPayload(apiUrl);
      const result = await handleBankPaymentPayload(payload);
      if (result.matched || result.rejected) {
        console.log(
          `[bando:bank] sync: received=${result.received} matched=${result.matched} rejected=${result.rejected} ignored=${result.ignored}`,
        );
      }
    } catch (error) {
      console.error("[bando:bank] sync error:", error instanceof Error ? error.message : error);
    } finally {
      running = false;
    }
  }

  const timer = setInterval(tick, intervalMs);
  tick();
  console.log(`[bando:bank] Dang tu dong kiem tra giao dich moi moi ${intervalMs}ms.`);

  return {
    stop() {
      clearInterval(timer);
    },
  };
}

async function fetchBankPayload(apiUrl) {
  const requestUrl = new URL(apiUrl);
  const headers = { accept: "application/json" };
  const token = String(process.env.BANDO_BANK_API_TOKEN || "").trim();
  const mode = String(process.env.BANDO_BANK_TOKEN_MODE || "bearer").trim().toLowerCase();
  const tokenName = String(process.env.BANDO_BANK_TOKEN_NAME || "").trim();

  if (token) {
    if (mode === "query") {
      requestUrl.searchParams.set(tokenName || "token", token);
    } else if (mode === "header") {
      headers[tokenName || "token"] = token;
    } else if (mode === "x-api-key") {
      headers[tokenName || "x-api-key"] = token;
    } else {
      headers[tokenName || "authorization"] = tokenName ? token : `Bearer ${token}`;
    }
  }

  const response = await fetch(requestUrl, { headers });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(`HTTP ${response.status} ${text.slice(0, 160)}`);
  }
  return response.json();
}

function isEnabled(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function readIntegerEnv(name, fallback, min, max) {
  const value = Number(process.env[name]);
  if (!Number.isInteger(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}
