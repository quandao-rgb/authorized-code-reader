# Project guidance

- This application is only for administrator-owned mailboxes and explicitly authorized services.
- Never add provider-specific logic for third-party subscription services.
- Never commit `.env`, mailbox credentials, tokens, retrieved codes, email subjects, or email bodies.
- Keep all code-related API responses cache-disabled.
- Preserve TLS certificate verification and read-only IMAP behavior.
- Any new message category must default to rejected until its authorization rules are explicit.
- Run `npm run lint`, `npm run typecheck`, `npm test`, and `npm run build` before merging.
