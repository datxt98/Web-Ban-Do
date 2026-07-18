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
http://0.0.0.0:5001
```

Bank callback URL:

```text
http://YOUR_PUBLIC_IP:5001/api/bando/payments/bank-webhook
```

For production with a domain and HTTPS, put Nginx/Caddy/IIS in front of port `5001` and use:

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
```

Keep real API tokens and callback signatures out of Git. Configure bank accounts and signatures from the BANDO admin web after the server is running.
