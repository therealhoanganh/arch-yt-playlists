'use strict';

/**
 * YouTube descriptions are mostly not description. They are a short blurb
 * followed by a timestamp block, a socials block, an affiliate block, and a
 * hashtag pile. yt-dlp returns chapters as structured data, so the timestamp
 * block is pure duplication and the rest is noise.
 */

// A line that is only a timestamp plus a label, e.g. "00:00 Intro" or "1:23:45 - Outro"
const TIMESTAMP_LINE_RE = /^\s*[(\[]?\d{1,2}:\d{2}(?::\d{2})?[)\]]?\s*[-–—:|]?\s*\S/;

// Headings that mark the start of promotional tail content.
const PROMO_HEADINGS = [
  /^\s*(?:my\s+)?(?:gear|setup|equipment|kit)\b/i,
  /^\s*(?:follow|connect with|find)\s+(?:me|us)\b/i,
  /^\s*social(?:s| media| links)?\b/i,
  /^\s*(?:affiliate|discount|promo)\s*(?:links?|codes?)?\b/i,
  /^\s*(?:links?|resources?)\s+mentioned\b/i,
  /^\s*support\s+(?:the\s+)?(?:channel|me|us)\b/i,
  /^\s*(?:sponsor|sponsored by|brought to you by)\b/i,
  /^\s*(?:subscribe|join)\b.{0,40}(?:channel|membership|patreon)/i,
  /^\s*chapters?\s*:?\s*$/i,
  /^\s*timestamps?\s*:?\s*$/i,
  /^#\w+(\s+#\w+)*\s*$/, // a bare hashtag pile
];

const PROMO_URL_RE =
  /(patreon\.com|ko-fi\.com|buymeacoffee|amzn\.to|amazon\.[a-z.]+\/.*tag=|bit\.ly|linktr\.ee|discord\.gg|twitter\.com|x\.com\/|instagram\.com|tiktok\.com|facebook\.com|threads\.net|skillshare|squarespace|nordvpn|brilliant\.org)/i;

function isNoiseLine(line) {
  const t = line.trim();
  if (!t) return false;
  if (TIMESTAMP_LINE_RE.test(t)) return true;
  if (PROMO_URL_RE.test(t)) return true;
  // Divider bars, including box-drawing and full-width characters people paste in.
  if (/^[\-=_*~•·+#>|\u2010-\u2015\u2500-\u257F\u25A0-\u25FF\u2580-\u259F\uFF0D\s]{3,}$/.test(t)) return true;
  if (/^#\w+(\s+#\w+)*$/.test(t)) return true; // hashtag line
  return false;
}

/**
 * @param {string} description raw description from yt-dlp
 * @param {object} opts
 * @param {number} opts.maxLines hard cap on kept lines (0 = no cap)
 * @param {number} opts.maxChars hard cap on characters (0 = no cap)
 * @returns {string} trimmed description
 */
function trimDescription(description, opts = {}) {
  const maxLines = opts.maxLines === undefined ? 20 : opts.maxLines;
  const maxChars = opts.maxChars === undefined ? 1200 : opts.maxChars;

  const lines = String(description || '').replace(/\r\n/g, '\n').split('\n');
  const kept = [];

  for (const line of lines) {
    // Once a promo heading appears, everything after it is tail content.
    if (PROMO_HEADINGS.some((re) => re.test(line))) break;
    if (isNoiseLine(line)) continue;
    kept.push(line);
  }

  // Collapse runs of blank lines left behind by removals.
  const cleaned = [];
  for (const line of kept) {
    if (!line.trim() && (!cleaned.length || !cleaned[cleaned.length - 1].trim())) continue;
    cleaned.push(line.replace(/\s+$/, ''));
  }
  while (cleaned.length && !cleaned[cleaned.length - 1].trim()) cleaned.pop();

  let out = cleaned;
  if (maxLines > 0 && out.length > maxLines) out = out.slice(0, maxLines);
  let text = out.join('\n').trim();
  if (maxChars > 0 && text.length > maxChars) {
    text = text.slice(0, maxChars).replace(/\s+\S*$/, '') + '…';
  }
  return text;
}

/** Renders yt-dlp's structured chapters, which beat parsing the description. */
function renderChapters(chapters, formatTimestamp) {
  if (!Array.isArray(chapters) || !chapters.length) return '';
  return chapters
    .map((c) => `- \`${formatTimestamp(c.start_time || 0)}\` ${String(c.title || '').trim()}`)
    .join('\n');
}

module.exports = { trimDescription, renderChapters, isNoiseLine };
