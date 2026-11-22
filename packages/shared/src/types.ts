import type {
  AdminRole,
  AlertEvent,
  PaymentKind,
  PaymentMethod,
  PaymentStatus,
  SiteVisitStatus,
  VerificationStatus,
  BlogCategory,
  BlogStatus,
  Amenity,
  AreaType,
  AreaUnit,
  Category,
  EnquiryStatus,
  EnquiryType,
  LoanEmployment,
  LoanPurpose,
  LoanStage,
  FaqCategory,
  FurnishingStatus,
  LandmarkKind,
  ListingType,
  PgGender,
  PgSharing,
  PlotApproval,
  FarmLandUse,
  FarmWaterSource,
  FarmElectricity,
  FarmFeature,
  ProjectStage,
  ProjectStatus,
  ProjectUnitType,
  ReportReason,
  ReportStatus,
  OwnershipType,
  ParkingOption,
  PossessionStatus,
  PosterType,
  PreferredTenant,
  PropertyStatus,
  PropertyType,
  SortOption,
  TransactionType,
  SupportStatus,
  SupportTopic,
  UserRole,
  UserStatus,
} from './constants.js';
import type { FarmSettings, LoanLender } from './schemas.js';

/** Envelope used by every API response. */
export type ApiSuccess<T> = { ok: true; data: T; meta?: PaginationMeta };
export type ApiError = {
  ok: false;
  error: { code: string; message: string; details?: Record<string, string[]> };
};
export type ApiResponse<T> = ApiSuccess<T> | ApiError;

export type PaginationMeta = {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
};

export type PropertyImage = {
  url: string;
  publicId?: string;
  alt: string;
  width?: number;
  height?: number;
  isDemo?: boolean;
};

/** Public information about whoever posted a listing. Phone numbers are never included. */
export type ListingPoster = {
  type: PosterType;
  /** Person or company name; null for listings posted by NEXUS. */
  name: string | null;
  companyName: string | null;
  verified: boolean;
  /** Has an active paid plan. */
  premium: boolean;
  /** True when a signed-in visitor may reveal this poster's phone number. */
  canRevealPhone: boolean;
  memberSince: string | null;
  /** Public profile page for agents and builders: /agents/<slug> or /builders/<slug>. */
  profilePath: string | null;
};

export type GeoPointValue = { lat: number; lng: number };

/** Public-safe projection of a property. Never contains owner details or internal notes. */
export type PublicProperty = {
  id: string;
  slug: string;
  listingType: ListingType;
  title: string;
  description: string;
  highlights: string[];
  category: Category;
  propertyType: PropertyType;
  status: Extract<PropertyStatus, 'published' | 'rented' | 'sold'>;
  city: { slug: string; name: string };
  locality: { slug: string; name: string };
  state: string;
  approvedAddress: string;
  projectName: string | null;
  /** Monthly rent for rent listings, total asking price for sale listings. */
  price: number;
  priceNegotiable: boolean;
  pricePerSqft: number | null;
  securityDeposit: number | null;
  maintenanceCharges: number | null;
  maintenanceIncluded: boolean;
  brokerage: string | null;
  lockInMonths: number | null;
  rentalTerms: string | null;
  possessionStatus: PossessionStatus | null;
  possessionDate: string | null;
  transactionType: TransactionType | null;
  ownershipType: OwnershipType | null;
  reraId: string | null;
  areaValue: number;
  areaUnit: AreaUnit;
  areaType: AreaType;
  areaSqft: number;
  bedrooms: number | null;
  bathrooms: number | null;
  balconies: number | null;
  washrooms: number | null;
  floorNumber: number | null;
  totalFloors: number | null;
  facing: string | null;
  ageOfPropertyYears: number | null;
  furnishingStatus: FurnishingStatus;
  amenities: Amenity[];
  parking: ParkingOption;
  preferredTenants: PreferredTenant[];
  suitableFor: string[];
  images: PropertyImage[];
  coverImage: PropertyImage | null;
  location: GeoPointValue | null;
  videoUrl: string | null;
  project: { id: string; slug: string; name: string } | null;
  plotApproval: PlotApproval | null;
  cornerPlot: boolean;
  roadWidthFt: number | null;
  openSides: number | null;
  boundaryWall: boolean;
  farmLandUse: FarmLandUse | null;
  farmWaterSource: FarmWaterSource | null;
  farmElectricity: FarmElectricity | null;
  farmFeatures: FarmFeature[];
  farmhouseAreaSqft: number | null;
  pgSharing: PgSharing[];
  pgGender: PgGender | null;
  pgFoodIncluded: boolean;
  /** Views of the detail page (approximate). */
  views: number;
  availableFrom: string | null;
  featured: boolean;
  verified: boolean;
  isDemo: boolean;
  poster: ListingPoster;
  seoTitle: string | null;
  seoDescription: string | null;
  publishedAt: string | null;
  updatedAt: string;
};

export type PropertyCard = Pick<
  PublicProperty,
  | 'id'
  | 'slug'
  | 'listingType'
  | 'title'
  | 'category'
  | 'propertyType'
  | 'status'
  | 'city'
  | 'locality'
  | 'projectName'
  | 'price'
  | 'pricePerSqft'
  | 'areaValue'
  | 'areaUnit'
  | 'bedrooms'
  | 'bathrooms'
  | 'furnishingStatus'
  | 'possessionStatus'
  | 'coverImage'
  | 'featured'
  | 'verified'
  | 'isDemo'
  | 'availableFrom'
  | 'publishedAt'
  | 'location'
  | 'plotApproval'
  | 'farmLandUse'
  | 'farmWaterSource'
  | 'farmhouseAreaSqft'
  | 'pgGender'
> & {
  posterType: PosterType;
  imageCount: number;
  areaSqft: number;
  /** The poster's plan gives a Premium Partner badge. */
  partnerBadge: boolean;
  /** Last time the listing moved back to the top (publish or plan auto refresh). */
  refreshedAt: string | null;
};

/** A user's view of their own listing. */
export type OwnListing = Omit<PublicProperty, 'status' | 'poster'> & {
  status: PropertyStatus;
  citySlug: string;
  localitySlug: string;
  pincode: string | null;
  coverImageIndex: number;
  moderationNote: string | null;
  createdAt: string;
  enquiryCount: number;
  projectId: string | null;
  /** Saved and complete, waiting for the user to take a plan before review. */
  awaitingPlan: boolean;
  /** Featured by the user with a plan feature, until this date. */
  featuredUntil: string | null;
};

export type AdminProperty = OwnListing & {
  listingVisibility: 'public' | 'unlisted';
  ownerReference: string | null;
  internalNotes: string | null;
  postedBy: { id: string; name: string; role: UserRole; email: string; phone: string } | null;
  poster: ListingPoster;
};

/** Search copy for the Buy or Rent page of a city or locality. */
export type DealSeo = {
  title?: string;
  description?: string;
  h1?: string;
  intro?: string;
};

export type Locality = {
  name: string;
  slug: string;
  active: boolean;
  intro: string;
  seoTitle?: string;
  seoDescription?: string;
  buySeo?: DealSeo;
  rentSeo?: DealSeo;
  publishedCount?: number;
  center?: GeoPointValue | null;
  highlights?: string[];
  landmarks?: { name: string; kind: LandmarkKind; location?: GeoPointValue | null }[];
};

/** Prices and counts for a locality page, worked out from live listings. */
export type LocalityInsights = {
  city: { slug: string; name: string };
  locality: Locality;
  sale: {
    count: number;
    medianPricePerSqft: number | null;
    minPrice: number | null;
    maxPrice: number | null;
  };
  rent: {
    count: number;
    medianRent: number | null;
    medianRentByBhk: { bedrooms: number; rent: number }[];
  };
  /** Live listings per property type. */
  byType: { propertyType: PropertyType; count: number }[];
  projects: number;
  /** City-wide median sale price per sq ft, for comparison. */
  cityMedianPricePerSqft: number | null;
};

export type City = {
  id: string;
  name: string;
  slug: string;
  state: string;
  active: boolean;
  sortOrder: number;
  intro: string;
  seoTitle?: string;
  seoDescription?: string;
  buySeo?: DealSeo;
  rentSeo?: DealSeo;
  localities: Locality[];
  publishedCount?: number;
};

export type Faq = {
  id: string;
  question: string;
  answer: string;
  category: FaqCategory;
  sortOrder: number;
  published: boolean;
  showOnHome: boolean;
};

export type HomeBanner = {
  id: string;
  /** top: wide strip under the tiles; middle: wide banner after agents; lower: two-up after tools. */
  placement: 'top' | 'middle' | 'lower';
  imageUrl: string;
  title: string;
  text: string;
  buttonLabel: string;
  link: string;
  active: boolean;
};

export type InvoiceSettings = {
  /** Registered business name, if different from the brand name. */
  legalName: string;
  /** With a GSTIN the invoice is a tax invoice with GST; without it, a payment receipt. */
  gstin?: string;
  address: string;
  /** State of the GST registration, e.g. Rajasthan. */
  state: string;
  sacCode: string;
};

export type SiteSettings = {
  businessName: string;
  tagline: string;
  phone: string;
  whatsapp: string;
  email?: string;
  address: { line1: string; line2: string; city: string; state: string; pincode: string };
  showAddress: boolean;
  businessHours: string;
  social: {
    facebook?: string;
    instagram?: string;
    linkedin?: string;
    youtube?: string;
    x?: string;
  };
  home: {
    heroHeadline: string;
    heroSubheadline: string;
    heroImageUrl?: string;
    showRecent: boolean;
    showFeatured: boolean;
    /** Home page promo banners, managed in admin Settings. */
    banners: HomeBanner[];
  };
  allowInternationalEnquiries: boolean;
  /** Paid Featured prices in rupees (GST included), set by admin. */
  featurePrices: { days7: number; days30: number };
  /** Admin only. Business details printed on payment invoices. */
  invoice: InvoiceSettings;
  /** Admin only. */
  enquiryNotificationEmail?: string;
  /** Home loan page: rates table and calculator defaults. */
  homeLoan: {
    enabled: boolean;
    lenders: LoanLender[];
    ratesCheckedAt: string | null;
    exampleRate: number;
  };
  /** Farm property switches (main switch plus one per place on the site). */
  farms: FarmSettings;
};

/** What the sign-in screens can offer, based on server configuration. */
export type AuthConfig = { otpEnabled: boolean; emailResetEnabled: boolean };

export type EnquiryNote = { text: string; by: string; at: string };

export type Enquiry = {
  id: string;
  leadId: string;
  type: EnquiryType;
  name: string;
  phone: string;
  email: string | null;
  message: string;
  property: { id: string; title: string; slug: string } | null;
  project: { id: string; name: string; slug: string } | null;
  sourcePage: string | null;
  preferredContactTime: string | null;
  status: EnquiryStatus;
  followUpAt: string | null;
  assignedTo: string | null;
  /** The team member working this lead. */
  assignedAdmin: { id: string; name: string } | null;
  notes: EnquiryNote[];
  consentAt: string;
  createdAt: string;
  updatedAt: string;
  /** Set when the visitor was signed in. */
  userId: string | null;
  /** Set when the listing belongs to a user (owner/agent/builder). */
  listingOwner: { id: string; name: string } | null;
  /** Home loan leads only. */
  loan: EnquiryLoan | null;
};

export type EnquiryLoan = {
  amount: number;
  monthlyIncome: number | null;
  employment: LoanEmployment;
  purpose: LoanPurpose;
  lender: string | null;
  stage: LoanStage;
  bank: string | null;
  sentToBankAt: string | null;
};

/** An enquiry as seen by the user who posted the listing. */
export type ReceivedLead = Pick<
  Enquiry,
  | 'id'
  | 'leadId'
  | 'type'
  | 'name'
  | 'phone'
  | 'email'
  | 'message'
  | 'property'
  | 'project'
  | 'createdAt'
> & {
  seen: boolean;
  /** Over the free lead limit: name, phone, email and message are hidden until a plan. */
  locked: boolean;
};

/** An enquiry as seen by the visitor who sent it. */
export type SentEnquiry = Pick<
  Enquiry,
  'id' | 'leadId' | 'type' | 'message' | 'property' | 'project' | 'createdAt'
>;

export type AdminUser = { id: string; email: string; name: string; role: AdminRole };

/** The signed-in website user. */
export type SessionUser = {
  id: string;
  role: UserRole;
  name: string;
  email: string;
  phone: string;
  phoneVerified: boolean;
  companyName: string | null;
  reraNumber: string | null;
  about: string | null;
  citySlug: string | null;
  showPhone: boolean;
  whatsappEnabled: boolean;
  verified: boolean;
  createdAt: string;
  experienceYears: number | null;
  website: string | null;
  logoUrl: string | null;
  localities: string[];
  /** Public profile URL for agents and builders. */
  profileSlug: string | null;
};

/** Agent or builder profile shown at /agents/<slug> and /builders/<slug>. */
export type PublicProfile = {
  id: string;
  slug: string;
  role: 'agent' | 'builder';
  name: string;
  companyName: string | null;
  about: string | null;
  reraNumber: string | null;
  verified: boolean;
  premium: boolean;
  experienceYears: number | null;
  website: string | null;
  logoUrl: string | null;
  city: { slug: string; name: string } | null;
  localities: { slug: string; name: string }[];
  memberSince: string;
  counts: { sale: number; rent: number; projects: number };
  canRevealPhone: boolean;
};

export type ProfileCard = Pick<
  PublicProfile,
  'id' | 'slug' | 'role' | 'name' | 'companyName' | 'verified' | 'logoUrl' | 'experienceYears'
> & { listings: number };

export type AdminWebsiteUser = SessionUser & {
  status: UserStatus;
  verificationStatus: VerificationStatus;
  lastLoginAt: string | null;
  listingCount: number;
  notes: EnquiryNote[];
};

export type UserDashboard = {
  listings: Record<PropertyStatus, number> & { total: number };
  leads: { total: number; unseen: number };
  saved: number;
  enquiriesSent: number;
  listingLimit: number;
  recentLeads: ReceivedLead[];
  subscription: MySubscription;
  usage: PlanUsage;
  performance: DashboardPerformance;
};

/** Views and leads across all of a poster's listings, for the dashboard chart and cards. */
export type DashboardPerformance = {
  /** The last 14 days (India time), oldest first, as YYYY-MM-DD. */
  days: string[];
  views: number[];
  leads: number[];
  views30: number;
  viewsPrev30: number;
  leads30: number;
  leadsPrev30: number;
  leadsToday: number;
  /** Leads that came from someone viewing the number, last 30 days. */
  contacts30: number;
};

/** What a user has used of their free allowance or plan. */
export type PlanUsage = {
  listings: { used: number; limit: number };
  /** Leads with contact details this period. limit null means no limit. */
  leads: { used: number; limit: number | null; locked: number; periodStart: string };
  awaitingPlan: number;
  premium: boolean;
};

export type DashboardStats = {
  properties: {
    total: number;
    published: number;
    pending: number;
    draft: number;
    rented: number;
    sold: number;
    inactive: number;
    archived: number;
    demo: number;
  };
  enquiries: {
    total: number;
    new: number;
    contacted: number;
    qualified: number;
    followUpsDue: number;
  };
  users: { total: number; individual: number; agent: number; builder: number; newThisWeek: number };
  recentProperties: Pick<
    AdminProperty,
    'id' | 'title' | 'slug' | 'status' | 'price' | 'listingType' | 'createdAt'
  >[];
  recentEnquiries: Pick<Enquiry, 'id' | 'leadId' | 'name' | 'status' | 'createdAt' | 'property'>[];
};

export type ProjectConfigurationView = {
  unitType: ProjectUnitType;
  bedrooms: number | null;
  minAreaSqft: number;
  maxAreaSqft: number;
  minPrice: number;
  maxPrice: number;
  floorPlanUrl: string | null;
  /** e.g. "3 BHK Apartment", "Plot". */
  label: string;
};

export type PublicProject = {
  id: string;
  slug: string;
  name: string;
  description: string;
  highlights: string[];
  city: { slug: string; name: string };
  locality: { slug: string; name: string };
  address: string;
  location: GeoPointValue | null;
  stage: ProjectStage;
  launchDate: string | null;
  possessionDate: string | null;
  reraId: string | null;
  totalUnits: number | null;
  totalTowers: number | null;
  landAreaAcres: number | null;
  configurations: ProjectConfigurationView[];
  priceRange: { min: number; max: number };
  amenities: Amenity[];
  images: PropertyImage[];
  coverImage: PropertyImage | null;
  brochureUrl: string | null;
  videoUrl: string | null;
  featured: boolean;
  builder: {
    id: string;
    name: string;
    companyName: string | null;
    verified: boolean;
    profilePath: string | null;
    logoUrl: string | null;
  };
  seoTitle: string | null;
  seoDescription: string | null;
  publishedAt: string | null;
  updatedAt: string;
};

export type ProjectCard = Pick<
  PublicProject,
  | 'id'
  | 'slug'
  | 'name'
  | 'city'
  | 'locality'
  | 'stage'
  | 'possessionDate'
  | 'reraId'
  | 'priceRange'
  | 'coverImage'
  | 'featured'
  | 'location'
> & { builderName: string; unitSummary: string };

/** A builder's own project, including review state. */
export type OwnProject = Omit<PublicProject, 'builder'> & {
  status: ProjectStatus;
  citySlug: string;
  localitySlug: string;
  coverImageIndex: number;
  moderationNote: string | null;
  createdAt: string;
  enquiryCount: number;
};

export type AdminProject = OwnProject & {
  builder: { id: string; name: string; email: string; phone: string } | null;
};

export type ListingReport = {
  id: string;
  property: { id: string; title: string; slug: string } | null;
  reason: ReportReason;
  details: string;
  status: ReportStatus;
  reporter: { name: string | null; userId: string | null };
  note: string | null;
  createdAt: string;
};

export type CategoryInfo = {
  category: Category;
  label: string;
  enabled: boolean;
  types: { value: PropertyType; label: string }[];
};

export type { SortOption };

/* ---------------- Blog ---------------- */

export type BlogCover = {
  url: string;
  publicId?: string;
  alt: string;
  width?: number;
  height?: number;
};

export type BlogPostCard = {
  id: string;
  slug: string;
  title: string;
  excerpt: string;
  coverImage: BlogCover | null;
  category: BlogCategory;
  tags: string[];
  authorName: string;
  featured: boolean;
  readingMinutes: number;
  publishedAt: string | null;
  updatedAt: string;
};

export type PublicBlogPost = BlogPostCard & {
  content: string;
  seoTitle?: string;
  seoDescription?: string;
};

export type AdminBlogPost = PublicBlogPost & {
  status: BlogStatus;
  createdAt: string;
  /** All-time reader numbers; only on the admin list. */
  stats?: BlogReadStats;
};

/* ---------------- Blog reader analytics ---------------- */

export type BlogReadStats = {
  /** Article opens (one per reader per browser tab session). */
  views: number;
  /** Distinct browsers that opened the article. */
  readers: number;
  /** Total active reading time, in seconds (only while the tab is visible and the reader is active). */
  totalSeconds: number;
  /** Average active reading time per view, in seconds. */
  avgSeconds: number;
  /** Views that scrolled to the end of the article. */
  completed: number;
  /** completed / views, 0-100. */
  completionRate: number;
};

export type BlogAnalyticsDay = {
  /** YYYY-MM-DD, India time. */
  date: string;
  views: number;
  readers: number;
  avgSeconds: number;
};

export type BlogAnalyticsRange = { days: number; from: string; to: string };

export type BlogAnalyticsCount = { label: string; count: number };

export type BlogAnalyticsPostRow = BlogReadStats & {
  id: string;
  title: string;
  slug: string;
  status: BlogStatus;
  publishedAt: string | null;
};

export type BlogAnalyticsOverview = {
  range: BlogAnalyticsRange;
  totals: BlogReadStats;
  daily: BlogAnalyticsDay[];
  posts: BlogAnalyticsPostRow[];
};

export type BlogRecentRead = {
  at: string;
  seconds: number;
  scroll: number;
  device: string;
  source: string;
  returning: boolean;
};

export type BlogPostAnalytics = {
  post: { id: string; title: string; slug: string; status: BlogStatus; readingMinutes: number };
  range: BlogAnalyticsRange;
  totals: BlogReadStats & {
    /** Views with at least 30 seconds of reading. */
    engaged: number;
    /** Views that left within 10 seconds. */
    quickExits: number;
    /** Readers who had read a NEXUS article before. */
    returningReaders: number;
  };
  allTime: BlogReadStats;
  daily: BlogAnalyticsDay[];
  /** How many views reached 25/50/75/100% of the article. */
  scrollDepth: BlogAnalyticsCount[];
  /** Views grouped by reading time. */
  timeBuckets: BlogAnalyticsCount[];
  devices: BlogAnalyticsCount[];
  sources: BlogAnalyticsCount[];
  recent: BlogRecentRead[];
};

/* ---------------- Admin panel ---------------- */

export type AdminRef = { id: string; name: string; role: AdminRole };

export type TeamMember = {
  id: string;
  name: string;
  email: string;
  role: AdminRole;
  active: boolean;
  lastLoginAt: string | null;
  lockedUntil: string | null;
  createdAt: string;
  /** Work in hand, for the Team page. */
  stats: { openLeads: number; closedLeads: number; upcomingVisits: number; actions30d: number };
};

export type ActivityItem = {
  id: string;
  actor: AdminRef | null;
  actorEmail: string | null;
  action: string;
  entity: string;
  entityId: string | null;
  summary: string | null;
  createdAt: string;
};

export type Kpi = { value: number; previous: number; spark: number[] };

export type DashboardCharts = {
  days: number;
  today: {
    toReview: number;
    newLeads: number;
    followUpsOverdue: number;
    visitsToday: number;
    openReports: number;
    pendingVerification: number;
  };
  kpis: { liveListings: Kpi; newLeads: Kpi; closedLeads: Kpi; signups: Kpi };
  leadsByDay: { date: string; buy: number; rent: number; other: number }[];
  pipeline: { total: number; contacted: number; visited: number; closed: number };
  uncontacted24h: number;
  localities: { slug: string; name: string; leads: number; live: number }[];
  listingsByType: { type: string; label: string; count: number }[];
  /** Per team member, open and closed leads in the period. */
  team: { admin: AdminRef; open: number; closed: number }[];
  /** Super Admins only; empty for Sub-admins. */
  activity: ActivityItem[];
};

export type SiteVisit = {
  id: string;
  name: string;
  phone: string;
  scheduledAt: string;
  status: SiteVisitStatus;
  enquiry: { id: string; leadId: string } | null;
  property: { id: string; title: string; slug: string } | null;
  assignedAdmin: AdminRef | null;
  outcome: string | null;
  notes: EnquiryNote[];
  createdBy: string;
  createdAt: string;
};

export type VerificationItem = AdminWebsiteUser & {
  verificationStatus: VerificationStatus;
  verifiedAt: string | null;
  verifiedBy: string | null;
  verificationNote: string | null;
};

export type FeaturedListing = {
  id: string;
  title: string;
  slug: string;
  status: PropertyStatus;
  listingType: ListingType;
  localityName: string;
  price: number;
  featuredUntil: string | null;
  postedBy: { id: string; name: string } | null;
};

export type Plan = {
  id: string;
  name: string;
  description: string;
  price: number;
  durationDays: number;
  listingLimit: number;
  featuredListings: number;
  featuredDays: number;
  /** 0 means no limit. */
  leadLimit: number;
  /** Cut price shown struck through; 0 means none. */
  mrp: number;
  /** 0 Normal, 1 High, 2 Higher, 3 Top (SEARCH_RANKS). */
  searchRank: number;
  partnerBadge: boolean;
  /** 0 means off. */
  autoRefreshDays: number;
  recommended: boolean;
  roles: UserRole[];
  active: boolean;
  sortOrder: number;
};

export type Payment = {
  id: string;
  kind: PaymentKind;
  /** For a Featured payment: the listing it featured. */
  property: { id: string; title: string; slug: string } | null;
  user: { id: string; name: string; role: UserRole; phone: string } | null;
  plan: {
    id: string;
    name: string;
    durationDays: number;
    listingLimit: number;
    featuredListings: number;
    featuredDays: number;
    leadLimit: number;
    searchRank: number;
    partnerBadge: boolean;
    autoRefreshDays: number;
  };
  amount: number;
  status: PaymentStatus;
  method: PaymentMethod;
  orderId: string | null;
  paymentId: string | null;
  reference: string | null;
  note: string | null;
  recordedBy: string | null;
  paidAt: string | null;
  startsAt: string | null;
  endsAt: string | null;
  /** Set once the payment is paid, e.g. NX/2026-27/0001. */
  invoiceNo: string | null;
  createdAt: string;
};

/** A printable invoice (with GST) or payment receipt (without GSTIN) for one paid payment. */
export type PaymentInvoice = {
  number: string;
  kind: 'tax-invoice' | 'receipt';
  /** Date of payment. */
  date: string;
  status: 'paid' | 'refunded';
  seller: {
    name: string;
    legalName: string;
    gstin: string | null;
    address: string;
    state: string;
    phone: string;
    email: string | null;
  };
  buyer: {
    name: string;
    company: string | null;
    phone: string;
    email: string | null;
    city: string | null;
    state: string | null;
  };
  item: {
    description: string;
    detail: string | null;
    sacCode: string | null;
    from: string | null;
    to: string | null;
  };
  /** Amount paid in rupees. Prices include GST. */
  total: number;
  /** Value before GST, in rupees with paise. Equals total for a receipt. */
  taxable: number;
  gstRate: number;
  cgst: number;
  sgst: number;
  igst: number;
  totalInWords: string;
  payment: {
    method: PaymentMethod;
    paymentId: string | null;
    orderId: string | null;
    reference: string | null;
  };
};

export type PaymentSummary = {
  thisMonth: number;
  lastMonth: number;
  activeSubscriptions: number;
  onlineEnabled: boolean;
};

export type MySubscription = {
  plan: Payment['plan'];
  startsAt: string;
  endsAt: string;
} | null;

export type CheckoutOrder = {
  orderId: string;
  keyId: string;
  amount: number;
  currency: 'INR';
  planName: string;
  prefill: { name: string; email: string; contact: string };
};

export type AdminNotification = {
  id: string;
  kind: AlertEvent | 'assigned' | 'system';
  title: string;
  body: string;
  link: string | null;
  read: boolean;
  createdAt: string;
};

export type AlertSettings = {
  emails: string[];
  whatsappNumbers: string[];
  events: Record<AlertEvent, boolean>;
};

export type AlertChannels = { email: boolean; whatsapp: boolean };

export type AdminBadges = {
  review: number;
  projects: number;
  leads: number;
  reports: number;
  verification: number;
  support: number;
  unread: number;
};

export type SupportMessage = {
  from: 'user' | 'admin';
  /** Team member's name on admin replies; the user's name otherwise. */
  by: string;
  text: string;
  images: string[];
  at: string;
};

export type SupportTicketSummary = {
  id: string;
  ticketId: string;
  topic: SupportTopic | null;
  subject: string;
  status: SupportStatus;
  property: { id: string; title: string; slug: string } | null;
  lastMessageAt: string;
  createdAt: string;
  /** For the user: a team reply they have not opened. For admins: a user message not opened. */
  unread: boolean;
  user: { id: string; name: string; role: UserRole; companyName: string | null; phone: string };
};

export type SupportTicket = SupportTicketSummary & {
  messages: SupportMessage[];
  resolvedAt: string | null;
};

/** Admin-only extra details about who raised the ticket. */
export type AdminSupportTicket = SupportTicket & {
  userInfo: { email: string; premiumUntil: string | null; verified: boolean } | null;
};

export type AdminSupportCounts = {
  /** Tickets per role for the chosen status ("all" = every role). */
  roles: Record<UserRole | 'all', number>;
  /** Tickets per status for the chosen role ("all" = every status). */
  statuses: Record<SupportStatus | 'all', number>;
  stats: { open: number; inProgress: number; resolved7d: number; avgFirstReplyMins: number | null };
};
