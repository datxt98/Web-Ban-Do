import "dotenv/config";
import { createApp } from "./app.js";
import { startBankPaymentSync } from "./bank-sync.js";
import { startTelegramBot } from "./telegram-bot.js";

const port = Number(process.env.PORT || process.env.BANDO_BACKEND_PORT || 5001);
const app = createApp();

app.listen(port, () => {
  console.log(`Backend bán đồ đang chạy tại http://localhost:${port}`);
});

startBankPaymentSync();
startTelegramBot();
