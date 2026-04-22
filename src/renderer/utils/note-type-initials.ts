const KNOWN: Record<string, string> = {
  markdown: "MD",
  mdx: "MX",
  text: "RT",
  code: "CD",
  pdf: "PDF",
  image: "IM",
  video: "VD",
  audio: "AU",
};

/** Two-character type label for sidebar rows. */
export function noteTypeInitials(type: string): string {
  const k = KNOWN[type];
  if (k) {
    return k;
  }
  const alnum = type.replace(/[^a-zA-Z0-9]/g, "");
  if (alnum.length >= 2) {
    return alnum.slice(0, 2).toUpperCase();
  }
  if (alnum.length === 1) {
    return `${alnum.toUpperCase()}·`;
  }
  return "··";
}
