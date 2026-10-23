import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import {
  ALL_PROPERTY_TYPES,
  AMENITIES,
  AREA_TYPES,
  AREA_UNITS,
  CATEGORIES,
  FURNISHING_STATUSES,
  LISTING_TYPES,
  LISTING_VISIBILITY,
  MAX_MONEY_INR,
  OWNERSHIP_TYPES,
  PARKING_OPTIONS,
  POSSESSION_STATUSES,
  POSTER_TYPES,
  PREFERRED_TENANTS,
  PROPERTY_STATUSES,
  TRANSACTION_TYPES,
} from '@nexus/shared';

const moneyField = {
  type: Number,
  min: [0, 'Cannot be negative'] as [number, string],
  max: MAX_MONEY_INR,
  validate: {
    validator: (v: unknown) => v === null || v === undefined || Number.isInteger(v),
    message: 'Use whole rupees',
  },
};

const imageSchema = new Schema(
  {
    url: { type: String, required: true, maxlength: 1000 },
    publicId: { type: String, maxlength: 300 },
    alt: { type: String, default: '', maxlength: 160 },
    width: Number,
    height: Number,
    isDemo: { type: Boolean, default: false },
  },
  { _id: false },
);

const propertySchema = new Schema(
  {
    listingType: { type: String, enum: LISTING_TYPES, required: true, default: 'rent' },
    title: { type: String, required: true, trim: true, maxlength: 140 },
    slug: { type: String, required: true, lowercase: true, trim: true, maxlength: 100 },
    description: { type: String, required: true, maxlength: 6000 },
    highlights: { type: [String], default: [] },

    category: { type: String, enum: CATEGORIES, required: true },
    propertyType: { type: String, enum: ALL_PROPERTY_TYPES, required: true },
    status: { type: String, enum: PROPERTY_STATUSES, default: 'draft', required: true },
    listingVisibility: { type: String, enum: LISTING_VISIBILITY, default: 'public' },

    citySlug: { type: String, required: true, lowercase: true },
    cityName: { type: String, required: true },
    localitySlug: { type: String, required: true, lowercase: true },
    localityName: { type: String, required: true },
    state: { type: String, default: '' },
    approvedAddress: { type: String, default: '', maxlength: 200 },
    pincode: { type: String, match: /^\d{6}$/ },
    projectName: { type: String, maxlength: 120 },

    currency: { type: String, default: 'INR', enum: ['INR'], immutable: true },
    /** Monthly rent (rent) or total asking price (sale), in whole rupees. */
    price: { ...moneyField, required: true },
    priceNegotiable: { type: Boolean, default: false },
    maintenanceCharges: { ...moneyField, default: null },
    maintenanceIncluded: { type: Boolean, default: false },
    brokerage: { type: String, maxlength: 120 },

    // Rent
    securityDeposit: { ...moneyField, default: null },
    lockInMonths: { type: Number, min: 0, max: 120, default: null },
    rentalTerms: { type: String, maxlength: 2000 },
    preferredTenants: { type: [String], enum: PREFERRED_TENANTS, default: [] },
    availableFrom: { type: Date, default: null },

    // Sale
    possessionStatus: { type: String, enum: [...POSSESSION_STATUSES, null], default: null },
    possessionDate: { type: Date, default: null },
    transactionType: { type: String, enum: [...TRANSACTION_TYPES, null], default: null },
    ownershipType: { type: String, enum: [...OWNERSHIP_TYPES, null], default: null },
    reraId: { type: String, maxlength: 60 },

    areaValue: { type: Number, required: true, min: 0 },
    areaUnit: { type: String, enum: AREA_UNITS, required: true },
    areaType: { type: String, enum: AREA_TYPES, default: 'carpet' },
    /** Normalised area in sq ft — used for filtering, sorting and price per sq ft. */
    areaSqft: { type: Number, required: true, min: 0 },

    bedrooms: { type: Number, min: 0, max: 20, default: null },
    bathrooms: { type: Number, min: 0, max: 20, default: null },
    balconies: { type: Number, min: 0, max: 20, default: null },
    washrooms: { type: Number, min: 0, max: 50, default: null },
    floorNumber: { type: Number, min: -5, max: 200, default: null },
    totalFloors: { type: Number, min: 0, max: 200, default: null },
    facing: { type: String, maxlength: 30 },
    ageOfPropertyYears: { type: Number, min: 0, max: 200, default: null },

    furnishingStatus: { type: String, enum: FURNISHING_STATUSES, required: true },
    amenities: { type: [String], enum: AMENITIES, default: [] },
    parking: { type: String, enum: PARKING_OPTIONS, default: 'none' },
    suitableFor: { type: [String], default: [] },

    images: { type: [imageSchema], default: [] },
    coverImageIndex: { type: Number, default: 0, min: 0 },

    featured: { type: Boolean, default: false },
    /** Checked by the NEXUS team (site visit / documents). Shown as a badge. */
    verified: { type: Boolean, default: false },
    /** Demo listings are labelled on the site and removable with one command. */
    isDemo: { type: Boolean, default: false },

    /** The website user who posted it; null for listings created by the NEXUS team. */
    postedBy: { type: Schema.Types.ObjectId, ref: 'User', default: null },
    posterType: { type: String, enum: POSTER_TYPES, default: 'nexus' },
    /** Shown to the poster when the team asks for changes. */
    moderationNote: { type: String, maxlength: 1000 },
    submittedAt: { type: Date, default: null },

    /** Private: never returned by public endpoints. */
    ownerReference: { type: String, maxlength: 200 },
    internalNotes: { type: String, maxlength: 4000 },

    seoTitle: { type: String, maxlength: 70 },
    seoDescription: { type: String, maxlength: 170 },

    publishedAt: { type: Date, default: null },
    closedAt: { type: Date, default: null },
    createdBy: { type: Schema.Types.ObjectId, default: null },
    updatedBy: { type: Schema.Types.ObjectId, default: null },
  },
  { timestamps: true, minimize: false },
);

propertySchema.index({ slug: 1 }, { unique: true });
// Primary search path: visible listings filtered by type/category/location, sorted by price or recency.
propertySchema.index({
  status: 1,
  listingVisibility: 1,
  listingType: 1,
  citySlug: 1,
  localitySlug: 1,
  price: 1,
});
propertySchema.index({
  status: 1,
  listingVisibility: 1,
  listingType: 1,
  category: 1,
  publishedAt: -1,
});
propertySchema.index({ status: 1, listingVisibility: 1, citySlug: 1, publishedAt: -1 });
propertySchema.index({ status: 1, listingVisibility: 1, propertyType: 1, price: 1 });
propertySchema.index({ status: 1, featured: 1, publishedAt: -1 });
propertySchema.index({ postedBy: 1, status: 1, updatedAt: -1 });
propertySchema.index({ status: 1, submittedAt: 1 });
propertySchema.index({ isDemo: 1 });
propertySchema.index({ updatedAt: -1 });
propertySchema.index(
  { title: 'text', localityName: 'text', projectName: 'text', description: 'text' },
  {
    weights: { title: 10, projectName: 8, localityName: 6, description: 1 },
    name: 'property_text',
  },
);

export type PropertyAttrs = InferSchemaType<typeof propertySchema>;
export type PropertyDoc = HydratedDocument<PropertyAttrs>;
export const Property = model('Property', propertySchema);
