# Authorized Code Reader

A full-stack application that retrieves a short-lived, four-digit login code from an
administrator-owned mailbox. The interface is in Vietnamese and is designed for
authorized internal use only.

This project does not contain provider-specific logic for any third-party subscription
service. Only connect mailboxes and sender domains that you own or are explicitly
authorized to use.

## Architecture

- **React + Vite + Tailwind CSS** render the responsive glassmorphism interface.
- **Express** serves the production frontend and the JSON API.
- **ImapFlow** opens a TLS-only, read-only IMAP connection.
- **Mailparser** parses text and HTML email without changing read/unread flags.
- **Zod** validates the environment and every creation request.
- **In-memory Maps** hold active jobs, rate-limit counters, and completed results.
- **Vitest** uses mocked mailbox clients; tests never require a real mailbox.

The browser creates a job, then polls its status every two seconds. The server records
the request time and the mailbox's next UID, inspects only newer messages, and closes
the IMAP connection on success, timeout, cancellation, error, or shutdown.

Only one IMAP watcher runs for each mailbox. Cancellation is confirmed after that
watcher closes. During this brief handoff, one new request can wait in a `queued`
state and starts automatically as soon as the previous watcher has stopped.

Only successfully created requests consume the per-mailbox abuse limit. A confirmed
cancellation releases that request's reservation, so the mailbox can be requested
again immediately. Non-cancelled requests remain limited to six starts per rolling
ten-minute window, and the reverse-proxy-aware IP limit allows thirty successful
starts per rolling ten-minute window.

## Requirements

- Node.js 20.19 or newer
- npm
- An IMAP mailbox owned by the administrator
- A sender address or domain owned by the administrator, or explicit authorization to
  process its login-code messages

## Local installation

```bash
npm install
cp .env.example .env
```

Edit `.env` before starting the API. Do not commit that file.

```bash
npm run dev
```

The frontend runs at `http://localhost:5173` and proxies API requests to port `3001`.

## Environment configuration

`MAILBOXES_JSON` is a JSON array. Each mailbox entry has:

- `email`: the exact email a user is allowed to submit
- `imap.host`, `imap.port`, and `imap.secure`: TLS IMAP settings; `secure` must be
  `true`
- `imap.username` and `imap.password`: runtime-only credentials
- `allowedSenders`: exact authorized sender addresses
- `allowedSenderDomains`: authorized sender domains
- `loginKeywords`: phrases expected near a legitimate login code

The server refuses to start if configuration is missing, malformed, duplicated, not
TLS-only, or has no sender allowlist. Errors never print the configuration.

### Add an authorized mailbox

1. Copy `.env.example` to `.env`.
2. Add an object to the `MAILBOXES_JSON` array.
3. Use a dedicated app password if the mailbox provider supports it.
4. Add the narrowest possible sender address or domain allowlist.
5. Add only phrases used by ordinary login or verification-code messages.
6. Restart the single server instance.

The frontend never receives IMAP credentials.

## Sender and message filtering

A message is processed only when all of the following are true:

- its UID is new for the current request;
- its internal received time is not earlier than the request;
- at least one sender matches an exact address or configured domain;
- a configured login keyword appears;
- one high-confidence four-digit code is close to that keyword.

Password resets, account recovery, security alerts, account changes, payment changes,
new-device approval, and similar sensitive flows are rejected. Years, dates, prices,
phone fragments, order numbers, and unrelated four-digit numbers are rejected.

## Commands

```bash
npm run dev
npm run build
npm start
npm test
npm run lint
npm run typecheck
```

Production uses `dist/client` for static assets and `dist/server/server/index.js` for
the Express server.

## Docker deployment

```bash
cp .env.example .env
docker compose up --build -d
```

Place the container behind an HTTPS reverse proxy and restrict who can reach it. The
application needs outbound TCP access to each configured IMAP host and port.
The Express application trusts exactly one proxy hop for client-IP rate limiting.

This no-database edition must run as **one server instance**. Multiple replicas would
have separate job and rate-limit Maps. Active requests are lost whenever the server
restarts.

### Hosting compatibility

Deploy the complete application to a single Node.js or Docker host with outbound TCP
access to IMAP. Static-only and edge-worker hosting is not suitable for this build:
the required Express process and ImapFlow connection need a Node runtime with
long-lived TLS sockets.

### Vercel

The included `vercel.json` publishes `dist/client`, so a Vercel deployment can serve
the frontend without returning `NOT_FOUND`. This is a frontend preview only. Do not
configure mailbox credentials in that Vercel project and do not treat it as the
production API: the in-memory request Map and five-minute IMAP watcher require the
single long-running Node/Docker process described above.

### Render

The included `render.yaml` creates one Node web service and prompts for
`MAILBOXES_JSON` during the initial Blueprint setup. Enter the value only in Render's
secret environment-variable form; never add it to this repository.

1. In Render, create a new Blueprint from this repository.
2. Enter the production `MAILBOXES_JSON` value when prompted.
3. Keep exactly one service instance.
4. Verify `GET /api/health` returns `{"status":"ok"}` over HTTPS.

The Free instance type is suitable only for testing because Render can suspend it
after a period without inbound traffic and can restart it at any time. Use a
non-sleeping single instance for reliable production code retrieval.

## Security limitations

- This is an authorization aid, not an identity provider.
- Codes remain in memory for at most 60 seconds after completion.
- No email, code, or mailbox data is stored in local storage, session storage,
  cookies, URL parameters, or a database.
- Network access controls and HTTPS are still required.
- Allowlist maintenance is an administrator responsibility.
- Review [SECURITY.md](./SECURITY.md) before production use.

## IMAP troubleshooting

- Confirm the server supports IMAP over implicit TLS, normally port 993.
- Confirm the app password or OAuth-compatible credential is current.
- Verify the mailbox provider permits IMAP access.
- Verify the container or host can reach the IMAP hostname and port.
- Ensure the configured mailbox email exactly matches what users submit.
- Confirm the sender address/domain and login keyword match the authorized message.
- Check server logs for the safe generic error only; do not log message content or
  credentials while debugging.

The watcher retries one temporary connection failure, then reports a generic error.
It never deletes messages and opens the inbox read-only.
