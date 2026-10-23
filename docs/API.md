# API

Base path: `/api/v1`. Interactive docs: `/api/docs` (OpenAPI JSON at `/api/openapi.json`) when `ENABLE_API_DOCS=true` — keep it off in production or protect it.

## Response format

```json
{ "ok": true, "data": { }, "meta": { "page": 1, "limit": 12, "total": 40, "totalPages": 4 } }
{ "ok": false, "error": { "code": "VALIDATION_ERROR", "message": "Please check the highlighted fields", "details": { "phone": ["Enter a valid 10-digit Indian mobile number"] } } }
```

Codes: `BAD_REQUEST` 400, `UNAUTHORIZED` 401, `FORBIDDEN` 403, `NOT_FOUND` 404, `CONFLICT` 409, `VALIDATION_ERROR` 422, `LOCKED` 423, `RATE_LIMITED` 429, `UPLOAD_FAILED` 502, `INTERNAL_ERROR` 500.

## Public

| Method | Path                             | Notes                                                                                                                                                                                                                                 |
| ------ | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------ |
| GET    | `/health`                        | DB ping; 503 when degraded                                                                                                                                                                                                            |
| GET    | `/properties`                    | Search. Params: `category, propertyType (csv), city, locality, minRent, maxRent, furnishing (csv), bedrooms (min), bathrooms (min), minArea, maxArea (sq ft), amenities (csv, all must match), parking, availableNow, q, sort (newest | rent_asc | rent_desc), page, limit (≤48)` |
| GET    | `/properties/:slug`              | `{ property, similar }`, or `{ redirectTo }` for an old slug; published and rented only                                                                                                                                               |
| GET    | `/home`                          | Featured and recent cards                                                                                                                                                                                                             |
| GET    | `/sitemap/properties`            | Slugs + `updatedAt` for indexable listings                                                                                                                                                                                            |
| GET    | `/locations`, `/locations/:city` | Active cities/localities with live listing counts                                                                                                                                                                                     |
| GET    | `/categories`                    | Categories and property types                                                                                                                                                                                                         |
| GET    | `/faqs?category=&home=true`      | Published FAQs                                                                                                                                                                                                                        |
| GET    | `/settings`                      | Public business details                                                                                                                                                                                                               |
| POST   | `/enquiries`                     | `{ name, phone, email?, message?, propertyId?, sourcePage?, consent: true, website (honeypot), elapsedMs }` → `201 { leadId }`                                                                                                        |
| POST   | `/property-submissions`          | Landlord listing request → `201 { leadId }`                                                                                                                                                                                           |

## Admin (cookie session + `X-CSRF-Token` on writes)

| Method                | Path                                                                  | Min. role                   |
| --------------------- | --------------------------------------------------------------------- | --------------------------- |
| POST                  | `/admin/auth/login`, `/admin/auth/logout`                             | —                           |
| GET                   | `/admin/auth/me`                                                      | editor                      |
| POST                  | `/admin/auth/change-password`, `/admin/auth/logout-all`               | editor                      |
| GET                   | `/admin/dashboard`                                                    | editor                      |
| GET/POST              | `/admin/properties`                                                   | editor                      |
| GET/PATCH             | `/admin/properties/:id`                                               | editor                      |
| POST                  | `/admin/properties/:id/status`                                        | editor                      |
| DELETE                | `/admin/properties/:id`                                               | admin                       |
| POST                  | `/admin/uploads` (multipart `files`, ≤10 × 8 MB)                      | editor                      |
| GET                   | `/admin/enquiries`, `/admin/enquiries/:id`                            | editor                      |
| PATCH                 | `/admin/enquiries/:id` (`status`, `followUpAt`, `assignedTo`, `note`) | editor                      |
| GET                   | `/admin/enquiries/export.csv`                                         | admin                       |
| GET/PATCH             | `/admin/submissions`, `/admin/submissions/:id`                        | editor                      |
| GET/POST/PATCH/DELETE | `/admin/locations[/:id]`                                              | read: editor · write: admin |
| GET/POST/PATCH/DELETE | `/admin/faqs[/:id]`                                                   | editor                      |
| GET/PATCH             | `/admin/settings`                                                     | read: editor · write: admin |

`PATCH` endpoints apply only the fields sent. Full field rules: `packages/shared/src/schemas.ts`.
