'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const { vttToTranscript, formatTimestamp } = require('./vtt.js');
const { trimDescription, renderChapters } = require('./describe.js');

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
    const res = await this.plugin.runYtDlp(args, 180000);
    if (res.code !== 0 && !res.stdout.trim()) {
      throw new Error((res.stderr || 'yt-dlp returned nothing').trim().split('\n').slice(-3).join(' '));
    }

    const items = [];
    let playlistTitle = '';
    let playlistId = '';
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
    return { url, playlistTitle, playlistId, items };
  }

  /** Pass 2: full metadata plus subtitle files, one process for the whole set. */
  async hydrate(target, onItem, wantTranscript) {
    const url = resolveSourceTarget(target);
    const subDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clip-archiver-subs-'));
    const args = [
      '--dump-json',
      '--skip-download',
      '--ignore-no-formats-error',
      '--no-warnings',
      '-o',
      path.join(subDir, '%(id)s.%(ext)s'),
    ];
    if (wantTranscript) {
      args.push(
        '--write-auto-subs',
        '--write-subs',
        '--sub-langs',
        this.settings.subtitleLangs || 'en.*',
        '--sub-format',
        'vtt/best'
      );
    }
    args.push(url);

    const res = await this.plugin.runYtDlp(args, 600000);
    // Logged on every path. Without this, "hung", "returned nothing" and
    // "worked fine" were indistinguishable in the console.
    this.plugin.log(
      `enumerate finished: exit ${res.code}, ${(res.stdout || '').length} bytes of stdout`
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

    try {
      fs.rmSync(subDir, { recursive: true, force: true });
    } catch (_) {
      /* temp dir, not worth reporting */
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
  async mergePlaylist(file, playlistName) {
    const link = wikilink(playlistName);
    if (!link) return;
    try {
      await this.plugin.app.fileManager.processFrontMatter(file, (fm) => {
        const current = fm['yt-playlist'];
        const list = Array.isArray(current) ? current.slice() : current ? [current] : [];
        if (!list.includes(link)) {
          list.push(link);
          fm['yt-playlist'] = list;
        }
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
    const topics = (typeof source === 'object' && source.topics) || opts.topics || [];

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
    const playlistName =
      (typeof source === 'object' && source.note) || result.playlistTitle || String(target);
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
    let created = 0, merged = 0, skipped = 0;

    for (const item of result.items) {
      this.plugin.checkAborted();
      if (item.unavailable) { skipped++; continue; }

      const existing = index.get(item.id);
      if (existing) {
        await this.mergePlaylist(existing, playlistName);
        written.push({ name: existing.basename, duration: durationMinutes(item.duration) });
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
            topics,
            thumbnail,
            notePath, // so the banner link can be shortened relative to the note
          })
        );
        written.push({ name: file.basename, duration: durationMinutes(item.duration) });
        created++;
      } catch (e) {
        console.warn('[ArchYTPlaylists] could not create', notePath, e);
      }

      if ((created + merged) % 10 === 0) {
        notice.setMessage(`${created + merged} of ${result.items.length}...`);
      }
    }

    const playlistPath = `${root}/${safeFileName(playlistName)}.md`;
    const body = this.buildPlaylistNote(result, written, topics);
    const existingPlaylist = this.plugin.app.vault.getAbstractFileByPath(playlistPath);
    if (existingPlaylist) await this.plugin.app.vault.process(existingPlaylist, () => body);
    else await this.plugin.app.vault.create(playlistPath, body);

    notice.hide();
    this.plugin.toast(
      `${playlistName}: ${created} new, ${merged} already present, ${skipped} unavailable.`,
      10000
    );
    return { created, merged, skipped, folder, playlistPath };
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

    // Keep the frontmatter exactly as it is; replace only the body.
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
    return { transcript: !!transcript, chapters: !!chapters };
  }

  buildPlaylistNote(result, noteLinks, topics) {
    // 'dl-all' mirrors 'dl-ed' on the video notes: false until every video in the
    // playlist has its media on disk. It is also what ARCH After Clipping looks
    // for to know this note is not its business -- a playlist note carries no
    // yt-playlist property, so without this it was being renamed on every sync.
    const fm = {
      'dl-all': false,
      count: noteLinks.length,
      url: `[Link](${result.url})`,
      topic: (topics || []).map(wikilink).filter(Boolean),
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
  videoIdFromUrl,
  resolveSourceTarget,
  safeFileName,
  buildFrontmatter,
  YT_SHORTCUTS,
};
