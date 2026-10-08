# ARCH YT Playlists

## Rules

### What It Is

- An Obsidian plugin that turns a YouTube playlist into a folder of notes, one per video.
- Each note can carry the description, chapters, transcript and the downloaded media. It also writes channel notes.
- Read `CHANGELOG.md` before changing behaviour. It records why each thing is the way it is.
- The old file word for word, with the full reasoning: `Documents/_/AI/arch-yt-playlists/Details.md`.
- It is the less tested of the two downloaders, and it writes many notes at once, so a mistake is multiplied. Check on a real sync of a small playlist, not the mock.

### What Comes First

- Downloaded media is the expensive thing to protect. Notes are cheap, and he tidies them by hand. His words: "they are harder to manage, while clipped notes are easier and I can manually download myself."
- So anything that prevents a second download fails closed: when unsure whether a file was fetched, skip it.
- Nothing deletes a note.

### Videos at Risk of Removal

- A video at risk of removal gets its video file downloaded to 4T-HDD when its note is written, not later. Agreed Sep 28.
- At risk, his three steps: political and sensitive videos (Prof. Jiang's), Vietnamese videos of the kinds that get removed, and fan edits.
- The whole definition, with the kinds of Vietnamese videos he kept: GENERALS `YouTube/YouTube Sorting Strategy.md`, part of his YouTube System. Apply all of it from the start, in any archive, sync or sort.
- Before applying a broad rule to a category, show him the category sorted by kind. "Every Vietnamese video" pulled in 51 videos, 23 hours.

### yt-dlp

- `--remote-components ejs:github` goes on download calls only, never in `buildFlags`. Listing a playlist has no challenge, so it would fetch the solver for nothing.
- Listing a playlist has a 10-minute ceiling and logs its exit code and output size. Keep both. With `timeout: 0` a hang never ended and logged nothing.
- Downloads run one at a time through one queue, whatever started them. The queue uses `.then(task, task)`, so a failure does not stall the rest.
- Whole bulk runs chain the same way (`_bulkChain`). A second playlist waits its turn.
- An empty `--print-to-file` does not mean failure: yt-dlp skips a file already there. The output folder is searched for the expected name, never a `.vtt`.
- `--flat-playlist` gives no date, measured. `fillPlaylistDates` fills `published` after the notes are written (Fill Publish Dates After a Sync).
- That pass fetches only the notes missing a date, by their own addresses. Never pass it the whole playlist: about 2.3 s a video.
- Sync hands that pass its own `byId` map and playlist address. Rebuilt from `metadataCache`, it misses exactly the new notes.
- Never add a full extraction to `enumerate()`. That is the slow two-pass sync 0.6.0 removed.

### Downloaded or Not

- `dl-ed` and `dl-all` are claims, not evidence. The file on disk decides, found by resolving the `media` wikilink from the note.
- A file already there only corrects the property. `dl-all` turns true only after every video is checked again.
- Never simplify this to trusting the property.

### Subtitles and Transcripts

- One subtitle track per language is kept. `en.*` can fetch nine files, and yt-dlp has no "best one" selector, so the extras are pruned after.
- Kept: the main language's best track, plus the track in the language the video is spoken in, whatever it is. His rule, Oct 9: "Any language". The transcript is in the spoken language.
- The spoken language is the video's `language` field, printed with `--print-to-file video:%(language)s`. The "-orig" label alone cannot tell it: a Vietnamese video offered both `vi-orig` and an English `en-US-orig`.
- `--sub-langs` is the main pattern plus `.*-orig`. Never a plain second language: that is a machine translation, and YouTube refuses those with HTTP 429.
- Subtitle Languages holds one language. A second one after a comma is dropped on load, saved and announced.
- Every call that fetches subtitles carries `--ignore-errors`, so a refused track is a warning.
- All of this is `lib/subtitles.js`, copied word for word into After Clipping. Change both together.
- Never tighten `--sub-langs` to plain `en`. YouTube tags auto-captions with a region or `-orig`, so plain `en` gets nothing.
- Known and accepted: ranking by language code cannot tell a creator's track from an automatic one, and a hand-made Vietnamese track is never fetched.
- Transcript paragraphs break on a 1.4 s pause, capped at 25 s. Auto-captions carry no punctuation.

### The Note Templates

- `videoNoteOrder` and `playlistNoteOrder` set the property order. The whole frontmatter is rebuilt in that order on every write.
- A property not on the list is added at the end, never dropped.
- `videoNoteDefaults` and `channelNoteDefaults` are written on creation and added when missing. Never overwritten: `rank: 0` becomes his judgement once he changes it.
- `rank` is 0 to 5, 0 never judged. The old `v-rank` (5 meant unjudged) becomes `rank: 0` on a sync, with the old value logged. Never carry the old number across.
- Not configurable: `url`, `yt-playlist`, `media`, `dl-ed` and `dl-all`. Each is used in about ten places.
- A playlist's videos are found by resolving `yt-playlist` links back to its note, never by its folder. A video can be in several playlists.

### Channel Notes

- `syncChannels` is shaped like ARCH X Twitter's bulk list on purpose. Read X Twitter's `writeProfileNote` before changing it.
- The Channel List is edited as text in a popup behind Manage… (`ListModal`, the same class as X Twitter's).
- `--playlist-items 0` returns a channel's own details in about 1.5 s. Without it, every video is listed.
- `channelFromJson` takes the largest square avatar and the widest banner strip. The uncropped banner is a 16:9 image YouTube crops per device.
- Channel images become WebP here (`lib/image.js`, a copy of X Twitter's). Left to Images Plus, the note's `.jpg` link would race the conversion.
- Channel notes carry only `url`, `icon`, `banner` and `tags`, like his hand-made ones.
- So After Clipping tells them by the tag, `otherArchTags` (`yt-channel`). Change the tag and After Clipping's setting together, or yt-dlp downloads whole channels.
- An existing channel note goes through `processFrontMatter`, which keeps every other property and the body. Tags are merged.

### After Clipping

- No shared code. The split is by workflow: After Clipping reacts to each clip, this plugin works on command.
- After Clipping skips notes with `yt-playlist` or `dl-all`, and channel notes by their tag. Rename one here and change its `otherArchKeys` too.
- Single notes are After Clipping's, playlist notes are this plugin's. His words: "we already have after clipping for individual video/note".
- After Clipping calls `bulkDownload([file], mode)` and `downloadWholePlaylist(file, mode)`. Those names and the mode strings (`video_and_audio`, `video_only`, `audio_only`, `subs_only`) are a contract.

### Videos Outside the Vault

- The plan and the reasons: `backup-strategy/Videos Outside the Vault.md`.
- A video goes under `<setting>/<vault name>/<the folder it would have had in the vault>`. Subtitles and audio stay in the vault.
- `media` is a bare `file:///…` URL from Node's `pathToFileURL`. A markdown link there opens in the web browser.
- A `file:///` video on an unplugged drive counts as downloaded (`mediaOnDisk`). Never simplify this to an existence check: it would download whole playlists again.
- A download to an unplugged drive is refused, and the folder is never created.
- A drive is plugged in when `/Volumes/<name>` has a different device number from `/Volumes`.
- `driveOf` reads `/Volumes/<name>` on any platform. The PC reaches the drive through the same `/Volumes/4T-HDD` link.
- `addDriveLinks` writes `[4T-HDD: <file name>](file:///…)` at the top of the body. It checks only the body for an existing link.
- These are copied word for word in After Clipping. Change both together: `driveOf`, `driveMounted`, `checkMediaExtended`, `addDriveLinks`, `externalVideoFolder`, `keepsVideosInVault`, `videoPlace`, `writeLibraryNote`, `renderPlaceChoice`.
- The link form has two more copies, `file_url` in `backup-strategy/move-videos-out.py` and `relink-videos.py`. Change all four or none.
- A video that falls back into the vault goes to After Clipping's `queueDriveMove`, called by name.
- Never test subtitles by reading the player's text tracks. Look, or ask him to.
- `checkMediaExtended` logs the running version against `TESTED`, 4.2.7. If Media Extended changes version, test playback again.

### Tools

- The plugin finds and installs yt-dlp itself (Set Up External Tools).
- Tool paths are synced, and each computer fills in its own. `localTool` skips a saved yt-dlp, ffmpeg or JavaScript runtime that is missing here or built for the other system, for the one on this computer's PATH. Never save the fallback: the two computers would overwrite each other.
- `runsHere`, `localTool` and `ytDlpBin` are copied word for word in After Clipping.

### Building and Releasing

- `npm run build` writes `dist/main.js` and `dist/manifest.json`. A release ships those two.
- The build inlines `lib/` into `main.js` as `ARCH_LIB`. Without it the installed plugin dies looking for `lib/archiver.js`.
- `lib()` is the only loader of `lib/archiver.js`. It takes `ARCH_LIB` when defined, else reads from disk, which keeps the repo running unbuilt. Keep both paths.
- Check a release as it installs: only `dist/main.js` and `dist/manifest.json` in a folder with no `lib/`, then load it.
- Notices from `lib/` go through `plugin.toast()`.
- Rewriting history means moving every tag too. The steps: `Details.md`, Rewriting History Means Repointing Every Tag.

### Testing

- Before writing a method, check it does not exist. A later definition in a class silently wins.
- A clean mock test run is not evidence. The mock has missed five real Obsidian APIs.
- Only a person has ever used the right-click menus (`file-menu`, `files-menu`) and the download popup.
- `purgeModuleCache` compares real paths and walks `window.require.cache`, Recreations' fix, since 1.9.5. A `lib/` edit takes effect on a plugin reload.

## Mistakes and Lessons

- Sep 29: iCanStudy's `en.*,vi.*` asked for a machine translation, and a Vietnamese video kept only English.
- Oct 9: TESTFIELD's yt-dlp and ffmpeg paths were the PC's, synced to the Mac, and every download there failed with ENOENT.
- 0.6.0 to 1.3.0: the listing fix landed in `hydrate()`, which nothing called. The live `enumerate()` kept a 3-minute timeout, and this file claimed otherwise for four versions.
- Five releases: `media` was looked up as a path and matched nothing. yt-dlp skipping existing files hid it.
- An empty `--print-to-file` was read as failure, so `dl-ed` stayed false and the file was fetched again.
- Until 1.3.0: `lib/` was not inlined, and every release install died on load.
- A `require('obsidian')` in `lib/` broke every sync once.
- 1.3.0: removing `topic` changed behaviour. The old file said the setting did nothing, and it was wrong.
- A duplicate `pruneSubtitles` silently replaced the better original. A test crash on its missing helper caught it.
- Sep 28: plain `vi` failed the first download on the PC with HTTP 429.
- Before 1.9.2: the PC's drive links read ": file.webm", because `driveOf` checked macOS only.
- Sep 28: "every Vietnamese video" was applied literally and made the download list too big.

## Where It Stands

- 1.9.5 is current (Oct 9). In `~/Documents` and 12 vaults through BRAT, checked Oct 9. `~/Documents` has 1.9.5, copied in to check the release.
- The other vaults run 1.9.2 to 1.9.4. BRAT updates each at its next startup.
- Switched off in THOUGHTS and PROJECTS. TESTFIELD has the symlink.
- Psycho-history's Subtitle Languages is `en.*,vi*.`. 1.9.5 trims it to `en.*`, with a notice, the next time that vault opens.
- iCanStudy's Also Keep Subtitles In (`vi`, set Oct 9) is no longer read. *The Hanoi Chamomile* is not synced again yet.
- Planned, not started: more sites than YouTube, and maybe a new name. His words, Sep 24: "download videos with subtitle from Rumble, for MONEY vault… And for other things too, Facebook, X/Twitter."
	- yt-dlp reads Rumble, Facebook and X. The YouTube-only parts are the listing, the note template and channel notes.
	- Unknown: whether Rumble has subtitles. If not, Whisper on the PC.
	- Decide whether X video belongs here or in X Twitter before building it twice.
	- MONEY's videos stay in the vault, so Videos Outside the Vault stays off there.
	- A rename touches the plugin id, every BRAT install and After Clipping's `getPlugin('arch-yt-playlists')`.
