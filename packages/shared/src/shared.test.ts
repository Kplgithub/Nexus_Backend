import { describe, expect, it } from 'vitest';
import {
  enquiryCreateSchema,
  formatPrice,
  formatRent,
  pricePerSqft,
  signupSchema,
  userPropertyCreateSchema,
  normalizePhone,
  propertyCreateSchema,
  propertySearchSchema,
  slugify,
  toSqft,
  whatsappLink,
} from './index.js';

describe('normalizePhone', () => {
  it.each([
    ['9521750202', '+919521750202'],
    ['09521750202', '+919521750202'],
    ['+91 95217 50202', '+919521750202'],
    ['91-9521750202', '+919521750202'],
    ['0091 9521750202', '+919521750202'],
  ])('accepts Indian mobile %s', (input, expected) => {
    expect(normalizePhone(input)).toBe(expected);
  });

  it.each(['12345', '5521750202', '+91 1234567890', 'abcdefghij', ''])('rejects %s', (input) => {
    expect(normalizePhone(input)).toBeNull();
  });

  it('accepts international numbers only when enabled', () => {
    expect(normalizePhone('+44 7911 123456')).toBeNull();
    expect(normalizePhone('+44 7911 123456', true)).toBe('+447911123456');
  });
});

describe('whatsappLink', () => {
  it('uses digits with country code', () => {
    expect(whatsappLink('+919521750202', 'Hi')).toBe('https://wa.me/919521750202?text=Hi');
  });
});

describe('slugify', () => {
  it('produces clean slugs', () => {
    expect(slugify('2 BHK Flat in Vaishali Nagar, Jaipur!')).toBe(
      '2-bhk-flat-in-vaishali-nagar-jaipur',
    );
    expect(slugify('Shop & Showroom')).toBe('shop-and-showroom');
  });
});

describe('formatting', () => {
  it('formats rent', () => {
    expect(formatRent(25000)).toBe('₹25,000/month');
    expect(formatRent(150000)).toBe('₹1.5 L/month');
  });
  it('formats sale prices in lakh and crore', () => {
    expect(formatPrice(4500000, 'sale')).toBe('₹45 L');
    expect(formatPrice(12500000, 'sale')).toBe('₹1.25 Cr');
    expect(formatPrice(850000, 'sale')).toBe('₹8.5 L');
    expect(formatPrice(18000, 'rent')).toBe('₹18,000/month');
    expect(pricePerSqft(4500000, 1500)).toBe(3000);
  });
  it('converts area', () => {
    expect(toSqft(100, 'sqyd')).toBe(900);
  });
});

describe('propertySearchSchema', () => {
  it('drops invalid values instead of failing', () => {
    const q = propertySearchSchema.parse({
      category: 'castle',
      minPrice: 'abc',
      page: '-4',
      sort: 'x',
    });
    expect(q.category).toBeUndefined();
    expect(q.minPrice).toBeUndefined();
    expect(q.page).toBe(1);
    expect(q.sort).toBe('newest');
  });
  it('swaps inverted price range', () => {
    const q = propertySearchSchema.parse({ minPrice: '30000', maxPrice: '10000' });
    expect(q.minPrice).toBe(10000);
    expect(q.maxPrice).toBe(30000);
  });
  it('keeps possession only for sale searches', () => {
    expect(propertySearchSchema.parse({ possession: 'ready' }).possession).toBeUndefined();
    expect(
      propertySearchSchema.parse({ listingType: 'sale', possession: 'ready' }).possession,
    ).toBe('ready');
  });
  it('drops property types outside the category', () => {
    const q = propertySearchSchema.parse({
      category: 'commercial',
      propertyType: 'office,apartment',
    });
    expect(q.propertyType).toEqual(['office']);
  });
  it('ignores locality without city', () => {
    expect(propertySearchSchema.parse({ locality: 'c-scheme' }).locality).toBeUndefined();
  });
});

const baseProperty = {
  listingType: 'rent',
  title: 'Spacious office near Ashok Marg',
  description: 'A bright, ready-to-move office suitable for a team of fifteen people.',
  category: 'commercial',
  propertyType: 'office',
  citySlug: 'jaipur',
  localitySlug: 'c-scheme',
  price: 60000,
  areaValue: 1200,
  areaUnit: 'sqft',
  furnishingStatus: 'furnished',
} as const;

describe('propertyCreateSchema', () => {
  it('does not require bedrooms for offices', () => {
    expect(propertyCreateSchema.safeParse(baseProperty).success).toBe(true);
  });
  it('requires bedrooms and bathrooms for apartments', () => {
    const r = propertyCreateSchema.safeParse({
      ...baseProperty,
      category: 'residential',
      propertyType: 'apartment',
    });
    expect(r.success).toBe(false);
    const paths = r.error?.issues.map((i) => i.path.join('.'));
    expect(paths).toContain('bedrooms');
    expect(paths).toContain('bathrooms');
  });
  it('rejects negative rent', () => {
    expect(propertyCreateSchema.safeParse({ ...baseProperty, price: -1 }).success).toBe(false);
  });
  it('rejects a type from another category', () => {
    expect(propertyCreateSchema.safeParse({ ...baseProperty, propertyType: 'villa' }).success).toBe(
      false,
    );
  });
  it('rejects publishing without photos', () => {
    expect(propertyCreateSchema.safeParse({ ...baseProperty, status: 'published' }).success).toBe(
      false,
    );
  });
  it('rejects marking a rental as sold', () => {
    expect(
      propertyCreateSchema.safeParse({
        ...baseProperty,
        status: 'sold',
        images: [{ url: 'https://example.com/a.jpg' }],
      }).success,
    ).toBe(false);
  });
  it('strips markup characters', () => {
    const r = propertyCreateSchema.parse({
      ...baseProperty,
      title: 'Office <script>near</script> park',
    });
    expect(r.title).not.toMatch(/[<>]/);
  });
});

describe('enquiryCreateSchema', () => {
  it('requires consent', () => {
    expect(enquiryCreateSchema.safeParse({ name: 'Asha', phone: '9521750202' }).success).toBe(
      false,
    );
    expect(
      enquiryCreateSchema.safeParse({ name: 'Asha', phone: '9521750202', consent: true }).success,
    ).toBe(true);
  });
  it('treats empty email as absent', () => {
    const r = enquiryCreateSchema.parse({
      name: 'Asha',
      phone: '9521750202',
      email: '',
      consent: true,
    });
    expect(r.email).toBeUndefined();
  });
});

describe('userPropertyCreateSchema', () => {
  it('does not let users set admin-only fields', () => {
    expect(userPropertyCreateSchema.safeParse({ ...baseProperty, featured: true }).success).toBe(
      false,
    );
    expect(
      userPropertyCreateSchema.safeParse({ ...baseProperty, status: 'published' }).success,
    ).toBe(false);
    expect(userPropertyCreateSchema.safeParse(baseProperty).success).toBe(true);
  });
});

describe('signupSchema', () => {
  const base = {
    role: 'individual',
    name: 'Asha Verma',
    email: 'asha@example.com',
    phone: '9829012345',
    password: 'secret123',
    acceptTerms: true,
  } as const;
  it('accepts an individual without a company', () => {
    expect(signupSchema.safeParse(base).success).toBe(true);
  });
  it('requires a company name for agents and builders', () => {
    const r = signupSchema.safeParse({ ...base, role: 'agent' });
    expect(r.success).toBe(false);
    expect(r.error?.issues[0]?.path).toEqual(['companyName']);
    expect(
      signupSchema.safeParse({ ...base, role: 'builder', companyName: 'Acme Homes' }).success,
    ).toBe(true);
  });
  it('enforces the password policy and terms', () => {
    expect(signupSchema.safeParse({ ...base, password: 'short' }).success).toBe(false);
    expect(signupSchema.safeParse({ ...base, password: 'lettersonly' }).success).toBe(false);
    expect(signupSchema.safeParse({ ...base, acceptTerms: false }).success).toBe(false);
  });
});
