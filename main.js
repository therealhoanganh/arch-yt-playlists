'use strict';

const { Plugin, PluginSettingTab, Setting, Notice, Modal, TFile, TFolder, normalizePath, requestUrl } = require('obsidian');
const { execFile } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Video sizes offered by the quality dropdown; 0 means no cap.
const HEIGHT_OPTIONS = [0, 2160, 1440, 1080, 720];

// The yt-dlp selector for a height cap. Both halves carry the cap so a video
// that only offers a single combined stream is capped too.
function videoFormat(maxHeight) {
  const h = Number(maxHeight) || 0;
  const cap = h ? `[height<=${h}]` : '';
  return `bestvideo*${cap}+bestaudio/best${cap}`;
}

const DEFAULT_SETTINGS = {
  // where notes land
  archiveRoot: 'YouTube/Playlists',
  tags: ['yt-video'],
  playlistTags: ['youtube-playlist'],

  // Frontmatter order, as a plain list. A name not in the list is appended, and
  // a name listed but not produced is skipped, so editing this can reorder or
  // drop a property but cannot invent one.
  // media first, so the player is the first thing in the properties panel;
  // rank and status are hand-added on the notes this was modelled on, and
  // naming them here positions them when present and costs nothing when not.
  videoNoteOrder: 'media, channel, yt-playlist, banner, url, dl-ed, rank, duration, status, published, tags',
  playlistNoteOrder: 'dl-all, count, url, tags',
  // "key: value" per line, written on every new note so the property exists
  // to be edited, and added to an existing note that lacks it on the next
  // sync. A value already on a note is never changed.
  videoNoteDefaults: 'rank: 0\nstatus: Watch Later',
  channelNoteDefaults: '',
  sources: [{ target: 'Watch Later', note: 'Watch Later' }],

  // Channel notes. The list is a plain block of text, one channel per line,
  // the way ARCH X Twitter keeps its bulk list: rows per channel would make
  // the tab unusable at a hundred channels.
  channelList: '',
  channelListOpen: false,
  channelTags: ['yt-channel'],
  channelNoteOrder: 'url, icon, banner, tags',
  channelLocationMode: 'specified', // vault | root | subfolder | specified
  channelSubfolder: 'Channels',
  channelFolder: 'YouTube/Channels',
  channelImageLocationMode: 'subfolder', // vault | same | subfolder | specified
  channelImageSubfolder: 'Images',
  channelImageFolder: '',
  channelIconTemplate: '{{channel}} Icon',
  channelBannerTemplate: '{{channel}} Banner',
  channelImageFormat: 'webp', // webp | keep
  refreshChannelImages: false,

  // what to fetch
  transcript: true,
  downloadThumbnails: true,
  // Same choices as Obsidian's "Default location for new attachments".
  thumbnailLocationMode: 'specified', // obsidian | vault | same | subfolder | specified
  thumbnailSubfolder: 'Materials',
  thumbnailFolder: 'YouTube/Images',
  subtitleLangs: 'en.*',
  transcriptParagraphSeconds: 25,
  transcriptGapSeconds: 1.4,
  noteNameTemplate: '{{channel}} \u2014 {{title}}',
  playlistNoteNameTemplate: '{{channel}} \u2013 {{title}}',
  fillDatesAfterSync: true,
  descriptionMaxLines: 20,
  descriptionMaxChars: 1200,

  // media download
  mediaLocationMode: 'specified', // vault | same | subfolder | specified
  mediaSubfolder: 'Materials',
  mediaFolder: 'YouTube/Medias',
  maxHeight: 1080, // 0 = best available; else 2160 | 1440 | 1080 | 720
  audioFormat: 'mp3',
  askDownloadMode: true,
  downloadSubtitles: true,
  keepOneSubtitle: true,
  defaultDownloadMode: 'video_and_audio',

  // external tools
  ytDlpPath: 'yt-dlp',
  ffmpegLocation: '',
  cookiesFromBrowser: '',
  cookiesFile: '',
  jsRuntime: '',
  ytDlpExtraArgs: '',

  setupDone: false,
};

const CLIPPINGS_PLUGIN_DIRS = [
  'arch-after-clipping',
  'arch-web-clipper',
  'arch-clipping',
  'archive-clippings-plus',
  'clip-archiver',
];

function splitList(raw) {
  return String(raw || '')
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// A folder setting as typed, made safe: backslashes, empty and "." segments
// and characters no filesystem here accepts are removed.
function cleanFolder(raw) {
  return String(raw || '')
    .replace(/\\/g, '/')
    .split('/')
    .map((seg) => (seg === '.' || seg === '' ? '' : seg.replace(/[\\/:*?"<>|]/g, ' ').trim()))
    .filter(Boolean)
    .join('/');
}

function extFromType(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('webp')) return '.webp';
  if (t.includes('png')) return '.png';
  if (t.includes('gif')) return '.gif';
  return '.jpg';
}

module.exports = class YouTubeArchiver extends Plugin {
  async onload() {
    // Never use underscore-prefixed names here: Obsidian's Component base class
    // owns _children, _events and _loaded, and clobbering _children with a Set
    // breaks the plugin lifecycle before onload finishes.
    this.ytProcs = new Set();
    this.activeNotice = null;
    this.aborted = false;

    // Obsidian re-reads main.js on enable, but Node caches required modules by
    // path. Without this, disabling and re-enabling after a lib/ update would
    // silently keep running the previous code.
    this.purgeModuleCache();

    await this.loadSettings();
    // files-menu is the multi-select right-click; file-menu is the single one.
    this.registerEvent(
      this.app.workspace.on('files-menu', (menu, files) => {
        const notes = files.filter((f) => f && f.extension === 'md');
        if (notes.length < 2) return;
        menu.addItem((item) =>
          item
            .setTitle(`Download media for ${notes.length} notes`)
            .setIcon('download')
            .onClick(() => this.bulkDownload(notes))
        );
      })
    );
    this.registerEvent(
      this.app.workspace.on('file-menu', (menu, file) => {
        if (!file || file.extension !== 'md') return;
        const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? null;
        if (fm && fm['dl-all'] !== undefined) {
          menu.addItem((item) =>
            item
              .setTitle('Download media for every video in this playlist')
              .setIcon('download')
              .onClick(() => this.downloadWholePlaylist(file))
          );
          menu.addItem((item) =>
            item
              .setTitle('Fill publish dates for this playlist')
              .setIcon('calendar')
              .onClick(() => this.fillPlaylistDates(file))
          );
          return;
        }
        menu.addItem((item) =>
          item
            .setTitle('Download media for this note')
            .setIcon('download')
            .onClick(() => this.bulkDownload([file]))
        );
      })
    );

    this.addSettingTab(new YouTubeArchiverSettingTab(this.app, this));

    this.addRibbonIcon('download', 'Sync YouTube playlists', () => this.syncAll());

    if (!this.settings.setupDone) {
      this.app.workspace.onLayoutReady(async () => {
        const report = await this.detectTools();
        const filled = await this.autoConfigure(report);
        this.settings.setupDone = true;
        await this.saveSettings();
        if (filled.length) new Notice(`ARCH YT Playlists configured itself: ${filled.length} setting(s).`, 8000);
      });
    }
    this.addCommand({
      id: 'sync-all',
      name: 'Sync all playlists',
      callback: () => this.syncAll(),
    });
    // obsidian://arch-yt-download?vault=<name>&file=<playlist note path>&mode=<mode>
    // The same as the per-playlist command, reachable from a shell or a script
    // so several playlists can be queued without clicking through each. The
    // path is vault-relative, with or without .md; mode is optional and, when
    // given, replaces the prompt. Handy for `open` from Terminal.
    this.registerObsidianProtocolHandler('arch-yt-download', (params) => {
      const MODES = ['video_and_audio', 'video_only', 'audio_only', 'subs_only'];
      const raw = String(params.file || '').replace(/\.md$/, '');
      const file = this.app.vault.getAbstractFileByPath(normalizePath(raw + '.md'));
      if (!(file instanceof TFile)) {
        this.toast(`arch-yt-download: no note at "${raw}"`);
        return;
      }
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? null;
      if (!fm || fm['dl-all'] === undefined) {
        this.toast(`arch-yt-download: "${file.basename}" is not a playlist note`);
        return;
      }
      const mode = MODES.includes(params.mode) ? params.mode : undefined;
      this.log(`arch-yt-download: ${file.path}${mode ? ' as ' + mode : ''}`);
      this.downloadWholePlaylist(file, mode);
    });
    this.addCommand({
      id: 'download-playlist-media',
      name: 'Download media for every video in this playlist',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== 'md') return false;
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter ?? null;
        if (!fm || fm['dl-all'] === undefined) return false; // not a playlist note
        if (!checking) this.downloadWholePlaylist(f);
        return true;
      },
    });
    this.addCommand({
      id: 'fill-playlist-dates',
      name: 'Fill publish dates for this playlist',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== 'md') return false;
        const fm = this.app.metadataCache.getFileCache(f)?.frontmatter ?? null;
        if (!fm || fm['dl-all'] === undefined) return false; // not a playlist note
        if (!checking) this.fillPlaylistDates(f);
        return true;
      },
    });
    this.addCommand({
      id: 'download-media-note',
      name: 'Download media for this note',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!f || f.extension !== 'md') return false;
        if (!checking) this.bulkDownload([f]);
        return true;
      },
    });
    this.addCommand({
      id: 'setup',
      name: 'Set up external tools',
      callback: () => this.setup(),
    });
    this.addCommand({
      id: 'fetch-details',
      name: 'Fetch details and transcript for this note',
      callback: () => this.hydrateActive(),
    });
    this.addCommand({
      id: 'sync-prompt',
      name: 'Sync one playlist or channel by URL',
      callback: () => this.syncPrompt(),
    });
    this.addCommand({
      id: 'sync-channels',
      name: 'Sync channels',
      callback: () => this.syncChannels(),
    });
  }

  // Set by "use this for the rest of this session"; cleared on unload.
  get sessionMode() { return this._sessionMode || null; }
  set sessionMode(v) { this._sessionMode = v; }

  log(...args) {
    // Always on. The toggle only ever encoded indecision, and a log that is
    // off by default is a log nobody has when they need it.
    console.log('[ArchYTPlaylists]', ...args);
  }

  onunload() {
    this.bulkRunning = false;
    this.datesRunning = false;
    this._sessionMode = null;
    // This plugin is meant to be switched off between uses, so leaving a yt-dlp
    // process running or a sync writing into a dead plugin is not acceptable.
    this.aborted = true;
    for (const child of this.ytProcs || []) {
      try {
        child.kill();
      } catch (_) {
        /* already gone */
      }
    }
    this.ytProcs = new Set();
    if (this.activeNotice) {
      try {
        this.activeNotice.hide();
      } catch (_) {
        /* already hidden */
      }
      this.activeNotice = null;
    }
    this.archiverModule = null;
    this.syncing = false;
    this.purgeModuleCache();
  }

  purgeModuleCache() {
    let dir;
    try {
      dir = path.join(this.pluginDir(), 'lib');
    } catch (_) {
      return;
    }
    for (const key of Object.keys(require.cache || {})) {
      if (key.startsWith(dir)) delete require.cache[key];
    }
  }

  // Lets a long sync stop promptly when the plugin is switched off.
  // The one place lib/archiver.js is loaded.
  //
  // A release build inlines that module and defines ARCH_LIB, because a release
  // delivers only main.js, manifest.json and styles.css -- a lib/ loaded from
  // disk would not arrive and the plugin would die on load. Working from the
  // repo there is no ARCH_LIB, so it comes off disk as before, which is what
  // keeps an edit-and-reload loop working with no build step. Both give the
  // same module object.
  lib() {
    if (typeof ARCH_LIB !== 'undefined') return ARCH_LIB;
    return require(path.join(this.pluginDir(), 'lib', 'archiver.js'));
  }

  checkAborted() {
    if (this.aborted) throw new Error('__aborted__');
  }

  // lib/ cannot construct a Notice itself, so it calls through here.
  toast(message, timeout = 8000) {
    return new Notice(message, timeout);
  }

  notice(message, timeout = 0) {
    if (this.activeNotice) {
      try {
        this.activeNotice.hide();
      } catch (_) {
        /* ignore */
      }
    }
    this.activeNotice = new Notice(message, timeout);
    return this.activeNotice;
  }

  /* ---------------- lazy module load ---------------- */

  archiver() {
    if (!this.archiverModule) {
      const { YouTubeBulk } = this.lib();
      this.archiverModule = new YouTubeBulk(this);
    }
    return this.archiverModule;
  }

  pluginDir() {
    const base =
      this.app.vault.adapter && this.app.vault.adapter.getBasePath
        ? this.app.vault.adapter.getBasePath()
        : '';
    return path.join(base, this.manifest.dir || '');
  }

  /* ---------------- running ---------------- */

  async syncAll() {
    const sources = (this.settings.sources || []).filter((s) => s && s.target);
    if (!sources.length) {
      new Notice('Add at least one playlist in ARCH YT Playlists settings.', 10000);
      return;
    }
    return this.syncSources(sources);
  }

  // One source or all of them go through the same loop, so the per-row button
  // in settings and the ribbon behave identically apart from the list.
  async syncSources(sources) {
    if (this.syncing) {
      new Notice('A sync is already running.');
      return;
    }
    this.syncing = true;
    this.aborted = false;
    try {
      for (const source of sources) {
        this.checkAborted();
        await this.archiver().run({
          target: source.target,
          note: source.note || source.target,
        });
      }
    } catch (e) {
      if (String(e && e.message) === '__aborted__') {
        this.log('sync stopped because the plugin was disabled');
      } else {
        console.error('[ArchYTPlaylists] sync failed:', e);
        new Notice('Sync failed. See the developer console.', 10000);
      }
    } finally {
      this.syncing = false;
    }
  }

  async hydrateActive() {
    const file = this.app.workspace.getActiveFile();
    if (!file || file.extension !== 'md') return new Notice('Open a video note first.');
    const { videoIdFromUrl } = this.lib();
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
    const id = fm && videoIdFromUrl(fm.url);
    if (!id) return new Notice('No YouTube address in this note\u2019s url property.');
    const n = this.notice('Fetching details...', 0);
    try {
      const r = await this.archiver().hydrateOne(file, id);
      n.hide();
      new Notice(r.transcript ? 'Details and transcript added.' : 'Details added, no transcript available.', 8000);
    } catch (e) {
      n.hide();
      new Notice(`Could not fetch details: ${e.message}`, 12000);
    }
  }

  async syncPrompt() {
    const { Modal } = require('obsidian');
    const plugin = this;
    class PromptModal extends Modal {
      onOpen() {
        this.titleEl.setText('Sync a playlist or channel');
        const input = this.contentEl.createEl('input', {
          type: 'text',
          attr: { placeholder: 'Playlist URL, playlist id, Watch Later, or a channel URL / @handle', style: 'width:100%;' },
        });
        const row = this.contentEl.createDiv({
          attr: { style: 'display:flex; gap:8px; margin-top:12px;' },
        });
        const go = row.createEl('button', { text: 'Sync', cls: 'mod-cta' });
        go.onclick = async () => {
          const target = input.value.trim();
          this.close();
          if (!target) return;
          // A channel address is the other thing a person pastes here. A bare
          // word is tried as a playlist shortcut first (Watch Later, Liked).
          const { channelUrlFromInput, resolveSourceTarget } = plugin.lib();
          const isShortcut = resolveSourceTarget(target) !== target;
          if (!isShortcut && /@|\/channel\/|\/c\/|\/user\//.test(target) && channelUrlFromInput(target)) {
            await plugin.syncOneChannel(target);
            return;
          }
          await plugin.archiver().run({ target, note: target });
        };
        input.focus();
        input.onkeydown = (e) => {
          if (e.key === 'Enter') go.click();
        };
      }
      onClose() {
        this.contentEl.empty();
      }
    }
    new PromptModal(this.app).open();
  }

  /* ---------------- channels ---------------- */

  // The list as typed, reduced to yt-dlp addresses. Lines that are not a
  // channel are reported rather than silently dropped: a watch URL pasted here
  // by mistake should say so in the log.
  channelTargets() {
    const { channelUrlFromInput } = this.lib();
    const seen = new Set();
    const targets = [];
    const rejected = [];
    for (const line of String(this.settings.channelList || '').split('\n')) {
      const raw = line.trim();
      if (!raw || raw.startsWith('#')) continue;
      const url = channelUrlFromInput(raw);
      if (!url) { rejected.push(raw); continue; }
      if (seen.has(url.toLowerCase())) continue;
      seen.add(url.toLowerCase());
      targets.push(url);
    }
    return { targets, rejected };
  }

  async syncChannels() {
    const { targets, rejected } = this.channelTargets();
    for (const r of rejected) this.log('not a channel address, skipped:', r);
    if (!targets.length) {
      new Notice('Add at least one channel in ARCH YT Playlists settings.', 10000);
      return;
    }
    if (this.syncingChannels) {
      new Notice('A channel sync is already running.');
      return;
    }
    this.syncingChannels = true;
    this.aborted = false;
    const started = Date.now();
    let created = 0, updated = 0, failed = 0;
    const n = this.notice(`Syncing ${targets.length} channel${targets.length === 1 ? '' : 's'}...`, 0);
    this.log(`syncing ${targets.length} channels into ${this.resolveChannelFolder() || 'the vault root'}`);
    try {
      for (let i = 0; i < targets.length; i++) {
        this.checkAborted();
        n.setMessage(`Channel ${i + 1} of ${targets.length}: ${targets[i].replace(/^https:\/\/www\.youtube\.com\//, '')}`);
        try {
          const r = await this.syncChannel(targets[i]);
          if (r.created) created++; else updated++;
        } catch (e) {
          if (String(e && e.message) === '__aborted__') throw e;
          failed++;
          console.error('[ArchYTPlaylists] channel failed:', targets[i], e);
        }
      }
    } catch (e) {
      if (String(e && e.message) === '__aborted__') this.log('channel sync stopped because the plugin was disabled');
      else console.error('[ArchYTPlaylists] channel sync failed:', e);
    } finally {
      this.syncingChannels = false;
      n.hide();
    }
    const msg = `Channels: ${created} new, ${updated} updated, ${failed} failed, ${Math.round((Date.now() - started) / 1000)}s.`;
    this.log(msg);
    new Notice(msg, 10000);
  }

  // One channel from the prompt. Not added to the list: the list is what gets
  // re-synced, and a one-off is a one-off.
  async syncOneChannel(target) {
    const n = this.notice('Fetching channel...', 0);
    try {
      const r = await this.syncChannel(target);
      n.hide();
      new Notice(`${r.created ? 'Created' : 'Updated'} ${r.notePath}`, 8000);
    } catch (e) {
      n.hide();
      console.error('[ArchYTPlaylists] channel failed:', target, e);
      new Notice(`Channel failed: ${e.message}`, 12000);
    }
  }

  // --playlist-items 0 is what makes this cheap: yt-dlp returns the channel's
  // own metadata -- name, handle, avatar and banner addresses -- without
  // listing a single video. Measured at about 1.5 s a channel.
  async syncChannel(target) {
    const { channelUrlFromInput, channelFromJson, channelImageStem, safeFileName } = this.lib();
    const url = channelUrlFromInput(target) || target;
    const r = await this.runYtDlp(['--dump-single-json', '--playlist-items', '0', '--no-warnings', url], 120000);
    if (r.code !== 0 || !r.stdout.trim()) {
      const last = String(r.stderr || '').trim().split('\n').pop();
      throw new Error(`yt-dlp exit ${r.code}: ${last || 'no output'}`);
    }
    let json;
    try { json = JSON.parse(r.stdout); } catch (_) { throw new Error('yt-dlp returned something that is not JSON'); }
    const ch = channelFromJson(json);
    if (!ch.name) throw new Error('no channel name in the metadata');

    const folder = this.resolveChannelFolder();
    if (folder) await this.ensureFolder(folder);
    // Named after the channel, and nothing else: that is what makes the
    // channel: [[Name]] link every video note already carries resolve here.
    const notePath = normalizePath(`${folder ? folder + '/' : ''}${safeFileName(ch.name)}.md`);
    const imageFolder = this.resolveChannelImageFolder(folder);
    if (imageFolder) await this.ensureFolder(imageFolder);

    const images = { icon: '', banner: '' };
    for (const [key, imgUrl, template, fallback, alias] of [
      ['icon', ch.icon, this.settings.channelIconTemplate, '{{channel}} Icon', 'Icon'],
      ['banner', ch.banner, this.settings.channelBannerTemplate, '{{channel}} Banner', 'Banner'],
    ]) {
      if (!imgUrl) { this.log(`${ch.name}: no ${key} on YouTube`); continue; }
      try {
        const stem = safeFileName(channelImageStem(template, ch, fallback));
        const file = await this.saveChannelImage(imgUrl, imageFolder, stem);
        if (file) images[key] = this.embedFor(file, notePath, alias);
      } catch (e) {
        // A missing picture is not a reason to lose the note.
        this.log(`${ch.name}: ${key} failed: ${e.message}`);
      }
    }

    const created = await this.writeChannelNote(ch, images, notePath);
    this.log(`${created ? 'created' : 'updated'} ${notePath}` +
      (images.icon ? '' : ' (no icon)') + (images.banner ? '' : ' (no banner)'));
    return { created, notePath };
  }

  existingImage(folder, stem) {
    for (const ext of ['.webp', '.jpg', '.jpeg', '.png']) {
      const hit = this.app.vault.getAbstractFileByPath(normalizePath(folder ? `${folder}/${stem}${ext}` : `${stem}${ext}`));
      if (hit instanceof TFile) return hit;
    }
    return null;
  }

  // Encoded to WebP here rather than left for ARCH Images Plus to convert on
  // arrival: the note is written moments after the image, and a link written
  // as .jpg to a file that becomes .webp a second later is a race this plugin
  // should not be entering. Quality 0.90 for the same reason Images Plus uses
  // it: the original is not kept.
  async saveChannelImage(url, folder, stem) {
    const existing = this.existingImage(folder, stem);
    if (existing && !this.settings.refreshChannelImages) {
      this.log('image already on disk, kept:', existing.path);
      return existing;
    }
    // requestUrl is Obsidian's own client: not subject to the renderer's CORS
    // rules, and it follows redirects.
    const res = await requestUrl({ url, throw: false });
    if (res.status !== 200 || !res.arrayBuffer || !res.arrayBuffer.byteLength) throw new Error(`HTTP ${res.status}`);
    const type = (res.headers && (res.headers['content-type'] || res.headers['Content-Type'])) || 'image/jpeg';
    let bytes = new Uint8Array(res.arrayBuffer);
    let ext = extFromType(type);
    if (this.settings.channelImageFormat === 'webp' && ext !== '.webp') {
      try {
        const { encodeWebp } = this.lib();
        const encoded = await encodeWebp(new Blob([res.arrayBuffer], { type }), 0.9);
        if (encoded.data) { bytes = encoded.data; ext = '.webp'; }
        else this.log('kept the original format, WebP would be larger:', stem);
      } catch (e) {
        this.log('WebP encode failed, keeping the original:', e.message);
      }
    }
    const target = normalizePath(folder ? `${folder}/${stem}${ext}` : `${stem}${ext}`);
    const already = this.app.vault.getAbstractFileByPath(target);
    if (already instanceof TFile) {
      await this.app.vault.modifyBinary(already, bytes);
      this.log('refreshed', target);
      return already;
    }
    await this.app.vault.createBinary(target, bytes);
    if (existing) this.log(`refreshed as ${target}; the old ${existing.path} is left for you to remove`);
    else this.log('saved', target, `${Math.round(bytes.length / 1024)} KB`);
    const file = this.app.vault.getAbstractFileByPath(target);
    return file instanceof TFile ? file : null;
  }

  embedFor(file, fromNotePath, alias) {
    let link = file.path;
    try {
      link = this.app.metadataCache.fileToLinktext(file, fromNotePath || '', true);
    } catch (_) { /* fall back to the full path */ }
    return `[[${link}|${alias}]]`;
  }

  // Rewritten on every sync, and these notes are where a person puts things
  // the sync cannot know -- a ranking, extra tags, a body. An existing note
  // goes through processFrontMatter, which keeps every property it is not
  // told about and never touches the body; tags are merged, not replaced. An
  // image that was not fetched this run leaves whatever the property had.
  async writeChannelNote(ch, images, notePath) {
    const { buildFrontmatter, parseDefaults, addMissingDefaults } = this.lib();
    const tags = (this.settings.channelTags || []).map((t) => String(t).replace(/^#+/, '').trim()).filter(Boolean);
    const fields = { url: `[Link](${ch.url})`, icon: images.icon, banner: images.banner, tags };

    const defaults = parseDefaults(this.settings.channelNoteDefaults);
    const existing = this.app.vault.getAbstractFileByPath(notePath);
    if (existing instanceof TFile) {
      await this.app.fileManager.processFrontMatter(existing, (fm) => {
        fm.url = fields.url;
        if (fields.icon) fm.icon = fields.icon;
        if (fields.banner) fm.banner = fields.banner;
        const had = [].concat(fm.tags ?? []).map((t) => String(t).replace(/^#+/, '').trim()).filter(Boolean);
        fm.tags = [...had, ...tags.filter((t) => !had.includes(t))];
        addMissingDefaults(fm, defaults);
        this.applyOrder(fm, this.settings.channelNoteOrder);
      });
      return false;
    }
    addMissingDefaults(fields, defaults);
    await this.app.vault.create(notePath, buildFrontmatter(this.applyOrder(fields, this.settings.channelNoteOrder)));
    return true;
  }

  // Where channel notes go. 'root' and 'subfolder' are relative to the archive
  // root, the folder playlists land in; the default is a sibling of it.
  resolveChannelFolder() {
    const mode = this.settings.channelLocationMode || 'specified';
    const root = cleanFolder(this.settings.archiveRoot);
    if (mode === 'vault') return '';
    if (mode === 'root') return root;
    if (mode === 'specified') return cleanFolder(this.settings.channelFolder) || root;
    const sub = cleanFolder(this.settings.channelSubfolder || 'Channels');
    return root ? `${root}/${sub}` : sub;
  }

  // Where a channel's icon and banner go, relative to the channel note.
  resolveChannelImageFolder(noteFolder) {
    const mode = this.settings.channelImageLocationMode || 'subfolder';
    if (mode === 'vault') return '';
    if (mode === 'same') return noteFolder;
    if (mode === 'specified') return cleanFolder(this.settings.channelImageFolder) || noteFolder;
    const sub = cleanFolder(this.settings.channelImageSubfolder || 'Images');
    return sub ? (noteFolder ? `${noteFolder}/${sub}` : sub) : noteFolder;
  }

  /* ---------------- vault helpers ---------------- */

  async ensureFolder(folderPath) {
    const parts = normalizePath(folderPath).split('/').filter(Boolean);
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (existing) throw new Error(`"${current}" exists but is a file.`);
      try {
        await this.app.vault.createFolder(current);
      } catch (e) {
        if (!/exists/i.test(String(e && e.message))) throw e;
      }
    }
  }

  async uniquePath(folder, filename) {
    const ext = path.extname(filename);
    const stem = filename.slice(0, filename.length - ext.length);
    let candidate = normalizePath(`${folder}/${stem}${ext}`);
    let n = 1;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      candidate = normalizePath(`${folder}/${stem}-${n++}${ext}`);
    }
    return candidate;
  }

  /* ---------------- yt-dlp ---------------- */

  buildEnv() {
    const env = Object.assign({}, process.env);
    if (process.platform !== 'win32') {
      const extras = [
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        path.join(os.homedir(), '.local', 'bin'),
        path.join(os.homedir(), '.deno', 'bin'),
      ];
      env.PATH = [...extras, env.PATH || ''].filter(Boolean).join(path.delimiter);
    }
    return env;
  }

  tokenize(str) {
    const out = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(str))) out.push(m[1] ?? m[2] ?? m[3]);
    return out;
  }

  // Mirrors Obsidian's "Default location for new attachments". noteFolder is the
  // folder the note itself lands in. Returns a vault-relative folder ('' = root).
  resolveThumbnailFolder(noteFolder) {
    const mode = this.settings.thumbnailLocationMode || 'subfolder';
    const clean = (s) =>
      String(s || '')
        .replace(/\\/g, '/')
        .split('/')
        .map((seg) => (seg === '.' || seg === '' ? '' : seg.replace(/[\\/:*?"<>|]/g, ' ').trim()))
        .filter(Boolean)
        .join('/');
    if (mode === 'vault') return '';
    if (mode === 'same' || mode === 'obsidian') return noteFolder;
    if (mode === 'specified') return clean(this.settings.thumbnailFolder) || noteFolder;
    const sub = clean(this.settings.thumbnailSubfolder || 'thumbnails');
    return sub ? (noteFolder ? `${noteFolder}/${sub}` : sub) : noteFolder;
  }

  // Vault-relative unless an absolute path was typed. yt-dlp needs a real path.
  resolveMediaFolder(noteFolder) {
    const mode = this.settings.mediaLocationMode || 'subfolder';
    const clean = (s) =>
      String(s || '').replace(/\\/g, '/').split('/')
        .map((seg) => (seg === '.' || seg === '' ? '' : seg.replace(/[\\/:*?"<>|]/g, ' ').trim()))
        .filter(Boolean).join('/');
    let rel;
    if (mode === 'vault') rel = '';
    else if (mode === 'same') rel = noteFolder;
    else if (mode === 'specified') {
      const raw = String(this.settings.mediaFolder || '').trim();
      if (path.isAbsolute(raw)) return raw;
      rel = clean(raw) || noteFolder;
    } else {
      const sub = clean(this.settings.mediaSubfolder || 'media');
      rel = sub ? (noteFolder ? `${noteFolder}/${sub}` : sub) : noteFolder;
    }
    const base =
      this.app.vault.adapter && this.app.vault.adapter.getBasePath
        ? this.app.vault.adapter.getBasePath()
        : '';
    return rel ? path.join(base, rel) : base;
  }

  /* ---------------- media download ---------------- */

  // Sequential on purpose: ten parallel yt-dlp processes saturate the connection
  // and make failures impossible to read. The mode is asked once and reused.
  // The videos are found by resolving each note's yt-playlist links rather than
  // by folder, because a video can sit in several playlists and only one of them
  // is its folder. Link resolution follows renames; a folder scan would not.
  videosInPlaylist(playlistFile) {
    const out = [];
    for (const md of this.app.vault.getMarkdownFiles()) {
      if (md.path === playlistFile.path) continue;
      const cache = this.app.metadataCache.getFileCache(md);
      const raw = cache?.frontmatter?.['yt-playlist'];
      if (raw === undefined) continue;
      const list = Array.isArray(raw) ? raw : [raw];
      for (const entry of list) {
        const m = String(entry).match(/\[\[([^\]|]+)/);
        if (!m) continue;
        const target = this.app.metadataCache.getFirstLinkpathDest(m[1].trim(), md.path);
        if (target && target.path === playlistFile.path) {
          out.push(md);
          break;
        }
      }
    }
    return out;
  }

  async downloadWholePlaylist(playlistFile, mode) {
    const videos = this.videosInPlaylist(playlistFile);
    if (!videos.length) {
      this.toast(`No video notes link to "${playlistFile.basename}".`);
      return;
    }
    this.log(`playlist ${playlistFile.basename}: ${videos.length} video note(s)`);
    const summary = await this.bulkDownload(videos, mode);

    // dl-all is only true when every video actually has its media on disk, which
    // is checked rather than inferred from the run that just happened.
    const missing = videos.filter((f) => {
      const fm = this.app.metadataCache.getFileCache(f)?.frontmatter ?? {};
      return this.mediaOnDisk(fm, f.path).length === 0;
    });
    await this.setFrontmatterFields(playlistFile, { 'dl-all': missing.length === 0 });
    if (missing.length) {
      this.log(`dl-all stays false: ${missing.length} video(s) still without media`);
    }
    return summary;
  }

  // The publish date is null in the flat enumeration sync uses, so it needs a
  // real extraction pass. hydrate() does a whole playlist in one yt-dlp process,
  // which measured about 2.3s a video against 3.3s for one-at-a-time calls, so
  // this is a single walk-away run rather than opening every note by hand.
  // Sequential and abortable for the same reasons bulkDownload is.
  async fillPlaylistDates(playlistFile, opts = {}) {
    if (this.datesRunning) {
      if (!opts.auto) this.toast('A date fill is already running.');
      return;
    }
    const { videoIdFromUrl, isoDate } = this.lib();

    // Video id -> note, so each JSON line yt-dlp emits can find where it goes.
    // A sync passes this in: it has just created these notes and the metadata
    // cache has not caught up, so rebuilding it from the cache would come back
    // empty for precisely the new notes.
    let byId = opts.byId;
    if (!byId) {
      byId = new Map();
      for (const f of this.videosInPlaylist(playlistFile)) {
        const id = videoIdFromUrl(this.app.metadataCache.getFileCache(f)?.frontmatter?.url);
        if (id) byId.set(id, f);
      }
    }
    if (!byId.size) {
      if (!opts.auto) this.toast(`No video notes link to "${playlistFile.basename}".`);
      return;
    }

    // Only the notes actually missing a date are fetched, and they are fetched
    // by their own addresses rather than through the playlist. Re-extracting a
    // whole playlist to fill the three videos added since last week is the
    // expensive mistake here: at ~2.3s a video it is the difference between
    // seconds and half an hour on a long list. A note with no cache entry yet
    // counts as missing, which is right -- it was just created.
    const missing = [];
    for (const [id, file] of byId) {
      if (!this.app.metadataCache.getFileCache(file)?.frontmatter?.published) missing.push([id, file]);
    }
    if (!missing.length) {
      this.log(`date fill skipped for ${playlistFile.basename}: all ${byId.size} note(s) already have one`);
      if (!opts.auto) this.toast(`${playlistFile.basename}: every note already has a publish date.`);
      return;
    }
    const wanted = new Map(missing);
    const urls = missing.map(([id]) => `https://www.youtube.com/watch?v=${id}`);
    this.log(`date fill for ${playlistFile.basename}: ${missing.length} of ${byId.size} note(s) need a date`);

    this.datesRunning = true;
    const notice = this.notice(`Fetching ${missing.length} publish date(s)...`, 0);
    let seen = 0, written = 0, noDate = 0, unmatched = 0;
    try {
      await this.archiver().hydrate(urls, async (j) => {
        this.checkAborted();
        seen++;
        const file = wanted.get(j.id);
        if (!file) { unmatched++; return; }
        const published = isoDate(j.upload_date);
        if (!published) { noDate++; return; }
        await this.setFrontmatterFields(file, { published });
        written++;
        if (written % 10 === 0) notice.setMessage(`${written} of ${missing.length} date(s)...`);
      }, false);
      notice.hide();
      this.log(`date fill done: ${seen} seen, ${written} written, ${noDate} without a date, ${unmatched} unexpected`);
      // After a sync this is a second notice on top of the sync's own, so it is
      // only worth showing when it actually did something.
      if (!opts.auto || written) {
        this.toast(
          `${playlistFile.basename}: ${written} publish date(s) written` +
            (noDate ? `, ${noDate} with no date from YouTube` : ''),
          10000
        );
      }
    } catch (e) {
      notice.hide();
      if (String(e && e.message) === '__aborted__') {
        this.log('date fill stopped because the plugin was disabled');
      } else {
        console.error('[ArchYTPlaylists] date fill failed:', e);
        new Notice(`Could not fetch publish dates: ${e.message}`, 12000);
      }
    } finally {
      this.datesRunning = false;
    }
  }

  // Every entry point -- one note, a multi-select, a whole playlist -- is a
  // run through here, so a request made while another run is going waits its
  // turn rather than being refused or slipping in ahead: the mode is asked
  // now, the downloads happen after the queue ahead of it. Each run keeps
  // its own notice and summary, so six playlists queued in a row report six
  // times. A single note used to go straight to the download queue, which
  // gave no sign it was waiting and popped its mode prompt minutes later.
  async bulkDownload(files, mode) {
    const what = files.length === 1 ? `"${files[0].basename}"` : `${files.length} notes`;
    if (!mode) mode = await this.askMode(what);
    if (!mode || mode === 'skip') return;
    if (this.bulkRunning) {
      this.log(`queued ${what} behind the running download`);
      this.toast(`Queued ${what}; starts when the current download finishes.`);
    }
    const run = () => this.runBulk(files, mode);
    this._bulkChain = (this._bulkChain || Promise.resolve()).then(run, run);
    return this._bulkChain;
  }

  async runBulk(files, mode) {
    if (this.aborted) return { ok: 0, skipped: 0, failed: 0 };
    this.bulkRunning = true;
    const notice = new Notice(`Downloading media: 0 / ${files.length}`, 0);
    let done = 0, ok = 0, skipped = 0, failed = 0;
    try {
      for (const f of files) {
        if (!this.bulkRunning) break; // unload aborts the loop
        const r = await this.downloadMediaFor(f, mode);
        if (r.ok && r.reason === 'already downloaded') skipped++;
        else if (r.ok) ok++;
        else failed++;
        done++;
        notice.setMessage(`Downloading media: ${done} / ${files.length}`);
      }
    } finally {
      notice.hide();
      this.bulkRunning = false;
    }
    this.log(`bulk finished: ${ok} downloaded, ${skipped} already present, ${failed} failed`);
    this.toast(`Done. ${ok} downloaded, ${skipped} already there, ${failed} failed.`);
    return { ok, skipped, failed };
  }


  // The url property is "[Link](https://...)"; the bare URL is also accepted.
  urlFromNote(fm) {
    const raw = String((fm && fm.url) || '');
    const m = raw.match(/\((https?:\/\/[^)\s]+)\)/) || raw.match(/(https?:\/\/\S+)/);
    return m ? m[1] : '';
  }

  // dl-ed is only a claim. This checks the disk, so a box ticked by hand or left
  // stale by a deleted file does not decide whether a download happens.
  // The media property is a wikilink by file name, not a path, so it is
  // resolved the way Obsidian resolves a link from that note. The earlier
  // lookup by path only matched a file at the vault root, so this check
  // never found anything and dl-all never turned true.
  mediaOnDisk(fm, notePath = '') {
    const raw = (fm && fm.media) || '';
    const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
    const found = [];
    for (const entry of list) {
      const m = String(entry).match(/\[\[([^\]|]+)/);
      const target = (m ? m[1] : String(entry)).trim();
      const tf =
        this.app.metadataCache.getFirstLinkpathDest(target, notePath) ||
        this.app.vault.getAbstractFileByPath(target);
      if (tf) found.push(tf);
    }
    return found;
  }

  askMode(name) {
    if (this.sessionMode) return Promise.resolve(this.sessionMode);
    if (!this.settings.askDownloadMode) return Promise.resolve(this.settings.defaultDownloadMode);
    return new Promise((resolve) => {
      new DownloadModeModal(this.app, name, (mode, remember) => {
        if (remember && mode) this.sessionMode = mode;
        resolve(mode);
      }).open();
    });
  }

  // Downloads run one at a time whatever started them. A bulk run and the
  // hotkey are separate entry points; without this they overlap, splitting
  // bandwidth and, on the same note, writing the same output path twice.
  enqueue(task) {
    this._chain = (this._chain || Promise.resolve()).then(task, task);
    return this._chain;
  }

  async downloadMediaFor(file, mode) {
    if (!this._inFlight) this._inFlight = new Set();
    if (this._inFlight.has(file.path)) {
      this.log('already downloading, ignoring the repeat:', file.path);
      return { ok: false, reason: 'in flight' };
    }
    this._inFlight.add(file.path);
    try {
      return await this.enqueue(() => this.runDownloadFor(file, mode));
    } finally {
      this._inFlight.delete(file.path);
    }
  }

  async runDownloadFor(file, mode) {
    const fm = this.app.metadataCache.getFileCache(file)?.frontmatter ?? {};
    const url = this.urlFromNote(fm);
    if (!url) {
      this.toast(`No url property in "${file.basename}".`);
      return { ok: false, reason: 'no url' };
    }

    // Checked before anything is asked or fetched, so a re-run is cheap.
    // A subtitles-only run has its own check further down: the media being
    // there says nothing about whether its subtitles were fetched.
    const already = mode === 'subs_only' ? [] : this.mediaOnDisk(fm, file.path);
    if (already.length) {
      this.log('media already on disk, only correcting dl-ed:', file.path);
      await this.setDlEd(file, true);
      return { ok: true, reason: 'already downloaded' };
    }

    if (!mode) mode = await this.askMode(file.basename);
    if (!mode || mode === 'skip') {
      this.log('download skipped by user:', url);
      return { ok: false, reason: 'skipped' };
    }

    const noteFolder = file.parent ? file.parent.path : '';
    const folder = this.resolveMediaFolder(noteFolder);
    try {
      fs.mkdirSync(folder, { recursive: true });
    } catch (e) {
      this.toast(`Could not create the media folder: ${folder}`);
      return { ok: false, reason: 'folder' };
    }

    // yt-dlp reads % in an output template, so it is doubled there. The plain
    // form is kept for matching files on disk.
    const rawStem = String(file.basename).replace(/[\\/:*?"<>|]/g, ' ').trim();
    const stem = rawStem.replace(/%/g, '%%');
    const notice = new Notice(`Downloading media for "${file.basename}"...`, 0);
    const saved = [];
    try {
      if (mode === 'video_only' || mode === 'video_and_audio') {
        const out = path.join(folder, `${stem}.%(ext)s`);
        const vArgs = ['-f', videoFormat(this.settings.maxHeight), '-o', out];
        if (this.settings.downloadSubtitles) {
          vArgs.push(
            '--write-auto-subs', '--write-subs',
            '--sub-langs', this.settings.subtitleLangs || 'en.*',
            '--sub-format', 'vtt/best'
          );
        }
        const r = await this.runMedia(vArgs, url, folder, rawStem);
        if (!r.ok) {
          notice.hide();
          this.toast(`Video download failed for "${file.basename}". See the console.`);
          console.error('[ArchYTPlaylists] video download failed:\n' + r.stderr);
          return { ok: false, reason: 'video failed' };
        }
        saved.push(...r.files);
        if (this.settings.downloadSubtitles && this.settings.keepOneSubtitle) {
          this.pruneSubtitles(folder, rawStem);
        }

        if (mode === 'video_and_audio' && r.files.length) {
          const mp3 = await this.extractAudioFrom(r.files[0], folder);
          if (mp3) saved.push(mp3);
          else this.log('audio extraction failed; the video is still saved');
        }
      } else if (mode === 'subs_only') {
        // Subtitles only, no media: the files land where the video would,
        // under its stem, so a later video download finds them and yt-dlp
        // skips fetching them again. Nothing is written to the note -- a
        // subtitle is a sidecar and is never linked as the media.
        const have = this.subtitlesNamed(folder, rawStem);
        if (have.length) {
          this.log('subtitles already on disk:', have.join(', '));
          return { ok: true, reason: 'already downloaded' };
        }
        const out = path.join(folder, `${stem}.%(ext)s`);
        const r = await this.runYtDlp(
          [
            '--no-playlist', '--remote-components', 'ejs:github', '--skip-download',
            '--write-auto-subs', '--write-subs',
            '--sub-langs', this.settings.subtitleLangs || 'en.*',
            '--sub-format', 'vtt/best',
            '-o', out, url,
          ],
          600000
        ).catch((e) => ({ code: 1, stderr: String((e && e.message) || e) }));
        let files = this.subtitlesNamed(folder, rawStem);
        if (r.code !== 0 || !files.length) {
          notice.hide();
          this.toast(`Subtitle download failed for "${file.basename}". See the console.`);
          console.error('[ArchYTPlaylists] subtitle download failed:\n' + (r.stderr || 'no subtitle file appeared'));
          return { ok: false, reason: 'subtitles failed' };
        }
        if (this.settings.keepOneSubtitle) {
          const kept = this.pruneSubtitles(folder, rawStem);
          files = kept ? [kept] : files;
        }
        notice.hide();
        this.log('subtitles saved:', files.join(', '));
        return { ok: true, files };
      } else if (mode === 'audio_only') {
        // Staged in a temp folder: YouTube's best audio is itself a webm, so
        // writing it beside the video under the same stem lands on the video,
        // which yt-dlp then deletes after converting.
        const staged = fs.mkdtempSync(path.join(os.tmpdir(), 'arch-yt-audio-'));
        const out = path.join(staged, `${stem}.%(ext)s`);
        const r = await this.runMedia(
          ['-f', 'bestaudio/best', '-x', '--audio-format', this.settings.audioFormat, '-o', out],
          url,
          staged,
          rawStem
        );
        if (!r.ok) {
          notice.hide();
          this.toast(`Audio download failed for "${file.basename}". See the console.`);
          console.error('[ArchYTPlaylists] audio download failed:\n' + r.stderr);
          return { ok: false, reason: 'audio failed' };
        }
        for (const f of r.files) {
          const dest = path.join(folder, path.basename(f));
          try {
            fs.renameSync(f, dest);
          } catch (_) {
            fs.copyFileSync(f, dest);
            fs.unlinkSync(f);
          }
          saved.push(dest);
        }
        try { fs.rmSync(staged, { recursive: true, force: true }); } catch (_) {}
      }
    } finally {
      notice.hide();
    }

    if (!saved.length) return { ok: false, reason: 'nothing saved' };

    const base =
      this.app.vault.adapter && this.app.vault.adapter.getBasePath
        ? this.app.vault.adapter.getBasePath()
        : '';
    const links = saved.map((abs) => {
      const rel = base && abs.startsWith(base) ? abs.slice(base.length + 1) : abs;
      return `[[${rel.split('/').pop()}]]`;
    });
    await this.setFrontmatterFields(file, { media: links.length === 1 ? links[0] : links, 'dl-ed': true });
    this.log('media saved:', saved.join(', '));
    return { ok: true, files: saved };
  }

  // --remote-components is added here, not in buildFlags: enumeration has no
  // challenge to solve, so making every sync fetch the solver would be waste.
  async runMedia(args, url, folder, stem) {
    const full = ['--no-playlist', '--remote-components', 'ejs:github', ...args];
    const printFile = path.join(os.tmpdir(), `arch-yt-${Date.now()}.txt`);
    const res = await this.runYtDlp(
      [...full, '--no-simulate', '--print-to-file', 'after_move:filepath', printFile, url],
      3600000
    ).catch((e) => ({ code: 1, stdout: '', stderr: String((e && e.message) || e) }));

    let files = [];
    try {
      files = fs.readFileSync(printFile, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
      fs.unlinkSync(printFile);
    } catch (_) {
      /* nothing was written */
    }
    files = files.filter((f) => fs.existsSync(f));

    // yt-dlp skips a file that is already there, and after_move never fires, so
    // an empty print file does not mean the download failed. Treating it as a
    // failure meant the note kept dl-ed false and fetched the whole thing again
    // on the next run. Fall back to looking for what the output template named.
    if (res.code === 0 && !files.length && folder && stem) {
      files = this.filesNamed(folder, stem);
      if (files.length) this.log('print file was empty; matched on disk instead:', files.join(', '));
    }
    return { ok: res.code === 0 && files.length > 0, files, stderr: res.stderr || '' };
  }

  // Files the output template could have produced: the stem, optionally with
  // yt-dlp's numeric suffix. Subtitle sidecars are excluded -- they are not the
  // media file and would be linked as if they were.
  // The subtitle sidecars for a stem, the ones filesNamed leaves out.
  subtitlesNamed(folder, stem) {
    let entries = [];
    try {
      entries = fs.readdirSync(folder);
    } catch (_) {
      return [];
    }
    const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const shape = new RegExp(`^${esc}\\.[A-Za-z0-9_-]+\\.(vtt|srt|ass)$`, 'i');
    return entries.filter((n) => shape.test(n)).map((n) => path.join(folder, n));
  }

  filesNamed(folder, stem) {
    let entries = [];
    try {
      entries = fs.readdirSync(folder);
    } catch (_) {
      return [];
    }
    const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const shape = new RegExp(`^${esc}(?:[-. ]\\d+)?\\.[A-Za-z0-9]+$`, 'i');
    return entries
      .filter((n) => shape.test(n) && !/\.(vtt|srt|ass|lrc|json|txt)$/i.test(n))
      .map((n) => path.join(folder, n));
  }

  // '--sub-langs en.*' matches every English variant YouTube offers -- en,
  // en-US, en-GB, en-orig and the rest -- and yt-dlp writes all of them. The
  // pattern stays broad so something always arrives even when there is no plain
  // 'en' track; the surplus is removed here instead. Subtitle files are a few KB,
  // so fetching several and keeping one is cheaper than a second request.
  pruneSubtitles(folder, stem) {
    let entries = [];
    try {
      entries = fs.readdirSync(folder);
    } catch (_) {
      return null;
    }
    const esc = stem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const shape = new RegExp(`^${esc}\\.([A-Za-z0-9_-]+)\\.(vtt|srt|ass)$`, 'i');

    const found = [];
    for (const name of entries) {
      const m = name.match(shape);
      if (m) found.push({ name, lang: m[1], ext: m[2].toLowerCase() });
    }
    if (found.length < 2) return found[0] ? path.join(folder, found[0].name) : null;

    found.sort((a, b) => this.subtitleRank(a) - this.subtitleRank(b) || a.lang.localeCompare(b.lang));
    const keep = found[0];
    let removed = 0;
    for (const f of found.slice(1)) {
      try {
        fs.unlinkSync(path.join(folder, f.name));
        removed++;
      } catch (_) {
        /* leave it rather than fail the download over a subtitle */
      }
    }
    this.log(`subtitles: kept ${keep.lang}, removed ${removed} other track(s)`);
    return path.join(folder, keep.name);
  }

  // Lower sorts first. A plain language code beats a regional variant, and the
  // original-language track beats an auto-translation of it.
  subtitleRank(f) {
    const lang = f.lang.toLowerCase();
    const base = (this.settings.subtitleLangs || 'en').replace(/[.*].*$/, '').toLowerCase() || 'en';
    if (lang === base) return 0;
    if (lang === `${base}-orig`) return 1;
    if (lang.startsWith(`${base}-`)) return 2;
    return 3;
  }

  async extractAudioFrom(videoPath, folder) {
    const format = this.settings.audioFormat || 'mp3';
    const stem = path.basename(videoPath, path.extname(videoPath));
    let dest = path.join(folder, `${stem}.${format}`);
    if (dest === videoPath) return null;
    let n = 1;
    while (fs.existsSync(dest)) dest = path.join(folder, `${stem}-${n++}.${format}`);

    const bin = this.settings.ffmpegLocation
      ? path.join(this.settings.ffmpegLocation, 'ffmpeg')
      : 'ffmpeg';
    const args = ['-y', '-loglevel', 'error', '-i', videoPath, '-vn', '-b:a', '192k', dest];
    const started = Date.now();
    const code = await new Promise((resolve) => {
      execFile(bin, args, { timeout: 600000 }, (err) => resolve(err ? 1 : 0));
    });
    if (code !== 0) {
      try { fs.unlinkSync(dest); } catch (_) {}
      return null;
    }
    this.log(`extracted ${format} in ${Date.now() - started}ms`);
    return dest;
  }

  async setDlEd(file, value) {
    await this.setFrontmatterFields(file, { 'dl-ed': value });
  }

  // Key order is insertion order, and that is what gets serialised, so the whole
  // object is rebuilt in the configured order rather than any one key being
  // shuffled to the end. Without this a property added later -- media, after a
  // download -- always lands at the bottom.
  applyOrder(fm, order) {
    const wanted = splitList(order);
    const ordered = {};
    for (const key of wanted) {
      if (Object.prototype.hasOwnProperty.call(fm, key)) ordered[key] = fm[key];
    }
    for (const key of Object.keys(fm)) {
      if (!(key in ordered)) ordered[key] = fm[key]; // unlisted keys keep their place at the end
    }
    for (const key of Object.keys(fm)) delete fm[key];
    Object.assign(fm, ordered);
    return fm;
  }

  async setFrontmatterFields(file, fields) {
    await this.app.fileManager.processFrontMatter(file, (fm) => {
      for (const [k, v] of Object.entries(fields)) fm[k] = v;
      const isPlaylist = Object.prototype.hasOwnProperty.call(fm, 'dl-all');
      this.applyOrder(
        fm,
        isPlaylist ? this.settings.playlistNoteOrder : this.settings.videoNoteOrder
      );
    });
  }

  buildFlags() {
    const flags = [];
    if (this.settings.cookiesFile) flags.push('--cookies', this.settings.cookiesFile);
    else if (this.settings.cookiesFromBrowser)
      flags.push('--cookies-from-browser', this.settings.cookiesFromBrowser);
    if (this.settings.ffmpegLocation) flags.push('--ffmpeg-location', this.settings.ffmpegLocation);
    if (this.settings.jsRuntime) flags.push('--js-runtime', this.settings.jsRuntime);
    const extra = String(this.settings.ytDlpExtraArgs || '').trim();
    if (extra) flags.push(...this.tokenize(extra));
    return flags;
  }

  runYtDlp(args, timeoutMs = 0) {
    const full = [...this.buildFlags(), ...args];
    this.log('yt-dlp', full.join(' '));
    return new Promise((resolve, reject) => {
      const child = execFile(
        this.settings.ytDlpPath || 'yt-dlp',
        full,
        {
          env: this.buildEnv(),
          encoding: 'utf8',
          maxBuffer: 1024 * 1024 * 256, // a few hundred videos of JSON
          timeout: timeoutMs || 0,
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          if (err && err.code === 'ENOENT') return reject(err);
          resolve({
            code: err ? (typeof err.code === 'number' ? err.code : 1) : 0,
            stdout: stdout || '',
            stderr: stderr || (err ? String(err.message) : ''),
          });
        }
      );
      this.ytProcs.add(child);
      child.on('close', () => this.ytProcs.delete(child));
    });
  }

  /* ---------------- tool detection and setup ---------------- */

  binDir() { return path.join(this.pluginDir(), 'bin'); }
  exeName(base) { return process.platform === 'win32' ? `${base}.exe` : base; }

  candidatePaths(base) {
    const name = this.exeName(base);
    const list = [path.join(this.binDir(), name)];
    if (process.platform === 'win32') {
      list.push(
        path.join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WinGet', 'Links', name),
        path.join(process.env.PROGRAMFILES || '', base, 'bin', name),
        path.join(process.env.LOCALAPPDATA || '', 'Programs', base, name),
        name
      );
    } else {
      list.push(
        `/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`,
        `/snap/bin/${name}`, path.join(os.homedir(), '.local', 'bin', name),
        path.join(os.homedir(), '.deno', 'bin', name), name
      );
    }
    return list.filter(Boolean);
  }

  runProcess(command, args, timeoutMs = 10000) {
    return new Promise((resolve, reject) => {
      const child = execFile(command, args,
        { env: this.buildEnv(), encoding: 'utf8', maxBuffer: 1024 * 1024 * 8, timeout: timeoutMs, windowsHide: true },
        (err, stdout, stderr) => {
          if (err && err.code === 'ENOENT') return reject(err);
          resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || '' });
        });
      this.ytProcs.add(child);
      child.on('close', () => this.ytProcs.delete(child));
    });
  }

  async resolveAbsolutePath(name) {
    if (path.isAbsolute(name)) return name;
    try {
      const r = await this.runProcess(process.platform === 'win32' ? 'where' : 'which', [name], 8000);
      if (r.code === 0) {
        const first = r.stdout.split('\n').map((x) => x.trim()).filter(Boolean)[0];
        if (first && path.isAbsolute(first)) return first;
      }
    } catch (_) { /* fall through */ }
    return name;
  }

  async findBinary(base, versionArgs = ['--version']) {
    for (const candidate of this.candidatePaths(base)) {
      try {
        const r = await this.runProcess(candidate, versionArgs);
        if (r.code === 0) {
          return { found: true, path: await this.resolveAbsolutePath(candidate), version: (r.stdout || r.stderr).trim().split('\n')[0] };
        }
      } catch (_) { /* next */ }
    }
    return { found: false, path: null, version: null };
  }

  ytDlpAgeDays(v) {
    const m = String(v || '').match(/(\d{4})\.(\d{2})\.(\d{2})/);
    if (!m) return null;
    return Math.floor((Date.now() - Date.UTC(+m[1], +m[2] - 1, +m[3])) / 86400000);
  }

  browserProfiles() {
    const home = os.homedir();
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const roaming = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    if (process.platform === 'darwin') {
      const sup = path.join(home, 'Library', 'Application Support');
      return [
        { name: 'chrome', dir: path.join(sup, 'Google', 'Chrome') },
        { name: 'brave', dir: path.join(sup, 'BraveSoftware', 'Brave-Browser') },
        { name: 'edge', dir: path.join(sup, 'Microsoft Edge') },
        { name: 'firefox', dir: path.join(sup, 'Firefox') },
        { name: 'safari', dir: path.join(home, 'Library', 'Safari') },
      ];
    }
    if (process.platform === 'win32') {
      return [
        { name: 'chrome', dir: path.join(local, 'Google', 'Chrome', 'User Data') },
        { name: 'edge', dir: path.join(local, 'Microsoft', 'Edge', 'User Data') },
        { name: 'brave', dir: path.join(local, 'BraveSoftware', 'Brave-Browser', 'User Data') },
        { name: 'firefox', dir: path.join(roaming, 'Mozilla', 'Firefox') },
      ];
    }
    return [
      { name: 'chrome', dir: path.join(home, '.config', 'google-chrome') },
      { name: 'brave', dir: path.join(home, '.config', 'BraveSoftware', 'Brave-Browser') },
      { name: 'chromium', dir: path.join(home, '.config', 'chromium') },
      { name: 'firefox', dir: path.join(home, '.mozilla', 'firefox') },
    ];
  }

  detectBrowsers() {
    const out = [];
    for (const b of this.browserProfiles()) {
      try {
        const st = fs.statSync(b.dir);
        if (st.isDirectory()) out.push({ ...b, mtime: st.mtimeMs });
      } catch (_) { /* not installed */ }
    }
    return out.sort((a, b) => b.mtime - a.mtime);
  }

  async detectTools() {
    const r = {};
    r.ytdlp = await this.findBinary('yt-dlp');
    if (r.ytdlp.found) r.ytdlp.ageDays = this.ytDlpAgeDays(r.ytdlp.version);
    r.ffmpeg = await this.findBinary('ffmpeg', ['-version']);
    r.jsRuntime = { found: false };
    for (const rt of ['deno', 'node', 'bun', 'qjs']) {
      const hit = await this.findBinary(rt);
      if (hit.found) { r.jsRuntime = { ...hit, name: rt }; break; }
    }
    r.browsers = this.detectBrowsers();
    return r;
  }

  async autoConfigure(report) {
    const filled = [];
    if (report.ytdlp.found && path.isAbsolute(report.ytdlp.path) && report.ytdlp.path !== this.settings.ytDlpPath) {
      this.settings.ytDlpPath = report.ytdlp.path;
      filled.push(`yt-dlp path \u2192 ${report.ytdlp.path}`);
    }
    if (report.ffmpeg.found && path.isAbsolute(report.ffmpeg.path)) {
      const dir = path.dirname(report.ffmpeg.path);
      if (dir !== this.settings.ffmpegLocation) {
        this.settings.ffmpegLocation = dir;
        filled.push(`ffmpeg folder \u2192 ${dir}`);
      }
    }
    if (!this.settings.cookiesFile && !this.settings.cookiesFromBrowser && report.browsers.length) {
      this.settings.cookiesFromBrowser = report.browsers[0].name;
      filled.push(`Cookies from browser \u2192 ${report.browsers[0].name}`);
    }
    if (filled.length) await this.saveSettings();
    return filled;
  }

  ytDlpAssetName() {
    if (process.platform === 'win32') return 'yt-dlp.exe';
    if (process.platform === 'darwin') return 'yt-dlp_macos';
    return process.arch === 'arm64' ? 'yt-dlp_linux_aarch64' : 'yt-dlp_linux';
  }

  downloadToFile(url, dest, onProgress, hops = 0) {
    return new Promise((resolve, reject) => {
      if (hops > 6) return reject(new Error('too many redirects'));
      const https = require('https');
      const req = https.get(url, { headers: { 'User-Agent': 'archive-youtube-bulk' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          return resolve(this.downloadToFile(new URL(res.headers.location, url).toString(), dest, onProgress, hops + 1));
        }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`HTTP ${res.statusCode}`)); }
        const total = Number(res.headers['content-length'] || 0);
        let done = 0;
        const out = fs.createWriteStream(dest);
        res.on('data', (c) => { done += c.length; if (onProgress && total) onProgress(done, total); });
        res.pipe(out);
        out.on('finish', () => out.close(() => resolve(dest)));
        out.on('error', reject);
      });
      req.on('error', reject);
      req.setTimeout(120000, () => req.destroy(new Error('timed out')));
    });
  }

  async installYtDlp() {
    const n = this.notice('Fetching yt-dlp...', 0);
    try {
      fs.mkdirSync(this.binDir(), { recursive: true });
      const dest = path.join(this.binDir(), this.exeName('yt-dlp'));
      const tmp = dest + '.part';
      await this.downloadToFile(
        `https://github.com/yt-dlp/yt-dlp/releases/latest/download/${this.ytDlpAssetName()}`,
        tmp,
        (d, t) => n.setMessage(`Fetching yt-dlp... ${Math.round((d / t) * 100)}%`)
      );
      fs.renameSync(tmp, dest);
      if (process.platform !== 'win32') fs.chmodSync(dest, 0o755);
      if (process.platform === 'darwin') {
        try { await this.runProcess('xattr', ['-d', 'com.apple.quarantine', dest], 8000); } catch (_) { /* usually absent */ }
      }
      const check = await this.runProcess(dest, ['--version'], 20000);
      n.hide();
      if (check.code !== 0) { new Notice('yt-dlp downloaded but would not run.', 10000); return false; }
      this.settings.ytDlpPath = dest;
      await this.saveSettings();
      new Notice(`yt-dlp ${check.stdout.trim()} installed.`, 8000);
      return true;
    } catch (e) {
      n.hide();
      new Notice(`Could not install yt-dlp: ${e.message}`, 12000);
      return false;
    }
  }

  async updateYtDlp() {
    const n = this.notice('Updating yt-dlp...', 0);
    const bin = this.settings.ytDlpPath || 'yt-dlp';
    let r = await this.runProcess(bin, ['-U'], 180000).catch((e) => ({ code: 1, stdout: '', stderr: String(e.message) }));
    const all = r.stdout + r.stderr;
    if (r.code === 0 && !/ERROR/i.test(all)) { n.hide(); new Notice(all.trim().split('\n').slice(-1)[0] || 'Up to date.', 8000); return; }
    n.hide();
    new Notice('yt-dlp could not self-update. Use Install standalone, or update it the way you installed it.', 12000);
  }

  async setup() {
    const n = this.notice('Looking for yt-dlp, ffmpeg, browsers...', 0);
    const report = await this.detectTools();
    const filled = await this.autoConfigure(report);
    n.hide();
    this.log('tool report', report, 'filled', filled);
    new SetupModal(this.app, this, report, filled).open();
  }

  /* ---------------- settings ---------------- */

  // One-time copy, not a live dependency. Clip Archiver can be absent or removed.
  async importFromClipArchiver() {
    const configDir = this.app.vault.configDir || '.obsidian';
    const base =
      this.app.vault.adapter && this.app.vault.adapter.getBasePath
        ? this.app.vault.adapter.getBasePath()
        : '';
    let file = null;
    for (const dir of CLIPPINGS_PLUGIN_DIRS) {
      const candidate = path.join(base, configDir, 'plugins', dir, 'data.json');
      if (fs.existsSync(candidate)) {
        file = candidate;
        break;
      }
    }
    if (!file) {
      new Notice('No Clip Archiver settings found. Enter the paths manually.', 8000);
      return false;
    }
    try {
      const other = JSON.parse(fs.readFileSync(file, 'utf8'));
      const copied = [];
      for (const key of [
        'ytDlpPath',
        'ffmpegLocation',
        'cookiesFromBrowser',
        'cookiesFile',
        'jsRuntime',
        'subtitleLangs',
      ]) {
        if (other[key]) {
          this.settings[key] = other[key];
          copied.push(key);
        }
      }
      await this.saveSettings();
      new Notice(`Copied ${copied.length} setting(s) from Clip Archiver.`, 8000);
      return true;
    } catch (e) {
      console.error('[ArchYTPlaylists] import failed:', e);
      new Notice('Could not read Clip Archiver settings.', 8000);
      return false;
    }
  }

  // The plugin folder has changed name, which changes where Obsidian keeps
  // data.json. Pull the previous file across once so nothing is re-entered.
  migrateFromOldFolder() {
    try {
      const base =
        this.app.vault.adapter && this.app.vault.adapter.getBasePath
          ? this.app.vault.adapter.getBasePath()
          : '';
      if (!base) return null;
      for (const dir of ['arch-youtube', 'archive-youtube-bulk', 'youtube-archiver']) {
        const old = path.join(base, this.app.vault.configDir || '.obsidian', 'plugins', dir, 'data.json');
        if (!fs.existsSync(old)) continue;
        console.log(`[ArchYTPlaylists] imported settings from the old ${dir} folder`);
        return JSON.parse(fs.readFileSync(old, 'utf8'));
      }
    } catch (e) {
      console.warn('[ArchYTPlaylists] could not migrate old settings:', e);
    }
    return null;
  }

  async loadSettings() {
    let saved = (await this.loadData()) || {};
    if (!Object.keys(saved).length) {
      const migrated = this.migrateFromOldFolder();
      if (migrated) {
        saved = migrated;
        await this.saveData(saved);
      }
    }
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    if (!Array.isArray(this.settings.sources)) {
      this.settings.sources = DEFAULT_SETTINGS.sources.map((s) => ({ ...s }));
    }
    if (!Array.isArray(this.settings.tags)) this.settings.tags = [];
    // The 1.3.x default put media last, which is where a property added after
    // sync lands anyway. A vault still on that exact string never chose it, so
    // it moves to the new default; anything else was typed and stays.
    if (
      saved.videoNoteOrder === 'dl-ed, duration, url, banner, yt-playlist, channel, media, published, tags' ||
      saved.videoNoteOrder === 'media, channel, yt-playlist, banner, url, dl-ed, v-rank, duration, status, published, tags'
    ) {
      this.settings.videoNoteOrder = DEFAULT_SETTINGS.videoNoteOrder;
    }
    // v-rank: 5 was the first guess at a default; rank: 0 replaced it. Only
    // the exact old text moves, since anything else was typed.
    if (saved.videoNoteDefaults === 'v-rank: 5\nstatus: Watch Later') {
      this.settings.videoNoteDefaults = DEFAULT_SETTINGS.videoNoteDefaults;
    }
    // Same for the tag: a saved list that is exactly the old default moves to
    // yt-video, matching yt-channel and yt-playlist. A list with anything
    // else in it was typed and stays.
    if (Array.isArray(saved.tags) && saved.tags.length === 1 && saved.tags[0] === 'youtube-video') {
      this.settings.tags = DEFAULT_SETTINGS.tags.slice();
    }
    if (!Array.isArray(this.settings.channelTags)) this.settings.channelTags = DEFAULT_SETTINGS.channelTags.slice();
    // The video quality used to be a raw yt-dlp selector. A cap typed into it
    // as [height<=N] becomes the matching dropdown choice; anything else was
    // "best", which is what the old default meant.
    if (typeof saved.quality === 'string') {
      const m = saved.quality.match(/height<=(\d+)/);
      this.settings.maxHeight = m && HEIGHT_OPTIONS.includes(Number(m[1])) ? Number(m[1]) : 0;
      delete this.settings.quality;
    }
    if (!HEIGHT_OPTIONS.includes(Number(this.settings.maxHeight))) this.settings.maxHeight = 0;
    this.settings.maxHeight = Number(this.settings.maxHeight);
    // Older vaults stored a bare subfolder name, which is what 'subfolder' means.
    // Only when there is a saved config predating the setting: on a fresh install
    // saved is empty, there is nothing to migrate, and running this would stomp
    // the defaults with 'subfolder' and blank the specified folder.
    if (Object.keys(saved).length && saved.thumbnailLocationMode === undefined) {
      this.settings.thumbnailLocationMode = 'subfolder';
      if (saved.thumbnailFolder) this.settings.thumbnailSubfolder = saved.thumbnailFolder;
      this.settings.thumbnailFolder = '';
    }
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }
};

class SetupModal extends Modal {
  constructor(app, plugin, report, filled) {
    super(app);
    this.plugin = plugin;
    this.report = report;
    this.filled = filled || [];
  }

  onOpen() {
    this.titleEl.setText('External tools');
    this.render();
  }

  async refresh() {
    this.report = await this.plugin.detectTools();
    this.filled = await this.plugin.autoConfigure(this.report);
    this.render();
  }

  row(label, ok, detail, action) {
    const st = new Setting(this.contentEl).setName(label).setDesc(detail);
    st.nameEl.prepend(
      createSpan({
        text: ok === true ? '\u25CF ' : ok === 'warn' ? '\u25CF ' : '\u25CB ',
        attr: { style: `color: var(--color-${ok === true ? 'green' : ok === 'warn' ? 'yellow' : 'red'});` },
      })
    );
    if (action) st.addButton((b) => b.setButtonText(action.label).onClick(action.onClick));
    return st;
  }

  render() {
    const { contentEl } = this;
    const r = this.report;
    const s = this.plugin.settings;
    contentEl.empty();
    contentEl.createEl('p', {
      text: `${process.platform} ${process.arch}`,
      attr: { style: 'font-size:var(--font-ui-smaller); opacity:.6; margin:0 0 12px;' },
    });

    if (this.filled.length) {
      const box = contentEl.createDiv({
        attr: { style: 'border-left:3px solid var(--color-green); padding:8px 12px; margin-bottom:14px; background:var(--background-secondary); border-radius:4px;' },
      });
      box.createEl('div', { text: 'Filled in for you', attr: { style: 'font-weight:600; margin-bottom:4px;' } });
      for (const line of this.filled) {
        box.createEl('div', { text: line, attr: { style: 'font-size:var(--font-ui-smaller); opacity:.85; word-break:break-all;' } });
      }
    }

    const stale = r.ytdlp.found && r.ytdlp.ageDays !== null && r.ytdlp.ageDays > 30;
    const ytRow = this.row(
      'yt-dlp',
      r.ytdlp.found ? (stale ? 'warn' : true) : false,
      r.ytdlp.found
        ? `${r.ytdlp.version}, ${r.ytdlp.ageDays} days old\n${r.ytdlp.path}` + (stale ? '\nOld builds are the usual cause of 403 errors.' : '')
        : 'Required. A self-updating copy can be installed into this plugin\u2019s folder.',
      r.ytdlp.found
        ? { label: 'Update', onClick: async () => { await this.plugin.updateYtDlp(); this.refresh(); } }
        : { label: 'Install', onClick: async () => { await this.plugin.installYtDlp(); this.refresh(); } }
    );
    if (r.ytdlp.found) {
      ytRow.addButton((b) =>
        b.setButtonText('Install standalone')
          .setTooltip('Downloads a self-updating copy here. Your existing install is left alone.')
          .onClick(async () => { await this.plugin.installYtDlp(); this.refresh(); })
      );
    }

    this.row('ffmpeg', r.ffmpeg.found, r.ffmpeg.found ? `${r.ffmpeg.version}\n${r.ffmpeg.path}` : 'Only needed if you extract audio. Syncing does not use it.', null);

    this.row('JavaScript runtime', r.jsRuntime.found ? true : 'warn',
      r.jsRuntime.found ? `${r.jsRuntime.name} ${r.jsRuntime.version}` : 'yt-dlp uses one to solve YouTube challenges. Install Deno or Node and it is picked up automatically.', null);

    let cookieDetail = 'None configured. Watch Later, Liked and private playlists need cookies.';
    let cookieOk = 'warn';
    if (s.cookiesFile) {
      cookieOk = fs.existsSync(s.cookiesFile) ? true : false;
      cookieDetail = fs.existsSync(s.cookiesFile) ? `File: ${s.cookiesFile}` : `No file at ${s.cookiesFile}`;
    } else if (s.cookiesFromBrowser) {
      cookieOk = true;
      cookieDetail = `Read from ${s.cookiesFromBrowser} on each run.`;
    }
    const ck = this.row('Cookies', cookieOk, cookieDetail, null);
    if ((r.browsers || []).length && !s.cookiesFile) {
      ck.addDropdown((d) => {
        d.addOption('', 'None');
        for (const b of r.browsers) d.addOption(b.name, b.name);
        d.setValue(s.cookiesFromBrowser || '');
        d.onChange(async (v) => { s.cookiesFromBrowser = v; await this.plugin.saveSettings(); this.render(); });
      });
    }

    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Check again').onClick(() => this.refresh()))
      .addButton((b) => b.setButtonText('Close').setCta().onClick(() => this.close()));
  }

  onClose() { this.contentEl.empty(); }
}

class DownloadModeModal extends Modal {
  constructor(app, name, done) {
    super(app);
    this.name = name;
    this.done = done;
    this.answered = false;
    this.remember = false;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl('h3', { text: 'Download media' });
    contentEl.createEl('p', { text: this.name });

    const row = contentEl.createDiv({ cls: 'modal-button-container' });
    for (const [value, label] of [
      ['video_and_audio', 'Video + Audio'],
      ['video_only', 'Video'],
      ['audio_only', 'Audio'],
      ['subs_only', 'Subtitles'],
      ['skip', 'Skip'],
    ]) {
      const b = row.createEl('button', { text: label });
      if (value === 'video_and_audio') b.addClass('mod-cta');
      b.onclick = () => this.finish(value);
    }

    const remember = contentEl.createDiv();
    const cb = remember.createEl('input', { type: 'checkbox' });
    cb.id = 'arch-yt-remember';
    cb.onchange = () => {
      this.remember = cb.checked;
    };
    remember.createEl('label', {
      text: ' Use this for the rest of this session',
      attr: { for: 'arch-yt-remember' },
    });
  }

  finish(mode) {
    this.answered = true;
    this.close();
    this.done(mode, this.remember);
  }

  onClose() {
    this.contentEl.empty();
    // Closing with Escape is a skip, not a hang.
    if (!this.answered) this.done(null, false);
  }
}

class YouTubeArchiverSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  save() {
    return this.plugin.saveSettings();
  }

  display() {
    const { containerEl } = this;
    const s = this.plugin.settings;
    containerEl.empty();

    new Setting(containerEl).setName('Playlists').setHeading();

    const srcBox = containerEl.createDiv();
    const renderSources = () => {
      srcBox.empty();
      srcBox.createEl('p', {
        text:
          'Target is a playlist URL, a playlist id, or a shortcut: Watch Later, Liked, History, ' +
          'Subscriptions. The second field is the playlist note name that videos link to. ' +
          'Topics are written once when a note is created \u2014 later syncs never overwrite them, ' +
          'so hand-sorting survives. A video in several playlists gets all of them in yt-playlist.',
        attr: { style: 'font-size:var(--font-ui-smaller); opacity:.75;' },
      });
      s.sources.forEach((src, i) => {
        const row = new Setting(srcBox).setName(`Source ${i + 1}`);
        row.addText((t) =>
          t.setPlaceholder('Watch Later').setValue(src.target || '').onChange(async (v) => {
            src.target = v.trim();
            await this.save();
          })
        );
        row.addText((t) =>
          t.setPlaceholder('Playlist note name').setValue(src.note || '').onChange(async (v) => {
            src.note = v.trim();
            await this.save();
          })
        );
        row.addExtraButton((b) =>
          b.setIcon('refresh-cw').setTooltip('Sync this source only').onClick(() => {
            if (!src.target) return this.plugin.toast('Fill in the target first.');
            this.plugin.syncSources([src]);
          })
        );
        row.addExtraButton((b) =>
          b.setIcon('trash').setTooltip('Remove').onClick(async () => {
            s.sources.splice(i, 1);
            await this.save();
            renderSources();
          })
        );
      });
      new Setting(srcBox)
        .addButton((b) =>
          b.setButtonText('Add source').onClick(async () => {
            s.sources.push({ target: '', note: '' });
            await this.save();
            renderSources();
          })
        )
        .addButton((b) => b.setButtonText('Sync all').setCta().onClick(() => this.plugin.syncAll()));
    };
    renderSources();

    /* ---- channels ---- */
    new Setting(containerEl).setName('Channels').setHeading();

    const { targets: channelTargets, rejected: channelRejected } = this.plugin.channelTargets();
    containerEl.createEl('p', {
      text:
        'One channel per line: @handle or any channel URL. Lines starting with # are ignored, so you can keep notes in here. ' +
        'Each channel becomes one note named after the channel, with its icon and banner, so the channel property on ' +
        'video notes links to it. Re-syncing keeps anything you added to the note by hand.',
      attr: { style: 'font-size:var(--font-ui-smaller); opacity:.75;' },
    });

    // Hundreds of rows is what made X Twitter's tab unusable, so the list is
    // one textarea behind a disclosure that remembers whether it was open.
    const details = containerEl.createEl('details');
    details.open = !!s.channelListOpen;
    const summaryText = channelTargets.length
      ? `Show the list (${channelTargets.length} channel${channelTargets.length === 1 ? '' : 's'}` +
        (channelRejected.length ? `, ${channelRejected.length} line${channelRejected.length === 1 ? '' : 's'} not a channel)` : ')')
      : 'Show the list (empty)';
    details.createEl('summary', { text: summaryText });
    details.addEventListener('toggle', async () => { s.channelListOpen = details.open; await this.save(); });
    const ta = details.createEl('textarea');
    ta.value = s.channelList || '';
    ta.rows = 12;
    ta.spellcheck = false;
    ta.placeholder = '@StarTalk\nhttps://www.youtube.com/@aiDotEngineer';
    ta.style.width = '100%';
    ta.style.fontFamily = 'var(--font-monospace)';
    let typing = null;
    ta.addEventListener('input', () => {
      // Debounced: saving on every keystroke of a long list is pointless work,
      // and re-rendering the tab mid-edit would steal focus.
      clearTimeout(typing);
      typing = setTimeout(async () => { s.channelList = ta.value; await this.save(); }, 400);
    });
    ta.addEventListener('blur', async () => { s.channelList = ta.value; await this.save(); this.display(); });

    new Setting(containerEl)
      .addButton((b) => b.setButtonText('Sync channels now').setCta().onClick(() => this.plugin.syncChannels()));

    new Setting(containerEl)
      .setName('Channel note location')
      .setDesc('Root and subfolder are relative to the archive root the playlists use.')
      .addDropdown((d) =>
        d
          .addOption('vault', 'Vault folder')
          .addOption('root', 'The archive root')
          .addOption('subfolder', 'In subfolder under the archive root')
          .addOption('specified', 'In the folder specified below')
          .setValue(s.channelLocationMode || 'specified')
          .onChange(async (v) => {
            s.channelLocationMode = v;
            await this.save();
            this.display();
          })
      );
    if (s.channelLocationMode === 'subfolder') {
      new Setting(containerEl)
        .setName('Channel subfolder name')
        .addText((t) =>
          t.setValue(s.channelSubfolder).onChange(async (v) => {
            s.channelSubfolder = v.trim() || 'Channels';
            await this.save();
          })
        );
    }
    if ((s.channelLocationMode || 'specified') === 'specified') {
      new Setting(containerEl)
        .setName('Channel folder')
        .setDesc('Path from the vault root.')
        .addText((t) =>
          t.setValue(s.channelFolder).onChange(async (v) => {
            s.channelFolder = v.trim();
            await this.save();
          })
        );
    }

    new Setting(containerEl)
      .setName('Channel image location')
      .setDesc('Where the icon and banner go. Same folder and subfolder are relative to the channel note.')
      .addDropdown((d) =>
        d
          .addOption('vault', 'Vault folder')
          .addOption('same', 'Same folder as the note')
          .addOption('subfolder', 'In subfolder under the note')
          .addOption('specified', 'In the folder specified below')
          .setValue(s.channelImageLocationMode || 'subfolder')
          .onChange(async (v) => {
            s.channelImageLocationMode = v;
            await this.save();
            this.display();
          })
      );
    if ((s.channelImageLocationMode || 'subfolder') === 'subfolder') {
      new Setting(containerEl)
        .setName('Channel image subfolder name')
        .addText((t) =>
          t.setValue(s.channelImageSubfolder).onChange(async (v) => {
            s.channelImageSubfolder = v.trim() || 'Images';
            await this.save();
          })
        );
    }
    if (s.channelImageLocationMode === 'specified') {
      new Setting(containerEl)
        .setName('Channel image folder')
        .setDesc('Path from the vault root.')
        .addText((t) =>
          t.setValue(s.channelImageFolder).onChange(async (v) => {
            s.channelImageFolder = v.trim();
            await this.save();
          })
        );
    }

    new Setting(containerEl)
      .setName('Icon and banner file names')
      .setDesc('Placeholders: {{channel}} is the channel name, {{handle}} its @handle.')
      .addText((t) => t.setPlaceholder('{{channel}} Icon').setValue(s.channelIconTemplate).onChange(async (v) => {
        s.channelIconTemplate = v.trim() || DEFAULT_SETTINGS.channelIconTemplate;
        await this.save();
      }))
      .addText((t) => t.setPlaceholder('{{channel}} Banner').setValue(s.channelBannerTemplate).onChange(async (v) => {
        s.channelBannerTemplate = v.trim() || DEFAULT_SETTINGS.channelBannerTemplate;
        await this.save();
      }));

    new Setting(containerEl)
      .setName('Channel image format')
      .setDesc('YouTube serves JPEG. WebP at quality 0.90 is about half the size and is what the rest of the vault uses.')
      .addDropdown((d) =>
        d.addOption('webp', 'WebP').addOption('keep', 'Keep what YouTube serves')
          .setValue(s.channelImageFormat || 'webp')
          .onChange(async (v) => { s.channelImageFormat = v; await this.save(); })
      );

    new Setting(containerEl)
      .setName('Re-download icons and banners on every sync')
      .setDesc('Off means an image already on disk is left alone, which is what makes a re-run of every channel cheap. Turn it on once to pick up changed pictures, then turn it off.')
      .addToggle((t) => t.setValue(!!s.refreshChannelImages).onChange(async (v) => { s.refreshChannelImages = v; await this.save(); }));

    new Setting(containerEl)
      .setName('Channel note tags')
      .setDesc('Comma-separated. ARCH After Clipping leaves notes tagged yt-channel alone; change both if you change this.')
      .addText((t) =>
        t.setValue((s.channelTags || []).join(', ')).onChange(async (v) => {
          s.channelTags = splitList(v);
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Default properties for channel notes')
      .setDesc('Same rules as the video note defaults, e.g. c-rank: 5.')
      .addTextArea((t) => {
        t.setPlaceholder('rank: 0').setValue(s.channelNoteDefaults || '').onChange(async (v) => {
          s.channelNoteDefaults = v;
          await this.save();
        });
        t.inputEl.rows = 2;
        t.inputEl.style.fontFamily = 'var(--font-monospace)';
      });

    new Setting(containerEl)
      .setName('Channel note property order')
      .setDesc('Comma-separated, same rules as the video note order.')
      .addText((t) =>
        t.setValue(s.channelNoteOrder).onChange(async (v) => {
          s.channelNoteOrder = v.trim() || DEFAULT_SETTINGS.channelNoteOrder;
          await this.save();
        })
      );

    new Setting(containerEl).setName('Output').setHeading();

    new Setting(containerEl)
      .setName('Video note property order')
      .setDesc('Comma-separated. A property you added by hand is placed where you list it, or kept at the end if unlisted; a name the plugin does not produce and the note does not have is skipped.')
      .addText((t) =>
        t.setValue(s.videoNoteOrder).onChange(async (v) => {
          s.videoNoteOrder = v.trim() || DEFAULT_SETTINGS.videoNoteOrder;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Default properties for video notes')
      .setDesc('One "key: value" per line. Written on every new note so the property is there to edit, and added to an existing note that lacks it on the next sync. A value already on a note is never changed. Position them with the order above.')
      .addTextArea((t) => {
        t.setPlaceholder('rank: 0\nstatus: Watch Later').setValue(s.videoNoteDefaults || '').onChange(async (v) => {
          s.videoNoteDefaults = v;
          await this.save();
        });
        t.inputEl.rows = 3;
        t.inputEl.style.fontFamily = 'var(--font-monospace)';
      });

    new Setting(containerEl)
      .setName('Playlist note property order')
      .setDesc('Comma-separated, same rules.')
      .addText((t) =>
        t.setValue(s.playlistNoteOrder).onChange(async (v) => {
          s.playlistNoteOrder = v.trim() || DEFAULT_SETTINGS.playlistNoteOrder;
          await this.save();
        })
      );

    new Setting(containerEl).setName('Media download').setHeading();

    new Setting(containerEl)
      .setName('Media location')
      .addDropdown((d) =>
        d
          .addOption('vault', 'Vault folder')
          .addOption('same', 'Same folder as the note')
          .addOption('subfolder', 'In subfolder under the note')
          .addOption('specified', 'In the folder specified below')
          .setValue(s.mediaLocationMode || 'subfolder')
          .onChange(async (v) => {
            s.mediaLocationMode = v;
            await this.save();
            this.display();
          })
      );

    if (s.mediaLocationMode === 'subfolder') {
      new Setting(containerEl)
        .setName('Media subfolder name')
        .addText((t) =>
          t.setValue(s.mediaSubfolder).onChange(async (v) => {
            s.mediaSubfolder = v.trim() || 'Materials';
            await this.save();
          })
        );
    }

    if (s.mediaLocationMode === 'specified') {
      new Setting(containerEl)
        .setName('Media folder')
        .setDesc('Vault-relative, or an absolute path outside the vault.')
        .addText((t) =>
          t.setValue(s.mediaFolder).onChange(async (v) => {
            s.mediaFolder = v.trim();
            await this.save();
          })
        );
    }

    new Setting(containerEl)
      .setName('Video quality')
      .setDesc('The best stream at or under this size is merged with the best audio. A video that only exists at a lower size is downloaded as is.')
      .addDropdown((d) => {
        d.addOption('0', 'Best available');
        d.addOption('2160', '4K or less');
        d.addOption('1440', '1440p or less');
        d.addOption('1080', '1080p or less');
        d.addOption('720', '720p or less');
        d.setValue(String(s.maxHeight || 0)).onChange(async (v) => {
          s.maxHeight = Number(v);
          await this.save();
        });
      });

    new Setting(containerEl)
      .setName('Audio format')
      .addDropdown((d) =>
        d
          .addOption('mp3', 'mp3')
          .addOption('m4a', 'm4a')
          .addOption('opus', 'opus')
          .addOption('flac', 'flac')
          .setValue(s.audioFormat || 'mp3')
          .onChange(async (v) => {
            s.audioFormat = v;
            await this.save();
          })
      );

    new Setting(containerEl)
      .setName('Download subtitles with the video')
      .setDesc('Uses the subtitle languages set above. Saved beside the video as .vtt.')
      .addToggle((t) =>
        t.setValue(s.downloadSubtitles).onChange(async (v) => {
          s.downloadSubtitles = v;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Keep only the best subtitle')
      .setDesc('yt-dlp fetches every track matching the language pattern. This removes the extras, keeping the original track where there is one.')
      .addToggle((t) =>
        t.setValue(s.keepOneSubtitle).onChange(async (v) => {
          s.keepOneSubtitle = v;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Ask what to download')
      .setDesc('Off means always use the default choice without a prompt.')
      .addToggle((t) =>
        t.setValue(s.askDownloadMode).onChange(async (v) => {
          s.askDownloadMode = v;
          await this.save();
          this.display();
        })
      );

    if (!s.askDownloadMode) {
      new Setting(containerEl)
        .setName('Default choice')
        .addDropdown((d) =>
          d
            .addOption('video_and_audio', 'Video + Audio')
            .addOption('video_only', 'Video')
            .addOption('audio_only', 'Audio')
            .addOption('subs_only', 'Subtitles')
            .setValue(s.defaultDownloadMode || 'video_and_audio')
            .onChange(async (v) => {
              s.defaultDownloadMode = v;
              await this.save();
            })
        );
    }

    new Setting(containerEl)
      .setName('Archive root')
      .setDesc('Playlist notes go here; each playlist gets a folder beside its note.')
      .addText((t) =>
        t.setValue(s.archiveRoot).onChange(async (v) => {
          s.archiveRoot = v.trim() || 'Playlists';
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Tags')
      .setDesc('Comma-separated, applied to every note a sync creates.')
      .addText((t) =>
        t.setValue((s.tags || []).join(', ')).onChange(async (v) => {
          s.tags = splitList(v);
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Include transcripts when fetching details')
      .setDesc('Applies to the per-note "Fetch details" command, not to syncing. Syncing never downloads subtitles.')
      .addToggle((t) =>
        t.setValue(s.transcript).onChange(async (v) => {
          s.transcript = v;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Download thumbnails')
      .setDesc('Saves each video\u2019s thumbnail into the vault and points the img property at it.')
      .addToggle((t) =>
        t.setValue(s.downloadThumbnails).onChange(async (v) => {
          s.downloadThumbnails = v;
          await this.save();
          this.display();
        })
      );

    if (s.downloadThumbnails) {
      new Setting(containerEl)
        .setName('Thumbnail location')
        .setDesc('Same choices as Obsidian\'s own attachment setting.')
        .addDropdown((d) =>
          d
            .addOption('obsidian', 'Follow Obsidian\'s attachment setting')
            .addOption('vault', 'Vault folder')
            .addOption('same', 'Same folder as the note')
            .addOption('subfolder', 'In subfolder under the note')
            .addOption('specified', 'In the folder specified below')
            .setValue(s.thumbnailLocationMode || 'subfolder')
            .onChange(async (v) => {
              s.thumbnailLocationMode = v;
              await this.save();
              this.display();
            })
        );

      if (s.thumbnailLocationMode === 'subfolder') {
        new Setting(containerEl)
          .setName('Thumbnail subfolder name')
          .addText((t) =>
            t.setValue(s.thumbnailSubfolder).onChange(async (v) => {
              s.thumbnailSubfolder = v.trim() || 'Materials';
              await this.save();
            })
          );
      }

      if (s.thumbnailLocationMode === 'specified') {
        new Setting(containerEl)
          .setName('Thumbnail folder')
          .setDesc('Path from the vault root.')
          .addText((t) =>
            t.setValue(s.thumbnailFolder).onChange(async (v) => {
              s.thumbnailFolder = v.trim();
              await this.save();
            })
          );
      }
    }

    new Setting(containerEl)
      .setName('Subtitle languages')
      .setDesc('yt-dlp filter. "en.*" takes English including auto-generated.')
      .addText((t) =>
        t.setValue(s.subtitleLangs).onChange(async (v) => {
          s.subtitleLangs = v.trim() || 'en.*';
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Note name')
      .setDesc('Placeholders: {{channel}} and {{title}}. Notes are created with this name, so nothing is renamed afterwards.')
      .addText((t) =>
        t.setValue(s.noteNameTemplate).onChange(async (v) => {
          s.noteNameTemplate = v.trim() || DEFAULT_SETTINGS.noteNameTemplate;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Fill publish dates after a sync')
      .setDesc(
        'The upload date is not in the fast listing a sync uses, so it is fetched once the ' +
          'notes exist. Skipped entirely when every note already has one, so re-syncing costs ' +
          'nothing. Turn off if you would rather run it by hand.'
      )
      .addToggle((t) =>
        t.setValue(s.fillDatesAfterSync !== false).onChange(async (v) => {
          s.fillDatesAfterSync = v;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Playlist note name')
      .setDesc(
        'Placeholders: {{channel}} is the playlist owner, {{title}} its title. A per-source ' +
          'playlist note name overrides this. Changing it does not rename playlist notes you ' +
          'already have \u2014 rename those in Obsidian first so the yt-playlist links follow.'
      )
      .addText((t) =>
        t.setValue(s.playlistNoteNameTemplate).onChange(async (v) => {
          s.playlistNoteNameTemplate = v.trim() || DEFAULT_SETTINGS.playlistNoteNameTemplate;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Pause that starts a new paragraph')
      .setDesc('Seconds of silence. Auto-captions have no punctuation, so a gap in the timing is the only clue a sentence ended.')
      .addText((t) =>
        t.setValue(String(s.transcriptGapSeconds)).onChange(async (v) => {
          const n = Number(v);
          s.transcriptGapSeconds = Number.isFinite(n) && n >= 0 ? n : 1.4;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Longest paragraph')
      .setDesc('Seconds. A safety cap for speakers who never pause. 0 writes one unbroken block.')
      .addText((t) =>
        t.setValue(String(s.transcriptParagraphSeconds)).onChange(async (v) => {
          const n = Number(v);
          s.transcriptParagraphSeconds = Number.isFinite(n) && n >= 0 ? n : 60;
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Description limit')
      .setDesc('Max lines kept after promo blocks and timestamp lists are stripped.')
      .addText((t) =>
        t.setValue(String(s.descriptionMaxLines)).onChange(async (v) => {
          const n = Number(v);
          s.descriptionMaxLines = Number.isFinite(n) && n >= 0 ? n : 20;
          await this.save();
        })
      );

    new Setting(containerEl).setName('yt-dlp').setHeading();

    new Setting(containerEl)
      .setName('Set up external tools')
      .setDesc('Finds yt-dlp, ffmpeg, a JavaScript runtime and your browsers, fills the fields in, and offers to install what is missing.')
      .addButton((b) =>
        b.setButtonText('Open setup').setCta().onClick(async () => {
          await this.plugin.setup();
          this.display();
        })
      )
      .addButton((b) =>
        b.setButtonText('Copy from ARCH After Clipping').onClick(async () => {
          await this.plugin.importFromClipArchiver();
          this.display();
        })
      );

    new Setting(containerEl)
      .setName('yt-dlp path')
      .addText((t) =>
        t.setValue(s.ytDlpPath).onChange(async (v) => {
          s.ytDlpPath = v.trim() || 'yt-dlp';
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('ffmpeg folder')
      .addText((t) =>
        t.setValue(s.ffmpegLocation).onChange(async (v) => {
          s.ffmpegLocation = v.trim();
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Cookies from browser')
      .setDesc('Needed for Watch Later, Liked and private playlists.')
      .addText((t) =>
        t.setValue(s.cookiesFromBrowser).onChange(async (v) => {
          s.cookiesFromBrowser = v.trim();
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Cookies file')
      .setDesc('Overrides the browser setting when set.')
      .addText((t) =>
        t.setValue(s.cookiesFile).onChange(async (v) => {
          s.cookiesFile = v.trim();
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('JavaScript runtime')
      .setDesc('Leave blank to let yt-dlp find one.')
      .addText((t) =>
        t.setValue(s.jsRuntime).setPlaceholder('auto').onChange(async (v) => {
          s.jsRuntime = v.trim();
          await this.save();
        })
      );

    new Setting(containerEl)
      .setName('Extra yt-dlp arguments')
      .addText((t) =>
        t.setValue(s.ytDlpExtraArgs).onChange(async (v) => {
          s.ytDlpExtraArgs = v.trim();
          await this.save();
        })
      );

  }
}
