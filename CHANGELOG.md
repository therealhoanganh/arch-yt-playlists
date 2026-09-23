# Changelog


> **Numbering.** `1.0.0` is the first release meant for anyone other than its author. Everything before it was development and is numbered `0.1.0` upward in the order it happened, with no entries dropped or merged. Those versions were renumbered twice on the way here, so any number you see in an old console log or screenshot will not match this file.

## 1.6.0 — current

- **Playlist notes only.** The playlist commands are renamed *Download media for
  this playlist note* and *Download subtitles for this playlist note* (palette
  and right-click menu), and still show only while a playlist note is open. The
  single-note *Download media for this note* is gone from the palette and the
  right-click menu: a single video note is ARCH After Clipping's, whose four
  *Download … for this note* commands (1.11.0) hand a note of this plugin back
  here with the choice made, so the file still lands in this plugin's media
  folder. The palette had shown two identical *Download media for this note*.
  Selecting several video notes and right-clicking still offers the bulk
  download. No vault had a hotkey on the removed command.
  His words: *"Also change YT playlist 'Dowload media for this note' to 'Dowload media
  for this playlist note', better clarity"*, and then *"only run when in playlist note,
  the reason is we already have after clipping for individual video/note, we're just
  doing bad job at making the two plugins in synergy with each other, please fix
  that!"*

## 1.5.2

- **New command: Download subtitles for every video in this playlist**, also
  on the playlist note's right-click menu. The same run as the media
  command with the Subtitles choice made for it, so it queues like any other
  run and skips videos whose subtitle file is already there.

## 1.5.1

- **A fourth download choice: Subtitles.** Fetches only the subtitle files,
  into the folder the video would go in and under its stem, so a later video
  download finds them there and yt-dlp does not fetch them again. Nothing is
  written to the note — a subtitle is a sidecar and is never linked as the
  media — and the "already downloaded" check for this choice looks for a
  subtitle file, not the media. The extras are pruned to one track as usual.
- **A sync recomputes `dl-all` from disk.** 1.5.0 carried the value across a
  re-sync, which preserved a tick made by hand; the property is meant to be
  evidence, so it is now true only when every video note in the playlist has
  its media on disk at the time of the sync, and false whenever the sync
  created a video note.

## 1.5.0

- **Video quality defaults to 1080p or less.** Best available was the old
  default and took a 4K course down at 4K. A vault that already saved a
  choice keeps it; only fresh installs see the new default.
- **A playlist note keeps its properties across a re-sync, and `dl-all`
  resets only when a video is new.** The note was rebuilt from scratch on
  every sync, so `dl-all` went back to false whether or not anything had
  changed, and any property a person added to the note was lost. Now the
  existing properties come across, the configured tags are added to the
  tags a person gave it, and `dl-all` stays true unless this sync created a
  video note.
- **A single-note download waits its turn like a bulk one.** *Download media
  for this note* went straight to the download queue: nothing said it was
  waiting, and its mode prompt appeared whenever a running bulk let it in,
  ahead of playlists queued earlier. It now goes through the same run queue
  as everything else — mode asked at once, a "Queued" toast, started after
  what is ahead of it.

## 1.4.9

- **Each source row in settings has its own sync button**, so a playlist
  added later can be synced alone instead of re-running every source. The
  button at the bottom is now called *Sync all*; both go through one
  `syncSources(list)`, so they behave the same apart from the list. (A full
  re-sync never duplicates notes — existing videos are matched by id and
  merged — but it does re-enumerate every playlist, which is the slow part.)

## 1.4.8

- **The "media already on disk" check now finds the file.** The `media`
  property is a wikilink by file name, but the check looked the name up as a
  vault path, which only a file at the vault root would satisfy — so it has
  never matched since the first release. Every re-run handed the note to
  yt-dlp again (which skipped the existing file itself, so the cost was a
  process per note rather than a download), and `dl-all` on a playlist note
  could never turn true. The link is now resolved from the note the way
  Obsidian resolves it, so it also survives the media being moved to another
  folder, as long as the file name stays unique.

## 1.4.7

- **The playlist name is sanitised once, where it is decided, so the folder,
  the note file and the `yt-playlist` link on every video note agree.** Only
  the file paths were sanitised before, so a title with a character a file
  name cannot carry — *The Story of "Civilization"* — got a note without the
  quotes and links with them, and *Download media for every video in this
  playlist* reported no video notes linking to it. A re-sync repairs such a
  link on existing notes: an entry that sanitises to the current name is
  replaced by the current link, and duplicates collapse.

## 1.4.6

- **`obsidian://arch-yt-download?vault=…&file=…&mode=…` runs the
  per-playlist download from outside Obsidian.** `file` is the playlist note's
  vault path, `.md` optional; `mode` is `video_and_audio`, `video_only` or
  `audio_only` and replaces the prompt when given, otherwise the prompt shows
  as usual. It exists so several playlists can be queued from a Terminal
  `open` call, or a script, without opening each note. Anything else the URL
  could name is refused with a toast rather than guessed at.

## 1.4.5

- **A bulk download started while another is running is queued, not
  refused.** Every download already went through one queue, so the guard
  only ever spared two progress notices from interleaving — at the price of
  having to come back after each playlist finished to start the next. Now the
  mode is asked at once, a toast says the run is queued, and it starts when
  the running one ends; each run keeps its own notice and summary, and a
  playlist's `dl-all` is judged after its own run completes. Fire the command
  on every course note in a row and walk away.

## 1.4.4

- **The default rank property is `rank: 0`, not `v-rank: 5`.** `rank` is a
  0–5 scale where 0 means never judged and 5 means very high; the old default
  of 5 stood for "not judged yet", so the two do not line up. A re-sync turns
  every `v-rank` on an existing note into `rank: 0` whatever it held, logging
  the old value, rather than carrying a number from one scale into the other.
  A saved defaults setting that is exactly the old text moves to the new one
  on load, and the saved order does the same, so `rank` keeps `v-rank`'s
  position; anything typed stays. The channel defaults placeholder now
  suggests `rank: 0` too.

## 1.4.3

- **Video quality is a dropdown: Best available, 4K, 1440p, 1080p or 720p
  or less.** It was a raw yt-dlp selector in a text box, whose default
  `bestvideo*+bestaudio/best` takes the largest stream there is — a 4K course
  came down at 4K. The choice is stored as `maxHeight` and turned into the
  selector at download time, with the cap on both halves so a video that only
  offers a single combined stream is capped too. A saved selector carrying
  `[height<=N]` for one of those sizes becomes that choice on load; anything
  else becomes Best available, which is what the old default did. Audio is
  untouched: it was never read from that setting, and YouTube serves one or
  two audio streams per video, so there is nothing to choose.

## 1.4.2

- **Default properties for video and channel notes.** New settings taking
  one `key: value` per line — video notes default to `v-rank: 5` and
  `status: Watch Later` — written on every new note so the property is there
  to edit, and added to an existing note that lacks it on the next sync. A
  value already on a note is never changed; these are starting points for a
  human judgement, and a sync that reset them would destroy exactly what they
  hold. Position them with the order setting, whose default already names them.
- **A saved tag list that is exactly `youtube-video` moves to `yt-video`** on
  load, the same rule as the order migration. A re-sync renames that tag on
  existing notes and adds any configured tag a note lacks; tags a person added
  stay.
- **A re-sync no longer saves a second thumbnail.** The check looked for
  `name.jpg`, but ARCH Images Plus converts that to `name.webp` on arrival, so
  it was never found and each re-sync fetched again and wrote `name 1.webp`.
  An existing thumbnail is now reused whatever its image extension.

## 1.4.1

- **Default video note order is now `media, channel, yt-playlist, banner, url,
  dl-ed, v-rank, duration, status, published, tags`** — media first, so the
  player leads the properties panel. A vault whose saved order is exactly the
  old default is moved to the new one on load, since that order was never
  chosen; a customised order is untouched. `v-rank` and `status` are
  hand-added properties: naming them positions them when present and costs
  nothing when not.

## 1.4.0

- **Channel notes.** A *Channels* list in settings — one `@handle` or channel
  URL per line, `#` lines ignored — and a *Sync channels* command that writes
  one note per channel: `url`, `icon`, `banner`, `tags: yt-channel`, nothing
  else. The note is named after the channel, so the `channel: [[Name]]` link
  every video note already carries resolves to it. Metadata comes from one
  yt-dlp call with `--playlist-items 0`, which returns the channel's own facts
  without listing any videos, about 1.5 s a channel. The icon is the largest
  square thumbnail and the banner the widest strip, as YouTube shows them on a
  desktop; both are encoded to WebP at quality 0.90 in-plugin, so the link is
  right the first time rather than waiting for ARCH Images Plus to convert it.
  A channel with no banner set gets no `banner` property and a log line.
- Re-syncing goes through `processFrontMatter`: a property added by hand and
  the body survive, tags are merged rather than replaced, and an image already
  on disk is kept unless *Re-download icons and banners* is on.
- The *Sync one playlist by URL* prompt accepts a channel address too.
- **After Clipping needs its new `otherArchTags` setting** (`yt-channel`) to
  leave these notes alone — a channel note has a `url` and no marker property,
  and yt-dlp given a channel URL downloads the channel. Ships in After
  Clipping's next release.
- **Default video tag is `yt-video`** rather than `youtube-video`, matching
  `yt-channel` and `yt-playlist`. A saved setting is untouched; change it by
  hand if you want the new name.
- The *Video note property order* description now says what the code has
  always done: a hand-added property listed there is placed there.

## 1.3.1

- **The new thumbnail default did not survive a fresh install.** A migration added in 0.14.0 maps a vault predating `thumbnailLocationMode` onto subfolder mode, so nothing moves. It fired whenever the setting was absent from saved data — which includes an install with no saved data at all, where it overwrote the shipped default with `subfolder` and blanked the specified folder. It now runs only when there is a saved config to migrate. A vault that predates the setting still maps to its old subfolder exactly as before.

## 1.3.0

- **Video notes carry `published`**, the video's upload date as `YYYY-MM-DD`. It is not written by sync and cannot be: `--flat-playlist` returns `timestamp` and `release_timestamp` as `null` and has no `upload_date` field, so the date is only available from a full extraction. Making sync pay for that is exactly what 0.6.0 removed.
- **`hydrateOne` writes it.** That pass already fetched full metadata and already had `upload_date` in hand — it was being discarded because the pass deliberately rewrote only the body. The frontmatter is still otherwise untouched; `published` is the single exception.
- **New command: Fill publish dates for this playlist**, also on the playlist note's right-click menu. It wires up `hydrate()`, which has been dead code since 0.6.0 deleted its caller: one yt-dlp process over the whole playlist, emitting full metadata per video. Measured at ~2.3s a video against ~3.3s for one-at-a-time calls. Videos are found the same way the bulk download finds them, by resolving `yt-playlist` links back to the playlist note. A note already holding the correct date is skipped rather than rewritten, so the run does not churn mtimes across the vault.
- **Sync fills the dates once the notes exist.** Enumeration still cannot produce them and still is not asked to — `run()` calls the fill after the notes are written, so a sync is as fast as it was to the point the notes appear. New toggle **Fill publish dates after a sync**, on by default. Sync passes the pass its own id-to-note map rather than letting it be rebuilt from `metadataCache`, because a note created moments earlier is not in the cache yet and the lookup would come back empty for precisely the new notes.
- **Only the notes missing a date are fetched, and by their own addresses.** `hydrate()` now accepts an array of video URLs as well as a playlist. Filling the three videos added to a playlist since last week costs three extractions rather than a re-run of the whole list — at ~2.3s a video that is the difference between seconds and half an hour. A re-sync where nothing is missing makes no yt-dlp call at all.
- **`enumerate()` has the timeout and the logging this file has claimed since 0.12.0.** 0.6.0's restructure left both in `hydrate()`, which nothing called, while the live enumeration ran on a 3-minute ceiling and logged nothing after the command — the exact "hung, empty and fine look identical" problem 0.12.0 was written to fix. Its log line also said `enumerate finished` from inside `hydrate`; that one now says `hydrate finished`.
- **`hydrate()` makes no temp folder when it is not collecting subtitles.**
- **`published` is omitted until it is known**, then slotted into place by the configured order — the same behaviour `media` has after a download, and the reason 1.2.0 rebuilt the whole object on every write.
- **Playlist notes are named from a template**, new setting **Playlist note name**, defaulting to `{{channel}} – {{title}}` — the same shape as the video note name. `{{channel}}` is the playlist's *owner*, from `playlist_uploader`, which YouTube renders as `by Sylvie`, so the prefix is stripped.
- **The per-source playlist note name now feeds `{{title}}`** instead of replacing the whole name. It exists because yt-dlp's title for a shortcut like Watch Later is not what you want to link to — that is a better title, not a decision to drop the owner. A source named `Writing 2` becomes `Sylvie – Writing 2`. Set the template to `{{title}}` alone to get a literal name back.
- **Note: this renames playlist notes.** The name is the note's path, and every video note's `yt-playlist` links to it. A sync after upgrading creates a note at the new path and leaves the old one behind, with the links still pointing at it — and the folder is named from it too. Rename both the playlist note and its folder in Obsidian first, which fixes the links, then sync.
- **The plugin can actually be installed from a release.** `main.js` loaded `lib/archiver.js` from disk at three call sites, but a release delivers only `main.js`, `manifest.json` and `styles.css` — so `lib/` never arrived and the plugin died on load. Every release before this one was uninstallable. `npm run build` now bundles `lib/` into `dist/main.js` with esbuild; the three call sites became one `lib()` accessor that prefers the bundled module and falls back to disk, so the repo still runs unbuilt with no build step.
- **New default locations.** Archive root `YouTube/Playlists`, media in `YouTube/Medias`, thumbnails in `YouTube/Images`, the last two as specified folders rather than a `Materials` subfolder. Existing vaults keep whatever is in `data.json`; this only changes a fresh install.
- **`topic` is gone.** 0.12.0 dropped it from the video template and left the per-source setting behind; it was still writing `topic` on *playlist* notes, so it was not the no-op the notes claimed. Removed in all four places: the playlist property, the `playlistNoteOrder` default, the per-source settings field, and the categories box in the sync-by-URL prompt. `yt-playlist` and `tags` cover the same ground. A stale `topics` key left in `data.json` is ignored; there is no migration.

## 1.2.0

- **Frontmatter order is a setting.** Two of them — **Video note property order** and **Playlist note property order** — each a comma-separated list. A name not on the list is appended rather than dropped, so a property you added by hand survives; a name on the list that the plugin does not produce is skipped, so the setting can reorder and drop but cannot invent. The default puts `yt-playlist` above `channel`, leaving `channel` and `media` adjacent.
- **The order applies to properties added later, too.** `media` is written after a download, and a new key is appended, so it always landed at the bottom below `tags`. The whole object is now rebuilt in the configured order on every write, which replaces the previous fix of shuffling `tags` to the end.

## 1.1.0

## 1.1.0

- **The playlist note template was still on the old scheme.** It wrote `archived: true` and tagged itself `youtube-video`. It now writes `dl-all: false` and tags `youtube-playlist`, from a separate **playlistTags** setting so the two note types can differ.
- **After Clipping stopped renaming playlist notes.** A playlist note carries no `yt-playlist` property, so the ownership check added in After Clipping 0.23.0 never matched it — every sync still renamed `Framework` to `Sylvie — Framework`. `dl-all` is now the second ownership marker, and After Clipping checks for either. Needs After Clipping 1.1.0.
- **New command: Download media for every video in this playlist**, also on the playlist note's right-click menu. The videos are found by resolving each note's `yt-playlist` links back to this note rather than by folder, because a video can belong to several playlists and only one of them is its folder — and link resolution survives a rename where a folder scan would not.
- **`dl-all` is set by checking the disk**, not by assuming the run that just finished worked. If any video still has no media file, it stays false.

## 1.0.0

## 1.0.0

First public release. The entries below record how it got here.

- **Only the best subtitle track is kept.** `--sub-langs en.*` matches `en`, `en-US`, `en-GB`, `en-orig` and every auto-translated English variant, and `--write-subs --write-auto-subs` fetches each one — nine files on some videos. Which tracks exist is not knowable before the download, so the extras are removed afterwards: plain language code first, then the original-language track, then regional variants. The base language follows the subtitle languages setting, so a non-English pattern works the same way. New toggle **Keep only the best subtitle**, on by default.
- `media` is written above `tags` rather than appended below it.

## 0.18.0


- **An empty print file no longer counts as a failed download.** `runMedia` required `--print-to-file` to yield a path, so a download that worked but reported none was surfaced as a failure: `media` went unwritten, `dl-ed` stayed false, and the next run fetched the whole file again. It happens when yt-dlp finds the file already present, skips it, and never fires `after_move` — precisely the case where the property was lost but the file was not. The output folder is now searched for what the template would have named, with subtitle sidecars excluded so a `.vtt` is never linked as the media.
- **Downloads run one at a time, whatever started them.** `bulkDownload` guarded itself but the command and the right-click did not, so pressing the hotkey during a bulk run started a second yt-dlp beside it — split bandwidth, two notices, and on the same note two writes to one output path. Every entry point now goes through one queue, plus a per-note guard so the same note cannot start twice. A failed download does not stall the queue.

## 0.17.0


Filling in what 0.16.0's lean download left out.

- **Thumbnails and media both default to a `Materials` subfolder**, was `thumbnails` and `media`.
- **Subtitles download with the video**, using the same `--write-auto-subs --write-subs --sub-langs --sub-format vtt/best` flags ARCH After Clipping uses and the subtitle languages already configured for transcripts. 0.16.0 omitted them.
- **Media settings actually appear in the settings tab.** 0.16.0 added the settings but no controls for them, so location, quality, audio format and the prompt behaviour were all unreachable — the only way to change where media landed was to edit `data.json`.

## 0.16.0


- **Media download, finally.** New command **Download media for this note**, plus right-click entries on a single note and on a multi-select. The mode prompt matches ARCH After Clipping — Video + Audio, Video, Audio, Skip — with **use this for the rest of this session**, which is asked once and reused for a whole bulk run.
- **`dl-ed` is a claim, not evidence.** Whether a download happens is decided by looking for the file on disk, so a box ticked by hand, or one left true after the file was deleted, does not stop it. If the file is already there, only `dl-ed` is corrected and nothing is fetched.
- **Bulk download runs sequentially.** Ten parallel yt-dlp processes saturate the connection and make failures unreadable. Progress shows in a notice; unloading the plugin stops the loop.
- **`--remote-components ejs:github` is added to download calls only.** Without it YouTube downloads fail with "The page needs to be reloaded". It is deliberately not in `buildFlags`: enumeration has no challenge to solve, so every sync would otherwise fetch the solver for nothing.
- **Video + Audio is one download.** `bestvideo*+bestaudio` already merges the audio, so the mp3 comes from ffmpeg on the merged file rather than a second fetch. Audio-only is staged in a temp folder first, because YouTube's best audio is itself a webm and would land on the video file.
- **Media location has the four modes** — vault folder, same folder as the note, subfolder, or a specified path, absolute paths included.
- **Tags no longer carry a leading `#`.** Obsidian's tags property adds it, and storing one made the YAML come out as `- "#youtube-video"`. This reverses the 0.6.0 decision.

## 0.15.0


- **Banner alias is `Thumbnail`**, not `Banner`. Aliases were confirmed to render correctly in Pretty Properties, so the alias form stays.

## 0.14.0

- **Default archive root is `Playlists`**, was `Archive/YouTube`.
- **`youtube-video` is the default tag.** The tags list shipped empty, so every note came out with `tags: []`.
- **Thumbnails get the five location choices**, matching ARCH After Clipping and Obsidian's own attachment setting: vault folder, same folder as the note, subfolder under the note, a specified folder, or follow Obsidian. Previously the folder was hard-coded to a `thumbnails` subfolder with no way to change it — there was no setting for it at all. An existing vault maps to subfolder mode with whatever name it had, so nothing moves.
- **`banner` is now a short link with an alias:** `[[Name.jpg|Banner]]` rather than the full vault path. The link text comes from `fileToLinktext`, so it is the shortest form Obsidian will still resolve, and falls back to the full path if the file is not in the cache yet.
- **Verbose logging is always on and the toggle is gone.** A log that is off by default is a log nobody has when they need it, which is what happened chasing the enumeration hang.

## 0.13.0


- **`duration` is written again**, second in the frontmatter, directly under `dl-ed`. 0.12.0 dropped it; it is numeric minutes rounded up, which is what lets Bases sort on it. `topic` stays dropped.

## 0.12.0


Template and diagnostics. Media download is not in this release; see the notes below.

- **`archived` is now `dl-ed`, and starts false.** "Archived" reads as *kept for later*, when the only question the field answers is whether the media file is on disk. Sync writes the note long before anything is downloaded, so it is created as `dl-ed: false`. **Note the side effect:** ARCH After Clipping's `processedKey` defaults to `archived`, so every note this plugin created used to be invisible to its automatic pass. That shield is gone — After Clipping will now process these notes unless its folder scope excludes them.
- **`img` is now `banner`, written as `[[file.jpg]]`**, matching the property shape ARCH After Clipping moved to in its own 0.16.0.
- **`duration` and `topic` are no longer written.** (`duration` came back in 0.13.0.) `topic` was the judgment half of the provenance/judgment split, written once and never overwritten. The per-source **topics** setting still exists and now configures nothing — it should go in the next release.
- **Log prefix is `[ArchYTPlaylists]`**, six occurrences, left over from the 0.11.0-era name.
- **Enumeration has a timeout again.** It called `runYtDlp(args, 0)` while every other call site passed 180000, and Node reads `timeout: 0` as never. A hang there could never recover. It is now 600000ms — generous, because a long playlist legitimately takes minutes.
- **Enumeration logs its exit code and stdout size.** Previously nothing was logged after the command, on any path, so "hung", "returned nothing" and "worked perfectly" were indistinguishable in the console.

## 0.11.0


- Copy-from button follows ARCH After Clipping through all five of its previous folder names.
- **Version numbers realigned across both ARCH plugins.** The two had drifted to 5.3.0 and 3.1.0 through separate rename histories, which made "which version am I on" a per-plugin question. They now move together from 0.11.0. See the mapping table above.

## 0.10.0

- **Renamed to ARCH YT Playlists**, folder `arch-yt-playlists`. Settings migrate from `arch-youtube`, `archive-youtube-bulk` and `youtube-archiver`.
- Copy-from button follows ARCH Web Clipper through all its previous folder names.

## 0.9.0

- **Renamed to Arch YouTube**, folder `arch-youtube`. Settings migrate from `archive-youtube-bulk` and `youtube-archiver` automatically.
- Copy-from button follows Arch Clipping through all its old folder names.

## 0.8.0

- **Transcript paragraphs break on real pauses, not a clock.** Auto-captions carry no punctuation, so a gap in the cue timing is the only signal a sentence ended. Cue end times are now captured and a pause of 1.4s starts a new paragraph, with a 25s cap for speakers who never stop. The old fixed 60s window ran three separate points together in testing; the pause-based split separated them correctly.
- **Note name is configurable** via `{{channel}}` and `{{title}}`. There is no rename setting because notes are created with their final name — nothing is renamed after the fact. A video with no channel falls back to the title alone rather than "Unknown — Title".

## 0.7.0

- **Its own tool setup**, no longer dependent on copying from the other plugin. Detects yt-dlp, ffmpeg, a JavaScript runtime and installed browsers per OS; fills in paths; picks the browser whose profile was touched most recently for cookies; flags a yt-dlp build older than 30 days; and installs a self-updating standalone yt-dlp for the right platform and architecture. Runs once automatically on first load. The copy-from-Clippings button is still there as a shortcut.
- Verbose logging on by default.

## 0.6.0

- **Syncing no longer fetches transcripts.** That per-video pass was what stalled after Watch Later finished, and it was doing work most videos don't need. `--flat-playlist` already returns everything the note template requires, so a sync is now one fast call. Description, chapters and transcript moved to a per-note command, **Fetch details and transcript for this note**.
- **New note template**: numeric `duration` in whole minutes rounded up, `url` and `img` as markdown links, `channel` as a wikilink, `yt-playlist` and `topic` as wikilink lists, `tags` with a leading `#`.
- **Thumbnails download into the vault** and `img` points at the saved file. YouTube thumbnail addresses are derivable from the video id, so no metadata call is needed; maxres is tried first with hqdefault as fallback.
- **A video in several playlists accumulates them.** Re-syncing an existing note appends to `yt-playlist` instead of skipping. `topic` is still written once and never overwritten.
- **Playlist note name is configurable per source**, because yt-dlp's title for a shortcut like Watch Later isn't what you want to link to.
- Notes are named `Channel — Title`.
- `video-id` is gone from frontmatter; the id is recovered from the `url` property instead, so dedup still works with a cleaner template.

## 0.5.0

Fixes `Cannot find module 'obsidian'`, which broke every sync.

- **`lib/archiver.js` called `require('obsidian')`.** That module is injected by Obsidian into the plugin's `main.js` scope only; a file loaded from disk by plain Node has no way to resolve it, so the sync failed the moment it tried to show a notice. All notices now route through `plugin.toast()`, and lib carries a comment saying nothing in there may require the API directly.
- **Copy from Archive Clippings Plus** now checks both the new `archive-clippings-plus` folder and the old `clip-archiver` one.

## 0.4.0

Fixes the load failure.

- **`this._children = new Set()` broke the plugin lifecycle.** `Plugin` extends Obsidian's `Component`, which keeps its child components in `this._children` as an **array** and calls `.slice()` on it during unload. Overwriting it with a Set produced `TypeError: this._children.slice is not a function` before onload finished, so the plugin could never be enabled. Renamed to `ytProcs`, along with `_notice` → `activeNotice`, `_archiver` → `archiverModule`, `_running` → `syncing`. No underscore-prefixed property names remain — that namespace belongs to Obsidian.
- Zip now extracts as `archive-youtube-bulk/`, matching the manifest id, so it drops into `.obsidian/plugins/` without renaming.
- Renamed to **Archive YouTube Bulk**; id is `archive-youtube-bulk`.
- Ribbon uses a bundled icon.

## 0.3.0

- Renaming and packaging only; superseded by 0.4.0, which fixes the load failure it shipped with.

## 0.2.0

Hardening for the on-when-needed, off-the-rest-of-the-time usage this plugin is built for.

- **Purges the Node module cache on load and unload.** Obsidian re-reads `main.js` when a plugin is enabled, but `require()` caches by resolved path, so `lib/` modules stayed cached across a disable/enable cycle. An updated `lib/archiver.js` would have silently kept running the previous version. Verified: same file, three loads, `OLD / OLD / NEW` — the middle one is the bug.
- **Added `onunload`**, which the plugin previously lacked entirely. It kills any running yt-dlp process, aborts the sync loop, hides a stuck progress notice, and drops the cached module.
- Child processes are tracked so they can be killed. Disabling mid-sync no longer leaves yt-dlp running orphaned or writes notes into a dead plugin.
- Abort is checked between videos in both passes, so stopping is prompt rather than at the end of the batch.
- An abort is logged, not reported as a failure.
- Progress notices route through the plugin so unload can clear them.

## 0.1.0

Split out of ARCH After Clipping 0.7.0 — then named Archive Clippings Plus, and numbered 3.0.0 at the time — which briefly contained this as a `bulk/` module.

The merge was a mistake. I argued for it on the grounds that bulk could reuse Archive Clippings Plus's `doImages()` and `doTransform()`. It never called either — the actual overlap was `runYtDlp`, `ensureFolder`, and `uniquePath`, about 150 lines of utility. That is not enough shared code to justify one 2900-line file doing two unrelated jobs.

- Standalone plugin with its own yt-dlp runner, settings, and commands.
- **Copy from Archive Clippings Plus** button reads that plugin's saved paths and cookie settings once, so nothing has to be typed twice. Not a live dependency; works with Archive Clippings Plus absent.
- Two-pass sync: fast enumeration writes notes immediately, slower details pass fills them in.
- Transcripts via `--write-auto-subs --skip-download`, with a VTT converter that collapses rolling captions.
- Description trimming: cuts at the first promo heading, drops timestamp lines, affiliate and social URLs, hashtag piles, and divider bars including box-drawing characters.
- Chapters from yt-dlp's structured `chapters` field rather than parsed from prose.
- Idempotent re-runs keyed on `video-id`.
- Playlist shortcuts for Watch Later, Liked, History, Subscriptions.
