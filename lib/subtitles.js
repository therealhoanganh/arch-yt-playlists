'use strict';

// Which subtitle tracks to ask yt-dlp for, and which of the files it writes to
// keep. Pure functions, shared by the transcript (lib/archiver.js) and the
// sidecars saved with a video (main.js's pruneSubtitles).
//
// Two settings drive it. `subtitleLangs` is the main language pattern
// ("en.*"). `alsoSubtitleLangs` names extra languages ("vi") whose track is
// kept only when it is real, because YouTube offers an auto-translation into
// almost any language on almost any video: an English video comes back with
// en, en-orig and a machine-translated vi.
//
// The spoken language is the one with an "-orig" track. YouTube writes
// "<lang>-orig" only for the language its speech recognition heard, never for a
// translation (checked 2026-09-28: an English video gave en, en-orig, vi; a
// Vietnamese one gave en, vi, vi-orig). So an extra language is kept when it is
// the spoken one, and the transcript is taken in the spoken language whenever
// that is the main or an extra language.
//
// Known weakness: a hand-made Vietnamese track on an English video is named
// "vi" like the auto-translation and is dropped with it. Telling them apart
// needs the video's JSON (`subtitles` against `automatic_captions`), which the
// download path does not have.

function baseLang(settings) {
  return String((settings && settings.subtitleLangs) || 'en').replace(/[.*].*$/, '').toLowerCase() || 'en';
}

function extraLangs(settings) {
  return String((settings && settings.alsoSubtitleLangs) || '')
    .split(/[\s,]+/)
    .map((l) => l.replace(/[.*].*$/, '').toLowerCase())
    .filter(Boolean);
}

// The --sub-langs value: the main pattern, plus each extra language and its
// "-orig" track. Only the plain code is asked for, not "vi.*", so regional
// variants of a translation are not fetched as well.
function subLangsArg(settings) {
  const main = (settings && settings.subtitleLangs) || 'en.*';
  const extra = extraLangs(settings).flatMap((l) => [l, `${l}-orig`]);
  return [main, ...extra].join(',');
}

function spokenLang(tracks) {
  const orig = tracks.find((t) => /-orig$/i.test(t.lang));
  return orig ? orig.lang.toLowerCase().replace(/-orig$/, '') : '';
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
 * Returns { keep: [...tracks], transcript: track|null }.
 */
function pickSubtitles(tracks, settings) {
  if (!tracks.length) return { keep: [], transcript: null };
  const base = baseLang(settings);
  const extras = extraLangs(settings);
  const spoken = spokenLang(tracks);

  let main = bestIn(tracks, base);
  if (!main) {
    // No track in the main language: keep what the old single-track rule kept,
    // the first by rank and then by name.
    main = tracks
      .slice()
      .sort((a, b) => rankFor(a.lang, base) - rankFor(b.lang, base) || a.lang.localeCompare(b.lang))[0];
  }
  const keep = [main];
  for (const x of extras) {
    if (x !== spoken) continue;
    const t = bestIn(tracks, x);
    if (t && !keep.includes(t)) keep.push(t);
  }
  let transcript = main;
  if (spoken && spoken !== base && extras.includes(spoken)) transcript = bestIn(tracks, spoken) || main;
  return { keep, transcript };
}

module.exports = { baseLang, extraLangs, subLangsArg, spokenLang, pickSubtitles };
