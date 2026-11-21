import { Schema, model } from 'mongoose';

/**
 * What visitors typed into the smart search, so the team can see what people
 * want and which words the search does not understand yet. No IP or user id.
 */
const searchLogSchema = new Schema(
  {
    text: { type: String, required: true, maxlength: 200 },
    /** Lower-case, single-spaced: groups "2BHK Vaishali" and "2bhk  vaishali". */
    normalized: { type: String, required: true, maxlength: 200 },
    deal: { type: String, default: null },
    understood: { type: [String], default: [] },
    exactCount: { type: Number, default: 0 },
    resultCount: { type: Number, default: 0 },
    hinglish: { type: Boolean, default: false },
    createdAt: { type: Date, default: () => new Date() },
  },
  { versionKey: false },
);
// Keep six months.
searchLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 86_400 });
searchLogSchema.index({ normalized: 1, createdAt: -1 });
export const SearchLog = model('SearchLog', searchLogSchema);
