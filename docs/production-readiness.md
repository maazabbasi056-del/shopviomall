# Local production-readiness and release checklist

This is preparation guidance, not confirmation that production hosting, HTTPS, payments, or backups are active.

## Configuration

- Required values: `MONGODB_URI`, `JWT_SECRET`; `PORT` defaults to 5000.
- `FRONTEND_ORIGINS` is a comma-separated allowlist for separately hosted browser clients. Same-origin deployments need no cross-origin exception.
- `PUBLIC_BASE_URL` sets the public sitemap/robots origin. Configure it to the chosen canonical HTTPS origin after hosting is selected.
- `TRUST_PROXY_HOPS` should be set only to the verified number of trusted reverse-proxy hops. It is unset by default.
- Set `NODE_ENV=production` in production. Use a unique high-entropy JWT secret and rotate credentials that have been exposed in repository history.
- Do not serve the repository root as a static directory. `server.js` serves only the app shell and public product media.

## Data backup and restore

1. Before deployment or a schema/data migration, verify the Atlas cluster's backup capability and retention settings in Atlas. This repository does not verify that provider-managed backups are enabled.
2. Create a dated, access-restricted backup using an approved Atlas snapshot or MongoDB Database Tools with credentials supplied through a protected config/secret store. Do not place a URI in source control, ticket text, shell transcripts, or logs.
3. Record the backup identifier, cluster/database, operator, and time in the private operations record.
4. Verify restore by restoring into an isolated non-production database and checking collection counts, indexes, and representative application reads.
5. Define retention and deletion periods with the business owner and applicable legal requirements before production launch.

Never test restore by overwriting the live database. Do not claim a backup exists until Atlas or the backup operator verifies it.

## Release and rollback

`reviewed commit -> deterministic install (`npm ci`) -> automated tests -> verified backup -> staging/preview smoke checks -> production deployment -> `/api/health` and role-based smoke checks`

Keep the previous known-good commit/build and hosting release available. If application health fails, roll back the application release, then verify the database remains compatible. Do not roll back or delete production data as an application rollback step. Schema or data changes require a separately reviewed, backup-backed recovery plan.

## Hosting, media, and domain

- The current app serves the browser and API from one Express origin; configure exact browser origins if this changes.
- The current product upload implementation stores media on the local filesystem. Before multi-instance or ephemeral hosting, replace this storage with durable object storage and migrate media references safely.
- MongoDB remains configurable through `MONGODB_URI`; no database platform migration is required.
- `shopviomall.com` and `www.shopviomall.com` are future deployment domains. No DNS change has been made. Choose the canonical host and HTTPS redirect at the hosting/CDN layer, then set `PUBLIC_BASE_URL` and `FRONTEND_ORIGINS` accordingly. HTTPS is not asserted as active here.

## Legal and operational decisions before launch

Review the policy pages and fill the owner-controlled legal entity, governing jurisdiction, effective dates, contact channel, retention periods, restricted-goods rules, commission schedule, and payment/refund details. Avoid claims about coverage, payment providers, payout speed, or customer volume unless verified and configured.

## Development data

Catalog seed products carry a `developmentSeedKey` marker and can be removed through `npm run seed:catalog:clean`; run only against a development database. Seed scripts must not create simulated orders, payments, reviews, or revenue. Inspect target database configuration before running any seed or cleanup command.

## Current limitations to close before public release

- Git history contains a previously tracked `.env`; rotate all credentials that were present and scrub repository history before publishing or granting new repository access. The current working `.env` remains ignored and was not displayed or changed by this readiness work.
- The current rate limiter is process-local; configure a shared reverse-proxy/WAF rate limit for multi-instance deployments.
- Browser inline scripts/styles require the current Content Security Policy's inline allowance. Move to nonce/hash-based policy before relying on CSP as a strong XSS mitigation.
- Production upload storage, final legal review, Atlas backup verification, hosting, HTTPS, domain/DNS, and real payment integration are not completed by this local stage.
