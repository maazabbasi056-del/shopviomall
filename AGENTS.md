# ShopVioMall repository guide

## Architecture

- Express/Mongoose backend starts in `server.js`; dotenv is loaded before backend modules.
- `routes/` contains `/api` handlers, `models/` contains MongoDB schemas, `middleware/auth.js` enforces JWT roles, and `services/` contains shared business rules.
- The customer storefront, Seller Central, Admin Central, and policy pages are currently in `index.html`; the same Express origin serves `/` and app routes.
- `scripts/setup-admin.js` configures the owner account interactively. `scripts/seed-catalog.js` is development-only and tags inserted products for safe cleanup.

## Commands

- Install deterministically with `npm ci`.
- Start locally with `npm start`.
- Run automated checks with `npm test`.
- Readiness endpoint: `/api/health`; healthy means HTTP 200 and database connected.
- Local configuration is in ignored `.env`; `.env.example` contains names/placeholders only.

## Roles and security invariants

- Roles are `customer`, `vendor`, and `admin`. A vendor must be approved before Seller Central access.
- Treat MongoDB as the source of truth. Use the existing JWT module and authorization middleware.
- Enforce role, ownership, and account status on backend routes; never rely on frontend hiding.
- Never return password hashes, transaction-password hashes, KYC payloads, JWT secrets, or credentials. Never log passwords or tokens.
- Validate and allowlist request fields. Escape user content before rendering HTML. Public product images and protected KYC/evidence files must remain separate.
- Keep wallet amounts server-calculated, idempotent, ledger-backed, and transactional. Held/pending earnings cannot be withdrawn; payment/order/refund retries must not duplicate movements.
- Do not fabricate payments, sales, reviews, seller performance, or customer activity.

## Data and release safety

- Use MongoDB transactions for multi-record financial/order changes when supported by the configured cluster.
- Keep list APIs bounded and paginated. Add indexes only for measured/query-backed access patterns.
- Seed data only in development and clean only records with the exact seed marker.
- Never print `.env`, commit credentials, relax TLS, disable authorization, or run destructive database cleanup without explicit scope and a verified backup.
- Before deployment: review legal placeholders, rotate historical leaked credentials, verify backup and restore, run tests against staging, deploy a release, check health/smoke flows, and retain a rollback artifact. Do not change DNS or deploy without an explicit deployment task.
