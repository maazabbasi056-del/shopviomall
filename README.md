# ShopVioMall

ShopVioMall is a multi-vendor marketplace web application. It combines a browser storefront with a Node.js/Express API and MongoDB persistence.

## Technology

- Node.js and Express 5
- MongoDB Atlas or another MongoDB deployment, accessed with Mongoose
- Browser UI in `index.html` with its marketplace interactions implemented inline
- JWT-based authentication; password hashes are stored by the User model

## Project layout

- `server.js`: environment loading, HTTP configuration, API mounting, health, SEO endpoints, and startup
- `routes/`: authentication, customer, seller, admin, catalog, orders, wallet, chat, review, and case APIs
- `models/`: MongoDB schemas and indexes
- `middleware/`: authentication and role authorization
- `services/`: shared order, ledger, product media, notification, audit, and catalog logic
- `scripts/`: local owner-admin setup and development catalog seed/cleanup
- `index.html`: customer storefront, Seller Central, Admin Central, support panel, and informational pages
- `uploads/products/`: generated local product images in development; use durable object storage before running multiple production instances

## Local setup

1. Use a currently supported Node.js LTS release compatible with the installed dependencies.
2. Install the lockfile-defined dependency tree with `npm ci`.
3. Copy `.env.example` to `.env` and fill the required values locally. Keep `.env` private and never paste it into logs or issue reports.
4. Configure a MongoDB URI and a high-entropy JWT secret. The backend loads `.env` before importing the application routes.
5. Start the application with `npm start` and open `http://127.0.0.1:5000`.
6. Check readiness at `http://127.0.0.1:5000/api/health`. A healthy response has HTTP 200 and `database: "connected"`; HTTP 503 means the database is not ready.

The backend serves the storefront and API from one origin. If a separate development frontend is used, add its exact origin to `FRONTEND_ORIGINS` as a comma-separated list. Do not use a wildcard in production.

## Useful commands

- `npm start` — start the web application
- `npm test` — run the built-in automated test suite
- `npm run setup:admin` — interactively set the local owner administrator password
- `npm run seed:catalog` — add identifiable development catalog fixtures
- `npm run seed:catalog:clean` — remove only records carrying the development seed marker

Do not run catalog seed or cleanup against production. Never create synthetic orders, reviews, payments, or revenue as launch content.

## Roles and data boundaries

- `customer`: account profile, addresses, cart, orders, wishlist, reviews, returns, refunds, disputes, and support
- `vendor`: approved seller tools, seller-owned listings and fulfillments, wallet/ledger views, and seller support
- `admin`: protected moderation, seller/KYC review, customer support, order, wallet, payment configuration, and audit tools

Backend middleware enforces authentication, role, and ownership. Financial changes must be server-calculated, ledger-backed, idempotent, and performed using MongoDB transactions where supported. Pending or held funds are not withdrawable. Never bypass these checks in tests or UI code.

## Deployment preparation

This repository is prepared for later deployment only; it is not a production deployment. Configure `NODE_ENV=production`, `PORT`, `MONGODB_URI`, `JWT_SECRET`, `FRONTEND_ORIGINS`, and `PUBLIC_BASE_URL` in the hosting environment. Set `TRUST_PROXY_HOPS` only to the known proxy hop count for the chosen host. Choose durable object storage before using local product uploads across multiple instances. Configure and verify Atlas backups and restore procedures before launch.

Before release: review legal/business placeholders in the informational pages, rotate any credential ever committed to Git history, complete the release and rollback checklist in `docs/production-readiness.md`, run the suite against staging, then deploy and smoke-test. No domain DNS, hosting provider, external payment, or HTTPS activation is configured by this repository alone.
