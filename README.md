# ARCH YT Playlists

An Obsidian plugin that turns a YouTube playlist into a folder of notes, one per video.

Point it at a playlist and it writes a note for every video, carrying the channel, duration, thumbnail, and which playlists the video belongs to. Ask for more and it fills in the description, chapters and transcript. Ask again and it downloads the video, the audio, or both.

The transcript handling is the part that took the most work. YouTube's auto-captions arrive without punctuation, so there is no sentence to break paragraphs on. This splits on **pauses in the cue timing** instead — a gap of 1.4 seconds starts a new paragraph, with a 25-second ceiling for speakers who never stop. A fixed time window ran unrelated points together; the pause-based split separates them.

> **Status:** works, on one machine — macOS on Intel, Obsidian 1.13.4. Windows and Linux are untested, and browser cookie access and tool paths are where they are most likely to differ. Read 1.0.0 as "known to work for its author".

## Requirements

Desktop only. The plugin spawns external programs, which Obsidian mobile cannot do.

| | why |
| --- | --- |
| **yt-dlp** | everything; the plugin can install and self-update a standalone copy |
| **ffmpeg** | extracting audio from a downloaded video |
| **A JavaScript runtime** | YouTube's challenge solver, needed for downloads |

Setup runs automatically on first load. It looks for each tool, fills in the paths, picks the browser whose profile was touched most recently for cookies, and warns if your `yt-dlp` is more than a month old.

## Install

There is no community-store listing. Download the release zip, extract it into `YourVault/.obsidian/plugins/`, and enable **ARCH YT Playlists** under Settings → Community plugins. The folder must keep the name `arch-yt-playlists`.

To upgrade, replace `main.js`, `manifest.json` and the `lib/` folder — your settings survive. Replacing the whole folder wipes `data.json` and your settings with it.

## Syncing

Add playlists in settings — a full URL, a bare playlist ID, or one of the shortcuts `Watch Later`, `Liked`, `History`, `Subscriptions` — then run **Sync all playlists**.

A sync is one fast call. It enumerates the playlist and writes every note immediately; it does **not** fetch transcripts, because that was a per-video pass doing work most videos never need. Run **Fetch details and transcript for this note** on the ones you care about.

Re-syncing is safe. A video already in the vault is not duplicated, and a video that appears in several playlists accumulates them in `yt-playlist` rather than being skipped.

Each note comes out like this:

```yaml
---
dl-ed: false
duration: 22
url: "[Link](https://www.youtube.com/watch?v=...)"
banner: "[[Alex Ziskind — Framework 13 Pro.jpg|Thumbnail]]"
channel: "[[Alex Ziskind]]"
yt-playlist:
  - "[[Sylvie — Framework]]"
tags:
  - youtube-video
---
```

`duration` is whole minutes rounded up, so it sorts. `dl-ed` records whether the media is on disk.

## Downloading media

**Download media for this note** from the command palette, or right-click a note. Select several notes and right-click for a bulk download.

You are asked once what you want — Video + Audio, Video, Audio, or Skip — with a **use this for the rest of this session** checkbox, so a bulk run of fifty asks once.

Some details that matter:

**`dl-ed` is a claim, not evidence.** Whether a download happens is decided by looking for the file on disk. A box you ticked by hand, or one left `true` after you deleted the file, does not stop it. If the file is already there, only the checkbox is corrected.

**Video + Audio is one download.** `bestvideo*+bestaudio` already fetches and merges the audio, so the mp3 is extracted from the merged file locally with ffmpeg rather than downloading the same stream twice. Measured at around 80ms against seconds for a second download, and the quality is identical because it is the same stream.

**Downloads run one at a time**, whatever started them. A bulk run and the keyboard shortcut share one queue, so they cannot overlap and split your bandwidth.

**Only one subtitle track is kept.** `--sub-langs en.*` matches `en`, `en-US`, `en-GB`, `en-orig` and every auto-translated English variant — nine files on some videos. Which tracks exist is not knowable before downloading, so the extras are removed afterwards, keeping the plain language code first and the original-language track next. Turn off *Keep only the best subtitle* if you want them all.

## Where files go

Thumbnails and media each offer the same choices as Obsidian's own attachment setting: vault folder, same folder as the note, a subfolder under it, or a path you name. Both default to a `Materials` subfolder. The media path may be absolute, so downloads can land outside the vault.

## `topic` and hand-sorting

Sync writes `yt-playlist`, `url`, `channel` and `duration` on every run. It writes `topic` **once**, at creation, and never touches it again — so if you sort videos by hand into topics, re-syncing will not undo it. Provenance is refreshed; judgment is left alone.

## Relationship to ARCH After Clipping

They are separate plugins that share no code and no runtime state. The split is by workflow, not by site: After Clipping reacts to one page as you clip it, this handles a playlist at a time on demand.

Notes created here carry a `yt-playlist` property, which After Clipping treats as a claim of ownership and leaves alone. If you use both, keep that property.

## Troubleshooting

Open the developer console with `Cmd/Ctrl+Shift+I`. Everything is logged; there is no verbosity setting, because a log that is off by default is a log nobody has when they need it.

**A sync that seems to hang.** Look for `enumerate finished: exit 0, N bytes`. If that line is missing the call has not returned; if it is there with zero bytes, the playlist came back empty.

**"The page needs to be reloaded"** from yt-dlp means the challenge solver could not be fetched. Downloads pass `--remote-components ejs:github` for this; syncs deliberately do not, because enumeration has no challenge to solve.

## License

MIT. See [LICENSE](LICENSE).
