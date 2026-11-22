/**
 * Text helpers for the in-house smart search: Hindi (Devanagari) to Latin,
 * phonetic keys for spelling-tolerant matching, and edit distance.
 * Everything runs on our own server; no text leaves it.
 */

/** Common Hindi words people type in Devanagari, mapped to the English token the parser knows. */
const HINDI_WORDS: [string, string][] = [
  ['फ़्लैट', 'flat'],
  ['फ्लैट', 'flat'],
  ['फ्लेट', 'flat'],
  ['अपार्टमेंट', 'apartment'],
  ['मकान', 'house'],
  ['घर', 'house'],
  ['कोठी', 'house'],
  ['विला', 'villa'],
  ['प्लॉट', 'plot'],
  ['प्लाट', 'plot'],
  ['ज़मीन', 'zameen'],
  ['जमीन', 'zameen'],
  ['फार्म हाउस', 'farmhouse'],
  ['फार्महाउस', 'farmhouse'],
  ['फ़ार्म हाउस', 'farmhouse'],
  ['फ़ार्महाउस', 'farmhouse'],
  ['फार्म', 'farm'],
  ['फ़ार्म', 'farm'],
  ['कृषि भूमि', 'farmland'],
  ['कृषि', 'krishi'],
  ['खेती', 'kheti'],
  ['खेत', 'khet'],
  ['बीघा', 'bigha'],
  ['दुकान', 'shop'],
  ['ऑफ़िस', 'office'],
  ['ऑफिस', 'office'],
  ['दफ्तर', 'office'],
  ['शोरूम', 'showroom'],
  ['गोदाम', 'warehouse'],
  ['पीजी', 'pg'],
  ['हॉस्टल', 'hostel'],
  ['कमरे', 'room'],
  ['कमरा', 'room'],
  ['बीएचके', 'bhk'],
  ['बेडरूम', 'bedroom'],
  ['किराये', 'rent'],
  ['किराए', 'rent'],
  ['किराया', 'rent'],
  ['किराय', 'rent'],
  ['रेंट', 'rent'],
  ['खरीदना', 'buy'],
  ['खरीदें', 'buy'],
  ['ख़रीद', 'buy'],
  ['खरीद', 'buy'],
  ['बिक्री', 'sale'],
  ['बिकाऊ', 'sale'],
  ['से कम', 'under'],
  ['के अंदर', 'under'],
  ['तक', 'tak'],
  ['बजट', 'budget'],
  ['हज़ार', 'hazar'],
  ['हजार', 'hazar'],
  ['लाख', 'lakh'],
  ['करोड़', 'crore'],
  ['करोड', 'crore'],
  ['रुपये', 'rs'],
  ['रुपए', 'rs'],
  ['फर्निश्ड', 'furnished'],
  ['फर्नीश्ड', 'furnished'],
  ['फर्निशड', 'furnished'],
  ['सेमी', 'semi'],
  ['पार्किंग', 'parking'],
  ['गाड़ी', 'car'],
  ['लिफ्ट', 'lift'],
  ['लड़कियों', 'girls'],
  ['लड़कियां', 'girls'],
  ['लड़की', 'girls'],
  ['गर्ल्स', 'girls'],
  ['लड़कों', 'boys'],
  ['लड़के', 'boys'],
  ['बॉयज', 'boys'],
  ['खाना', 'meals'],
  ['भोजन', 'meals'],
  ['परिवार', 'family'],
  ['फैमिली', 'family'],
  ['के पास', 'near'],
  ['नज़दीक', 'near'],
  ['नजदीक', 'near'],
  ['पास', 'near'],
  ['में', 'in'],
  ['मे', 'in'],
  ['सस्ता', 'cheap'],
  ['सस्ते', 'cheap'],
  ['मालिक', 'owner'],
  ['जेडीए', 'jda'],
  ['चाहिए', 'chahiye'],
  ['एक', '1'],
  ['दो', '2'],
  ['तीन', '3'],
  ['चार', '4'],
  ['पांच', '5'],
  ['पाँच', '5'],
  ['जयपुर', 'jaipur'],
  ['मेट्रो', 'metro'],
  ['स्टेशन', 'station'],
  ['अस्पताल', 'hospital'],
  ['कॉलेज', 'college'],
] as [string, string][];
HINDI_WORDS.sort((a, b) => b[0].length - a[0].length);

const CONSONANTS: Record<string, string> = {
  क: 'k',
  ख: 'kh',
  ग: 'g',
  घ: 'gh',
  ङ: 'n',
  च: 'ch',
  छ: 'chh',
  ज: 'j',
  झ: 'jh',
  ञ: 'n',
  ट: 't',
  ठ: 'th',
  ड: 'd',
  ढ: 'dh',
  ण: 'n',
  त: 't',
  थ: 'th',
  द: 'd',
  ध: 'dh',
  न: 'n',
  प: 'p',
  फ: 'ph',
  ब: 'b',
  भ: 'bh',
  म: 'm',
  य: 'y',
  र: 'r',
  ल: 'l',
  व: 'v',
  श: 'sh',
  ष: 'sh',
  स: 's',
  ह: 'h',
  ळ: 'l',
};
const NUKTA: Record<string, string> = { ड: 'r', ढ: 'rh', क: 'q', ख: 'kh', ग: 'g', ज: 'z', फ: 'f' };
const VOWELS: Record<string, string> = {
  अ: 'a',
  आ: 'aa',
  इ: 'i',
  ई: 'ii',
  उ: 'u',
  ऊ: 'uu',
  ऋ: 'ri',
  ए: 'e',
  ऐ: 'ai',
  ओ: 'o',
  औ: 'au',
  ऑ: 'o',
};
const MATRAS: Record<string, string> = {
  'ा': 'aa',
  'ि': 'i',
  'ी': 'ii',
  'ु': 'u',
  'ू': 'uu',
  'ृ': 'ri',
  'े': 'e',
  'ै': 'ai',
  'ो': 'o',
  'ौ': 'au',
  'ॉ': 'o',
};
const VIRAMA = '्';
const NUKTA_SIGN = '़';

/** Rough Devanagari to Latin: good enough for fuzzy-matching place names. */
export function transliterate(s: string): string {
  let out = '';
  const chars = [...s];
  for (let i = 0; i < chars.length; i++) {
    const c = chars[i]!;
    if (CONSONANTS[c]) {
      let sound = CONSONANTS[c]!;
      let j = i + 1;
      if (chars[j] === NUKTA_SIGN) {
        sound = NUKTA[c] ?? sound;
        j++;
      }
      const next = chars[j];
      if (next === VIRAMA) {
        out += sound;
        i = j;
      } else if (next && MATRAS[next]) {
        out += sound + MATRAS[next];
        i = j;
      } else {
        out += sound + 'a';
        i = j - 1;
      }
    } else if (VOWELS[c]) out += VOWELS[c];
    else if (c === 'ं' || c === 'ँ') out += 'n';
    else if (c === 'ः') out += 'h';
    else if (c >= '०' && c <= '९') out += String(c.charCodeAt(0) - '०'.charCodeAt(0));
    else if (c === '।') out += ' ';
    else if (c !== NUKTA_SIGN && c !== VIRAMA) out += c;
  }
  return out;
}

export const hasDevanagari = (s: string) => /[ऀ-ॿ]/.test(s);

/** Lower-case Latin text with Hindi words translated and the rest transliterated. */
export function toLatin(input: string): string {
  let s = input.normalize('NFC');
  if (hasDevanagari(s)) {
    for (const [hi, en] of HINDI_WORDS) s = s.split(hi).join(` ${en} `);
    s = transliterate(s);
  }
  return s.toLowerCase();
}

/**
 * A spelling-tolerant key: "Vaishaali Nagar", "vaishali ngr" and "वैशाली नगर"
 * end up close to each other. Used only for comparison, never shown.
 */
export function phoneticKey(word: string): string {
  return word
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/ph/g, 'f')
    .replace(/(?<=[kgcjtdpb])h/g, '')
    .replace(/sh/g, 's')
    .replace(/ee|ii|y(?=[^aeiou]|$)/g, 'i')
    .replace(/oo|uu/g, 'u')
    .replace(/w/g, 'v')
    .replace(/z/g, 'j')
    .replace(/q|ck/g, 'k')
    .replace(/aa/g, 'a')
    .replace(/(.)\1+/g, '$1')
    .replace(/(?<=[a-z]{3})a$/g, '');
}

/** Classic Levenshtein distance, stopping early once it passes `max`. */
export function editDistance(a: string, b: string, max = 3): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(
        prev[j]! + 1,
        cur[j - 1]! + 1,
        prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length]!;
}

/** How many typos we forgive for a key of this length. */
export const typoAllowance = (len: number) => (len <= 3 ? 0 : len <= 6 ? 1 : len <= 11 ? 2 : 3);

/** Distance in km between two points. */
export function km(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const R = 6371;
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
