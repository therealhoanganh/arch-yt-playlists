'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const { vttToTranscript, formatTimestamp } = require('./vtt.js');
const { trimDescription, renderChapters } = require('./describe.js');
const channels = require('./channels.js');
const { encodeWebp } = require('./image.js');

/**
 * Bulk YouTube archiving.
 *
 * IMPORTANT: nothing in lib/ may `require('obsidian')`. That module is injected
 * by Obsidian into the plugin's main.js scope only; a file loaded from disk by
 * plain Node cannot resolve it. Reach the API through `this.plugin` instead.
 *
 * Runs in two passes because they have very different costs:
 *   1. enumerate  — one yt-dlp call, seconds, gives id/title/channel/duration
 *   2. hydrate    — one yt-dlp call over the whole playlist that emits JSON per
 *                   video and writes subtitle files, minutes for a few hundred
 *
 * Notes are written after pass 1 so the vault is useful immediately, then
 * updated in place as pass 2 streams results.
 */

const YT_SHORTCUTS = {
  'watch later': ':ytwatchlater',
  watchlater: ':ytwatchlater',
  wl: ':ytwatchlater',
  liked: ':ytfav',
  favourites: ':ytfav',
  favorites: ':ytfav',
  history: ':ythistory',
  subscriptions: ':ytsubs',
};

function resolveSourceTarget(raw) {
  const t = String(raw || '').trim();
  if (!t) return null;
  const shortcut = YT_SHORTCUTS[t.toLowerCase()];
  if (shortcut) return shortcut;
  if (t.startsWith(':yt')) return t;
  if (/^[A-Za-z0-9_-]{10,}$/.test(t) && !t.includes('/')) {
    return `https://www.youtube.com/playlist?list=${t}`;
  }
  return t;
}

function safeFileName(name, fallback = 'untitled') {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|#^[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 110)
    .trim();
  return cleaned || fallback;
}

function yamlString(value) {
  const s = String(value == null ? '' : value);
  if (!s) return '""';
  if (/^[\w .,\-/]+$/.test(s) && !/^\s|\s$/.test(s)) return s;
  return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildFrontmatter(fields) {
  const lines = ['---'];
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined || value === null || value === '') continue;
    if (Array.isArray(value)) {
      if (!value.length) {
        lines.push(`${key}: []`);
        continue;
      }
      lines.push(`${key}:`);
      for (const item of value) lines.push(`  - ${yamlString(item)}`);
    } else if (typeof value === 'boolean' || typeof value === 'number') {
      lines.push(`${key}: ${value}`);
    } else {
      lines.push(`${key}: ${yamlString(value)}`);
    }
  }
  lines.push('---');
  return lines.join('\n') + '\n';
}

// Whole minutes, rounded up: 10:00 -> 10, 10:01 -> 11. Numeric so it sorts.
function durationMinutes(seconds) {
  const n = Number(seconds);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.ceil(n / 60);
}

// yt-dlp reports upload_date as YYYYMMDD. The dashes matter: an ISO date sorts
// correctly in Bases as a plain string, 20200730 does not read as a date at all.
function isoDate(value) {
  const m = String(value == null ? '' : value).match(/^(\d{4})(\d{2})(\d{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

// "key: value" lines from the default-properties settings. A number or a
// true/false is written as such, anything else as a string; a line with no
// value is ignored, since an empty property would not be written anyway.
function parseDefaults(raw) {
  const out = {};
  for (const line of String(raw || '').split('\n')) {
    const m = line.match(/^\s*([^\s:#][^:]*?)\s*:\s*(.*?)\s*$/);
    if (!m || !m[2]) continue;
    const v = m[2].replace(/^["']|["']$/g, '');
    if (/^-?\d+(\.\d+)?$/.test(v)) out[m[1]] = Number(v);
    else if (v === 'true' || v === 'false') out[m[1]] = v === 'true';
    else out[m[1]] = v;
  }
  return out;
}

// Adds every default the note does not already have. Never changes a value
// that is there: these are starting points for a human to edit, and a sync
// that reset them would be destroying exactly the judgement they hold.
function addMissingDefaults(fm, defaults) {
  let added = false;
  for (const [k, v] of Object.entries(defaults || {})) {
    if (Object.prototype.hasOwnProperty.call(fm, k)) continue;
    fm[k] = v;
    added = true;
  }
  return added;
}

function wikilink(name) {
  const clean = String(name || '').replace(/[[\]|#^]/g, '').trim();
  return clean ? `[[${clean}]]` : '';
}

// No leading '#'. Obsidian's tags property adds it itself, and a stored '#'
// shows up quoted in the YAML. 1.5.0 wrote one deliberately; this reverses that.
function hashTag(t) {
  return String(t || '').replace(/^#+/, '').trim();
}

// The 11-character YouTube id, recovered from whatever shape the url property has.
function videoIdFromUrl(value) {
  const s = String(value == null ? '' : value);
  const m =
    s.match(/[?&]v=([A-Za-z0-9_-]{11})/) ||
    s.match(/youtu\.be\/([A-Za-z0-9_-]{11})/) ||
    s.match(/\/(?:embed|shorts|live)\/([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

class YouTubeBulk {
  constructor(plugin) {
    this.plugin = plugin;
  }

  get settings() {
    return this.plugin.settings;
  }

  log(...args) {
    this.plugin.log('[archive]', ...args);
  }

  /** Pass 1: cheap listing of everything in a playlist. */
  async enumerate(target) {
    const url = resolveSourceTarget(target);
    const args = [
      '--flat-playlist',
      '--dump-json',
      '--ignore-no-formats-error',
      '--no-warnings',
      url,
    ];
    // 10 minutes, not 3: a long playlist legitimately takes minutes, and this
    // is the call that used to hang. Logged on every path, because without it
    // "hung", "returned nothing" and "worked fine" look identical in the console
    // -- the log that says this lived in hydrate(), which nothing called.
    const res = await this.plugin.runYtDlp(args, 600000);
    this.plugin.log(
      `enumerate finished: exit ${res.code}, ${(res.stdout || '').length} bytes of stdout`
    );
    if (res.code !== 0 && !res.stdout.trim()) {
      throw new Error((res.stderr || 'yt-dlp returned nothing').trim().split('\n').slice(-3).join(' '));
    }

    const items = [];
    let playlistTitle = '';
    let playlistId = '';
    let playlistUploader = '';
    for (const line of res.stdout.split('\n')) {
      if (!line.trim()) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (!j.id) continue;
      playlistTitle = playlistTitle || j.playlist_title || j.playlist || '';
      playlistId = playlistId || j.playlist_id || '';
      // YouTube renders the owner as "by Sylvie", so the prefix comes off.
      playlistUploader =
        playlistUploader ||
        String(j.playlist_uploader || j.playlist_channel || '').replace(/^by\s+/i, '').trim();
      // Deleted or private entries come back with no title.
      const unavailable = !j.title || /^\[(Private|Deleted) video\]$/i.test(j.title);
      items.push({
        id: j.id,
        title: unavailable ? `[unavailable ${j.id}]` : j.title,
        url: j.url || `https://www.youtube.com/watch?v=${j.id}`,
        channel: j.channel || j.uploader || '',
        channelUrl: j.channel_url || j.uploader_url || '',
        duration: j.duration || 0,
        unavailable,
      });
    }
    return { url, playlistTitle, playlistId, playlistUploader, items };
  }

  /**
   * Pass 2: full metadata, one process for the whole set.
   * `target` is a playlist, or an array of video addresses to fetch just those.
   * The array form is what makes the date fill cheap: filling three new notes
   * costs three extractions, not a re-run of the entire playlist.
   */
  async hydrate(target, onItem, wantTranscript) {
    const urls = Array.isArray(target) ? target.slice() : [resolveSourceTarget(target)];
    // Only needed to catch subtitle files; without transcripts there is nothing
    // to write, so no temp folder is made and no output template is set.
    const subDir = wantTranscript
      ? fs.mkdtempSync(path.join(os.tmpdir(), 'clip-archiver-subs-'))
      : null;
    const args = [
      '--dump-json',
      '--skip-download',
      '--ignore-no-formats-error',
      '--no-warnings',
    ];
    if (wantTranscript) {
      args.push(
        '-o',
        path.join(subDir, '%(id)s.%(ext)s'),
        '--write-auto-subs',
        '--write-subs',
        '--sub-langs',
        this.settings.subtitleLangs || 'en.*',
        '--sub-format',
        'vtt/best'
      );
    }
    args.push(...urls);

    const res = await this.plugin.runYtDlp(args, 600000);
    // Logged on every path. Without this, "hung", "returned nothing" and
    // "worked fine" were indistinguishable in the console.
    this.plugin.log(
      `hydrate finished: exit ${res.code}, ${(res.stdout || '').length} bytes of stdout`
    );

    let count = 0;
    for (const line of res.stdout.split('\n')) {
      if (!line.trim()) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch (_) {
        continue;
      }
      if (!j.id) continue;
      let transcript = '';
      if (wantTranscript) transcript = this.readTranscript(subDir, j.id);
      count++;
      await onItem(j, transcript);
    }

    if (subDir) {
      try {
        fs.rmSync(subDir, { recursive: true, force: true });
      } catch (_) {
        /* temp dir, not worth reporting */
      }
    }
    if (!count && res.code !== 0) {
      throw new Error((res.stderr || 'no videos returned').trim().split('\n').slice(-3).join(' '));
    }
    return count;
  }

  readTranscript(dir, id) {
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((f) => f.startsWith(id + '.') && f.endsWith('.vtt'));
    } catch (_) {
      return '';
    }
    if (!files.length) return '';
    // Prefer a manual track over an auto-generated one when both landed.
    files.sort((a, b) => (a.includes('auto') ? 1 : 0) - (b.includes('auto') ? 1 : 0));
    try {
      const raw = fs.readFileSync(path.join(dir, files[0]), 'utf8');
      return vttToTranscript(raw, {
        paragraphSeconds: this.settings.transcriptParagraphSeconds,
        gapSeconds: this.settings.transcriptGapSeconds,
      });
    } catch (_) {
      return '';
    }
  }

  /* ---------------- thumbnails ---------------- */

  // YouTube thumbnail URLs are deterministic from the id, so no metadata call.
  // maxres does not exist for every video; hq always does.
  thumbnailCandidates(id) {
    return [
      `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`,
      `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    ];
  }

  fetchBinary(url, hops = 0) {
    return new Promise((resolve, reject) => {
      if (hops > 5) return reject(new Error('too many redirects'));
      const https = require('https');
      const req = https.get(
        url,
        { headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.youtube.com/' } },
        (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            res.resume();
            return resolve(this.fetchBinary(new URL(res.headers.location, url).toString(), hops + 1));
          }
          if (res.statusCode !== 200) {
            res.resume();
            return reject(new Error(`HTTP ${res.statusCode}`));
          }
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve(Buffer.concat(chunks)));
          res.on('error', reject);
        }
      );
      req.on('error', reject);
      req.setTimeout(20000, () => req.destroy(new Error('timed out')));
    });
  }

  async downloadThumbnail(id, folder, stem) {
    // A thumbnail already on disk is reused whatever its extension: ARCH
    // Images Plus converts the .jpg written here to .webp on arrival, so a
    // check for .jpg alone missed it and every re-sync saved "name 1.webp"
    // beside the original.
    const name = safeFileName(stem, id);
    for (const ext of ['.webp', '.jpg', '.jpeg', '.png']) {
      const hit = this.plugin.app.vault.getAbstractFileByPath(`${folder}/${name}${ext}`);
      if (hit) {
        this.log('thumbnail already on disk, kept:', hit.path);
        return hit.path;
      }
    }
    for (const url of this.thumbnailCandidates(id)) {
      try {
        const buf = await this.fetchBinary(url);
        if (!buf || buf.length < 2048) continue; // YouTube's grey placeholder
        const dest = await this.plugin.uniquePath(folder, safeFileName(stem, id) + '.jpg');
        await this.plugin.app.vault.createBinary(
          dest,
          buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
        );
        return dest;
      } catch (e) {
        this.log('thumbnail miss', url, String(e.message));
      }
    }
    return null;
  }

  /* ---------------- note writing ---------------- */

  /** Maps every existing video-id in the vault to its note, for idempotent re-runs. */
  buildIndex() {
    const index = new Map();
    for (const file of this.plugin.app.vault.getMarkdownFiles()) {
      const fm = this.plugin.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!fm) continue;
      const id = videoIdFromUrl(fm.url) || (fm['video-id'] ? String(fm['video-id']) : null);
      if (id) index.set(id, file);
    }
    return index;
  }

  videoNotePath(folder, item, position) {
    const prefix = position ? String(position).padStart(2, '0') + ' - ' : '';
    return `${folder}/${safeFileName(prefix + item.title, item.id)}.md`;
  }

  // Shortest form Obsidian will still resolve, so the property reads as a file
  // name rather than a full path. Falls back to the path if the file is not in
  // the cache yet, which still resolves, just verbosely.
  linkTextFor(vaultPath, sourcePath) {
    try {
      const tf = this.plugin.app.vault.getAbstractFileByPath(vaultPath);
      if (tf) return this.plugin.app.metadataCache.fileToLinktext(tf, sourcePath || '');
    } catch (_) {
      /* older builds */
    }
    return vaultPath;
  }

  buildVideoNote(item, meta, transcript, context) {
    const minutes = durationMinutes(meta?.duration ?? item.duration);
    // 'dl-ed' rather than 'archived': archived reads as "kept for later", and the
    // question here is only whether the media file is on disk. It starts false
    // because sync writes the note long before anything is downloaded.
    const fm = {
      'dl-ed': false,
      duration: minutes,
      url: `[Link](${item.url})`,
      banner: context.thumbnail
        ? `[[${this.linkTextFor(context.thumbnail, context.notePath)}|Thumbnail]]`
        : '',
      channel: wikilink(meta?.channel || item.channel || ''),
      'yt-playlist': (context.playlists || []).map(wikilink).filter(Boolean),
      tags: (this.settings.tags || []).map(hashTag).filter(Boolean),
    };
    // v-rank, status and whatever else the settings name: written on every
    // new note so the property exists to be edited, never touched afterwards.
    addMissingDefaults(fm, parseDefaults(this.settings.videoNoteDefaults));

    const body = [];
    const desc = trimDescription(meta?.description || '', {
      maxLines: this.settings.descriptionMaxLines,
      maxChars: this.settings.descriptionMaxChars,
    });
    if (desc) body.push(desc, '');

    const chapters = renderChapters(meta?.chapters, formatTimestamp);
    if (chapters) body.push('## Chapters', '', chapters, '');

    if (transcript) body.push('## Transcript', '', transcript, '');

    const text = body.join('\n').replace(/\n{3,}/g, '\n\n').trim();
    return buildFrontmatter(this.plugin.applyOrder(fm, this.settings.videoNoteOrder)) +
      (text ? '\n' + text + '\n' : '');
  }

  // A video can sit in several playlists, so re-syncing adds to the list
  // rather than replacing it. Topics are never touched after creation.
  // Also the moment an existing note picks up any default property it is
  // missing -- a default added to the settings after the note was created
  // reaches it on the next sync, in the configured position.
  async mergePlaylist(file, playlistName) {
    const link = wikilink(playlistName);
    if (!link) return;
    const defaults = parseDefaults(this.settings.videoNoteDefaults);
    try {
      await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
        const current = fm['yt-playlist'];
        let list = Array.isArray(current) ? current.slice() : current ? [current] : [];
        // A link written before the name was sanitised (1.4.7) points at a
        // name no note has; it is the same playlist, so it becomes this link.
        list = list.map((e) => {
          const inner = String(e || '').replace(/^\[\[|\]\]$/g, '');
          return inner !== playlistName && wikilink(safeFileName(inner)) === link ? link : e;
        });
        list = list.filter((e, i) => list.indexOf(e) === i);
        if (!list.includes(link)) {
          list.push(link);
          fm['yt-playlist'] = list;
        }
        // 'v-rank' was the default rank property until 1.4.4, on a scale where
        // its default 5 meant "not judged yet". 'rank' replaces it with 0 as
        // never-judged and 5 as very high, so the old values do not carry
        // over: every v-rank becomes rank: 0 and the old value is logged.
        if (Object.prototype.hasOwnProperty.call(fm, 'v-rank')) {
          this.log('renamed v-rank to rank: 0 on', file.path, '(was', JSON.stringify(fm['v-rank']) + ')');
          delete fm['v-rank'];
          fm.rank = 0;
        }
        addMissingDefaults(fm, defaults);
        // The configured tags are added if missing; tags a person added stay.
        // 'youtube-video' was the default until 1.4.0 and is renamed to the
        // current one, since a note carrying it got it from this plugin.
        const wanted = (this.settings.tags || []).map(hashTag).filter(Boolean);
        const had = [].concat(fm.tags ?? []).map(hashTag).filter(Boolean);
        const kept = had.filter((t) => t !== 'youtube-video' || wanted.includes(t));
        const merged = [...kept, ...wanted.filter((t) => !kept.includes(t))];
        if (merged.join('\n') !== had.join('\n')) fm.tags = merged;
        this.plugin.applyOrder(fm, this.settings.videoNoteOrder);
      });
    } catch (e) {
      this.log('could not merge playlist into', file.path, e);
    }
  }

  /* ---------------- orchestration ---------------- */

  // Enumeration only. Description, chapters and transcript are per-note and on
  // demand: fetching them for hundreds of videos up front is what used to stall.
  async run(source, opts = {}) {
    const target = typeof source === 'string' ? source : source.target;

    const notice = this.plugin.notice('Listing videos...', 0);
    let result;
    try {
      result = await this.enumerate(target);
    } catch (e) {
      notice.hide();
      this.plugin.toast(`Could not list that playlist: ${e.message}`, 14000);
      return null;
    }
    if (!result.items.length) {
      notice.hide();
      this.plugin.toast('That playlist came back empty.', 8000);
      return null;
    }

    // The playlist note name is configurable: yt-dlp's title for a shortcut
    // like Watch Later is not what you want to link to.
    // Sanitised here, once, because this one string becomes the folder, the
    // note file and the yt-playlist link on every video note. Sanitising only
    // the file paths left a title with a quote in it -- The Story of
    // "Civilization" -- linked under a name no note had, so the whole
    // playlist download found nothing.
    const playlistName = safeFileName(this.playlistNoteName(
      result,
      target,
      typeof source === 'object' ? source.note : ''
    ));
    // Logged because the name is the note's path, and the yt-playlist links on
    // every video note point at it -- worth being able to see what a template
    // change would produce before it produces it.
    this.log(
      `playlist note name: "${playlistName}" (title "${result.playlistTitle}", owner "${result.playlistUploader || ''}")`
    );
    const root = this.settings.archiveRoot || 'Archive/YouTube';
    const folder = `${root}/${safeFileName(playlistName)}`;
    await this.plugin.ensureFolder(folder);

    let thumbFolder = null;
    if (this.settings.downloadThumbnails) {
      thumbFolder = this.plugin.resolveThumbnailFolder(folder);
      await this.plugin.ensureFolder(thumbFolder);
    }

    const index = this.buildIndex();
    const written = [];
    // Collected here rather than rebuilt from the metadata cache afterwards: a
    // note created a moment ago is not in the cache yet, so the date pass would
    // find nothing for exactly the notes that need it most.
    const noteFiles = new Map();
    let created = 0, merged = 0, skipped = 0;

    for (const item of result.items) {
      this.plugin.checkAborted();
      if (item.unavailable) { skipped++; continue; }

      const existing = index.get(item.id);
      if (existing) {
        await this.mergePlaylist(existing, playlistName);
        written.push({ name: existing.basename, duration: durationMinutes(item.duration) });
        noteFiles.set(item.id, existing);
        merged++;
        continue;
      }

      const stem = safeFileName(this.noteName(item), item.id);

      let thumbnail = null;
      if (thumbFolder) thumbnail = await this.downloadThumbnail(item.id, thumbFolder, stem);

      const notePath = await this.plugin.uniquePath(folder, stem + '.md');
      try {
        const file = await this.plugin.app.vault.create(
          notePath,
          this.buildVideoNote(item, null, '', {
            playlists: [playlistName],
            thumbnail,
            notePath, // so the banner link can be shortened relative to the note
          })
        );
        written.push({ name: file.basename, duration: durationMinutes(item.duration) });
        noteFiles.set(item.id, file);
        created++;
      } catch (e) {
        console.warn('[ArchYTPlaylists] could not create', notePath, e);
      }

      if ((created + merged) % 10 === 0) {
        notice.setMessage(`${created + merged} of ${result.items.length}...`);
      }
    }

    const playlistPath = `${root}/${safeFileName(playlistName)}.md`;
    const body = this.buildPlaylistNote(result, written);
    const existingPlaylist = this.plugin.app.vault.getAbstractFileByPath(playlistPath);
    let playlistFile = existingPlaylist;
    if (existingPlaylist) await this.plugin.app.vault.process(existingPlaylist, () => body);
    else playlistFile = await this.plugin.app.vault.create(playlistPath, body);

    notice.hide();
    this.plugin.toast(
      `${playlistName}: ${created} new, ${merged} already present, ${skipped} unavailable.`,
      10000
    );

    // 'published' is the one field enumeration cannot produce, so it is filled
    // after the notes exist rather than during. Sync itself stays one fast call:
    // the notes are written and usable before this starts, it is abortable, and
    // it is skipped outright when every note already has a date -- which is the
    // normal case on a re-sync, so a repeat sync costs nothing extra.
    if (this.settings.fillDatesAfterSync !== false && playlistFile && noteFiles.size) {
      try {
        await this.plugin.fillPlaylistDates(playlistFile, { byId: noteFiles, auto: true });
      } catch (e) {
        this.log('date fill after sync failed', e);
      }
    }
    return { created, merged, skipped, folder, playlistPath };
  }

  // Mirrors noteName, but for the playlist note. {{channel}} is the playlist's
  // owner rather than any one video's channel.
  //
  // A per-source "Playlist note name" feeds {{title}} rather than replacing the
  // whole name. It exists because yt-dlp's title for a shortcut like Watch Later
  // is not what you want to link to -- that is a better *title*, not a decision
  // to drop the owner. Set the template to '{{title}}' alone for a literal name.
  playlistNoteName(result, target, override) {
    const template = this.settings.playlistNoteNameTemplate || '{{title}}';
    const title =
      String(override || '').trim() ||
      String(result.playlistTitle || '').trim() ||
      String(target || '').trim();
    const channel = String(result.playlistUploader || '').trim();
    if (!title) return channel || String(target);
    if (!channel) return title;
    return template.replace(/\{\{channel\}\}/g, channel).replace(/\{\{title\}\}/g, title);
  }

  // Notes are created with their final name, so there is nothing to rename later.
  noteName(item) {
    const template = this.settings.noteNameTemplate || '{{channel}} \u2014 {{title}}';
    const channel = String(item.channel || '').trim();
    const title = String(item.title || '').trim();
    if (!channel) return title || item.id;
    if (!title) return channel;
    return template.replace(/\{\{channel\}\}/g, channel).replace(/\{\{title\}\}/g, title);
  }

  /** On demand, for one note: description, chapters and transcript. */
  async hydrateOne(file, videoId) {
    const subDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yt-archive-'));
    const args = ['--dump-json', '--skip-download', '--ignore-no-formats-error', '--no-warnings'];
    if (this.settings.transcript) {
      args.push(
        '-o', path.join(subDir, '%(id)s.%(ext)s'),
        '--write-auto-subs', '--write-subs',
        '--sub-langs', this.settings.subtitleLangs || 'en.*',
        '--sub-format', 'vtt/best'
      );
    }
    args.push(`https://www.youtube.com/watch?v=${videoId}`);

    const res = await this.plugin.runYtDlp(args, 180000);
    let meta = null;
    for (const line of res.stdout.split('\n')) {
      if (!line.trim()) continue;
      try { meta = JSON.parse(line); break; } catch (_) { /* keep looking */ }
    }
    const transcript = this.settings.transcript ? this.readTranscript(subDir, videoId) : '';
    try { fs.rmSync(subDir, { recursive: true, force: true }); } catch (_) { /* temp */ }
    if (!meta) throw new Error((res.stderr || 'no metadata').trim().split('\n').slice(-2).join(' '));

    // The body is replaced wholesale. 'published' is the one frontmatter field
    // this pass writes: the date is not in the flat enumeration sync uses, so
    // this is the first point it is known, and it was previously discarded.
    const raw = await this.plugin.app.vault.read(file);
    const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n?/);
    const head = m ? m[0] : '';

    const parts = [];
    const desc = trimDescription(meta.description || '', {
      maxLines: this.settings.descriptionMaxLines,
      maxChars: this.settings.descriptionMaxChars,
    });
    if (desc) parts.push(desc, '');
    const chapters = renderChapters(meta.chapters, formatTimestamp);
    if (chapters) parts.push('## Chapters', '', chapters, '');
    if (transcript) parts.push('## Transcript', '', transcript, '');

    await this.plugin.app.vault.process(
      file, () => head + '\n' + parts.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n'
    );

    const published = isoDate(meta.upload_date);
    if (published) await this.plugin.setFrontmatterFields(file, { published });
    return { transcript: !!transcript, chapters: !!chapters, published };
  }

  buildPlaylistNote(result, noteLinks) {
    // 'dl-all' mirrors 'dl-ed' on the video notes: false until every video in the
    // playlist has its media on disk. It is also what ARCH After Clipping looks
    // for to know this note is not its business -- a playlist note carries no
    // yt-playlist property, so without this it was being renamed on every sync.
    const fm = {
      'dl-all': false,
      count: noteLinks.length,
      url: `[Link](${result.url})`,
      tags: (this.settings.playlistTags || []).map(hashTag).filter(Boolean),
    };
    const body = [
      `${noteLinks.length} video${noteLinks.length === 1 ? '' : 's'}.`,
      '',
      ...noteLinks.map((n, i) => `${i + 1}. [[${n.name}]]${n.duration ? ` · ${n.duration} min` : ''}`),
      '',
    ];
    return buildFrontmatter(this.plugin.applyOrder(fm, this.settings.playlistNoteOrder)) +
      '\n' + body.join('\n');
  }
}

module.exports = {
  YouTubeBulk,
  parseDefaults,
  addMissingDefaults,
  ...channels,
  encodeWebp,
  videoIdFromUrl,
  isoDate,
  resolveSourceTarget,
  safeFileName,
  buildFrontmatter,
  YT_SHORTCUTS,
};
