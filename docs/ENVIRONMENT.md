# Environment variables

Never commit real values. Development: `apps/api/.env`, `apps/web/.env.local`. Production: `deploy/.env.production` on the server (`chmod 600`), read by Docker Compose. CI-only values go in GitHub Actions secrets.

## API (`apps/api`)

| Variable                                                                       | Required        | Purpose                                                                                                                                                    |
| ------------------------------------------------------------------------------ | --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NODE_ENV`                                                                     | yes             | `development` · `test` · `production`                                                                                                                      |
| `PORT`, `HOST`                                                                 | no              | Listen address (default `0.0.0.0:4000`)                                                                                                                    |
| `LOG_LEVEL`                                                                    | no              | `info` default; JSON logs in production                                                                                                                    |
| `MONGODB_URI`                                                                  | **yes**         | MongoDB connection string. Use a dedicated least-privilege user (readWrite on the `nexus` DB).                                                             |
| `CORS_ORIGINS`                                                                 | **yes (prod)**  | Comma-separated allowed origins, e.g. `https://example.com,https://www.example.com`. Also used for the Origin check on writes. No wildcards in production. |
| `PUBLIC_SITE_URL`                                                              | yes             | Canonical site URL, used in emails                                                                                                                         |
| `TRUST_PROXY`                                                                  | prod            | `1` behind Nginx so rate limits see real client IPs                                                                                                        |
| `JWT_SECRET`                                                                   | **yes**         | ≥32 random chars (`openssl rand -base64 48`). Rotating it signs everyone out.                                                                              |
| `USER_SESSION_TTL_DAYS`                                                        | no              | Website user (buyer/owner/agent/builder) session length in days (default 30)                                                                               |
| `SESSION_TTL_HOURS`                                                            | no              | Admin session length (default 12)                                                                                                                          |
| `COOKIE_SECURE`                                                                | prod            | Must be `true` in production (enforced)                                                                                                                    |
| `COOKIE_DOMAIN`                                                                | no              | Leave empty unless sharing cookies across subdomains                                                                                                       |
| `UPLOAD_DRIVER`                                                                | yes             | `cloudinary` (required in production) or `local`                                                                                                           |
| `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`         | with cloudinary | From the Cloudinary console                                                                                                                                |
| `CLOUDINARY_FOLDER`                                                            | no              | Default `nexus-estate/properties`                                                                                                                          |
| `LOCAL_UPLOAD_DIR`, `LOCAL_UPLOAD_PUBLIC_URL`                                  | dev             | Local disk uploads for development (`/uploads` is proxied by the web app)                                                                                  |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `MAIL_FROM` | optional        | Lead notification emails. Recipient is set in Admin → Settings.                                                                                            |
| `SMS_DRIVER`                                                                   | **yes (prod)**  | `msg91` in production for mobile OTP; `console` prints codes in development/CI (refused in production); `disabled` turns OTP off (email + password only)   |
| `MSG91_AUTH_KEY`, `MSG91_TEMPLATE_ID`                                          | with msg91      | From your MSG91 account. The template must be DLT-approved for OTP messages.                                                                               |
| `ENABLE_API_DOCS`                                                              | no              | Serve Swagger UI at `/api/docs`. Keep `false` in production.                                                                                               |
| `PUBLIC_CACHE_SECONDS`                                                         | no              | `s-maxage` on public GET responses (default 60)                                                                                                            |

Seed-script-only (pass on the command line, never store): `ADMIN_EMAIL`, `ADMIN_NAME`, `ADMIN_ROLE`, `ADMIN_PASSWORD` (omit to be prompted).

## Web (`apps/web`)

| Variable               | Required | Purpose                                                                      |
| ---------------------- | -------- | ---------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SITE_URL` | **yes**  | Canonical origin, no trailing slash. **Build-time**: rebuild after changing. |
| `API_INTERNAL_URL`     | yes      | Where the Next.js server reaches the API (`http://api:4000` in Compose)      |
| `IMAGE_HOSTS`          | no       | Extra HTTPS image hostnames (e.g. an S3 bucket)                              |
| `REVALIDATE_SECONDS`   | no       | How long public pages may cache listing data (default 60)                    |
| `NEXT_PUBLIC_NOINDEX`  | no       | `true` on staging to block indexing (build-time)                             |

## GitHub Actions secrets (deploy workflow)

`DEPLOY_HOST`, `DEPLOY_USER`, `DEPLOY_SSH_KEY` (private key of a deploy-only user whose public key is in the server's `authorized_keys`), `DEPLOY_PATH`, optional `DEPLOY_KNOWN_HOSTS`. Create a GitHub _Environment_ named `production` with required reviewers to gate deploys.
