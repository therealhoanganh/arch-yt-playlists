# ARCH YT Playlists — working notes

An Obsidian plugin that turns a YouTube playlist into a folder of notes, one per
video, with optional description, chapters, transcript, and media download.

Read `CHANGELOG.md` before changing behaviour. It is the reliable record of why
things are the way they are, and it is kept current.

## The most important thing to know

**This plugin is the least tested of the two.** It writes many notes at once, so a
mistake is multiplied. Its note template was rewritten recently and much of the
media download is new. Verify against a real sync on a small playlist, not against
the mock.

## Environment

macOS Intel (`darwin x64`), Obsidian 1.13.4. Desktop only.

- yt-dlp standalone, self-installed; ffmpeg at `/usr/local/bin`
- Cookies from Chrome
- A JavaScript runtime, given by full path

## Things that cost hours to learn

**`--remote-components ejs:github` belongs on download calls only, not in
`buildFlags`.** Downloads fail without it — "The page needs to be reloaded" —
because yt-dlp cannot fetch the challenge solver. But enumeration has no challenge
to solve, so putting it in `buildFlags` makes every sync fetch the solver for
nothing. This looks like an inconsistency worth tidying. It is not.

**Enumeration used to pass `runYtDlp(args, 0)`.** Node reads `timeout: 0` as
*never*, so a hang there could not recover, and nothing was logged after the
command on any path — "hung", "returned nothing" and "worked perfectly" were
indistinguishable in the console. It has a 10-minute ceiling and logs its exit
code and stdout size. Keep both.

Worth knowing how that broke once already: 0.6.0 restructured the two passes and
the fix ended up in `hydrate()`, which nothing called, while the live
`enumerate()` was left on a 3-minute timeout and logged nothing after the
command. This file claimed otherwise for four versions. Restored in 1.3.0.

**`dl-ed` and `dl-all` are claims, not evidence.** Whether a download happens is
decided by looking for the file **on disk**. A box ticked by hand, or one left
true after the file was deleted, does not stop it; a file that is already there
only corrects the property. `dl-all` flips to true only after re-checking every
video. Do not "simplify" these to trust the property.

**Downloads run one at a time through a single queue**, whatever started them —
command, right-click, or bulk run. Without it the keyboard shortcut fired during a
bulk run starts a second yt-dlp beside it, splitting bandwidth and, on the same
note, writing the same output path twice. The queue uses `.then(task, task)` so a
failed download does not stall everything behind it.

**An empty `--print-to-file` result does not mean the download failed.** yt-dlp
skips a file that is already present and never fires `after_move`. Treating that
as failure left `dl-ed` false and re-fetched the whole file next run. The output
folder is searched for what the template would have named, with subtitle sidecars
excluded so a `.vtt` is never linked as the media.

**Only one subtitle track is kept, and this was a considered decision.**
`--sub-langs en.*` matches `en`, `en-US`, `en-GB`, `en-orig` and every
auto-translated variant — nine files on some videos. Which tracks exist is not
knowable before downloading, and there is no native yt-dlp selector for "the best
one"; it is an open problem upstream. So the extras are pruned afterwards.

The known weakness: ranking is by language code, which cannot tell a
creator-written track from an auto-generated one. Querying `--dump-json` first
would fix that, at the cost of an extra call per video. It was considered and
declined. Do not tighten `--sub-langs` to plain `en` as a shortcut — YouTube tags
auto-captions with a region or `-orig`, so the plain form quietly gets nothing.

**Transcript paragraphs break on pauses, not a clock.** Auto-captions carry no
punctuation, so a gap in cue timing is the only signal a sentence ended. 1.4s
starts a new paragraph, with a 25s cap. A fixed 60s window ran three separate
points together in testing.

**`published` cannot come from enumeration, so it is filled afterwards.**
`--flat-playlist` returns `timestamp` and `release_timestamp` as `null` and has no
`upload_date` at all — measured, not assumed. The date needs a full extraction.
Do not add one to `enumerate()`: that is the two-pass sync 0.6.0 removed, and it
is what used to stall on a long playlist.

Instead `run()` calls `fillPlaylistDates` **after** the notes are written, so the
notes exist and are usable before the slow part starts. Setting:
**fillDatesAfterSync**. It is also written free by `hydrateOne`, which already had
`upload_date` in hand.

**That pass fetches only the notes missing a date, by their own addresses** —
`hydrate()` takes either a playlist or an array of video URLs. Do not "simplify"
it back to passing the playlist: at ~2.3s a video, filling the three videos added
since last week would re-extract the entire list.

**Sync hands that pass its own `byId` map and playlist address.** Rebuilding them
from `metadataCache` looks tidier and is wrong: a note created moments earlier is
not in the cache yet, so the lookup comes back empty for exactly the new notes the
pass exists to fill.

**`topic` was removed in 1.3.0.** The old note here claimed the setting configured
nothing; that was wrong. It was still writing `topic` on playlist notes, so removing
it changed behaviour rather than deleting dead code. All four call sites are gone.

## The note templates

Property order is a setting, `videoNoteOrder` and `playlistNoteOrder`. A name not
on the list is appended rather than dropped, so a hand-added property survives; a
name on the list the plugin does not produce is skipped. The whole object is
rebuilt in that order on every write, which is what keeps `media` — added after a
download — from landing at the bottom.

`videoNoteDefaults` and `channelNoteDefaults` are `key: value` lines written on
creation and added to an existing note that lacks them on re-sync — never
overwritten, because `rank: 0` on a note is a person's judgement the moment
they change it. The default order names `rank` and `status` for this reason.

**`rank` is a 0–5 scale: 0 means never judged, 5 means very high.** It was
`v-rank: 5` before 1.4.4, where 5 was the unjudged default, so the two scales do
not line up and a re-sync turns every `v-rank` into `rank: 0`, whatever it held,
logging the old value. Do not carry the old number across.

Four property names are load-bearing and are **not** configurable: `url` (every
lookup), `yt-playlist` (playlist resolution and cross-plugin ownership), `media`
(the disk check), and `dl-ed` / `dl-all` (state). Making them configurable means
threading a setting through about ten call sites.

Videos belonging to a playlist are found by **resolving `yt-playlist` links back
to the playlist note**, not by scanning its folder. A video can belong to several
playlists while living in one folder, and links survive a rename.

## Channel notes

`syncChannels` is the equivalent of ARCH X Twitter's bulk list, and it is
shaped the same way on purpose: a textarea of addresses in settings rather than
rows, a note per channel named after the channel, icon and banner as aliased
wikilinks, hand-added properties carried across. Read that plugin's
`writeProfileNote` before changing this one; they should stay recognisably the
same feature.

**`--playlist-items 0` is what makes a channel cheap.** yt-dlp treats a channel
as a playlist; with no items requested it still returns the channel's own
metadata — `channel`, `uploader_id` (the `@handle`), `channel_follower_count`
and a `thumbnails` list — in about 1.5 s. Without it, a channel with two
thousand videos enumerates two thousand videos.

**Which thumbnail is which.** The list carries the avatar at several square
sizes plus an `avatar_uncropped`, and the banner at several wide sizes plus a
`banner_uncropped`. The uncropped entries have no `width`/`height`. The
uncropped banner is a 16:9 image (2560×1440 on StarTalk) that YouTube crops
differently per device — it is not the banner as seen on the channel page, which
is the widest strip (2560×424). `channelFromJson` takes the largest square and
the widest strip and falls back to the uncropped ones. A channel with no banner
(AI Engineer, at the time of writing) returns only avatar entries.

**Images are encoded to WebP here, not left to ARCH Images Plus.** The note is
written moments after the image; a link written as `.jpg` to a file that
becomes `.webp` a second later is a race. `lib/image.js` is a copy of X
Twitter's, renderer-only (OffscreenCanvas), and Images Plus ignores a file that
is already WebP.

**Channel notes have no marker property, by design** — `url`, `icon`, `banner`,
`tags` and nothing else, matching the hand-made ones. That means After Clipping
cannot recognise them by `otherArchKeys`; it recognises them by tag,
`otherArchTags`, default `yt-channel`. **If the channel tag changes, After
Clipping's setting must change with it**, or every new channel note sends
yt-dlp after the whole channel.

**An existing note goes through `processFrontMatter`**, which keeps every
property it is not told about and never touches the body; tags are merged. The
create path uses `buildFrontmatter`, which skips empty values, so a channel with
no banner simply has no `banner` line.

## Coupling to ARCH After Clipping

Separate plugin, separate repo, no shared code. The split is by workflow —
reactive versus on-demand — not by site. Almost nothing in After Clipping is
YouTube-specific, and moving media handling there would break its main use case.

The one link: this plugin writes `yt-playlist` on video notes and `dl-all` on
playlist notes, and tags channel notes `yt-channel`; After Clipping skips any
note carrying one of those. Before that
existed, After Clipping renamed every note here on every sync — including renaming
the playlist note itself. **If you rename those properties, After Clipping's
`otherArchKeys` setting must change to match.**

## Releasing

`npm run build` writes `dist/main.js` and `dist/manifest.json`. Those two files
are what a release ships; `dist/` is gitignored, since it is output.

A release delivers only `main.js`, `manifest.json` and `styles.css`, so `lib/`
has to travel inside `main.js` — otherwise `main.js` looks for `lib/archiver.js`
in a folder that was never installed and the plugin dies on load. This blocked
every release install until 1.3.0. The build bundles `archiver.js` and the
`vtt.js` and `describe.js` it requires into one expression assigned to
`ARCH_LIB`, prepended to `main.js`.

**`lib()` is the only place `lib/archiver.js` is loaded**, and it takes `ARCH_LIB`
when defined and falls back to reading from disk when it is not. That fallback is
what keeps the repo runnable unbuilt: edit, reload in Obsidian, no build step. Do
not "tidy" it into a single path — losing the fallback costs the edit-and-reload
loop, losing the bundle brings back the load failure.

Verify a release the way it actually installs: copy only `dist/main.js` and
`dist/manifest.json` into a folder with no `lib/`, and load it.

Nothing in `lib/` may `require('obsidian')`. That module is injected into
`main.js`'s scope only; a file loaded from disk by plain Node cannot resolve it.
This already broke every sync once. Notices route through `plugin.toast()`. The
build lists `obsidian` as external so a stray require fails loudly rather than
being quietly inlined.

## Working style that helps

Console logs settle far more than reasoning does. Logging is always on and has no
toggle, deliberately: a log that is off by default is a log nobody has when they
need it.

Two specific traps, both of which have already caused bugs here:

- **Check whether a method already exists before writing one.** A duplicate
  `pruneSubtitles` was added once and silently shadowed the existing, better
  implementation, because a later definition in a class wins. It was only caught
  when a test crashed on the missing helper the original used.
- **A clean test run is not evidence.** The mock has missed five real Obsidian
  APIs. The context menus (`file-menu`, `files-menu`) and the download modal have
  never been exercised by anything but a human clicking them.
## Rewriting history means repointing every tag

If commits are ever rewritten — an author correction, stripping a trailer —
moving `main` is not enough. **A tag is a reference**, so any tag left on an old
commit keeps that commit alive on GitHub, and it keeps whatever was wrong with it
alive too: the old author, the old trailer, the contributor entry derived from
them. This has already caused an afternoon of confusion, where `main` was clean
and the contributors list was not.

The steps, in order:

1. Note which commit each tag points at **before** rewriting, by commit subject —
   the SHAs are about to change.
2. Rewrite, e.g. `git rebase --root --exec '<amend script>'`.
3. Move every local tag onto its new equivalent: `git tag -f <tag> <new sha>`.
4. `git push --force-with-lease origin main`.
5. Repoint each remote tag:
   `gh api --method PATCH repos/<owner>/<repo>/git/refs/tags/<tag> -f sha=<new> -F force=true`
6. Verify no ref is orphaned:
   `gh api repos/<owner>/<repo>/git/refs --jq '.[] | "\(.ref) \(.object.sha)"'`
   — every one should be an ancestor of `main`.

Release assets survive a tag move; they are attached to the release, not the
commit. GitHub's contributors widget is cached separately and lags behind all of
this, so check `git/refs` rather than the web page to know whether the work is
actually done.
