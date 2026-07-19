# Web BANDO VPS Deploy

This package contains only the production files:

- `backend/src`: backend API.
- `frontend/dist`: built admin web.
- `package.json`: production dependencies only.
- `.env.example`: environment template.

## Run On VPS

```powershell
npm install --omit=dev
Copy-Item .env.example .env
notepad .env
npm start
```

The app listens on:

```text
http://0.0.0.0:1122
```

## Import Game Servers

To import a `game_servers.sql` dump into the `bando.game_servers` table:

```bash
npm run db:import-game-servers -- /path/to/game_servers.sql
```

The SQL file is not included in Git or in this deploy package because it contains DB passwords and socket keys.

Bank callback URL:

```text
http://YOUR_PUBLIC_IP:1122/api/bando/payments/bank-webhook
```

For production with a domain and HTTPS, put Nginx/Caddy/IIS in front of port `1122` and use:

```text
https://YOUR_DOMAIN/api/bando/payments/bank-webhook
```

## Required `.env`

Set the MySQL values for the VPS:

```text
BANDO_DB_HOST=127.0.0.1
BANDO_DB_PORT=3306
BANDO_DB_USER=root
BANDO_DB_PASS=your-password
BANDO_DB_NAME=bando
BANDO_PUBLIC_URL=http://YOUR_PUBLIC_IP:1122
```

Keep real API tokens and callback signatures out of Git. Configure bank accounts and signatures from the BANDO admin web after the server is running.

## Telegram Admin Bot

The Telegram bot uses polling, so you do not need HTTPS or a Telegram webhook.

Add these values to `.env` on the VPS:

```text
BANDO_TELEGRAM_ENABLED=1
BANDO_TELEGRAM_BOT_TOKEN=bot-token-from-botfather
BANDO_TELEGRAM_CHAT_IDS=your-chat-id
BANDO_TELEGRAM_ALLOWED_USER_IDS=your-telegram-user-id
BANDO_TELEGRAM_POLL_MS=2500
```

Commands:

```text
/id              show chat id and user id
/duyet <ma_don>  approve item/xu buy order payment
/huy <ma_don>    cancel an order or xu ticket
/traxu <ma>      approve payout for a customer sell-xu ticket
```
