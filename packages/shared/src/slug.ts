/** Lowercase, ASCII, hyphen-separated slug. Max 90 chars, cut on a word boundary. */
export function slugify(input: string, maxLength = 90): string {
  const base = input
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (base.length <= maxLength) return base;
  const cut = base.slice(0, maxLength);
  const lastHyphen = cut.lastIndexOf('-');
  return (lastHyphen > 20 ? cut.slice(0, lastHyphen) : cut).replace(/-+$/g, '');
}

export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
