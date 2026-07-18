import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

process.env.BANDO_DISABLE_MYSQL = "1";

const projectRoot = new URL("../", import.meta.url);
const previewRoot = new URL("../app/_sites-preview/", import.meta.url);

async function createWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return {
    fetch(path, init = {}) {
      return worker.fetch(
        new Request(`http://localhost${path}`, init),
        {
          ASSETS: {
            fetch: async () => new Response("Not found", { status: 404 }),
          },
        },
        {
          waitUntil() {},
          passThroughOnException() {},
        },
      );
    },
  };
}

test("server-renders the private Bando control dashboard", async () => {
  const worker = await createWorker();
  const response = await worker.fetch("/", {
    headers: { accept: "text/html" },
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Bảng quản lý bán đồ<\/title>/i);
  assert.match(html, /Bảng quản lý bán đồ/);
  assert.match(html, /Gian hàng/);
  assert.match(html, /Thêm item bán/);
  assert.match(html, /Đơn hàng/);
  assert.doesNotMatch(html, /codex-preview|react-loading-skeleton|SkeletonPreview/i);
});

test("Bando API creates an order, matches payment, and confirms delivery", async () => {
  const worker = await createWorker();

  const priceResponse = await worker.fetch("/api/bando/prices", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code: "test-bando-unit",
      itemId: 900001,
      name: "Test item",
      buyName: "codextest",
      aliases: ["codextest"],
      unit: "cai",
      sellPrice: 12000,
      stock: 5000,
      active: true,
    }),
  });
  assert.equal(priceResponse.status, 200);

  const orderResponse = await worker.fetch("/api/bando/bot/orders", {
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
  assert.match(orderPayload.reply, /Nội dung chuyển khoản:/);

  const paymentResponse = await worker.fetch("/api/bando/payments/confirm", {
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

  const deliveryResponse = await worker.fetch("/api/bando/bot/deliveries/confirm", {
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

  const historyResponse = await worker.fetch("/api/bando/history");
  assert.equal(historyResponse.status, 200);
  const historyPayload = await historyResponse.json();
  assert.ok(historyPayload.orders.some((order) => order.orderCode === orderPayload.order.orderCode));
  assert.ok(historyPayload.transactions.some((transaction) => transaction.paymentCode === orderPayload.order.paymentCode));
});

test("starter preview is removed from the finished app", async () => {
  const [page, layout, packageJson, hosting] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../.openai/hosting.json", import.meta.url), "utf8"),
  ]);

  assert.match(page, /<BandoAdmin \/>/);
  assert.match(layout, /lang="vi"/);
  assert.match(hosting, /"d1": "DB"/);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/);
  await assert.rejects(access(previewRoot));
  await assert.rejects(access(new URL("public/_sites-preview", projectRoot)));
});
