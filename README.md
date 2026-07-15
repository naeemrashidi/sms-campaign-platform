# SMS & WhatsApp Campaign Platform

A bulk messaging service built on the Twilio API. Upload a contact list as an Excel file, send a templated message over SMS and/or WhatsApp to every contact, and track delivery status in real time as Twilio reports it back.

## How It Works

```mermaid
flowchart LR
    A[Excel Upload] --> B[Contact Parser]
    B --> C[Concurrent Sender]
    C --> D[Twilio API]
    D --> E[Delivery Status Webhook]
    E --> F[Campaign Log]
```

1. An Excel file of contacts is uploaded through the web UI.
2. Rows are parsed and normalized into `NAME`, `CONTACT`, `LINK`, and `PROMO_CODE` fields, with support for varied column headers.
3. A message template (supporting `{{name}}`, `{{link}}`, `{{promo_code}}` placeholders) is rendered per contact and sent through Twilio, with sends bounded by a concurrency limit so large campaigns do not overwhelm the API.
4. Twilio's inbound and status-callback webhooks feed delivery state back into an in-memory campaign log, exposed through a `/logs` endpoint.

## Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js, Express |
| Messaging | Twilio (SMS + WhatsApp) |
| File parsing | xlsx (Excel), multer (uploads) |
| Concurrency | p-limit |
| Frontend | Vanilla HTML/CSS/JS |

## Features

- Dual-channel sending: SMS, WhatsApp, or both per campaign
- Per-contact message templating
- Bounded concurrency to respect Twilio rate limits on large contact lists
- Client-initiated cancellation mid-campaign
- Delivery and read-status tracking via Twilio webhooks
- Graceful shutdown handling (`SIGINT`/`SIGTERM`)

## Running Locally

```bash
cd backend
npm install
cp .env.example .env
```

Fill in `.env` with a Twilio Account SID, Auth Token, and Messaging Service SID, then:

```bash
npm start
```

Visit `http://localhost:4000`.

### Twilio webhook configuration

On the Messaging Service used above, in the Twilio Console:
- **Inbound webhook**: `<PUBLIC_BASE_URL>/twilio/incoming`
- **Status callback**: `<PUBLIC_BASE_URL>/twilio/status`

## About This Repository

This project was verified end to end before publishing: dependency install, server boot, and `/health` and static frontend responses were all confirmed working. See [LICENSE](LICENSE) for usage terms.
