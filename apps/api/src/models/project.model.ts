import { Schema, model, type HydratedDocument, type InferSchemaType } from 'mongoose';
import {
  AMENITIES,
  MAX_MONEY_INR,
  PROJECT_STAGES,
  PROJECT_STATUSES,
  PROJECT_UNIT_TYPES,
} from '@nexus/shared';
import { refreshWebsiteOnWrite } from '../lib/web-revalidate.js';

/**
 * A builder's new project (MagicBricks-style "New Projects"). Projects go through the
 * same staff review as listings; resale and rental listings can point at one with
 * `Property.projectId`.
 */
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

const configurationSchema = new Schema(
  {
    unitType: { type: String, enum: PROJECT_UNIT_TYPES, required: true },
    bedrooms: { type: Number, min: 0, max: 10, default: null },
    minAreaSqft: { type: Number, required: true, min: 1 },
    maxAreaSqft: { type: Number, required: true, min: 1 },
    minPrice: { type: Number, required: true, min: 1, max: MAX_MONEY_INR },
    maxPrice: { type: Number, required: true, min: 1, max: MAX_MONEY_INR },
    floorPlanUrl: { type: String, maxlength: 1000 },
  },
  { _id: false },
);

const projectSchema = new Schema(
  {
    name: { type: String, required: true, trim: true, maxlength: 100 },
    slug: { type: String, required: true, lowercase: true, maxlength: 100 },
    description: { type: String, required: true, maxlength: 6000 },
    highlights: { type: [String], default: [] },
    status: { type: String, enum: PROJECT_STATUSES, default: 'draft' },

    citySlug: { type: String, required: true, lowercase: true },
    cityName: { type: String, required: true },
    localitySlug: { type: String, required: true, lowercase: true },
    localityName: { type: String, required: true },
    state: { type: String, default: '' },
    address: { type: String, default: '', maxlength: 200 },
    geo: {
      type: { type: String, enum: ['Point'] },
      coordinates: { type: [Number], default: undefined },
    },

    stage: { type: String, enum: PROJECT_STAGES, required: true },
    launchDate: { type: Date, default: null },
    possessionDate: { type: Date, default: null },
    reraId: { type: String, maxlength: 60 },
    totalUnits: { type: Number, default: null },
    totalTowers: { type: Number, default: null },
    landAreaAcres: { type: Number, default: null },

    configurations: { type: [configurationSchema], default: [] },
    /** Denormalised from configurations for sorting and price filters. */
    minPrice: { type: Number, default: 0 },
    maxPrice: { type: Number, default: 0 },
    unitTypes: { type: [String], default: [] },
    bedroomOptions: { type: [Number], default: [] },

    amenities: { type: [String], enum: AMENITIES, default: [] },
    images: { type: [imageSchema], default: [] },
    coverImageIndex: { type: Number, default: 0, min: 0 },
    brochureUrl: { type: String, maxlength: 1000 },
    videoUrl: { type: String, maxlength: 200 },

    builder: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    featured: { type: Boolean, default: false },
    moderationNote: { type: String, maxlength: 1000 },
    submittedAt: { type: Date, default: null },
    publishedAt: { type: Date, default: null },
    seoTitle: { type: String, maxlength: 70 },
    seoDescription: { type: String, maxlength: 170 },
    isDemo: { type: Boolean, default: false },
    views: { type: Number, default: 0 },
  },
  { timestamps: true, minimize: false },
);

projectSchema.index({ slug: 1 }, { unique: true });
projectSchema.index({ status: 1, citySlug: 1, localitySlug: 1, minPrice: 1 });
projectSchema.index({ status: 1, featured: -1, publishedAt: -1 });
projectSchema.index({ builder: 1, status: 1, updatedAt: -1 });
projectSchema.index({ status: 1, submittedAt: 1 });
projectSchema.index({ geo: '2dsphere' }, { sparse: true });

refreshWebsiteOnWrite(projectSchema, ['projects', 'properties']);

export type ProjectAttrs = InferSchemaType<typeof projectSchema>;
export type ProjectDoc = HydratedDocument<ProjectAttrs>;
export const Project = model('Project', projectSchema);
