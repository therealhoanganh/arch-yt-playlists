'use strict';

/**
 * Converts a yt-dlp auto-generated .vtt into readable text.
 *
 * Auto-captions roll: each cue repeats the previous cue's last line and appends
 * new words, and every word carries an inline <00:00:01.199><c> timing tag. A
 * naive strip produces roughly double the real line count, most of it duplicated.
 */

const CUE_TIME_RE =
  /^(\d{2}:)?\d{2}:\d{2}[.,]\d{3}\s*-->\s*(\d{2}:)?\d{2}:\d{2}[.,]\d{3}/;

function stripInlineTags(line) {
  return line
    .replace(/<\d{2}:\d{2}:\d{2}[.,]\d{3}>/g, '') // word-level timing marks
    .replace(/<\/?c[^>]*>/g, '') // <c> colour spans
    .replace(/<\/?[bius][^>]*>/g, '')
    .replace(/<v[^>]*>/g, '') // voice spans
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function timeToSeconds(stamp) {
  const parts = stamp.replace(',', '.').split(':').map(Number);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] || 0;
}

function formatTimestamp(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/** Parses cues into [{ start, lines }], dropping headers and NOTE blocks. */
function parseCues(vtt) {
  const cues = [];
  const blocks = String(vtt).replace(/\r\n/g, '\n').split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split('\n').filter((l) => l.trim());
    if (!lines.length) continue;
    if (/^WEBVTT/i.test(lines[0]) || /^NOTE\b/i.test(lines[0])) continue;

    const timeIndex = lines.findIndex((l) => CUE_TIME_RE.test(l));
    if (timeIndex === -1) continue;

    const start = timeToSeconds(lines[timeIndex].split('-->')[0].trim().split(' ')[0]);
    const end = timeToSeconds(lines[timeIndex].split('-->')[1].trim().split(' ')[0]);
    const text = lines
      .slice(timeIndex + 1)
      .map(stripInlineTags)
      .filter(Boolean);
    if (text.length) cues.push({ start, end, lines: text });
  }
  return cues;
}

function collapse(cues) {
  const out = [];
  for (const cue of cues) {
    for (const raw of cue.lines) {
      const line = raw.trim();
      if (!line) continue;
      const last = out[out.length - 1];
      if (!last) {
        out.push({ start: cue.start, end: cue.end, text: line });
        continue;
      }
      if (line === last.text) {
        last.end = cue.end;
        continue;
      }
      if (line.startsWith(last.text + ' ')) {
        last.text = line;
        last.end = cue.end;
        continue;
      }
      if (last.text.startsWith(line + ' ')) continue;
      out.push({ start: cue.start, end: cue.end, text: line });
    }
  }
  return out;
}

/**
 * @param {string} vtt raw subtitle file contents
 * @param {object} opts
 * @param {number} opts.paragraphSeconds insert a timestamp roughly this often (0 disables)
 * @returns {string} markdown transcript
 */
function vttToTranscript(vtt, opts = {}) {
  const paragraphSeconds = opts.paragraphSeconds === undefined ? 60 : opts.paragraphSeconds;
  const lines = collapse(parseCues(vtt));
  if (!lines.length) return '';

  if (!paragraphSeconds) {
    return lines.map((l) => l.text).join(' ').replace(/\s+/g, ' ').trim();
  }

  // Break where the speaker actually pauses, not on a fixed clock. Auto-captions
  // carry no punctuation, so a gap in the timing is the only signal of a
  // sentence ending. The duration cap stops an unbroken monologue running away.
  const gapSeconds = opts.gapSeconds === undefined ? 1.4 : opts.gapSeconds;
  const paragraphs = [];
  let current = null;
  let previous = null;
  for (const line of lines) {
    const pause = previous && line.start - previous.end >= gapSeconds;
    const tooLong = current && line.start - current.start >= paragraphSeconds;
    if (!current || tooLong || (pause && line.start - current.start >= 8)) {
      current = { start: line.start, parts: [] };
      paragraphs.push(current);
    }
    current.parts.push(line.text);
    previous = line;
  }

  return paragraphs
    .map((p) => `**${formatTimestamp(p.start)}** ${p.parts.join(' ').replace(/\s+/g, ' ').trim()}`)
    .join('\n\n');
}

module.exports = { vttToTranscript, parseCues, collapse, formatTimestamp, stripInlineTags };
