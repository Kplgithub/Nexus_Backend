/**
 * Domain constants shared by the API and the web app.
 * Changing a value here is a data-model change: update seed data and run tests.
 */

export const CATEGORIES = ['residential', 'commercial', 'industrial'] as const;
export type Category = (typeof CATEGORIES)[number];

/** Categories that are open to the public. Industrial is reserved for a future launch. */
export const ACTIVE_CATEGORIES: readonly Category[] = ['residential', 'commercial'];

export const PROPERTY_TYPES = {
  residential: ['apartment', 'independent-house', 'builder-floor', 'villa', 'studio', 'pg', 'plot'],
  commercial: [
    'office',
    'shop',
    'showroom',
    'commercial-building',
    'coworking',
    'other-commercial',
  ],
  industrial: ['warehouse', 'factory-shed', 'industrial-land'],
} as const satisfies Record<Category, readonly string[]>;

export type PropertyType =
  | (typeof PROPERTY_TYPES.residential)[number]
  | (typeof PROPERTY_TYPES.commercial)[number]
  | (typeof PROPERTY_TYPES.industrial)[number];

export const ALL_PROPERTY_TYPES = [
  ...PROPERTY_TYPES.residential,
  ...PROPERTY_TYPES.commercial,
  ...PROPERTY_TYPES.industrial,
] as const;

export const PROPERTY_TYPE_LABELS: Record<PropertyType, string> = {
  apartment: 'Apartment / Flat',
  'independent-house': 'Independent House',
  'builder-floor': 'Builder Floor',
  villa: 'Villa / Bungalow',
  studio: 'Studio Apartment',
  plot: 'Residential Plot',
  pg: 'PG / Shared Accommodation',
  office: 'Office Space',
  shop: 'Retail Shop',
  showroom: 'Showroom',
  'commercial-building': 'Commercial Building',
  coworking: 'Co-working Space',
  'other-commercial': 'Other Commercial Unit',
  warehouse: 'Warehouse / Godown',
  'factory-shed': 'Factory / Shed',
  'industrial-land': 'Industrial Land',
};

/** Residential types where bedroom and bathroom counts are mandatory. */
export const TYPES_REQUIRING_ROOMS: readonly PropertyType[] = [
  'apartment',
  'independent-house',
  'builder-floor',
  'villa',
];

/** Whether a listing is offered for rent or for sale. */
export const LISTING_TYPES = ['rent', 'sale'] as const;
export type ListingType = (typeof LISTING_TYPES)[number];

export const LISTING_TYPE_LABELS: Record<ListingType, string> = { rent: 'Rent', sale: 'Sale' };

/**
 * Lifecycle: draft → pending (submitted by a user, awaiting admin review) →
 * published, or rejected. Closed listings become rented / sold. inactive and
 * archived hide a listing without deleting it.
 */
export const PROPERTY_STATUSES = [
  'draft',
  'pending',
  'published',
  'rejected',
  'rented',
  'sold',
  'inactive',
  'archived',
] as const;
export type PropertyStatus = (typeof PROPERTY_STATUSES)[number];

export const PROPERTY_STATUS_LABELS: Record<PropertyStatus, string> = {
  draft: 'Draft',
  pending: 'Under review',
  published: 'Live',
  rejected: 'Needs changes',
  rented: 'Rented out',
  sold: 'Sold',
  inactive: 'Inactive',
  archived: 'Archived',
};

/** Statuses whose detail page stays reachable by the public. */
export const PUBLIC_DETAIL_STATUSES: readonly PropertyStatus[] = ['published', 'rented', 'sold'];

/** Statuses a signed-in user may set on their own listing directly. */
export const USER_SETTABLE_STATUSES = ['draft', 'pending', 'rented', 'sold', 'inactive'] as const;

export const POSSESSION_STATUSES = ['ready', 'under-construction'] as const;
export type PossessionStatus = (typeof POSSESSION_STATUSES)[number];
export const POSSESSION_LABELS: Record<PossessionStatus, string> = {
  ready: 'Ready to move',
  'under-construction': 'Under construction',
};

export const TRANSACTION_TYPES = ['new', 'resale'] as const;
export type TransactionType = (typeof TRANSACTION_TYPES)[number];
export const TRANSACTION_LABELS: Record<TransactionType, string> = {
  new: 'New booking',
  resale: 'Resale',
};

export const OWNERSHIP_TYPES = [
  'freehold',
  'leasehold',
  'cooperative',
  'power-of-attorney',
] as const;
export type OwnershipType = (typeof OWNERSHIP_TYPES)[number];
export const OWNERSHIP_LABELS: Record<OwnershipType, string> = {
  freehold: 'Freehold',
  leasehold: 'Leasehold',
  cooperative: 'Co-operative society',
  'power-of-attorney': 'Power of attorney',
};

export const LISTING_VISIBILITY = ['public', 'unlisted'] as const;
export type ListingVisibility = (typeof LISTING_VISIBILITY)[number];

export const FURNISHING_STATUSES = ['unfurnished', 'semi-furnished', 'furnished'] as const;
export type FurnishingStatus = (typeof FURNISHING_STATUSES)[number];

export const FURNISHING_LABELS: Record<FurnishingStatus, string> = {
  unfurnished: 'Unfurnished',
  'semi-furnished': 'Semi-furnished',
  furnished: 'Fully furnished',
};

export const AREA_UNITS = ['sqft', 'sqyd', 'sqm'] as const;
export type AreaUnit = (typeof AREA_UNITS)[number];

export const AREA_UNIT_LABELS: Record<AreaUnit, string> = {
  sqft: 'sq ft',
  sqyd: 'sq yd',
  sqm: 'sq m',
};

/** Conversion factors to square feet, used to normalise area for filtering. */
export const AREA_TO_SQFT: Record<AreaUnit, number> = {
  sqft: 1,
  sqyd: 9,
  sqm: 10.7639,
};

export const AREA_TYPES = ['carpet', 'built-up', 'super-built-up', 'plot'] as const;
export type AreaType = (typeof AREA_TYPES)[number];

export const PARKING_OPTIONS = ['none', 'bike', 'car', 'car-and-bike', 'covered', 'open'] as const;
export type ParkingOption = (typeof PARKING_OPTIONS)[number];

export const PARKING_LABELS: Record<ParkingOption, string> = {
  none: 'No parking',
  bike: 'Two-wheeler parking',
  car: 'Car parking',
  'car-and-bike': 'Car and two-wheeler parking',
  covered: 'Covered parking',
  open: 'Open parking',
};

export const AMENITIES = [
  'lift',
  'power-backup',
  'security',
  'cctv',
  'gated-community',
  'water-supply-24x7',
  'gas-pipeline',
  'air-conditioning',
  'modular-kitchen',
  'wifi',
  'gym',
  'swimming-pool',
  'clubhouse',
  'park',
  'visitor-parking',
  'fire-safety',
  'conference-room',
  'pantry',
  'private-washroom',
  'reception',
  'servant-room',
  'pet-friendly',
] as const;
export type Amenity = (typeof AMENITIES)[number];

export const AMENITY_LABELS: Record<Amenity, string> = {
  lift: 'Lift',
  'power-backup': 'Power backup',
  security: 'Security guard',
  cctv: 'CCTV',
  'gated-community': 'Gated community',
  'water-supply-24x7': '24×7 water supply',
  'gas-pipeline': 'Piped gas',
  'air-conditioning': 'Air conditioning',
  'modular-kitchen': 'Modular kitchen',
  wifi: 'Wi-Fi ready',
  gym: 'Gym',
  'swimming-pool': 'Swimming pool',
  clubhouse: 'Clubhouse',
  park: 'Park / garden',
  'visitor-parking': 'Visitor parking',
  'fire-safety': 'Fire safety',
  'conference-room': 'Conference room',
  pantry: 'Pantry',
  'private-washroom': 'Private washroom',
  reception: 'Reception area',
  'servant-room': 'Servant room',
  'pet-friendly': 'Pet friendly',
};

/* ---------------- Plots and PG ---------------- */

/** Who approved a plot's layout. Buyers in Jaipur filter on JDA approval first. */
export const PLOT_APPROVALS = ['jda', 'rhb', 'municipal', 'panchayat', 'other', 'none'] as const;
export type PlotApproval = (typeof PLOT_APPROVALS)[number];
export const PLOT_APPROVAL_LABELS: Record<PlotApproval, string> = {
  jda: 'JDA approved',
  rhb: 'RHB (Housing Board)',
  municipal: 'Municipal corporation',
  panchayat: 'Gram panchayat',
  other: 'Other authority',
  none: 'Not approved yet',
};

export const PG_SHARING = ['single', 'double', 'triple', 'dorm'] as const;
export type PgSharing = (typeof PG_SHARING)[number];
export const PG_SHARING_LABELS: Record<PgSharing, string> = {
  single: 'Single room',
  double: 'Double sharing',
  triple: 'Triple sharing',
  dorm: '4+ sharing',
};

export const PG_GENDERS = ['any', 'male', 'female'] as const;
export type PgGender = (typeof PG_GENDERS)[number];
export const PG_GENDER_LABELS: Record<PgGender, string> = {
  any: 'Boys and girls',
  male: 'Boys only',
  female: 'Girls only',
};

export const PREFERRED_TENANTS = ['any', 'family', 'bachelors', 'company', 'students'] as const;
export type PreferredTenant = (typeof PREFERRED_TENANTS)[number];
export const PREFERRED_TENANT_LABELS: Record<PreferredTenant, string> = {
  any: 'Anyone',
  family: 'Families',
  bachelors: 'Bachelors',
  company: 'Company lease',
  students: 'Students',
};

export const ENQUIRY_STATUSES = ['new', 'contacted', 'qualified', 'closed', 'spam'] as const;
export type EnquiryStatus = (typeof ENQUIRY_STATUSES)[number];

/** "contact" = a signed-in user revealed the poster's phone number. */
export const ENQUIRY_TYPES = ['property', 'general', 'callback', 'contact'] as const;
export type EnquiryType = (typeof ENQUIRY_TYPES)[number];

export const SORT_OPTIONS = ['newest', 'price_asc', 'price_desc', 'area_desc'] as const;
export type SortOption = (typeof SORT_OPTIONS)[number];

export const SORT_LABELS: Record<SortOption, string> = {
  newest: 'Newest first',
  price_asc: 'Price: low to high',
  price_desc: 'Price: high to low',
  area_desc: 'Largest first',
};

/** "Posted within" filter, in days. */
export const POSTED_WITHIN_DAYS = [1, 7, 30] as const;

/* ---------------- Localities ---------------- */

export const LANDMARK_KINDS = [
  'school',
  'college',
  'hospital',
  'mall',
  'market',
  'metro',
  'railway',
  'bus',
  'airport',
  'park',
  'office',
  'temple',
] as const;
export type LandmarkKind = (typeof LANDMARK_KINDS)[number];
export const LANDMARK_KIND_LABELS: Record<LandmarkKind, string> = {
  school: 'School',
  college: 'College',
  hospital: 'Hospital',
  mall: 'Mall',
  market: 'Market',
  metro: 'Metro station',
  railway: 'Railway station',
  bus: 'Bus stand',
  airport: 'Airport',
  park: 'Park',
  office: 'Office hub',
  temple: 'Temple',
};

/* ---------------- Reports ---------------- */

export const REPORT_REASONS = [
  'already-rented-or-sold',
  'wrong-price',
  'wrong-photos',
  'fake-or-fraud',
  'broker-posing-as-owner',
  'other',
] as const;
export type ReportReason = (typeof REPORT_REASONS)[number];
export const REPORT_REASON_LABELS: Record<ReportReason, string> = {
  'already-rented-or-sold': 'Already rented or sold',
  'wrong-price': 'Wrong price or details',
  'wrong-photos': 'Photos are not of this property',
  'fake-or-fraud': 'Looks fake or fraudulent',
  'broker-posing-as-owner': 'Broker posing as owner',
  other: 'Something else',
};
export const REPORT_STATUSES = ['open', 'resolved', 'dismissed'] as const;
export type ReportStatus = (typeof REPORT_STATUSES)[number];

/* ---------------- New projects (builders) ---------------- */

export const PROJECT_STATUSES = ['draft', 'pending', 'published', 'rejected', 'inactive'] as const;
export type ProjectStatus = (typeof PROJECT_STATUSES)[number];
export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  draft: 'Draft',
  pending: 'In review',
  published: 'Live',
  rejected: 'Changes needed',
  inactive: 'Inactive',
};

export const PROJECT_STAGES = ['new-launch', 'under-construction', 'ready-to-move'] as const;
export type ProjectStage = (typeof PROJECT_STAGES)[number];
export const PROJECT_STAGE_LABELS: Record<ProjectStage, string> = {
  'new-launch': 'New launch',
  'under-construction': 'Under construction',
  'ready-to-move': 'Ready to move',
};

/** Property types a project can contain. */
export const PROJECT_UNIT_TYPES = [
  'apartment',
  'villa',
  'independent-house',
  'builder-floor',
  'plot',
  'office',
  'shop',
] as const;
export type ProjectUnitType = (typeof PROJECT_UNIT_TYPES)[number];

export const ADMIN_ROLES = ['owner', 'admin', 'editor'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/* ---------------- Website users ---------------- */

/** Account types offered at sign-up. "individual" covers buyers, owners and tenants. */
export const USER_ROLES = ['individual', 'agent', 'builder'] as const;
export type UserRole = (typeof USER_ROLES)[number];

export const USER_ROLE_LABELS: Record<UserRole, string> = {
  individual: 'Buyer / Owner / Tenant',
  agent: 'Agent',
  builder: 'Builder',
};

export const USER_ROLE_DESCRIPTIONS: Record<UserRole, string> = {
  individual: 'Looking to buy or rent, or own a property you want to sell or rent out.',
  agent: 'A real estate agent or broker listing properties for clients.',
  builder: 'A developer or builder listing projects and units.',
};

/** Who posted a listing, as shown on the site. "nexus" = posted by the NEXUS team. */
export const POSTER_TYPES = ['nexus', 'owner', 'agent', 'builder'] as const;
export type PosterType = (typeof POSTER_TYPES)[number];
export const POSTER_LABELS: Record<PosterType, string> = {
  nexus: 'NEXUS Estate',
  owner: 'Owner',
  agent: 'Agent',
  builder: 'Builder',
};

/** Active (live or under review) listings a user may hold at once. */
export const LISTING_LIMITS: Record<UserRole, number> = { individual: 5, agent: 200, builder: 500 };

export const USER_STATUSES = ['active', 'blocked'] as const;
export type UserStatus = (typeof USER_STATUSES)[number];

export const OTP_PURPOSES = ['login', 'verify', 'reset'] as const;
export type OtpPurpose = (typeof OTP_PURPOSES)[number];
export const OTP_LENGTH = 6;
export const OTP_TTL_SECONDS = 600;
export const OTP_RESEND_SECONDS = 30;
export const OTP_MAX_ATTEMPTS = 5;

/** All Indian states and union territories, for adding cities anywhere in the country. */
export const INDIAN_STATES = [
  'Andaman and Nicobar Islands',
  'Andhra Pradesh',
  'Arunachal Pradesh',
  'Assam',
  'Bihar',
  'Chandigarh',
  'Chhattisgarh',
  'Dadra and Nagar Haveli and Daman and Diu',
  'Delhi',
  'Goa',
  'Gujarat',
  'Haryana',
  'Himachal Pradesh',
  'Jammu and Kashmir',
  'Jharkhand',
  'Karnataka',
  'Kerala',
  'Ladakh',
  'Lakshadweep',
  'Madhya Pradesh',
  'Maharashtra',
  'Manipur',
  'Meghalaya',
  'Mizoram',
  'Nagaland',
  'Odisha',
  'Puducherry',
  'Punjab',
  'Rajasthan',
  'Sikkim',
  'Tamil Nadu',
  'Telangana',
  'Tripura',
  'Uttar Pradesh',
  'Uttarakhand',
  'West Bengal',
] as const;

export const FAQ_CATEGORIES = [
  'general',
  'buyers',
  'tenants',
  'owners',
  'agents',
  'commercial',
] as const;
export type FaqCategory = (typeof FAQ_CATEGORIES)[number];

export const PAGE_SIZE_DEFAULT = 12;
export const PAGE_SIZE_MAX = 48;

/** Upper bound on any price (₹1,000 crore) — guards against typos. */
export const MAX_MONEY_INR = 10_000_000_000;

export const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
export const IMAGE_MAX_PER_PROPERTY = 30;
export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'] as const;

/* ---------------- Blog ---------------- */
export const BLOG_STATUSES = ['draft', 'published'] as const;
export type BlogStatus = (typeof BLOG_STATUSES)[number];

export const BLOG_CATEGORIES = [
  'buying',
  'renting',
  'investment',
  'home-loans',
  'legal',
  'localities',
  'interiors',
  'news',
] as const;
export type BlogCategory = (typeof BLOG_CATEGORIES)[number];

export const BLOG_CATEGORY_LABELS: Record<BlogCategory, string> = {
  buying: 'Buying guide',
  renting: 'Renting guide',
  investment: 'Investment',
  'home-loans': 'Home loans',
  legal: 'Legal and RERA',
  localities: 'Locality guides',
  interiors: 'Interiors and Vastu',
  news: 'Market news',
};

/** Slugs the blog uses for its own pages, so no post can take them. */
export const BLOG_RESERVED_SLUGS = ['category', 'tag', 'page', 'feed', 'rss'] as const;

/* ---------------- Admin panel: roles, visits, verification, plans ---------------- */

/**
 * Staff roles as people see them. "owner" and "admin" are both Super Admins (full
 * access); "editor" is a Sub-admin who runs listings, leads and content but cannot
 * delete, export, manage the team, change passwords or touch settings and payments.
 */
export const ADMIN_ROLE_LABELS: Record<AdminRole, string> = {
  owner: 'Super Admin',
  admin: 'Super Admin',
  editor: 'Sub-admin',
};
/** Roles offered when adding a team member. */
export const TEAM_ROLES = ['owner', 'editor'] as const;
export type TeamRole = (typeof TEAM_ROLES)[number];
export const isSuperAdmin = (role: AdminRole) => role === 'owner' || role === 'admin';

export const SITE_VISIT_STATUSES = ['scheduled', 'done', 'cancelled', 'no-show'] as const;
export type SiteVisitStatus = (typeof SITE_VISIT_STATUSES)[number];
export const SITE_VISIT_STATUS_LABELS: Record<SiteVisitStatus, string> = {
  scheduled: 'Scheduled',
  done: 'Done',
  cancelled: 'Cancelled',
  'no-show': 'No-show',
};

export const VERIFICATION_STATUSES = ['unverified', 'pending', 'verified', 'rejected'] as const;
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
export const VERIFICATION_STATUS_LABELS: Record<VerificationStatus, string> = {
  unverified: 'Not checked',
  pending: 'Waiting for check',
  verified: 'Verified',
  rejected: 'Rejected',
};

/** How long a listing stays featured when an admin features it. */
export const FEATURE_DAYS = [7, 15, 30, 60, 90] as const;

export const PAYMENT_STATUSES = ['created', 'paid', 'failed', 'refunded'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];
export const PAYMENT_METHODS = ['online', 'manual'] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

export const ALERT_EVENTS = ['lead', 'listing', 'report', 'signup', 'payment', 'visit'] as const;
export type AlertEvent = (typeof ALERT_EVENTS)[number];
export const ALERT_EVENT_LABELS: Record<AlertEvent, string> = {
  lead: 'New enquiry',
  listing: 'Listing sent for review',
  report: 'Listing reported',
  signup: 'New agent or builder signed up',
  payment: 'Payment received',
  visit: 'Site visit booked',
};
