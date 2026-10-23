# Architecture

```
Browser ──HTTPS──► Nginx ─┬─ /api/*  ──► API (Express, :4000) ──► MongoDB (Atlas)
                          │                      └──────────────► Cloudinary (images)
                          └─ /*      ──► Web (Next.js, :3000) ──server-side fetch──► API
```

## Key decisions

- **Same-origin API.** Browsers always call `/api/v1/*` on the site's own domain (Nginx routes it in production; Next.js rewrites it in development). This keeps admin cookies first-party, avoids CORS complexity and lets cookies be `SameSite=Lax`.
- **Server-rendered public pages.** Listing, detail and location pages are React Server Components that fetch the API on the server, so search engines receive complete HTML. Only interactive pieces (filters, gallery, forms, admin) are client components.
- **Filters live in the URL.** `/properties?category=residential&city=jaipur&minRent=10000&maxRent=25000` is parsed by the same Zod schema on the web and the API (`packages/shared`). Invalid values are dropped rather than erroring, ranges are normalised, and URLs are re-serialised in a stable order.
- **MongoDB with Mongoose**, as requested. Listing data is document-shaped (amenities, images, conditional fields per type), which suits Mongo well. Money is stored as integer rupees; area is stored as entered plus a normalised `areaSqft` for filtering.
- **Shared validation.** `packages/shared` exports the Zod schemas, constants (types, amenities, statuses) and formatters used by both apps, so a rule such as “bedrooms are required for apartments but not offices” is defined once.
- **Admin UI is a client app** under `/admin`, protected by a Next.js proxy (cookie presence → otherwise redirect to login) and, authoritatively, by the API on every request.

## API modules (`apps/api/src`)

| Folder            | Responsibility                                                                                     |
| ----------------- | -------------------------------------------------------------------------------------------------- |
| `config/env.ts`   | Zod-validated environment; refuses to start with unsafe production settings                        |
| `models/`         | Mongoose schemas and indexes                                                                       |
| `services/`       | Business logic (properties, enquiries, locations, auth, uploads, settings, dashboard, mail, audit) |
| `routes/`         | Thin HTTP layer: parse → call service → respond                                                    |
| `middleware/`     | Auth + CSRF, roles, body sanitising, origin check, rate limits, error handler                      |
| `docs/openapi.ts` | OpenAPI 3.1 contract                                                                               |
| `scripts/`        | Seeds, demo data, index sync                                                                       |

## Data model

| Collection             | Notes                                                                                                                                                                                                                                                                                                                                                                                          |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `properties`           | Status `draft · published · rented · inactive · archived`; visibility `public · unlisted`; denormalised city/locality names; images `{url, publicId, alt, width, height}`; private `ownerReference`/`internalNotes` never leave admin endpoints. Indexes cover the search path (status, visibility, category, city, locality, rent), recency, featured, unique slug and a weighted text index. |
| `slugredirects`        | Old slug → property, so changed URLs 308-redirect.                                                                                                                                                                                                                                                                                                                                             |
| `enquiries`            | Lead ID `NX-E-YYYY-NNNNN`, normalised E.164 phone, property snapshot, consent timestamp + text, status, follow-up, notes, hashed IP.                                                                                                                                                                                                                                                           |
| `propertysubmissions`  | Landlord requests, lead ID `NX-L-…`.                                                                                                                                                                                                                                                                                                                                                           |
| `cities`               | Cities with embedded localities, intros and SEO overrides.                                                                                                                                                                                                                                                                                                                                     |
| `faqs`, `sitesettings` | CMS-style content; settings is a single document.                                                                                                                                                                                                                                                                                                                                              |
| `admins`               | Argon2id hash, role, `tokenVersion` for session revocation, lockout counters.                                                                                                                                                                                                                                                                                                                  |
| `auditlogs`            | Who did what to which record (logins, publishes, deletes, exports, settings changes).                                                                                                                                                                                                                                                                                                          |

## Security summary

- Argon2id hashing; 5 failed logins → 15-minute lock; uniform error and timing for unknown emails.
- Session JWT in an `httpOnly`, `SameSite=Lax`, `Secure` (prod) cookie; CSRF token bound inside the JWT and required as `X-CSRF-Token` on every admin write; Origin check on all writes.
- “Sign out everywhere” and password change bump `tokenVersion`, invalidating all sessions.
- Roles: `editor` (content), `admin` (+ delete, locations, settings, CSV export), `owner`.
- Zod validation on every input; `$`/dotted keys stripped from bodies; text fields stripped of `<`/`>`; CSV export escapes spreadsheet formulas.
- Uploads: type detected from file bytes (not the client MIME), 8 MB cap, EXIF stripped by Cloudinary.
- Rate limits: global, login, public forms, uploads (plus Nginx limits).
- Helmet headers on the API; HSTS, frame-deny and other headers on the web; admin `noindex` via meta and `X-Robots-Tag`.
- Errors never include stack traces or driver messages.

## SEO summary

Unique titles/descriptions, canonical URLs, Open Graph/Twitter cards, breadcrumbs (+ JSON-LD), `RealEstateAgent` + `WebSite` JSON-LD, `RealEstateListing` JSON-LD for real (non-demo, published) listings, `FAQPage` where FAQs are shown, XML sitemap of indexable URLs only, robots.txt, 308 redirects for changed slugs, `noindex,follow` for filtered/paginated searches, rented and demo listings, and location pages without content. No ratings/reviews markup.

## Hindi readiness

All user-facing copy is in components/pages (not hard-coded in the API), `lang="en-IN"` is set at the root, and route structure allows a future `/hi/...` segment with `alternates.languages`. Hindi is not implemented in this MVP.
