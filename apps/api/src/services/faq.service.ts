import type { z } from 'zod';
import type { Faq as FaqDto, faqCreateSchema, faqUpdateSchema } from '@nexus/shared';
import { Faq } from '../models/misc.models.js';
import { notFound } from '../lib/errors.js';

type FaqLean = Omit<FaqDto, 'id'> & { _id: unknown };
const toDto = (f: FaqLean): FaqDto => ({
  id: String(f._id),
  question: f.question,
  answer: f.answer,
  category: f.category,
  sortOrder: f.sortOrder,
  published: f.published,
  showOnHome: f.showOnHome,
});

export async function listPublicFaqs(opts: { category?: string; home?: boolean }) {
  const f: Record<string, unknown> = { published: true };
  if (opts.category) f.category = opts.category;
  if (opts.home) f.showOnHome = true;
  const rows = await Faq.find(f)
    .sort({ category: 1, sortOrder: 1, createdAt: 1 })
    .lean<FaqLean[]>();
  return rows.map(toDto);
}

export async function listAllFaqs() {
  return (await Faq.find().sort({ category: 1, sortOrder: 1 }).lean<FaqLean[]>()).map(toDto);
}

export async function createFaq(input: z.output<typeof faqCreateSchema>) {
  const doc = await Faq.create(input);
  return toDto(doc.toObject() as unknown as FaqLean);
}

export async function updateFaq(id: string, patch: z.output<typeof faqUpdateSchema>) {
  const doc = await Faq.findByIdAndUpdate(
    id,
    { $set: patch },
    { new: true, runValidators: true },
  ).lean<FaqLean>();
  if (!doc) throw notFound('FAQ not found');
  return toDto(doc);
}

export async function deleteFaq(id: string) {
  const r = await Faq.deleteOne({ _id: id });
  if (!r.deletedCount) throw notFound('FAQ not found');
}
