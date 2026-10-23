/**
 * Sample Jaipur localities for development, demos and CI. Map centres are
 * approximate (good enough to place a map); correct them in Admin → Locations.
 */
import type { LandmarkKind } from '@nexus/shared';

export type SampleLocality = {
  name: string;
  intro?: string;
  center: { lat: number; lng: number };
  highlights?: string[];
  landmarks?: { name: string; kind: LandmarkKind }[];
};

export const JAIPUR_CENTER = { lat: 26.9124, lng: 75.7873 };

export const JAIPUR_LOCALITIES: SampleLocality[] = [
  {
    name: 'Vaishali Nagar',
    intro:
      'Vaishali Nagar is a large, well-established residential area in west Jaipur with a mix of apartments, builder floors and independent houses, along with busy shopping streets suited to retail and small offices.',
    center: { lat: 26.911, lng: 75.743 },
    highlights: [
      'Gandhi Path and Queens Road shopping',
      'Close to Ajmer Road',
      'Many schools nearby',
    ],
    landmarks: [
      { name: 'Vaishali Nagar market', kind: 'market' },
      { name: 'Gandhi Path', kind: 'market' },
    ],
  },
  {
    name: 'Malviya Nagar',
    intro:
      'Malviya Nagar in south Jaipur combines residential sectors with commercial stretches along its main roads, making it a common choice for both family homes and storefronts.',
    center: { lat: 26.855, lng: 75.815 },
    highlights: [
      'Near MNIT and colleges',
      'Popular for PGs and rentals',
      'World Trade Park nearby',
    ],
    landmarks: [
      { name: 'MNIT Jaipur', kind: 'college' },
      { name: 'World Trade Park', kind: 'mall' },
    ],
  },
  {
    name: 'Jagatpura',
    intro:
      'Jagatpura in south-east Jaipur has seen steady growth in apartment projects and is popular with working professionals and students looking for newer housing.',
    center: { lat: 26.825, lng: 75.865 },
    highlights: [
      'Many new apartment projects',
      'Jagatpura railway station',
      'Close to universities',
    ],
    landmarks: [{ name: 'Jagatpura railway station', kind: 'railway' }],
  },
  {
    name: 'C-Scheme',
    intro:
      'C-Scheme is one of central Jaipur’s best-known addresses, with offices, showrooms and premium residences close to key roads such as Ashok Marg and Prithviraj Road.',
    center: { lat: 26.908, lng: 75.8 },
    highlights: ['Central business district', 'Premium residences', 'Close to MI Road'],
  },
  { name: 'Mansarovar', center: { lat: 26.87, lng: 75.76 } },
  { name: 'Raja Park', center: { lat: 26.898, lng: 75.83 } },
  { name: 'Bani Park', center: { lat: 26.93, lng: 75.795 } },
  { name: 'Tonk Road', center: { lat: 26.84, lng: 75.8 } },
  { name: 'Civil Lines', center: { lat: 26.905, lng: 75.785 } },
  { name: 'Durgapura', center: { lat: 26.85, lng: 75.795 } },
  { name: 'Ajmer Road', center: { lat: 26.89, lng: 75.73 } },
  { name: 'Jawahar Nagar', center: { lat: 26.893, lng: 75.825 } },
  { name: 'Sodala', center: { lat: 26.9, lng: 75.775 } },
  { name: 'Nirman Nagar', center: { lat: 26.885, lng: 75.755 } },
  { name: 'Sitapura', center: { lat: 26.78, lng: 75.845 } },
  { name: 'Jhotwara', center: { lat: 26.95, lng: 75.74 } },
  { name: 'Pratap Nagar', center: { lat: 26.8, lng: 75.82 } },
  { name: 'Sanganer', center: { lat: 26.82, lng: 75.79 } },
];
