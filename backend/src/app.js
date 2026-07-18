import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import cors from "cors";
import express from "express";
import helmet from "helmet";
import morgan from "morgan";
import { handleBankPaymentPayload, validateBankWebhookAuth } from "./bank-payments.js";
import {
  approveBandoOrder,
  approveCoinTradePayout,
  confirmBandoBotNotification,
  confirmBandoDelivery,
  confirmBandoPayment,
  createBandoOrderFromChat,
  deleteBandoBankAccount,
  deleteBandoGameServer,
  getBandoAuthStatus,
  getBandoBotConfig,
  importBandoItemsFromServer,
  listBandoGameServers,
  listPendingBandoDeliveries,
  listBandoState,
  loginBandoAdmin,
  registerBandoAdmin,
  resolveBandoBotConfig,
  upsertBandoBankAccount,
  upsertBandoGameServer,
  updateBandoBotConfig,
  updateBandoInventory,
  updateBandoPrice,
  validateBandoAdminAuth,
  validateBandoBotAuth,
} from "./bando-storage.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export function createApp(options = {}) {
  const app = express();
  const serveFrontend = options.serveFrontend !== false;

  app.set("trust proxy", 1);
  app.use(cors({ origin: true, credentials: true }));
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(express.json({ limit: "2mb" }));

  if (process.env.NODE_ENV !== "test") {
    app.use(morgan("dev"));
  }

  app.get("/health", (_req, res) => {
    res.json({ ok: true, service: "nso-bando-backend" });
  });

  app.get("/api/bando/auth/status", asyncHandler(async (req, res) => {
    res.json(await getBandoAuthStatus(req.headers));
  }));

  app.post("/api/bando/auth/register", asyncHandler(async (req, res) => {
    const result = await registerBandoAdmin(req.body, req.headers);
    if (!result.ok) return res.status(400).json(result);
    return res.status(201).json(result);
  }));

  app.post("/api/bando/auth/login", asyncHandler(async (req, res) => {
    const result = await loginBandoAdmin(req.body);
    if (!result.ok) return res.status(401).json(result);
    return res.json(result);
  }));

  app.post("/api/bando/auth/logout", (_req, res) => {
    res.json({ ok: true });
  });

  app.get("/api/bando/history", authorizeAdmin, asyncHandler(async (_req, res) => {
    res.json(await listBandoState({ gameName: _req.query.gameName, serverName: _req.query.serverName }));
  }));

  app.get("/api/bando/bot/config", authorizeAdmin, asyncHandler(async (_req, res) => {
    res.json(await getBandoBotConfig());
  }));

  app.patch("/api/bando/bot/config", authorizeAdmin, asyncHandler(async (req, res) => {
    const result = await updateBandoBotConfig(req.body);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  }));

  app.get("/api/bando/prices", authorizeAdmin, asyncHandler(async (_req, res) => {
    const state = await listBandoState({ gameName: _req.query.gameName, serverName: _req.query.serverName });
    res.json({ items: state.items, storage: state.storage });
  }));

  app.patch("/api/bando/prices", authorizeAdmin, asyncHandler(async (req, res) => {
    const result = await updateBandoPrice({
      code: req.body.code ?? "",
      gameName: req.body.gameName,
      serverName: req.body.serverName,
      itemId: req.body.itemId,
      name: req.body.name,
      buyName: req.body.buyName,
      aliases: req.body.aliases,
      unit: req.body.unit,
      sellPrice: Number(req.body.sellPrice),
      stock: Number(req.body.stock),
      active: req.body.active,
    });

    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json(result);
  }));

  app.post("/api/bando/bank-accounts", authorizeAdmin, asyncHandler(async (req, res) => {
    const result = await upsertBandoBankAccount(req.body);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  }));

  app.patch("/api/bando/bank-accounts/:id", authorizeAdmin, asyncHandler(async (req, res) => {
    const result = await upsertBandoBankAccount({ ...req.body, id: req.params.id });
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  }));

  app.delete("/api/bando/bank-accounts/:id", authorizeAdmin, asyncHandler(async (req, res) => {
    const result = await deleteBandoBankAccount(req.params.id);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  }));

  app.get("/api/bando/game-servers", authorizeAdmin, asyncHandler(async (_req, res) => {
    res.json(await listBandoGameServers());
  }));

  app.post("/api/bando/game-servers", authorizeAdmin, asyncHandler(async (req, res) => {
    const result = await upsertBandoGameServer(req.body);
    if (!result.ok) return res.status(400).json(result);
    return res.status(201).json(result);
  }));

  app.patch("/api/bando/game-servers/:id", authorizeAdmin, asyncHandler(async (req, res) => {
    const result = await upsertBandoGameServer({ ...req.body, id: req.params.id });
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  }));

  app.delete("/api/bando/game-servers/:id", authorizeAdmin, asyncHandler(async (req, res) => {
    const result = await deleteBandoGameServer(req.params.id);
    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  }));

  app.post("/api/bando/items/import-server", authorizeAdmin, asyncHandler(async (req, res) => {
    const result = await importBandoItemsFromServer({
      gameName: req.body.gameName,
      serverName: req.body.serverName,
    });
    if (!result.ok) return res.status(400).json({ error: result.error });
    return res.json(result);
  }));

  app.post("/api/bando/orders/:orderCode/approve", authorizeAdmin, asyncHandler(async (req, res) => {
    const result = await approveBandoOrder({
      orderCode: req.params.orderCode,
      note: req.body.note,
    });

    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  }));

  app.post("/api/bando/coin-trades/:orderCode/payout/approve", authorizeAdmin, asyncHandler(async (req, res) => {
    const result = await approveCoinTradePayout({
      orderCode: req.params.orderCode,
      note: req.body.note,
    });

    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  }));

  app.post("/api/bando/bot/orders", authorizeBot, asyncHandler(async (req, res) => {
    const result = await createBandoOrderFromChat({
      characterName: req.body.characterName ?? "",
      privateMessage: req.body.privateMessage ?? "",
      gameName: req.body.gameName,
      serverName: req.body.serverName,
      inventory: req.body.inventory,
      coin: req.body.coin ?? req.body.xu,
    });

    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    return res.status(result.order ? 201 : 200).json(result);
  }));

  app.post("/api/bando/bot/inventory", authorizeBot, asyncHandler(async (req, res) => {
    const result = await updateBandoInventory({
      characterName: req.body.characterName,
      gameName: req.body.gameName,
      serverName: req.body.serverName,
      inventory: req.body.inventory,
    });

    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    return res.json(result);
  }));

  app.post("/api/bando/bot/config/resolve", authorizeBot, asyncHandler(async (req, res) => {
    const result = await resolveBandoBotConfig({
      characterName: req.body.characterName,
      gameName: req.body.gameName,
      serverName: req.body.serverName,
    });

    if (!result.ok) return res.status(400).json(result);
    return res.json(result);
  }));

  app.get("/api/bando/bot/deliveries/pending", authorizeBot, asyncHandler(async (req, res) => {
    res.json(await listPendingBandoDeliveries({ gameName: req.query.gameName, serverName: req.query.serverName }));
  }));

  app.post("/api/bando/payments/confirm", authorizeAdmin, asyncHandler(async (req, res) => {
    const result = await confirmBandoPayment({
      paymentCode: req.body.paymentCode ?? "",
      amount: Number(req.body.amount),
      note: req.body.note,
    });

    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    return res.json(result);
  }));

  app.post("/api/bando/payments/bank-webhook", asyncHandler(async (req, res) => {
    const state = await listBandoState();
    const authError = validateBankWebhookAuth(req, { bankAccounts: state.bankAccounts });
    if (authError) return res.status(401).json({ ok: false, error: authError });

    const result = await handleBankPaymentPayload(req.body, { bankAccounts: state.bankAccounts });
    return res.json(result);
  }));

  app.post("/api/bando/bot/deliveries/confirm", authorizeBot, asyncHandler(async (req, res) => {
    const result = await confirmBandoDelivery({
      orderCode: req.body.orderCode ?? "",
      botName: req.body.botName,
      receivedCoinAmount: req.body.receivedCoinAmount,
    });

    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    return res.json(result);
  }));

  app.post("/api/bando/bot/notifications/confirm", authorizeBot, asyncHandler(async (req, res) => {
    const result = await confirmBandoBotNotification({
      orderCode: req.body.orderCode ?? "",
      type: req.body.type ?? "",
    });

    if (!result.ok) return res.status(400).json({ ok: false, error: result.error });
    return res.json(result);
  }));

  app.use("/api", (_req, res) => {
    res.status(404).json({
      ok: false,
      error: "Không tìm thấy API. Hãy kiểm tra backend đang chạy đúng bản code.",
    });
  });

  if (serveFrontend) {
    const distPath = path.resolve(__dirname, "../../frontend/dist");
    const indexPath = path.join(distPath, "index.html");
    if (fs.existsSync(indexPath)) {
      app.use(express.static(distPath));
      app.get(/.*/, (_req, res) => res.sendFile(indexPath));
    }
  }

  app.use((err, _req, res, _next) => {
    console.error("[bando:api]", err);
    res.status(500).json({ error: err instanceof Error ? err.message : "Lỗi hệ thống bán đồ." });
  });

  return app;
}

function authorizeBot(req, res, next) {
  const error = validateBandoBotAuth(req.headers);
  if (error) return res.status(401).json({ error });
  return next();
}

function authorizeAdmin(req, res, next) {
  Promise.resolve(validateBandoAdminAuth(req.headers))
    .then((result) => {
      if (!result.ok) return res.status(401).json({ ok: false, error: result.error });
      req.bandoAdminUser = result.user;
      return next();
    })
    .catch(next);
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}
