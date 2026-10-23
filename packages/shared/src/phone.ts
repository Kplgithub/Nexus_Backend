/**
 * Phone helpers. Indian mobiles are validated strictly; other countries are
 * accepted in E.164 form only when international enquiries are enabled.
 */

const INDIAN_MOBILE = /^[6-9]\d{9}$/;
const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Normalise a user-entered phone number.
 * Returns the number in E.164 form (e.g. "+919521750202") or null when invalid.
 */
export function normalizePhone(input: string, allowInternational = false): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw || raw.length > 25) return null;

  // Keep a leading + and digits only.
  const hasPlus = raw.startsWith('+') || raw.startsWith('00');
  let digits = raw.replace(/\D/g, '');
  if (raw.startsWith('00')) digits = digits.slice(2);

  // Indian forms: 9876543210, 09876543210, 919876543210, +919876543210
  if (!hasPlus && digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10 && INDIAN_MOBILE.test(digits)) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith('91') && INDIAN_MOBILE.test(digits.slice(2))) {
    return `+${digits}`;
  }

  if (allowInternational && hasPlus && !digits.startsWith('91')) {
    const candidate = `+${digits}`;
    if (E164.test(candidate)) return candidate;
  }
  return null;
}

/** Build a wa.me link. `phoneE164` must include the country code. */
export function whatsappLink(phoneE164: string, message?: string): string {
  const digits = phoneE164.replace(/\D/g, '');
  const text = message ? `?text=${encodeURIComponent(message)}` : '';
  return `https://wa.me/${digits}${text}`;
}

/** Format +919521750202 as "+91 95217 50202" for display. */
export function formatIndianPhone(phoneE164: string): string {
  const d = phoneE164.replace(/\D/g, '');
  if (d.length === 12 && d.startsWith('91')) {
    return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
  }
  return phoneE164;
}
