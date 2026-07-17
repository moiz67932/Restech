# Restec Platform

Restec is a vendor-neutral restaurant POS integration and payment-status platform. This npm-workspace monorepo contains the Hono API, public documentation, partner portal, canonical contracts, connector framework, durable PostgreSQL inbox/outbox schema, and integration/security tooling.

## Commands

```sh
npm install
npm run format
npm run lint
npm run typecheck
npm test
npm run build
npm run verify
```

Use separate sandbox, production, and test configuration. Never reuse credentials across environments. The initial connectors are `canonical_rest` and `mock_pos`; real vendor behavior requires verified documentation and certification.
