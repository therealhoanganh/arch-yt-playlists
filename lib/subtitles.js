'use strict';

// Which subtitle tracks to ask yt-dlp for, and which of the files it writes to
// keep. Pure functions, shared by the transcript (lib/archiver.js) and the
// sidecars saved with a video (main.js's pruneSubtitles).
//
// The rule, his of 2026-10-09 ("Any language"): keep the main language's best
// track (`subtitleLangs`, English by default), and always keep YouTube's
// speech-recognition track in the language the video is spoken in, whatever
// that language is. The transcript is taken in the spoken language.
//
// The spoken language is the video's own `language` field, which yt-dlp prints
// for every video. The "-orig" label alone cannot tell it: on 2026-10-09 a
// Vietnamese video (4zpeu-XTBAQ, language "vi") offered both vi-orig, the
// Vietnamese speech, and en-US-orig, an English translation YouTube also labels
// "Original". Without the field, a lone "-orig" track is taken as the spoken one.
//
// Only "-orig" tracks are asked for beyond the main pattern, never a plain
// "vi": plain "vi" on an English video is a machine translation, which YouTube
// refuses with HTTP 429 (the first download on the PC, 2026-09-28). Before
// 2026-10-09 an extra language had to be named in `alsoSubtitleLangs`; that
// setting is no longer read.

// Subtitle Languages holds one language. A second one typed after a comma (as
// iCanStudy's `en.*,vi.*` and Psycho-history's `en.*,vi*.` were) asks YouTube
// for a machine translation; the spoken-language rule covers what it was meant
// for. These two split the setting so main.js can keep the first and say so.
function langEntries(settings) {
  return String((settings && settings.subtitleLangs) || 'en.*')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function mainPattern(settings) {
  return langEntries(settings)[0] || 'en.*';
}

function baseLang(settings) {
  return mainPattern(settings).replace(/[.*].*$/, '').toLowerCase() || 'en';
}

// The --sub-langs value: the main pattern, plus every "-orig" track.
function subLangsArg(settings) {
  return `${mainPattern(settings)},.*-orig`;
}

// "vi", "en-US" or "" from the video's `language` field; "NA" is yt-dlp's
// placeholder for a missing field.
function normLang(language) {
  const l = String(language || '').trim().toLowerCase();
  return l && l !== 'na' && l !== 'none' ? l.split(/[-_]/)[0] : '';
}

function spokenLang(tracks, language) {
  const fromField = normLang(language);
  if (fromField) return fromField;
  const orig = tracks.filter((t) => /-orig$/i.test(t.lang));
  return orig.length === 1 ? orig[0].lang.toLowerCase().replace(/-orig$/, '').split('-')[0] : '';
}

// Lower is better. The plain code beats a regional variant, and the plain code
// beats "-orig": when a creator uploaded captions, the plain code is theirs.
function rankFor(lang, target) {
  const l = lang.toLowerCase();
  if (l === target) return 0;
  if (l === `${target}-orig`) return 1;
  if (l.startsWith(`${target}-`)) return 2;
  return 3;
}

function bestIn(tracks, target) {
  const hits = tracks
    .filter((t) => rankFor(t.lang, target) < 3)
    .sort((a, b) => rankFor(a.lang, target) - rankFor(b.lang, target) || a.lang.localeCompare(b.lang));
  return hits[0] || null;
}

/**
 * tracks: [{ lang, ... }] as written for one video.
 * language: the video's `language` field, when known.
 * Returns { keep: [...tracks], transcript: track|null }.
 */
function pickSubtitles(tracks, settings, language) {
  if (!tracks.length) return { keep: [], transcript: null };
  const base = baseLang(settings);
  const spoken = spokenLang(tracks, language);

  let main = bestIn(tracks, base);
  if (!main) {
    // No track in the main language: keep the first by rank and then by name.
    main = tracks
      .slice()
      .sort((a, b) => rankFor(a.lang, base) - rankFor(b.lang, base) || a.lang.localeCompare(b.lang))[0];
  }
  const keep = [main];
  let transcript = main;
  if (spoken && spoken !== base) {
    const t = bestIn(tracks, spoken);
    if (t) {
      if (!keep.includes(t)) keep.push(t);
      transcript = t;
    }
  }
  return { keep, transcript };
}

module.exports = { langEntries, mainPattern, baseLang, subLangsArg, normLang, spokenLang, pickSubtitles };
