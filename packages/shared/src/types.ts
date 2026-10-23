import type {
  AdminRole,
  Amenity,
  AreaType,
  AreaUnit,
  Category,
  EnquiryStatus,
  EnquiryType,
  FaqCategory,
  FurnishingStatus,
  ListingType,
  OwnershipType,
  ParkingOption,
  PossessionStatus,
  PosterType,
  PreferredTenant,
  PropertyStatus,
  PropertyType,
  SortOption,
  TransactionType,
  UserRole,
  UserStatus,
} from './constants.js';

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
  /** True when a signed-in visitor may reveal this poster's phone number. */
  canRevealPhone: boolean;
  memberSince: string | null;
};

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
> & { posterType: PosterType; imageCount: number };

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
};

export type AdminProperty = OwnListing & {
  listingVisibility: 'public' | 'unlisted';
  ownerReference: string | null;
  internalNotes: string | null;
  postedBy: { id: string; name: string; role: UserRole; email: string; phone: string } | null;
  poster: ListingPoster;
};

export type Locality = {
  name: string;
  slug: string;
  active: boolean;
  intro: string;
  seoTitle?: string;
  seoDescription?: string;
  publishedCount?: number;
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
  };
  allowInternationalEnquiries: boolean;
  /** Admin only. */
  enquiryNotificationEmail?: string;
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
  sourcePage: string | null;
  preferredContactTime: string | null;
  status: EnquiryStatus;
  followUpAt: string | null;
  assignedTo: string | null;
  notes: EnquiryNote[];
  consentAt: string;
  createdAt: string;
  updatedAt: string;
  /** Set when the visitor was signed in. */
  userId: string | null;
  /** Set when the listing belongs to a user (owner/agent/builder). */
  listingOwner: { id: string; name: string } | null;
};

/** An enquiry as seen by the user who posted the listing. */
export type ReceivedLead = Pick<
  Enquiry,
  'id' | 'leadId' | 'type' | 'name' | 'phone' | 'email' | 'message' | 'property' | 'createdAt'
> & { seen: boolean };

/** An enquiry as seen by the visitor who sent it. */
export type SentEnquiry = Pick<
  Enquiry,
  'id' | 'leadId' | 'type' | 'message' | 'property' | 'createdAt'
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
};

export type AdminWebsiteUser = SessionUser & {
  status: UserStatus;
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

export type CategoryInfo = {
  category: Category;
  label: string;
  enabled: boolean;
  types: { value: PropertyType; label: string }[];
};

export type { SortOption };
