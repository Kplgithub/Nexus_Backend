/**
 * Idempotent base content: starter FAQs and default site settings. Safe to run
 * repeatedly — existing records are kept. Locations are NOT created here: add
 * them in Admin → Locations (or run `pnpm seed:locations` for sample data).
 *
 * FAQ copy is a starting draft. Review it before launch.
 */
import { Faq, SiteSettings } from '../models/misc.models.js';
import { DEFAULT_SETTINGS } from '../services/settings.service.js';
import { runScript } from './run.js';

const FAQS = [
  {
    category: 'general',
    showOnHome: true,
    question: 'What can I do on NEXUS Estate?',
    answer:
      'Search homes and commercial spaces to buy or rent, save the ones you like, and contact the owner, agent or builder. Owners, agents and builders can create a free account to post their properties.',
  },
  {
    category: 'general',
    showOnHome: true,
    question: 'Which type of account should I choose?',
    answer:
      'Choose “Buyer / Owner / Tenant” if you are looking for a property or want to sell or rent out your own. Choose “Agent” if you list properties for clients, and “Builder” if you are a developer listing projects.',
  },
  {
    category: 'owners',
    showOnHome: true,
    question: 'How do I post my property?',
    answer:
      'Sign up or log in, click “Post Property”, fill in the details and add photos. Our team reviews every listing before it goes live, usually within one working day.',
  },
  {
    category: 'owners',
    showOnHome: false,
    question: 'Will my phone number be shown publicly?',
    answer:
      'No. Your number is never printed on the page. Only signed-in visitors can choose to view it, and you can turn this off in your profile so people contact you through the enquiry form instead.',
  },
  {
    category: 'buyers',
    showOnHome: true,
    question: 'Are the listed prices final?',
    answer:
      'Prices are set by the owner, agent or builder. Listings marked “negotiable” are open to offers. Always confirm the price, charges and documents directly before you commit.',
  },
  {
    category: 'buyers',
    showOnHome: false,
    question: 'What does “Verified” mean?',
    answer:
      'A verified badge on a listing means our team has checked the property details. A verified badge on an agent or builder means we have checked their business details.',
  },
  {
    category: 'tenants',
    showOnHome: false,
    question: 'What documents will I need to rent a home?',
    answer:
      'Owners usually ask for identity and address proof, and sometimes proof of employment or income. Requirements vary, so confirm with the owner or agent for the property you choose.',
  },
  {
    category: 'agents',
    showOnHome: false,
    question: 'Can agents and builders post many properties?',
    answer:
      'Yes. Agent and builder accounts can keep many listings live at once and receive every enquiry in their dashboard. Add your RERA registration in your profile to apply for a verified badge.',
  },
  {
    category: 'commercial',
    showOnHome: false,
    question: 'Can I find offices and shops here?',
    answer:
      'Yes. Use the Commercial filter to find offices, shops, showrooms and co-working spaces for rent or sale, and compare area, parking and power backup.',
  },
] as const;

await runScript('seed:base', async () => {
  if ((await Faq.countDocuments()) === 0) {
    await Faq.insertMany(FAQS.map((f, i) => ({ ...f, sortOrder: i, published: true })));
    console.warn('Created', FAQS.length, 'FAQs');
  }
  await SiteSettings.updateOne(
    { key: 'site' },
    { $setOnInsert: { key: 'site', data: DEFAULT_SETTINGS } },
    { upsert: true },
  );
});
