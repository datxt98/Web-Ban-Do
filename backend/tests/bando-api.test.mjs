import assert from "node:assert/strict";
import test from "node:test";

process.env.BANDO_DISABLE_MYSQL = "1";
process.env.BANDO_DISABLE_ADMIN_AUTH = "1";
process.env.NODE_ENV = "test";

const { createApp } = await import("../src/app.js");
const { subscribeBandoEvents } = await import("../src/bando-events.js");

const safeOrderCodePattern = /^BD[1-9A-HJ-KM-NP-Z]{4,10}$/;
const safeCoinTradeCodePattern = /^SX[1-9A-HJ-KM-NP-Z]{4,10}$/;

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, () => {
      const address = server.address();
      resolve({ server, baseUrl: `http://127.0.0.1:${address.port}` });
    });
  });
}

function todayInputDate() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Ho_Chi_Minh",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

test("Bando API tạo đơn, khớp thanh toán và xác nhận giao hàng", async () => {
  const { server, baseUrl } = await listen(createApp({ serveFrontend: false }));
  try {
    const priceResponse = await fetch(`${baseUrl}/api/bando/prices`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "test-bando-unit",
        itemId: 900001,
        name: "Test item",
        buyName: "codextest",
        aliases: ["codextest"],
        unit: "cái",
        sellPrice: 12000,
        stock: 5000,
        active: true,
      }),
    });
    assert.equal(priceResponse.status, 200);

    const inventoryResponse = await fetch(`${baseUrl}/api/bando/bot/inventory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterName: "NinjaBot",
        serverName: "Ninja School",
        inventory: [
          {
            itemId: 900001,
            name: "Test item",
            quantity: 321,
          },
        ],
      }),
    });
    assert.equal(inventoryResponse.status, 200);

    const bankResponse = await fetch(`${baseUrl}/api/bando/bank-accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bankName: "VCB",
        accountNumber: "0123456789",
        accountName: "NGUYEN VAN A",
        active: true,
      }),
    });
    assert.equal(bankResponse.status, 200);
    const bankPayload = await bankResponse.json();
    assert.equal(bankPayload.bankAccount.active, true);

    const catalogResponse = await fetch(`${baseUrl}/api/bando/bot/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterName: "DatNinja",
        serverName: "Ninja School",
        privateMessage: "xem",
        inventory: [{ itemId: 900001, name: "Test item", quantity: 321 }],
      }),
    });
    assert.equal(catalogResponse.status, 200);
    const catalogPayload = await catalogResponse.json();
    assert.equal(catalogPayload.ok, true);
    assert.ok(Array.isArray(catalogPayload.replies));
    assert.ok(catalogPayload.replies.length > 0);
    assert.ok(catalogPayload.replies.every((reply) => !reply.includes("\n") && reply.length <= 180));
    assert.match(catalogPayload.reply, /mua codextest <sl>/);

    const priceStateResponse = await fetch(`${baseUrl}/api/bando/history`);
    assert.equal(priceStateResponse.status, 200);
    const priceStatePayload = await priceStateResponse.json();
    const liveItem = priceStatePayload.items.find((item) => item.code === "test-bando-unit");
    assert.equal(liveItem.stock, 321);
    assert.equal(liveItem.stockSource, "inventory");
    assert.ok(!priceStatePayload.events.some((event) => event.type === "inventory_synced"));

    const orderResponse = await fetch(`${baseUrl}/api/bando/bot/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterName: "DatNinja",
        serverName: "Ninja School",
        privateMessage: "codextest 200",
      }),
    });
    assert.equal(orderResponse.status, 201);
    const orderPayload = await orderResponse.json();
    assert.equal(orderPayload.ok, true);
    assert.equal(orderPayload.order.itemCode, "test-bando-unit");
    assert.equal(orderPayload.order.quantity, 200);
    assert.equal(orderPayload.order.totalAmount, 2400000);
    assert.equal(orderPayload.order.paymentCode, orderPayload.order.orderCode);
    assert.match(orderPayload.order.paymentCode, safeOrderCodePattern);
    assert.match(orderPayload.reply, /Noi dung chuyen khoan:/);
    assert.match(orderPayload.reply, /VCB/);
    assert.match(orderPayload.reply, /0123456789/);

    const paymentResponse = await fetch(`${baseUrl}/api/bando/payments/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paymentCode: orderPayload.order.paymentCode,
        amount: orderPayload.order.totalAmount,
        note: "unit test payment",
      }),
    });
    assert.equal(paymentResponse.status, 200);
    const paymentPayload = await paymentResponse.json();
    assert.equal(paymentPayload.ok, true);
    assert.equal(paymentPayload.deliveryJob.type, "deliver_item");
    assert.equal(paymentPayload.deliveryJob.characterName, "DatNinja");

    const deliveryResponse = await fetch(`${baseUrl}/api/bando/bot/deliveries/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderCode: orderPayload.order.orderCode,
        botName: "NinjaBot",
      }),
    });
    assert.equal(deliveryResponse.status, 200);
    const deliveryPayload = await deliveryResponse.json();
    assert.equal(deliveryPayload.ok, true);
    assert.equal(deliveryPayload.order.status, "completed");

    const historyResponse = await fetch(`${baseUrl}/api/bando/history`);
    assert.equal(historyResponse.status, 200);
    const historyPayload = await historyResponse.json();
    assert.ok(historyPayload.orders.some((order) => order.orderCode === orderPayload.order.orderCode));
    assert.ok(historyPayload.transactions.some((transaction) => transaction.paymentCode === orderPayload.order.paymentCode));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Bando API xu: xem bang gia, mua xu, ban xu va luu thong tin nhan tien", async () => {
  const { server, baseUrl } = await listen(createApp({ serveFrontend: false }));
  try {
    const configResponse = await fetch(`${baseUrl}/api/bando/bot/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        characterName: "NinjaBot",
        coinTrade: {
          sell: { enabled: true, rate: 2.0 },
          importXu: { enabled: true, rate: 2.6 },
        },
      }),
    });
    assert.equal(configResponse.status, 200);

    const bankResponse = await fetch(`${baseUrl}/api/bando/bank-accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bankName: "VCB",
        accountNumber: "999999999",
        accountName: "SHOP TEST",
        active: true,
      }),
    });
    assert.equal(bankResponse.status, 200);

    const catalogResponse = await fetch(`${baseUrl}/api/bando/bot/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterName: "KhachXu",
        serverName: "Ninja School",
        privateMessage: "xem",
        coin: 1000000,
        inventory: [],
      }),
    });
    assert.equal(catalogResponse.status, 200);
    const catalogPayload = await catalogResponse.json();
    assert.match(catalogPayload.reply, /Mua xu cua BOT gia/);
    assert.match(catalogPayload.reply, /200\.000 xu/);
    assert.match(catalogPayload.reply, /Vi du: muaxu 1000000 la mua 1m xu/);
    assert.match(catalogPayload.reply, /Ban xu cho BOT gia/);
    assert.match(catalogPayload.reply, /260\.000 xu/);
    assert.ok(catalogPayload.replies.every((reply) => !reply.includes("\n") && reply.length <= 180));

    const insufficientResponse = await fetch(`${baseUrl}/api/bando/bot/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterName: "KhachXu",
        serverName: "Ninja School",
        privateMessage: "muaxu 500000",
        coin: 1000000,
      }),
    });
    assert.equal(insufficientResponse.status, 400);
    const insufficientPayload = await insufficientResponse.json();
    assert.match(insufficientPayload.error, /toi thieu/);

    const buyResponse = await fetch(`${baseUrl}/api/bando/bot/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterName: "KhachXu",
        serverName: "Ninja School",
        privateMessage: "muaxu 2000000",
        coin: 3000000,
      }),
    });
    assert.equal(buyResponse.status, 201);
    const buyPayload = await buyResponse.json();
    assert.equal(buyPayload.order.itemCode, "coin-xu");
    assert.equal(buyPayload.order.quantity, 2000000);
    assert.equal(buyPayload.order.totalAmount, 10000);
    assert.equal(buyPayload.coinTrade.type, "buy_xu");
    assert.equal(buyPayload.order.paymentCode, buyPayload.order.orderCode);
    assert.equal(buyPayload.coinTrade.paymentCode, buyPayload.order.orderCode);
    assert.match(buyPayload.order.orderCode, safeOrderCodePattern);

    const payCoinResponse = await fetch(`${baseUrl}/api/bando/payments/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paymentCode: buyPayload.order.paymentCode,
        amount: 10000,
        note: "coin buy payment",
      }),
    });
    assert.equal(payCoinResponse.status, 200);
    const payCoinPayload = await payCoinResponse.json();
    assert.equal(payCoinPayload.deliveryJob.type, "deliver_coin");
    assert.equal(payCoinPayload.deliveryJob.coinAmount, 2000000);

    const sellResponse = await fetch(`${baseUrl}/api/bando/bot/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterName: "KhachBanXu",
        serverName: "Ninja School",
        privateMessage: "banxu 2600000",
      }),
    });
    assert.equal(sellResponse.status, 200);
    const sellPayload = await sellResponse.json();
    assert.equal(sellPayload.coinTrade.type, "sell_xu");
    assert.equal(sellPayload.coinTrade.totalAmount, 10000);
    assert.match(sellPayload.coinTrade.orderCode, safeCoinTradeCodePattern);

    const pendingResponse = await fetch(`${baseUrl}/api/bando/bot/deliveries/pending`);
    assert.equal(pendingResponse.status, 200);
    const pendingPayload = await pendingResponse.json();
    assert.ok(pendingPayload.deliveries.some((delivery) => delivery.type === "deliver_coin" && delivery.orderCode === buyPayload.order.orderCode));
    assert.ok(pendingPayload.deliveries.some((delivery) => delivery.type === "receive_coin" && delivery.orderCode === sellPayload.coinTrade.orderCode));

    const buyDeliveryResponse = await fetch(`${baseUrl}/api/bando/bot/deliveries/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderCode: buyPayload.order.orderCode,
        botName: "NinjaBot",
      }),
    });
    assert.equal(buyDeliveryResponse.status, 200);

    const sellDeliveryResponse = await fetch(`${baseUrl}/api/bando/bot/deliveries/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderCode: sellPayload.coinTrade.orderCode,
        botName: "NinjaBot",
        receivedCoinAmount: 2600000,
      }),
    });
    assert.equal(sellDeliveryResponse.status, 200);
    const sellDeliveryPayload = await sellDeliveryResponse.json();
    assert.equal(sellDeliveryPayload.coinTrade.status, "awaiting_payout_info");
    assert.match(sellDeliveryPayload.reply, /NganHang STK TenTaiKhoan/);

    const invalidPayoutResponse = await fetch(`${baseUrl}/api/bando/bot/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterName: "KhachBanXu",
        serverName: "Ninja School",
        privateMessage: "Shinhanbank TA QUOC DAT",
      }),
    });
    assert.equal(invalidPayoutResponse.status, 400);
    const invalidPayoutPayload = await invalidPayoutResponse.json();
    assert.match(invalidPayoutPayload.error, /Sai cu phap/);

    const payoutResponse = await fetch(`${baseUrl}/api/bando/bot/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterName: "KhachBanXu",
        serverName: "Ninja School",
        privateMessage: "VCB 0123456789 NGUYEN VAN A",
      }),
    });
    assert.equal(payoutResponse.status, 200);
    const payoutPayload = await payoutResponse.json();
    assert.equal(payoutPayload.coinTrade.bankName, "VCB");
    assert.equal(payoutPayload.coinTrade.accountNumber, "0123456789");
    assert.equal(payoutPayload.coinTrade.status, "completed");

    const approvePayoutResponse = await fetch(`${baseUrl}/api/bando/coin-trades/${sellPayload.coinTrade.orderCode}/payout/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "duyet tra tien test" }),
    });
    assert.equal(approvePayoutResponse.status, 200);
    const approvePayoutPayload = await approvePayoutResponse.json();
    assert.equal(approvePayoutPayload.coinTrade.status, "payout_completed");

    const payoutNotificationResponse = await fetch(`${baseUrl}/api/bando/bot/deliveries/pending`);
    assert.equal(payoutNotificationResponse.status, 200);
    const payoutNotificationPayload = await payoutNotificationResponse.json();
    const payoutNotification = payoutNotificationPayload.notifications.find(
      (notification) => notification.orderCode === sellPayload.coinTrade.orderCode && notification.type === "payout_completed",
    );
    assert.ok(payoutNotification);
    assert.match(payoutNotification.message, /Da thanh toan so tien 10\.000 VND cho don/);

    const confirmNotificationResponse = await fetch(`${baseUrl}/api/bando/bot/notifications/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderCode: sellPayload.coinTrade.orderCode,
        type: "payout_completed",
      }),
    });
    assert.equal(confirmNotificationResponse.status, 200);

    const sellCancelResponse = await fetch(`${baseUrl}/api/bando/bot/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterName: "KhachHuyStk",
        serverName: "Ninja School",
        privateMessage: "banxu 2600000",
      }),
    });
    assert.equal(sellCancelResponse.status, 200);
    const sellCancelPayload = await sellCancelResponse.json();
    const sellCancelDeliveryResponse = await fetch(`${baseUrl}/api/bando/bot/deliveries/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderCode: sellCancelPayload.coinTrade.orderCode,
        botName: "NinjaBot",
        receivedCoinAmount: 2600000,
      }),
    });
    assert.equal(sellCancelDeliveryResponse.status, 200);
    const cancelPayoutResponse = await fetch(`${baseUrl}/api/bando/bot/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterName: "KhachHuyStk",
        serverName: "Ninja School",
        privateMessage: "Huy",
      }),
    });
    assert.equal(cancelPayoutResponse.status, 200);
    const cancelPayoutPayload = await cancelPayoutResponse.json();
    assert.equal(cancelPayoutPayload.coinTrade.status, "payout_info_cancelled");

    const historyResponse = await fetch(`${baseUrl}/api/bando/history`);
    assert.equal(historyResponse.status, 200);
    const historyPayload = await historyResponse.json();
    assert.ok(historyPayload.coinTrades.some((trade) => trade.orderCode === buyPayload.order.orderCode));
    assert.ok(historyPayload.coinTrades.some((trade) => trade.orderCode === sellPayload.coinTrade.orderCode && trade.accountName === "NGUYEN VAN A" && trade.status === "payout_completed" && trade.payoutNotifiedAt));
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Bando API thong ke web gom tat ca game server va khoa sua xu buff", async () => {
  const previousDevUsername = process.env.BANDO_DEV_ADMIN_USERNAME;
  process.env.BANDO_DEV_ADMIN_USERNAME = "datxt998";
  const { server, baseUrl } = await listen(createApp({ serveFrontend: false }));
  const today = todayInputDate();
  const statsUrl = `${baseUrl}/api/bando/statistics?fromDate=${today}&toDate=${today}`;
  try {
    const baselineResponse = await fetch(statsUrl);
    assert.equal(baselineResponse.status, 200);
    const baseline = await baselineResponse.json();

    const configResponse = await fetch(`${baseUrl}/api/bando/bot/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        characterName: "StatsBot",
        gameName: "Ninja 2D",
        serverName: "S-Stats",
        coinTrade: {
          sell: { enabled: true, rate: 2.0 },
          importXu: { enabled: true, rate: 2.5 },
        },
      }),
    });
    assert.equal(configResponse.status, 200);

    const buyResponse = await fetch(`${baseUrl}/api/bando/bot/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterName: "StatsBuyer",
        gameName: "Ninja 2D",
        serverName: "S-Stats",
        privateMessage: "muaxu 1000000",
        coin: 5000000,
      }),
    });
    assert.equal(buyResponse.status, 201);
    const buyPayload = await buyResponse.json();
    assert.equal(buyPayload.order.totalAmount, 5000);

    const payResponse = await fetch(`${baseUrl}/api/bando/payments/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        paymentCode: buyPayload.order.paymentCode,
        amount: buyPayload.order.totalAmount,
        note: "stats payment",
      }),
    });
    assert.equal(payResponse.status, 200);

    const sellResponse = await fetch(`${baseUrl}/api/bando/bot/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterName: "StatsSeller",
        gameName: "Ninja 2D",
        serverName: "S-Stats",
        privateMessage: "banxu 1000000",
      }),
    });
    assert.equal(sellResponse.status, 200);
    const sellPayload = await sellResponse.json();
    assert.equal(sellPayload.coinTrade.totalAmount, 4000);

    const receiveResponse = await fetch(`${baseUrl}/api/bando/bot/deliveries/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderCode: sellPayload.coinTrade.orderCode,
        botName: "StatsBot",
        receivedCoinAmount: 1000000,
      }),
    });
    assert.equal(receiveResponse.status, 200);

    const statsResponse = await fetch(statsUrl);
    assert.equal(statsResponse.status, 200);
    const stats = await statsResponse.json();
    assert.ok(stats.buffedXuCanEdit);
    assert.equal(stats.totals.soldXu - baseline.totals.soldXu, 1000000);
    assert.equal(stats.totals.soldMoney - baseline.totals.soldMoney, 5000);
    assert.equal(stats.totals.importedXu - baseline.totals.importedXu, 1000000);
    assert.equal(stats.totals.importedMoney - baseline.totals.importedMoney, 4000);
    assert.equal(stats.totals.netIncome - baseline.totals.netIncome, 1000);
    assert.ok(stats.byServer.some((row) => row.gameName === "Ninja 2D" && row.serverName === "S-Stats"));

    const buffResponse = await fetch(`${baseUrl}/api/bando/statistics/buffed-xu`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fromDate: today,
        toDate: today,
        buffedDate: today,
        amount: "123.456.789",
        note: "buff lan 1",
      }),
    });
    assert.equal(buffResponse.status, 200);
    const buffPayload = await buffResponse.json();
    assert.equal(buffPayload.totals.buffedXu, 123456789);
    assert.equal(buffPayload.buffedEntries.length, 1);
    assert.equal(buffPayload.buffedEntries[0].note, "buff lan 1");

    const zeroBuffResponse = await fetch(`${baseUrl}/api/bando/statistics/buffed-xu`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fromDate: today,
        toDate: today,
        buffedDate: today,
        amount: "0",
      }),
    });
    assert.equal(zeroBuffResponse.status, 400);

    const secondBuffResponse = await fetch(`${baseUrl}/api/bando/statistics/buffed-xu`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fromDate: today,
        toDate: today,
        buffedDate: today,
        amount: 11,
        note: "buff lan 2",
      }),
    });
    assert.equal(secondBuffResponse.status, 200);
    const secondBuffPayload = await secondBuffResponse.json();
    assert.equal(secondBuffPayload.totals.buffedXu, 123456800);
    assert.equal(secondBuffPayload.buffedEntries.length, 2);

    const editBuffResponse = await fetch(`${baseUrl}/api/bando/statistics/buffed-xu`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: buffPayload.buffedEntries[0].id,
        fromDate: today,
        toDate: today,
        buffedDate: today,
        amount: 100,
        note: "buff da sua",
      }),
    });
    assert.equal(editBuffResponse.status, 200);
    const editBuffPayload = await editBuffResponse.json();
    assert.equal(editBuffPayload.totals.buffedXu, 111);
    assert.ok(editBuffPayload.buffedEntries.some((entry) => entry.amount === 100 && entry.note === "buff da sua"));

    process.env.BANDO_DEV_ADMIN_USERNAME = "other-admin";
    const deniedResponse = await fetch(`${baseUrl}/api/bando/statistics/buffed-xu`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        fromDate: today,
        toDate: today,
        buffedXu: 1,
      }),
    });
    assert.equal(deniedResponse.status, 403);

    const resetConfigResponse = await fetch(`${baseUrl}/api/bando/bot/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        characterName: "ADMIN",
        gameName: "Ninja Mobile",
        serverName: "nso-local",
        serverProfiles: [],
      }),
    });
    assert.equal(resetConfigResponse.status, 200);
  } finally {
    if (previousDevUsername == null) {
      delete process.env.BANDO_DEV_ADMIN_USERNAME;
    } else {
      process.env.BANDO_DEV_ADMIN_USERNAME = previousDevUsername;
    }
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Bando BOT dùng cấu hình web để xác nhận đúng nhân vật", async () => {
  const { server, baseUrl } = await listen(createApp({ serveFrontend: false }));
  try {
    const updateResponse = await fetch(`${baseUrl}/api/bando/bot/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        characterName: "AdminShop",
        serverName: "Ninja School",
        inventorySyncMs: 12000,
        stand: {
          enabled: true,
          mapId: 22,
          zoneId: 18,
          x: 488,
          y: 216,
          tolerance: 10,
          intervalMs: 1500,
        },
        autoChat: {
          enabled: true,
          text: "Bán đồ tự động, chat riêng 'xem' để xem hàng.",
          intervalMs: 60000,
          community: true,
          world: false,
        },
        coinTrade: {
          sell: {
            enabled: true,
            rate: 2.6,
          },
          importXu: {
            enabled: true,
            rate: 2.2,
          },
        },
      }),
    });
    assert.equal(updateResponse.status, 200);

    const configResponse = await fetch(`${baseUrl}/api/bando/bot/config`);
    assert.equal(configResponse.status, 200);
    const configPayload = await configResponse.json();
    assert.equal(configPayload.config.characterName, "AdminShop");
    assert.equal(configPayload.config.stand.mapId, 22);
    assert.equal(configPayload.config.coinTrade.sell.rate, 2.6);
    assert.equal(configPayload.config.coinTrade.importXu.rate, 2.2);

    const resolveResponse = await fetch(`${baseUrl}/api/bando/bot/config/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterName: "AdminShop",
        serverName: "Ninja School",
      }),
    });
    assert.equal(resolveResponse.status, 200);
    const resolvePayload = await resolveResponse.json();
    assert.equal(resolvePayload.ok, true);
    assert.equal(resolvePayload.config.autoChat.enabled, true);
    assert.equal(resolvePayload.config.coinTrade.sell.rate, 2.6);

    const mismatchResponse = await fetch(`${baseUrl}/api/bando/bot/config/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterName: "NguoiKhac",
        serverName: "Ninja School",
      }),
    });
    assert.equal(mismatchResponse.status, 400);
    const mismatchPayload = await mismatchResponse.json();
    assert.match(mismatchPayload.error, /Sai nhân vật BOT/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Bando BOT lấy danh sách game/server không cần API quản trị", async () => {
  const { server, baseUrl } = await listen(createApp({ serveFrontend: false }));
  try {
    const createResponse = await fetch(`${baseUrl}/api/bando/game-servers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gameName: "Ninja Mobile",
        name: "S99-Test",
        code: "s99-test",
        status: "online",
        dbHost: "private-db-host",
        dbPort: 3306,
        dbUser: "private-user",
        dbPassword: "private-password",
        dbGameDatabase: "private-game-db",
        dbPlayerDatabase: "private-player-db",
      }),
    });
    assert.equal(createResponse.status, 201);

    const listResponse = await fetch(`${baseUrl}/api/bando/bot/game-servers`);
    assert.equal(listResponse.status, 200);
    const listPayload = await listResponse.json();
    const serverProfile = listPayload.gameServers.find((entry) => entry.name === "S99-Test");
    assert.equal(serverProfile.gameName, "Ninja Mobile");
    assert.equal(serverProfile.serverName, "S99-Test");
    assert.equal(serverProfile.dbHost, undefined);
    assert.equal(serverProfile.dbPassword, undefined);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Bando API duyệt tay đơn hàng và đưa vào danh sách chờ BOT giao", async () => {
  const { server, baseUrl } = await listen(createApp({ serveFrontend: false }));
  try {
    const configResponse = await fetch(`${baseUrl}/api/bando/bot/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        characterName: "NinjaBot",
        serverName: "Ninja School",
        serverProfiles: [],
      }),
    });
    assert.equal(configResponse.status, 200);

    const priceResponse = await fetch(`${baseUrl}/api/bando/prices`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "manual-delivery-item",
        itemId: 900002,
        name: "Manual delivery item",
        buyName: "manualitem",
        aliases: ["manualitem"],
        unit: "cái",
        sellPrice: 5000,
        stock: 100,
        active: true,
      }),
    });
    assert.equal(priceResponse.status, 200);

    const inventoryResponse = await fetch(`${baseUrl}/api/bando/bot/inventory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterName: "NinjaBot",
        serverName: "Ninja School",
        inventory: [{ itemId: 900002, name: "Manual delivery item", quantity: 100 }],
      }),
    });
    assert.equal(inventoryResponse.status, 200);

    const orderResponse = await fetch(`${baseUrl}/api/bando/bot/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterName: "NguoiMua",
        serverName: "Ninja School",
        privateMessage: "manualitem 3",
      }),
    });
    assert.equal(orderResponse.status, 201);
    const orderPayload = await orderResponse.json();

    const approveResponse = await fetch(`${baseUrl}/api/bando/orders/${orderPayload.order.orderCode}/approve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "duyệt tay test" }),
    });
    assert.equal(approveResponse.status, 200);
    const approvePayload = await approveResponse.json();
    assert.equal(approvePayload.order.status, "paid");
    assert.equal(approvePayload.deliveryJob.itemId, 900002);

    const pendingResponse = await fetch(`${baseUrl}/api/bando/bot/deliveries/pending`);
    assert.equal(pendingResponse.status, 200);
    const pendingPayload = await pendingResponse.json();
    assert.ok(pendingPayload.deliveries.some((delivery) => delivery.orderCode === orderPayload.order.orderCode));

    const deliveryResponse = await fetch(`${baseUrl}/api/bando/bot/deliveries/confirm`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        orderCode: orderPayload.order.orderCode,
        botName: "NinjaBot",
      }),
    });
    assert.equal(deliveryResponse.status, 200);
    const deliveryPayload = await deliveryResponse.json();
    assert.equal(deliveryPayload.order.status, "completed");
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Bando API tách tồn kho theo đúng nhân vật BOT của từng server", async () => {
  const { server, baseUrl } = await listen(createApp({ serveFrontend: false }));
  try {
    const configResponse = await fetch(`${baseUrl}/api/bando/bot/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serverName: "Scope Server",
        characterName: "ScopeBot",
        serverProfiles: [
          {
            serverName: "Scope Server",
            characterName: "ScopeBot",
            enabled: true,
          },
        ],
      }),
    });
    assert.equal(configResponse.status, 200);

    const priceResponse = await fetch(`${baseUrl}/api/bando/prices`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "scoped-stock-item",
        itemId: 900003,
        name: "Scoped stock item",
        buyName: "scopedstock",
        aliases: ["scopedstock"],
        unit: "cái",
        sellPrice: 1000,
        stock: 0,
        active: true,
      }),
    });
    assert.equal(priceResponse.status, 200);

    const acceptedInventoryResponse = await fetch(`${baseUrl}/api/bando/bot/inventory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterName: "ScopeBot",
        serverName: "Scope Server",
        inventory: [{ itemId: 900003, name: "Scoped stock item", quantity: 5 }],
      }),
    });
    assert.equal(acceptedInventoryResponse.status, 200);

    const rejectedInventoryResponse = await fetch(`${baseUrl}/api/bando/bot/inventory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterName: "OtherBot",
        serverName: "Scope Server",
        inventory: [{ itemId: 900003, name: "Scoped stock item", quantity: 99 }],
      }),
    });
    assert.equal(rejectedInventoryResponse.status, 400);

    const stateResponse = await fetch(`${baseUrl}/api/bando/history?serverName=${encodeURIComponent("Scope Server")}`);
    assert.equal(stateResponse.status, 200);
    const statePayload = await stateResponse.json();
    const liveItem = statePayload.items.find((item) => item.code === "scoped-stock-item");
    assert.equal(liveItem.stock, 5);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Bando API tách tồn kho theo game khi trùng tên server", async () => {
  const { server, baseUrl } = await listen(createApp({ serveFrontend: false }));
  try {
    const configResponse = await fetch(`${baseUrl}/api/bando/bot/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gameName: "Ninja Mobile",
        serverName: "Shared Server",
        characterName: "MobileBot",
        serverProfiles: [
          { gameName: "Ninja Mobile", serverName: "Shared Server", characterName: "MobileBot", enabled: true },
          { gameName: "Ninja 2D", serverName: "Shared Server", characterName: "TwoDBot", enabled: true },
        ],
      }),
    });
    assert.equal(configResponse.status, 200);

    const mobileItemCode = "ninja-mobile-shared-server-item-900004";
    const twoDItemCode = "ninja-2d-shared-server-item-900004";
    const priceResponse = await fetch(`${baseUrl}/api/bando/prices`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: mobileItemCode,
        gameName: "Ninja Mobile",
        serverName: "Shared Server",
        itemId: 900004,
        name: "Shared mobile item",
        buyName: "sharedgame",
        aliases: ["sharedgame"],
        unit: "cái",
        sellPrice: 1000,
        stock: 0,
        active: true,
      }),
    });
    assert.equal(priceResponse.status, 200);

    const twoDPriceResponse = await fetch(`${baseUrl}/api/bando/prices`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: twoDItemCode,
        gameName: "Ninja 2D",
        serverName: "Shared Server",
        itemId: 900004,
        name: "Shared 2D item",
        buyName: "sharedgame",
        aliases: ["sharedgame"],
        unit: "cai",
        sellPrice: 1000,
        stock: 0,
        active: true,
      }),
    });
    assert.equal(twoDPriceResponse.status, 200);

    const mobileInventoryResponse = await fetch(`${baseUrl}/api/bando/bot/inventory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gameName: "Ninja Mobile",
        serverName: "Shared Server",
        characterName: "MobileBot",
        inventory: [{ itemId: 900004, name: "Shared game item", quantity: 7 }],
      }),
    });
    assert.equal(mobileInventoryResponse.status, 200);

    const twoDInventoryResponse = await fetch(`${baseUrl}/api/bando/bot/inventory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gameName: "Ninja 2D",
        serverName: "Shared Server",
        characterName: "TwoDBot",
        inventory: [{ itemId: 900004, name: "Shared game item", quantity: 22 }],
      }),
    });
    assert.equal(twoDInventoryResponse.status, 200);

    const mobileStateResponse = await fetch(`${baseUrl}/api/bando/history?gameName=${encodeURIComponent("Ninja Mobile")}&serverName=${encodeURIComponent("Shared Server")}`);
    const mobileState = await mobileStateResponse.json();
    assert.equal(mobileState.items.find((item) => item.code === mobileItemCode).stock, 7);

    const twoDStateResponse = await fetch(`${baseUrl}/api/bando/history?gameName=${encodeURIComponent("Ninja 2D")}&serverName=${encodeURIComponent("Shared Server")}`);
    const twoDState = await twoDStateResponse.json();
    assert.equal(twoDState.items.find((item) => item.code === twoDItemCode).stock, 22);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Bando API khop thanh toan tu webhook ngan hang", async () => {
  const { server, baseUrl } = await listen(createApp({ serveFrontend: false }));
  try {
    const priceResponse = await fetch(`${baseUrl}/api/bando/prices`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        code: "webhook-payment-item",
        itemId: 900005,
        name: "Webhook payment item",
        buyName: "webhookitem",
        aliases: ["webhookitem"],
        unit: "cai",
        sellPrice: 15000,
        stock: 100,
        active: true,
      }),
    });
    assert.equal(priceResponse.status, 200);

    const configResponse = await fetch(`${baseUrl}/api/bando/bot/config`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        serverName: "Webhook Server",
        characterName: "WebhookBot",
        serverProfiles: [
          {
            serverName: "Webhook Server",
            characterName: "WebhookBot",
            enabled: true,
          },
        ],
      }),
    });
    assert.equal(configResponse.status, 200);

    const bankResponse = await fetch(`${baseUrl}/api/bando/bank-accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bankName: "MB BANK",
        bankCode: "MB",
        accountNumber: "0354340126",
        accountName: "SHOP BANDO",
        paymentPrefix: "MBN",
        callbackSignature: "unit-bank-signature",
        active: true,
      }),
    });
    assert.equal(bankResponse.status, 200);

    const inventoryResponse = await fetch(`${baseUrl}/api/bando/bot/inventory`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterName: "WebhookBot",
        serverName: "Webhook Server",
        inventory: [{ itemId: 900005, name: "Webhook payment item", quantity: 100 }],
      }),
    });
    assert.equal(inventoryResponse.status, 200);

    const orderResponse = await fetch(`${baseUrl}/api/bando/bot/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterName: "KhachWebhook",
        serverName: "Webhook Server",
        privateMessage: "webhookitem 2",
      }),
    });
    assert.equal(orderResponse.status, 201);
    const orderPayload = await orderResponse.json();
    assert.equal(orderPayload.order.paymentCode, orderPayload.order.orderCode);
    assert.match(orderPayload.order.paymentCode, safeOrderCodePattern);

    const webhookResponse = await fetch(`${baseUrl}/api/bando/payments/bank-webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        signature: "unit-bank-signature",
      },
      body: JSON.stringify({
        status: "success",
        message: "Thanh cong",
        TranList: [
          {
            refNo: "FT26160751856109",
            tranId: "FT26160751856109",
            postingDate: "09/06/2026 23:59:59",
            transactionDate: "09/06/2026 20:48:17",
            accountNo: "990919072000",
            creditAmount: String(orderPayload.order.totalAmount),
            debitAmount: "0",
            currency: "VND",
            description: `PHAN TIEN DUC QR ${orderPayload.order.paymentCode}- Ma GD ACSP/ nf407 079`,
            addDescription: `QR ${orderPayload.order.paymentCode}- Ma GD ACSP/ nf407 079`,
            availableBalance: "31246205",
            beneficiaryAccount: "",
            transactionType: "BI2B",
          },
        ],
      }),
    });
    assert.equal(webhookResponse.status, 200);
    const webhookPayload = await webhookResponse.json();
    assert.equal(webhookPayload.ok, true);
    assert.equal(webhookPayload.matched, 1);
    assert.equal(webhookPayload.results[0].paymentCode, orderPayload.order.paymentCode);
    assert.equal(webhookPayload.results[0].deliveryJob.characterName, "KhachWebhook");

    const duplicateResponse = await fetch(`${baseUrl}/api/bando/payments/bank-webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        signature: "unit-bank-signature",
      },
      body: JSON.stringify({
        transactionID: "MBB-UNIT-1-DUP",
        amount: `${orderPayload.order.totalAmount} VND`,
        content: `CK ${orderPayload.order.paymentCode}`,
        transactionType: "credit",
      }),
    });
    assert.equal(duplicateResponse.status, 200);
    const duplicatePayload = await duplicateResponse.json();
    assert.equal(duplicatePayload.results[0].status, "already_paid");

    const mbPrefixBankResponse = await fetch(`${baseUrl}/api/bando/bank-accounts`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        bankName: "MB Bank",
        bankCode: "MB",
        accountNumber: "0333650993",
        accountName: "HOANG TIEN DUNG",
        paymentPrefix: "MB",
        callbackSignature: "unit-bank-signature",
        active: true,
      }),
    });
    assert.equal(mbPrefixBankResponse.status, 200);

    const prefixOrderResponse = await fetch(`${baseUrl}/api/bando/bot/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        characterName: "KhachPrefix",
        serverName: "Webhook Server",
        privateMessage: "webhookitem 1",
      }),
    });
    assert.equal(prefixOrderResponse.status, 201);
    const prefixOrderPayload = await prefixOrderResponse.json();
    assert.match(prefixOrderPayload.order.paymentCode, safeOrderCodePattern);

    const prefixedWebhookResponse = await fetch(`${baseUrl}/api/bando/payments/bank-webhook`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        signature: "unit-bank-signature",
      },
      body: JSON.stringify({
        transactionID: "MBB-PREFIX-UNIT-1",
        creditAmount: String(prefixOrderPayload.order.totalAmount),
        debitAmount: "0",
        accountNo: "0333650993",
        description: `HOANG DUC CHIEN ${prefixOrderPayload.order.paymentCode} I2MBXWJ8/185934 MBVCB.15218596641.954170.${prefixOrderPayload.order.paymentCode}.CT`,
        transactionType: "credit",
      }),
    });
    assert.equal(prefixedWebhookResponse.status, 200);
    const prefixedWebhookPayload = await prefixedWebhookResponse.json();
    assert.equal(prefixedWebhookPayload.matched, 1);
    assert.equal(prefixedWebhookPayload.results[0].paymentCode, prefixOrderPayload.order.paymentCode);
    assert.ok(prefixedWebhookPayload.results[0].paymentCodes.includes(prefixOrderPayload.order.paymentCode));
    assert.equal(prefixedWebhookPayload.results[0].bankAccount.accountNumber, "0333650993");
    assert.equal(prefixedWebhookPayload.results[0].order.bankName, "MB Bank");
    assert.equal(prefixedWebhookPayload.results[0].order.accountNumber, "0333650993");

    const bankEvents = [];
    const unsubscribe = subscribeBandoEvents((event) => bankEvents.push(event));
    try {
      const unmatchedResponse = await fetch(`${baseUrl}/api/bando/payments/bank-webhook`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          signature: "unit-bank-signature",
        },
        body: JSON.stringify({
          TranList: [
            {
              transactionID: "MBB-UNMATCHED-1",
              creditAmount: "123456",
              debitAmount: "0",
              senderBankName: "ACB",
              senderName: "NGUYEN VAN B",
              senderAccount: "123000111",
              accountNo: "0354340126",
              description: "chuyen tien khong co ma nap",
              transactionType: "credit",
            },
          ],
        }),
      });
      assert.equal(unmatchedResponse.status, 200);
      const unmatchedPayload = await unmatchedResponse.json();
      assert.equal(unmatchedPayload.ignored, 1);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const unmatchedEvent = bankEvents.find((event) => event.type === "bank_unmatched_payment");
      assert.ok(unmatchedEvent);
      assert.equal(unmatchedEvent.payload.bankTransaction.amount, 123456);
      assert.equal(unmatchedEvent.payload.bankTransaction.senderBankName, "ACB");
      assert.equal(unmatchedEvent.payload.bankTransaction.description, "chuyen tien khong co ma nap");
    } finally {
      unsubscribe();
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
