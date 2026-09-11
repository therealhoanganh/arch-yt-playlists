'use strict';

// Channel notes: turning a pasted list of channel addresses into what yt-dlp
// needs, and yt-dlp's channel JSON into the few facts a note carries.
//
// IMPORTANT: nothing in lib/ may `require('obsidian')`. See archiver.js.

// Accepts what a person pastes: "@handle", "handle", or any channel address
// (with or without a trailing tab such as /videos or /about). Returns the
// address yt-dlp should be given, or null for anything that is not a channel --
// a watch or playlist address is a different feature.
function channelUrlFromInput(raw) {
  const t = String(raw || '').trim().replace(/^<|>$/g, '');
  if (!t) return null;

  const m = t.match(/^(?:https?:\/\/)?(?:www\.|m\.)?youtube\.com\/(@[^/?#\s]+|channel\/[^/?#\s]+|c\/[^/?#\s]+|user\/[^/?#\s]+)/i);
  if (m) return `https://www.youtube.com/${m[1]}`;
  if (/youtube\.com|youtu\.be/i.test(t)) return null;   // some other YouTube address

  const handle = t.replace(/^@/, '');
  if (/^[\w.\-]{3,30}$/.test(handle)) return `https://www.youtube.com/@${handle}`;
  return null;
}

// The largest square thumbnail is the avatar; the widest strip is the banner
// as YouTube shows it on a desktop. The *_uncropped entries carry no size, so
// they are the fallback rather than the first choice: the uncropped banner is
// a 16:9 image that YouTube crops differently per device, not the banner as
// seen on the channel page.
function channelFromJson(j) {
  const thumbs = Array.isArray(j.thumbnails) ? j.thumbnails : [];
  const sized = thumbs.filter((t) => t && t.url && t.width && t.height);
  const squares = sized.filter((t) => t.width === t.height);
  const strips = sized.filter((t) => t.width / t.height >= 3);
  const byWidth = (a, b) => b.width - a.width;
  const byId = (id) => thumbs.find((t) => t && t.id === id && t.url);

  const icon = (squares.sort(byWidth)[0] || byId('avatar_uncropped') || {}).url || '';
  const banner = (strips.sort(byWidth)[0] || byId('banner_uncropped') || {}).url || '';

  const handle = String(j.uploader_id || '').startsWith('@') ? j.uploader_id : '';
  return {
    name: String(j.channel || j.uploader || j.title || '').trim(),
    id: String(j.channel_id || j.id || ''),
    handle,
    // The @handle address is what a person recognises; the /channel/UC.. form
    // is the fallback for the rare channel without one.
    url: handle ? `https://www.youtube.com/${handle}` : String(j.channel_url || j.uploader_url || j.webpage_url || ''),
    icon,
    banner,
    followers: Number.isFinite(j.channel_follower_count) ? j.channel_follower_count : null,
  };
}

function channelImageStem(template, ch, fallback) {
  return String(template || fallback)
    .replace(/\{\{channel\}\}/gi, ch.name || ch.handle || 'channel')
    .replace(/\{\{handle\}\}/gi, ch.handle || ch.name || 'channel');
}

module.exports = { channelUrlFromInput, channelFromJson, channelImageStem };
