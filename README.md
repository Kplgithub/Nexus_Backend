# NEXUS Estate — Backend

REST API for the NEXUS Estate property marketplace (buy, rent, post property), plus the shared
types and validation package used by both the API and the website.

- **API** (`apps/api`) — Express 5 + MongoDB (Mongoose), served under `/api/v1`. Accounts for
  buyers/owners/tenants, agents and builders; email + password and mobile OTP sign-in; listings
  for sale and rent with staff review; enquiries and leads; admin-managed cities and localities;
  Cloudinary image uploads. OpenAPI docs at `/api/docs` when `ENABLE_API_DOCS=true`.
- **Shared** (`packages/shared`) — Zod schemas, TypeScript types, constants and formatting
  helpers. The website repo ([Kplgithub/Nexus](https://github.com/Kplgithub/Nexus)) carries an
  identical copy; its CI fails if the two drift apart, so change both together.

The website (Next.js) lives in **Kplgithub/Nexus**, together with the production deployment
(Docker Compose, Nginx, server setup script), which builds this repo's `apps/api/Dockerfile`.

## Local development

Prerequisites: Node.js 22, pnpm 10 (`corepack enable`), MongoDB 7 running locally.

```bash
pnpm install
cp apps/api/.env.example apps/api/.env   # set JWT_SECRET (openssl rand -base64 48) and MONGODB_URI
pnpm seed:base                           # FAQs and default settings
pnpm seed:locations                      # optional: Jaipur with sample localities
ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" pnpm seed:admin   # prompts for a password
pnpm dev                                 # API on http://localhost:4000
```

Run the website from the other repo with `API_INTERNAL_URL=http://localhost:4000`.

| Command                               | What it does                                      |
| ------------------------------------- | ------------------------------------------------- |
| `pnpm lint` / `typecheck` / `test`    | Static checks and API tests (in-memory MongoDB)   |
| `pnpm build`                          | Build shared + API                                |
| `pnpm demo:remove`                    | Delete demo listings and demo users before launch |
| `pnpm --filter @nexus/api db:indexes` | Create/update MongoDB indexes                     |

## CI and deployment

- **CI** runs lint, typecheck, API tests and a build, then builds the production Docker image and
  starts it against MongoDB 7 with a smoke test.
- **Deploy** (Actions → Deploy → Run workflow) SSHes to the server and runs the website repo's
  `deploy/scripts/deploy.sh <web-ref> <backend-ref>`. It needs the same four `DEPLOY_*` secrets
  as the website repo. See `docs/ENVIRONMENT.md` for every setting.

Never commit `.env` files, production credentials, keys or connection strings.
