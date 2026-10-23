import { z } from 'zod';
import {
  ALL_PROPERTY_TYPES,
  AMENITIES,
  AREA_TYPES,
  AREA_UNITS,
  CATEGORIES,
  ENQUIRY_STATUSES,
  FAQ_CATEGORIES,
  LISTING_TYPES,
  OTP_LENGTH,
  OTP_PURPOSES,
  OWNERSHIP_TYPES,
  POSSESSION_STATUSES,
  TRANSACTION_TYPES,
  USER_ROLES,
  USER_SETTABLE_STATUSES,
  USER_STATUSES,
  ENQUIRY_TYPES,
  FURNISHING_STATUSES,
  LISTING_VISIBILITY,
  MAX_MONEY_INR,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
  PARKING_OPTIONS,
  PREFERRED_TENANTS,
  PROPERTY_STATUSES,
  PROPERTY_TYPES,
  SORT_OPTIONS,
  TYPES_REQUIRING_ROOMS,
  type Category,
  type PropertyType,
} from './constants.js';
import { SLUG_PATTERN } from './slug.js';

/* ------------------------------------------------------------------ */
/* Primitives                                                          */
/* ------------------------------------------------------------------ */

const money = z
  .number({ error: 'Must be a number' })
  .int('Use whole rupees')
  .min(0, 'Cannot be negative')
  .max(MAX_MONEY_INR, 'Amount looks too large');

const optionalMoney = money.nullable().optional();

const count = (max: number) => z.number().int().min(0).max(max);

const slug = z.string().trim().toLowerCase().max(100).regex(SLUG_PATTERN, 'Invalid slug');

export const objectIdSchema = z.string().regex(/^[a-f0-9]{24}$/i, 'Invalid id');

/** Plain text only: strips angle brackets so stored content can never become markup. */
const plainText = (min: number, max: number) =>
  z
    .string()
    .trim()
    .min(min)
    .max(max)
    .transform((s) => s.replace(/[<>]/g, ''));

/* ------------------------------------------------------------------ */
/* Public search                                                       */
/* ------------------------------------------------------------------ */

/** Accepts "a,b" or repeated params; returns a de-duplicated array. */
const csvList = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .union([z.string(), z.array(z.string())])
    .optional()
    .transform((v) => {
      if (!v) return undefined;
      const parts = (Array.isArray(v) ? v : v.split(',')).map((s) => s.trim()).filter(Boolean);
      const allowed = parts.filter((p): p is T[number] =>
        (values as readonly string[]).includes(p),
      );
      return allowed.length ? Array.from(new Set(allowed)) : undefined;
    });

/** Lenient number parser for query strings: invalid input is dropped, not rejected. */
const queryNumber = (min: number, max: number) =>
  z
    .union([z.string(), z.number()])
    .optional()
    .transform((v) => {
      if (v === undefined || v === '') return undefined;
      const n = typeof v === 'number' ? v : Number(String(v).replace(/[,\s₹]/g, ''));
      if (!Number.isFinite(n)) return undefined;
      return Math.min(Math.max(Math.round(n), min), max);
    });

const queryEnum = <T extends readonly [string, ...string[]]>(values: T) =>
  z
    .string()
    .optional()
    .transform((v) =>
      v && (values as readonly string[]).includes(v) ? (v as T[number]) : undefined,
    );

const queryBool = z
  .union([z.string(), z.boolean()])
  .optional()
  .transform((v) => (v === true || v === 'true' || v === '1' ? true : undefined));

const querySlug = z
  .string()
  .optional()
  .transform((v) => {
    if (!v) return undefined;
    const s = v.trim().toLowerCase();
    return SLUG_PATTERN.test(s) && s.length <= 100 ? s : undefined;
  });

/**
 * Public property search. Designed to be forgiving: unknown or invalid values
 * are discarded so a mangled shared URL still shows results instead of an error.
 */
export const propertySearchSchema = z
  .object({
    listingType: queryEnum(LISTING_TYPES),
    category: queryEnum(CATEGORIES as unknown as readonly [Category, ...Category[]]),
    propertyType: csvList(
      ALL_PROPERTY_TYPES as unknown as readonly [PropertyType, ...PropertyType[]],
    ),
    city: querySlug,
    locality: querySlug,
    minPrice: queryNumber(0, MAX_MONEY_INR),
    maxPrice: queryNumber(0, MAX_MONEY_INR),
    furnishing: csvList(FURNISHING_STATUSES),
    bedrooms: queryNumber(0, 10),
    bathrooms: queryNumber(0, 10),
    minArea: queryNumber(0, 10_000_000),
    maxArea: queryNumber(0, 10_000_000),
    amenities: csvList(AMENITIES),
    parking: queryBool,
    availableNow: queryBool,
    featured: queryBool,
    possession: queryEnum(POSSESSION_STATUSES),
    postedBy: queryEnum(['owner', 'agent', 'builder', 'nexus'] as const),
    verified: queryBool,
    q: z
      .string()
      .optional()
      .transform((v) => (v ? v.trim().slice(0, 80) || undefined : undefined)),
    sort: queryEnum(SORT_OPTIONS).transform((v) => v ?? 'newest'),
    page: queryNumber(1, 1000).transform((v) => v ?? 1),
    limit: queryNumber(1, PAGE_SIZE_MAX).transform((v) => v ?? PAGE_SIZE_DEFAULT),
  })
  .transform((q) => {
    // Swap inverted ranges instead of returning nothing.
    if (q.minPrice !== undefined && q.maxPrice !== undefined && q.minPrice > q.maxPrice) {
      [q.minPrice, q.maxPrice] = [q.maxPrice, q.minPrice];
    }
    // Possession only applies to sale listings.
    if (q.listingType !== 'sale') q.possession = undefined;
    if (q.minArea !== undefined && q.maxArea !== undefined && q.minArea > q.maxArea) {
      [q.minArea, q.maxArea] = [q.maxArea, q.minArea];
    }
    // Locality only makes sense inside a city.
    if (q.locality && !q.city) q.locality = undefined;
    // Drop property types that don't belong to the chosen category.
    if (q.category && q.propertyType) {
      const allowed = PROPERTY_TYPES[q.category] as readonly string[];
      const kept = q.propertyType.filter((t) => allowed.includes(t));
      q.propertyType = kept.length ? kept : undefined;
    }
    return q;
  });

export type PropertySearch = z.output<typeof propertySearchSchema>;

/* ------------------------------------------------------------------ */
/* Property (admin)                                                    */
/* ------------------------------------------------------------------ */

/** HTTPS (Cloudinary/S3), local dev uploads, or site-relative paths used by demo content. */
const imageUrl = z
  .string()
  .trim()
  .max(1000)
  .refine(
    (v) =>
      /^https:\/\/[^\s]+$/.test(v) ||
      /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?\/[^\s]*$/.test(v) ||
      /^\/[a-z0-9/_.-]+$/i.test(v),
    'Image URL must be HTTPS',
  );

export const propertyImageSchema = z.object({
  url: imageUrl,
  publicId: z.string().max(300).optional(),
  alt: plainText(0, 160).default(''),
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
  isDemo: z.boolean().optional(),
});

/**
 * Fields a signed-in user (owner, agent or builder) may set on their own listing.
 * Admin-only fields are layered on top in `propertyBase`.
 */
const userPropertyFields = {
  listingType: z.enum(LISTING_TYPES),
  title: plainText(8, 140),
  description: plainText(30, 6000),
  highlights: z.array(plainText(2, 140)).max(12).default([]),
  category: z.enum(CATEGORIES),
  propertyType: z.enum(ALL_PROPERTY_TYPES as unknown as readonly [PropertyType, ...PropertyType[]]),

  citySlug: slug,
  localitySlug: slug,
  /** Public-safe address line (e.g. "Near Gandhi Path, Vaishali Nagar"). Never the exact unit. */
  approvedAddress: plainText(0, 200).default(''),
  pincode: z
    .string()
    .trim()
    .regex(/^\d{6}$/, 'Pincode must be 6 digits')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  projectName: plainText(0, 120).optional(),

  /** Monthly rent for rent listings; total asking price for sale listings. Whole rupees. */
  price: money.min(1, 'Price is required'),
  priceNegotiable: z.boolean().default(false),
  maintenanceCharges: optionalMoney,
  maintenanceIncluded: z.boolean().default(false),
  brokerage: plainText(0, 120).optional(),

  // Rent only
  securityDeposit: optionalMoney,
  lockInMonths: count(120).nullable().optional(),
  rentalTerms: plainText(0, 2000).optional(),
  preferredTenants: z.array(z.enum(PREFERRED_TENANTS)).max(5).default([]),
  availableFrom: z.coerce.date().nullable().optional(),

  // Sale only
  possessionStatus: z.enum(POSSESSION_STATUSES).nullable().optional(),
  possessionDate: z.coerce.date().nullable().optional(),
  transactionType: z.enum(TRANSACTION_TYPES).nullable().optional(),
  ownershipType: z.enum(OWNERSHIP_TYPES).nullable().optional(),
  reraId: plainText(0, 60).optional(),

  areaValue: z.number().positive('Area must be positive').max(10_000_000),
  areaUnit: z.enum(AREA_UNITS),
  areaType: z.enum(AREA_TYPES).default('carpet'),

  bedrooms: count(20).nullable().optional(),
  bathrooms: count(20).nullable().optional(),
  balconies: count(20).nullable().optional(),
  floorNumber: z.number().int().min(-5).max(200).nullable().optional(),
  totalFloors: z.number().int().min(0).max(200).nullable().optional(),
  facing: plainText(0, 30).optional(),
  ageOfPropertyYears: count(200).nullable().optional(),

  furnishingStatus: z.enum(FURNISHING_STATUSES),
  amenities: z.array(z.enum(AMENITIES)).max(AMENITIES.length).default([]),
  parking: z.enum(PARKING_OPTIONS).default('none'),
  suitableFor: z.array(plainText(2, 60)).max(12).default([]),
  washrooms: count(50).nullable().optional(),

  images: z.array(propertyImageSchema).max(30).default([]),
  coverImageIndex: z.number().int().min(0).default(0),
};

const propertyBase = z.object({
  ...userPropertyFields,
  slug: slug.optional(),
  status: z.enum(PROPERTY_STATUSES).default('draft'),
  /** "unlisted" = reachable by direct link only; hidden from search, home and sitemap. */
  listingVisibility: z.enum(LISTING_VISIBILITY).default('public'),
  state: plainText(2, 60).optional(),
  featured: z.boolean().default(false),
  verified: z.boolean().default(false),
  isDemo: z.boolean().default(false),
  ownerReference: plainText(0, 200).optional(),
  internalNotes: plainText(0, 4000).optional(),
  moderationNote: plainText(0, 1000).optional(),
  seoTitle: plainText(0, 70).optional(),
  seoDescription: plainText(0, 170).optional(),
});

type PropertyBaseInput = z.infer<typeof propertyBase>;

function refineProperty(p: Partial<PropertyBaseInput>, ctx: z.RefinementCtx) {
  if (p.category && p.propertyType) {
    const allowed = PROPERTY_TYPES[p.category] as readonly string[];
    if (!allowed.includes(p.propertyType)) {
      ctx.addIssue({
        code: 'custom',
        path: ['propertyType'],
        message: `"${p.propertyType}" is not a ${p.category} property type`,
      });
    }
  }
  if (p.propertyType && TYPES_REQUIRING_ROOMS.includes(p.propertyType)) {
    if (p.bedrooms === undefined || p.bedrooms === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['bedrooms'],
        message: 'Bedrooms are required for this property type',
      });
    }
    if (p.bathrooms === undefined || p.bathrooms === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['bathrooms'],
        message: 'Bathrooms are required for this property type',
      });
    }
  }
  if (
    p.floorNumber !== undefined &&
    p.floorNumber !== null &&
    p.totalFloors !== undefined &&
    p.totalFloors !== null &&
    p.floorNumber > p.totalFloors
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['floorNumber'],
      message: 'Floor cannot exceed total floors',
    });
  }
  if (
    p.images &&
    p.coverImageIndex !== undefined &&
    p.images.length > 0 &&
    p.coverImageIndex >= p.images.length
  ) {
    ctx.addIssue({
      code: 'custom',
      path: ['coverImageIndex'],
      message: 'Cover image must be one of the uploaded images',
    });
  }
  if ((p.status === 'published' || p.status === 'pending') && p.images && p.images.length === 0) {
    ctx.addIssue({
      code: 'custom',
      path: ['images'],
      message: 'Add at least one photo before publishing',
    });
  }
  if (p.listingType === 'rent' && p.status === 'sold') {
    ctx.addIssue({ code: 'custom', path: ['status'], message: 'A rental listing cannot be sold' });
  }
  if (p.listingType === 'sale' && p.status === 'rented') {
    ctx.addIssue({ code: 'custom', path: ['status'], message: 'A sale listing cannot be rented' });
  }
}

export const propertyCreateSchema = propertyBase.superRefine(refineProperty);
export type PropertyCreateInput = z.input<typeof propertyCreateSchema>;
export type PropertyCreate = z.output<typeof propertyCreateSchema>;

/** Partial update; cross-field rules are re-checked by the service against the merged document. */
export const propertyUpdateSchema = propertyBase.partial().strict();
export type PropertyUpdate = z.output<typeof propertyUpdateSchema>;

export const propertyValidateMerged = (merged: Partial<PropertyBaseInput>) =>
  propertyBase.partial().superRefine(refineProperty).safeParse(merged);

export const propertyStatusChangeSchema = z.object({
  status: z.enum(PROPERTY_STATUSES),
  /** Shown to the poster when a listing is rejected. */
  note: plainText(0, 1000).optional(),
});

/* ---- Listings posted by signed-in users ---- */

const userPropertyBase = z.object({
  ...userPropertyFields,
  /** "draft" saves without review; "pending" submits for review. */
  status: z.enum(['draft', 'pending']).default('draft'),
});

export const userPropertyCreateSchema = userPropertyBase.strict().superRefine(refineProperty);
export type UserPropertyCreate = z.output<typeof userPropertyCreateSchema>;
export type UserPropertyCreateInput = z.input<typeof userPropertyCreateSchema>;
export const userPropertyUpdateSchema = userPropertyBase.partial().strict();
export type UserPropertyUpdate = z.output<typeof userPropertyUpdateSchema>;
export const userPropertyStatusSchema = z.object({ status: z.enum(USER_SETTABLE_STATUSES) });

export const adminPropertyQuerySchema = z.object({
  status: queryEnum(PROPERTY_STATUSES),
  listingType: queryEnum(LISTING_TYPES),
  postedBy: queryEnum(['nexus', 'users'] as const),
  userId: z
    .string()
    .optional()
    .transform((v) => (v && /^[a-f0-9]{24}$/i.test(v) ? v : undefined)),
  category: queryEnum(CATEGORIES),
  city: querySlug,
  featured: queryBool,
  demo: queryBool,
  q: z
    .string()
    .optional()
    .transform((v) => (v ? v.trim().slice(0, 80) || undefined : undefined)),
  page: queryNumber(1, 10_000).transform((v) => v ?? 1),
  limit: queryNumber(1, 100).transform((v) => v ?? 20),
});

/* ------------------------------------------------------------------ */
/* Enquiries & submissions                                             */
/* ------------------------------------------------------------------ */

/** Honeypot: real users never see this field; any value marks the request as spam. */
const honeypot = z.string().max(200).optional();

export const enquiryCreateSchema = z.object({
  type: z.enum(ENQUIRY_TYPES).default('general'),
  name: plainText(2, 80),
  phone: z.string().trim().min(8).max(25),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .max(120)
    .email('Enter a valid email')
    .optional()
    .or(z.literal('').transform(() => undefined)),
  message: plainText(0, 2000).default(''),
  propertyId: objectIdSchema.optional(),
  sourcePage: z.string().trim().max(300).optional(),
  preferredContactTime: plainText(0, 60).optional(),
  consent: z.literal(true, { error: 'Please agree to be contacted' }),
  website: honeypot,
  /** Milliseconds the form was open; very fast submissions are treated as bots. */
  elapsedMs: z.number().int().min(0).max(86_400_000).optional(),
});
export type EnquiryCreateInput = z.input<typeof enquiryCreateSchema>;

export const enquiryUpdateSchema = z
  .object({
    status: z.enum(ENQUIRY_STATUSES).optional(),
    followUpAt: z.coerce.date().nullable().optional(),
    assignedTo: plainText(0, 80).optional(),
    note: plainText(1, 2000).optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).length > 0, 'Nothing to update');

export const adminEnquiryQuerySchema = z.object({
  status: queryEnum(ENQUIRY_STATUSES),
  type: queryEnum(ENQUIRY_TYPES),
  propertyId: z
    .string()
    .optional()
    .transform((v) => (v && /^[a-f0-9]{24}$/i.test(v) ? v : undefined)),
  q: z
    .string()
    .optional()
    .transform((v) => (v ? v.trim().slice(0, 80) || undefined : undefined)),
  from: z.coerce.date().optional().catch(undefined),
  to: z.coerce.date().optional().catch(undefined),
  followUpDue: queryBool,
  page: queryNumber(1, 10_000).transform((v) => v ?? 1),
  limit: queryNumber(1, 100).transform((v) => v ?? 20),
});

/* ------------------------------------------------------------------ */
/* Auth                                                                */
/* ------------------------------------------------------------------ */

export const loginSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(120),
  password: z.string().min(1).max(200),
});

export const passwordPolicy = z
  .string()
  .min(12, 'Use at least 12 characters')
  .max(200)
  .refine(
    (v) => /[a-z]/.test(v) && /[A-Z]/.test(v) && /\d/.test(v),
    'Use upper- and lower-case letters and a number',
  );

export const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: passwordPolicy,
});

/* ---- Website users ---- */

/** Users: at least 8 characters with a letter and a number. */
export const userPasswordPolicy = z
  .string()
  .min(8, 'Use at least 8 characters')
  .max(200)
  .refine((v) => /[A-Za-z]/.test(v) && /\d/.test(v), 'Use at least one letter and one number');

const email = z.string().trim().toLowerCase().max(120).email('Enter a valid email address');
const phoneInput = z.string().trim().min(8, 'Enter a valid mobile number').max(25);

export const signupSchema = z
  .object({
    role: z.enum(USER_ROLES),
    name: plainText(2, 80),
    email,
    phone: phoneInput,
    password: userPasswordPolicy,
    /** Agency name for agents, company name for builders. */
    companyName: plainText(0, 120).optional(),
    reraNumber: plainText(0, 60).optional(),
    citySlug: slug.optional().or(z.literal('').transform(() => undefined)),
    acceptTerms: z.literal(true, { error: 'Please accept the terms to continue' }),
    website: honeypot,
  })
  .superRefine((v, ctx) => {
    if ((v.role === 'agent' || v.role === 'builder') && !v.companyName?.trim()) {
      ctx.addIssue({
        code: 'custom',
        path: ['companyName'],
        message: v.role === 'agent' ? 'Enter your agency name' : 'Enter your company name',
      });
    }
  });
export type SignupInput = z.input<typeof signupSchema>;

/** Email or mobile number plus password. */
export const userLoginSchema = z.object({
  identifier: z.string().trim().min(3, 'Enter your email or mobile number').max(120),
  password: z.string().min(1, 'Enter your password').max(200),
});

export const otpRequestSchema = z.object({
  phone: phoneInput,
  purpose: z.enum(OTP_PURPOSES),
});

const otpCode = z
  .string()
  .trim()
  .regex(new RegExp(`^\\d{${OTP_LENGTH}}$`), `Enter the ${OTP_LENGTH}-digit code`);

export const otpLoginSchema = z.object({ phone: phoneInput, code: otpCode });
export const otpVerifySchema = z.object({ code: otpCode });

export const forgotPasswordSchema = z.object({
  identifier: z.string().trim().min(3).max(120),
});

export const resetPasswordSchema = z
  .object({
    /** Either a phone + OTP code, or an emailed reset token. */
    phone: phoneInput.optional(),
    code: otpCode.optional(),
    token: z.string().trim().min(20).max(200).optional(),
    password: userPasswordPolicy,
  })
  .refine((v) => Boolean(v.token) || Boolean(v.phone && v.code), 'Missing reset code');

export const userChangePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: userPasswordPolicy,
});

export const profileUpdateSchema = z
  .object({
    name: plainText(2, 80),
    email,
    phone: phoneInput,
    companyName: plainText(0, 120),
    reraNumber: plainText(0, 60),
    about: plainText(0, 1000),
    citySlug: slug.or(z.literal('')),
    /** Let signed-in visitors see this number on the user's listings. */
    showPhone: z.boolean(),
    whatsappEnabled: z.boolean(),
  })
  .partial()
  .strict();

export const adminUserQuerySchema = z.object({
  role: queryEnum(USER_ROLES),
  status: queryEnum(USER_STATUSES),
  verified: queryBool,
  q: z
    .string()
    .optional()
    .transform((v) => (v ? v.trim().slice(0, 80) || undefined : undefined)),
  page: queryNumber(1, 10_000).transform((v) => v ?? 1),
  limit: queryNumber(1, 100).transform((v) => v ?? 20),
});

export const adminUserUpdateSchema = z
  .object({
    status: z.enum(USER_STATUSES),
    /** Agents and builders whose documents the team has checked get a "Verified" badge. */
    verified: z.boolean(),
    note: plainText(0, 1000),
  })
  .partial()
  .strict();

/* ------------------------------------------------------------------ */
/* Locations, FAQs, settings                                           */
/* ------------------------------------------------------------------ */

export const localitySchema = z.object({
  name: plainText(2, 80),
  slug: slug.optional(),
  active: z.boolean().default(true),
  /** Unique copy for the locality landing page. Pages without it are not indexed. */
  intro: plainText(0, 3000).default(''),
  seoTitle: plainText(0, 70).optional(),
  seoDescription: plainText(0, 170).optional(),
});

export const cityCreateSchema = z.object({
  name: plainText(2, 60),
  slug: slug.optional(),
  state: plainText(2, 60),
  active: z.boolean().default(true),
  sortOrder: z.number().int().min(0).max(1000).default(0),
  intro: plainText(0, 4000).default(''),
  seoTitle: plainText(0, 70).optional(),
  seoDescription: plainText(0, 170).optional(),
  localities: z.array(localitySchema).max(300).default([]),
});
export const cityUpdateSchema = cityCreateSchema.partial().strict();

export const faqCreateSchema = z.object({
  question: plainText(5, 200),
  answer: plainText(5, 3000),
  category: z.enum(FAQ_CATEGORIES).default('general'),
  sortOrder: z.number().int().min(0).max(1000).default(0),
  published: z.boolean().default(true),
  showOnHome: z.boolean().default(false),
});
export const faqUpdateSchema = faqCreateSchema.partial().strict();

const optionalUrl = z
  .union([z.url({ protocol: /^https$/ }).max(300), z.literal('')])
  .optional()
  .transform((v) => v || undefined);

export const siteSettingsSchema = z.object({
  businessName: plainText(2, 80),
  tagline: plainText(0, 80),
  phone: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/, 'Use international format, e.g. +919521750202'),
  whatsapp: z
    .string()
    .trim()
    .regex(/^\+[1-9]\d{7,14}$/, 'Use international format'),
  email: z
    .string()
    .trim()
    .toLowerCase()
    .email()
    .max(120)
    .optional()
    .or(z.literal('').transform(() => undefined)),
  address: z
    .object({
      line1: plainText(0, 120).default(''),
      line2: plainText(0, 120).default(''),
      city: plainText(0, 60).default(''),
      state: plainText(0, 60).default(''),
      pincode: z.string().trim().max(6).default(''),
    })
    .default({ line1: '', line2: '', city: '', state: '', pincode: '' }),
  showAddress: z.boolean().default(false),
  businessHours: plainText(0, 120).default(''),
  social: z
    .object({
      facebook: optionalUrl,
      instagram: optionalUrl,
      linkedin: optionalUrl,
      youtube: optionalUrl,
      x: optionalUrl,
    })
    .default({
      facebook: undefined,
      instagram: undefined,
      linkedin: undefined,
      youtube: undefined,
      x: undefined,
    }),
  home: z.object({
    heroHeadline: plainText(5, 90),
    heroSubheadline: plainText(5, 220),
    heroImageUrl: optionalUrl,
    showRecent: z.boolean().default(true),
    showFeatured: z.boolean().default(true),
  }),
  allowInternationalEnquiries: z.boolean().default(false),
  enquiryNotificationEmail: z
    .string()
    .trim()
    .toLowerCase()
    .email()
    .max(120)
    .optional()
    .or(z.literal('').transform(() => undefined)),
});
export type SiteSettingsInput = z.input<typeof siteSettingsSchema>;
export const siteSettingsUpdateSchema = siteSettingsSchema.partial();

/* ------------------------------------------------------------------ */
/* Uploads                                                             */
/* ------------------------------------------------------------------ */

export const imageReorderSchema = z.object({
  images: z.array(propertyImageSchema).max(30),
  coverImageIndex: z.number().int().min(0).default(0),
});
