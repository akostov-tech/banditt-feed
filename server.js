const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const { parseStringPromise, Builder } = require('xml2js');
const NodeCache = require('node-cache');
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

const SOURCE_FEED = 'https://bandittwear.bg/wp-content/uploads/woo-feed/facebook/xml/facebook_catalog_export.xml';
const LOGO_URL    = 'https://raw.githubusercontent.com/akostov-tech/banditt-feed/main/logo.png';
const BG_URL      = 'https://raw.githubusercontent.com/akostov-tech/banditt-feed/main/background.jpg';
const FONT_URL    = 'https://raw.githubusercontent.com/google/fonts/main/ofl/metalmania/MetalMania-Regular.ttf';
const FONT_PATH   = '/usr/local/share/fonts/MetalMania-Regular.ttf';
const BRAND       = 'BANDITT WEAR';

// ── Layout constants ──────────────────────────────────────────────────────────
const SIZE         = 1080;
const HEADER_H     = 140;
const TITLE_H      = 90;
const SHOP_BAR_H   = 90;
const FOOTER_H     = TITLE_H + SHOP_BAR_H;
const PHOTO_H      = SIZE - HEADER_H - FOOTER_H;   // 760px
const GAP          = 4;
const LEFT_W       = 600;
const RIGHT_W      = SIZE - LEFT_W - GAP;           // 476px
const RIGHT_TILE_H = Math.floor((PHOTO_H - GAP) / 2); // 378px

const feedCache  = new NodeCache({ stdTTL: 3600 });
const imageCache = new NodeCache({ stdTTL: 86400 });

// Pre-loaded static assets (loaded once at startup)
let bgHeaderBuf = null;
let bgTitleBuf  = null;
let bgShopBuf   = null;
let logoCircle  = null;

// ── Helpers ───────────────────────────────────────────────────────────────────
async function fetchBuf(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BandittFeed/1.0)' }
  });
  return Buffer.from(res.data);
}

function esc(s) {
  return String(s)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function cleanTitle(t) {
  if (!t) return '';
  return t.replace(/\s*[-–]\s*(XXXL|XXL|XL|XS|[SML]|\d{2,3})\s*$/i, '').trim();
}

function bat(cx, cy, sc, op) {
  return `<g transform="translate(${cx},${cy}) scale(${sc})" opacity="${op}" fill="#ffffff">
    <ellipse cx="0" cy="-2" rx="4" ry="6"/>
    <ellipse cx="-3" cy="-9" rx="2.5" ry="4"/>
    <ellipse cx="3"  cy="-9" rx="2.5" ry="4"/>
    <path d="M -4,-2 C -12,-28 -38,-22 -42,-8 C -38,2 -22,2 -4,4 Z"/>
    <path d="M  4,-2 C  12,-28  38,-22  42,-8 C  38,2  22,2  4,4 Z"/>
  </g>`;
}

// ── Font installation ─────────────────────────────────────────────────────────
async function ensureFont() {
  if (fs.existsSync(FONT_PATH)) {
    console.log('[Font] Metal Mania already installed.');
    return;
  }
  console.log('[Font] Downloading Metal Mania...');
  try {
    const fontBuf = await fetchBuf(FONT_URL);
    fs.mkdirSync(path.dirname(FONT_PATH), { recursive: true });
    fs.writeFileSync(FONT_PATH, fontBuf);
    execSync('fc-cache -f', { stdio: 'ignore' });
    console.log('[Font] Installed successfully.');
  } catch (err) {
    console.error('[Font] Failed:', err.message);
  }
}

// ── Logo circle ───────────────────────────────────────────────────────────────
async function buildLogoCircle(d) {
  const logoBuf = await fetchBuf(LOGO_URL);
  const inner   = Math.round(d * 0.70);
  const pad     = Math.round((d - inner) / 2);

  const logoResized = await sharp(logoBuf)
    .resize(inner, inner, { fit:'contain', background:{r:0,g:0,b:0,alpha:0} })
    .png().toBuffer();

  const darkCircle = Buffer.from(
    `<svg width="${d}" height="${d}"><circle cx="${d/2}" cy="${d/2}" r="${d/2}" fill="rgba(0,0,0,0.65)"/></svg>`
  );
  const mask = Buffer.from(
    `<svg width="${d}" height="${d}"><circle cx="${d/2}" cy="${d/2}" r="${d/2}" fill="#fff"/></svg>`
  );
  const base = await sharp({ create:{width:d,height:d,channels:4,background:{r:0,g:0,b:0,alpha:0}} }).png().toBuffer();
  const comp = await sharp(base).composite([{input:darkCircle},{input:logoResized,left:pad,top:pad}]).png().toBuffer();
  return sharp(comp).composite([{input:mask,blend:'dest-in'}]).png().toBuffer();
}

// ── Pre-load static assets ────────────────────────────────────────────────────
async function preloadAssets() {
  console.log('[Assets] Loading background and logo...');
  const bgRaw = await fetchBuf(BG_URL);

  bgHeaderBuf = await sharp(bgRaw)
    .resize(SIZE, HEADER_H, { fit:'cover', position:'top' })
    .jpeg({ quality:92 }).toBuffer();

  bgTitleBuf = await sharp(bgRaw)
    .resize(SIZE, TITLE_H, { fit:'cover', position:'bottom' })
    .jpeg({ quality:92 }).toBuffer();

  bgShopBuf = await sharp(bgRaw)
    .resize(SIZE, SHOP_BAR_H, { fit:'cover', position:'centre' })
    .modulate({ brightness:0.45 })
    .jpeg({ quality:92 }).toBuffer();

  logoCircle = await buildLogoCircle(82);
  console.log('[Assets] Ready.');
}

// ── Banner builder ────────────────────────────────────────────────────────────
async function buildBanner(img1Url, img2Url, img3Url, title) {
  const cacheKey = `banner_${img1Url}_${img2Url}_${img3Url}_${title}`;
  const cached = imageCache.get(cacheKey);
  if (cached) return cached;

  // ── Fetch product images ──────────────────────────────────────────────────
  const mainBuf = await fetchBuf(img1Url);

  let tile2Buf = null;
  if (img2Url) {
    try { tile2Buf = await fetchBuf(img2Url); } catch (_) {}
  }

  let tile3Buf = null;
  if (img3Url) {
    try { tile3Buf = await fetchBuf(img3Url); } catch (_) {}
  }

  // ── Resize tiles ──────────────────────────────────────────────────────────
  const tileLeft = await sharp(mainBuf)
    .resize(LEFT_W, PHOTO_H, { fit:'cover', position:'top' })
    .jpeg({ quality:92 }).toBuffer();

  const tileTR = await sharp(tile2Buf || mainBuf)
    .resize(RIGHT_W, RIGHT_TILE_H, { fit:'cover', position:'top' })
    .jpeg({ quality:92 }).toBuffer();

  const tileBR = await sharp(tile3Buf || mainBuf)
    .resize(RIGHT_W, RIGHT_TILE_H, { fit:'cover', position: tile3Buf ? 'top' : 'bottom' })
    .jpeg({ quality:92 }).toBuffer();

  // ── Centring: logo + brand name ───────────────────────────────────────────
  const logoDiam = 82;
  const estTextW = 390;
  const gx = Math.round((SIZE - logoDiam - 20 - estTextW) / 2);
  const tx = gx + logoDiam + 20;
  const my = Math.round(HEADER_H / 2);

  // ── SVG overlays ──────────────────────────────────────────────────────────
  const headerSVG = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${HEADER_H}">
  <defs>
    <filter id="sh"><feDropShadow dx="2" dy="3" stdDeviation="4" flood-color="#000" flood-opacity="0.9"/></filter>
  </defs>
  ${bat(110,55,0.55,0.38)} ${bat(210,28,0.38,0.28)}
  ${bat(960,70,0.50,0.35)} ${bat(850,25,0.32,0.25)}
  ${bat(430,18,0.42,0.28)} ${bat(650,100,0.45,0.32)}
  ${bat(760,40,0.30,0.22)}
  <text x="${tx}" y="${my+20}" font-family="Metal Mania" font-size="52"
    fill="#ffffff" filter="url(#sh)">${esc(BRAND)}</text>
</svg>`);

  const footerY = HEADER_H + PHOTO_H;
  const shopY   = SIZE - SHOP_BAR_H;
  const cleanedTitle = cleanTitle(title) || '';

  const titleSVG = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${TITLE_H}">
  <defs>
    <filter id="sh2"><feDropShadow dx="2" dy="2" stdDeviation="4" flood-color="#000" flood-opacity="0.85"/></filter>
  </defs>
  <text x="${SIZE/2}" y="${TITLE_H/2+16}" font-family="Metal Mania" font-size="36"
    fill="#ffffff" text-anchor="middle" filter="url(#sh2)">${esc(cleanedTitle)}</text>
</svg>`);

  const shopSVG = Buffer.from(`<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SHOP_BAR_H}">
  <defs>
    <filter id="sh3"><feDropShadow dx="1" dy="1" stdDeviation="3" flood-color="#000" flood-opacity="0.8"/></filter>
  </defs>
  <text x="44" y="${SHOP_BAR_H/2+14}" font-family="Metal Mania" font-size="34"
    letter-spacing="3" fill="#ffffff" filter="url(#sh3)">SHOP NOW</text>
  <text x="${SIZE-44}" y="${SHOP_BAR_H/2+13}" font-family="Metal Mania" font-size="30"
    fill="#ffffff" text-anchor="end">&#9658;</text>
</svg>`);

  // ── Composite ─────────────────────────────────────────────────────────────
  const base = await sharp({
    create:{ width:SIZE, height:SIZE, channels:3, background:{r:13,g:13,b:13} }
  }).png().toBuffer();

  const result = await sharp(base).composite([
    { input: tileLeft,    left: 0,            top: HEADER_H },
    { input: tileTR,      left: LEFT_W + GAP, top: HEADER_H },
    { input: tileBR,      left: LEFT_W + GAP, top: HEADER_H + RIGHT_TILE_H + GAP },
    { input: bgHeaderBuf, left: 0, top: 0 },
    { input: headerSVG,   left: 0, top: 0 },
    { input: logoCircle,  left: gx, top: Math.round((HEADER_H - logoDiam) / 2) },
    { input: bgTitleBuf,  left: 0, top: footerY },
    { input: titleSVG,    left: 0, top: footerY },
    { input: bgShopBuf,   left: 0, top: shopY },
    { input: shopSVG,     left: 0, top: shopY },
  ]).jpeg({ quality:94 }).toBuffer();

  imageCache.set(cacheKey, result);
  return result;
}

// ── Fetch & cache feed ────────────────────────────────────────────────────────
async function fetchFeed() {
  const cached = feedCache.get('feed');
  if (cached) return cached;
  console.log('[Feed] Fetching...');
  const { data } = await axios.get(SOURCE_FEED, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; BandittFeed/1.0)' }
  });
  const parsed = await parseStringPromise(data, { explicitArray: true });
  feedCache.set('feed', parsed);
  return parsed;
}

// ── Routes ────────────────────────────────────────────────────────────────────
app.get('/image', async (req, res) => {
  const { url, url2, url3, title } = req.query;
  if (!url) return res.status(400).send('Missing url');

  try {
    const buf = await buildBanner(
      decodeURIComponent(url),
      url2  ? decodeURIComponent(url2)  : null,
      url3  ? decodeURIComponent(url3)  : null,
      title ? decodeURIComponent(title) : ''
    );
    res.set('Content-Type', 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buf);
  } catch (err) {
    console.error('[Image] Error:', err.message);
    res.status(502).send('Image processing error');
  }
});

app.get('/feed.xml', async (req, res) => {
  try {
    const feed = await fetchFeed();
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const items = feed?.rss?.channel?.[0]?.item || [];

    const newItems = items.map(item => {
      const mainImg = item['g:image_link']?.[0];
      const title   = item['title']?.[0] || item['g:title']?.[0] || '';

      // Collect non-empty additional images
      const extras = (item['g:additional_image_link'] || [])
        .filter(u => u && u.trim().startsWith('http'));

      const img2 = extras[0] || null;
      const img3 = extras[1] || null;

      if (mainImg) {
        const p = new URLSearchParams();
        p.set('url',   mainImg);
        if (img2)  p.set('url2', img2);
        if (img3)  p.set('url3', img3);
        if (title) p.set('title', title);
        item['g:image_link'] = [`${baseUrl}/image?${p.toString()}`];
      }
      return item;
    });

    const builder = new Builder({
      xmldec: { version:'1.0', encoding:'UTF-8' },
      renderOpts: { pretty: true }
    });

    const out = {
      rss: {
        $: { 'xmlns:g':'http://base.google.com/ns/1.0', 'xmlns:c':'http://base.google.com/cns/1.0', version:'2.0' },
        channel: [{
          title: feed.rss.channel[0].title,
          link:  feed.rss.channel[0].link,
          description: ['Bandittwear enriched feed — banditt-feed-proxy'],
          item: newItems
        }]
      }
    };

    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(builder.buildObject(out));
  } catch (err) {
    console.error('[Feed] Error:', err.message);
    res.status(500).send('Feed error');
  }
});

app.get('/', (req, res) => res.json({ status:'ok', feed:'/feed.xml' }));

// ── Startup ───────────────────────────────────────────────────────────────────
(async () => {
  await ensureFont();
  await preloadAssets();
  app.listen(PORT, () => console.log(`✅ Server on port ${PORT}`));
})();
