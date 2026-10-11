# ShopVioMall production monitoring (prepared, not active)

This package is local-only until reviewed and explicitly approved for repository deployment. It does not change DNS, production services, application behavior, or database records. The five-minute workflow is dormant by default; its job runs on schedule only after the owner sets `MONITOR_ENABLE_SCHEDULE=true` in repository variables.

## Checks

The external runner checks every five minutes: apex, `www`, and HTTP-to-HTTPS redirect response/status/latency; `/api/health` including `database: connected`; the verified public seller URL `/shop/luxsry-mall`; DNS A/AAAA through Google, Cloudflare, Quad9, and each authoritative Namecheap nameserver; TLS certificate validity/expiry; and Verisign RDAP registration status/expiry. It warns above 2.5 seconds and treats 8 seconds as critical. The approved A record is fixed to `138.249.133.214`; unexpected A records or any AAAA record alert. RDAP can expose registry hold/expiry states, but cannot prove that Namecheap has verified the registrant email or account. Check Namecheap's dashboard and the registrant mailbox for those notices.

The optional forced-command SSH probe returns only Nginx/PM2 states, disk and available-memory percentages, and the local health database state. It never emits process environments, PM2 JSON, database details, or credentials. Install `scripts/production-monitor-vps-check.sh` at a root-owned path and bind a dedicated SSH key to that exact forced command with port forwarding, agent forwarding, X11, and PTY disabled. Do not put the production deploy key in GitHub. Use a dedicated read-only monitoring account/key and pin its SSH host key.

## Notifications and reminder thresholds

The monitor sends transition-based Resend notifications: a critical issue must persist across two consecutive five-minute runs; warnings (certificate expiry within 30 days or domain expiry within 60 days) notify once when the warning signature changes; a recovery message is sent after a notified incident clears. Certificate expiry within 7 days and registration expiry within 14 days are critical. The state file is carried between workflow runs using the GitHub Actions cache. Cache expiry/eviction can reset alert history, so review workflow state after repository/cache changes.

Alerts use the existing Resend integration and the configured verified sender; no secret is in the repository. Configure GitHub Actions repository variables `MONITOR_ALERT_TO`, `RESEND_FROM_EMAIL`, `MONITOR_SSH_TARGET`, `MONITOR_SSH_KNOWN_HOSTS`, and `MONITOR_STOREFRONT_URL`; configure repository secrets `RESEND_API_KEY` and `MONITOR_SSH_PRIVATE_KEY`. Keep the verified sender at the existing `ShopVioMall <support@shopviomall.com>` identity. Never paste credentials into source, issues, or chat. Email delivery should be tested with a manual workflow run after the sender domain and recipient are verified.

## Namecheap domain prevention

Enable Namecheap auto-renewal and maintain a monitored payment method. Keep registrant email, phone, and postal details current; complete any verification email promptly and confirm the Namecheap dashboard shows the domain active. Add calendar reminders 60, 30, and 14 days before the RDAP expiry date (currently checked dynamically by the monitor). The monitor cannot observe Namecheap's internal contact-verification state; maintain a separate owner calendar/email check. Never let monitoring automatically edit nameservers, A/AAAA records, or registrant details.

## Setup and cost caveat

The workflow uses GitHub Actions scheduled runs from the default branch. GitHub schedules have a five-minute minimum but are best-effort and may be delayed during load. A private-repository job can consume at least one billable minute per run; at five-minute intervals that is roughly 8,640 runner-minutes in a 30-day month before startup overhead. Confirm repository visibility, included quota, and billing settings before setting `MONITOR_ENABLE_SCHEDULE=true`. GitHub states public-repository standard runners are free, while private-repository usage beyond the plan quota is billed. No external paid monitoring account is activated by this package. For a contractual uptime SLA, use a separately approved independent monitoring service.

## Local test

Run `node --test tests/production-monitor.test.js`. A real read-only probe can be run with `node scripts/monitor-production.js --no-alerts --skip-server`; this omits email and SSH while validating public checks. It writes only its ignored local monitor state file. Production activation requires reviewing this package, adding GitHub variables/secrets securely, installing the restricted forced-command probe on the VPS, confirming GitHub Actions cost/quota, setting `MONITOR_ENABLE_SCHEDULE=true`, and explicitly approving the workflow deployment.

## Rollback

Disable/delete `.github/workflows/production-monitor.yml` from the repository and remove the monitor-specific GitHub variables/secrets. Remove only the dedicated monitor account, forced-command file, sudoers entry, and authorized key that were installed for this monitor after reviewing their exact paths. No application rollback, database action, DNS edit, or PM2 restart is required.
