# Changelog


> **Numbering.** `1.0.0` is the first release meant for anyone other than its author. Everything before it was development and is numbered `0.1.0` upward in the order it happened, with no entries dropped or merged. Those versions were renumbered twice on the way here, so any number you see in an old console log or screenshot will not match this file.

## 1.2.0 — current

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
