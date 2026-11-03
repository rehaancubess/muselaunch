/** X weighted length (twitter-text v3: most Latin = 1, CJK/emoji = 2, URLs = 23). */
export function xWeightedLength(text: string): number {
  let n = 0;
  const withoutUrls = text.replace(/https?:\/\/\S+/g, () => {
    n += 23;
    return "";
  });
  for (const ch of withoutUrls) {
    const cp = ch.codePointAt(0)!;
    n += cp <= 4351 || (cp >= 8192 && cp <= 8205) || (cp >= 8208 && cp <= 8223) || (cp >= 8242 && cp <= 8247) ? 1 : 2;
  }
  return n;
}
