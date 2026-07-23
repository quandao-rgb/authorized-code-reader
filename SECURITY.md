# Security policy

## Authorized use only

This project may only connect to mailboxes owned and configured by the administrator,
and may only read login-code messages from senders or domains the administrator owns
or is explicitly authorized to use. It must not be adapted to target third-party
subscription services without their explicit authorization.

## Secret handling

- Store production credentials only in runtime environment variables or a managed
  secret store.
- Never commit `.env`, mailbox passwords, OAuth tokens, app passwords, messages, or
  retrieved codes.
- Use a dedicated mailbox and a dedicated least-privilege app password when the
  provider supports it.
- Restrict access to the web application at the network or reverse-proxy layer.
- Terminate public HTTPS at a trusted reverse proxy. The application itself must not
  be exposed over plain HTTP on the public internet.

## Important limitations

- Jobs and rate-limit counters are kept in memory. A restart clears them.
- The no-database design must run as a single application instance.
- A four-digit code is sensitive authentication data. The server keeps a completed
  result for up to 60 seconds and sends `Cache-Control: no-store`.
- Sender and keyword allowlists reduce risk but cannot prove the intent of every
  possible email. Review allowlists conservatively.
- IMAP access is read-only, uses TLS, and retains certificate verification.

## Reporting a vulnerability

Do not open a public issue containing secrets, mailbox addresses, message content, or
working codes. Contact the repository owner privately with a minimal reproduction and
redacted logs.
