const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const { parseStringPromise, Builder } = require('xml2js');
const NodeCache = require('node-cache');

const app = express();
const PORT = process.env.PORT || 3000;
const SOURCE_FEED = 'https://bandittwear.bg/wp-content/uploads/woo-feed/facebook/xml/facebook_catalog_export.xml';
const LOGO_URL = 'https://raw.githubusercontent.com/akostov-tech/banditt-feed/main/logo.png';
const BRAND_NAME = 'BANDITT WEAR';

const feedCache = new NodeCache({ stdTTL: 3600 });
const imageCache = new NodeCache({ stdTTL: 86400 });
let logoCache = null;

async function fetchFeed() {
  const cached = feedCache.get('feed');
  if (cached) return cached;
  console.log('[Feed] Fetching...');
  const { data } = await axios.get(SOURCE_FEED, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FeedBot/1.0)' }
  });
  const parsed = await parseStringPromise(data, { explicitArray: true });
  feedCache.set('feed', parsed);
  return parsed;
}

async function fetchImageBuffer(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  return Buffer.from(res.data);
}

async function getLogoCircleBuffer(diameter) {
  const cacheKey = `logo_${diameter}`;
  const cached = imageCache.get(cacheKey);
  if (cached) return cached;

  try {
    if (!logoCache) {
      logoCache = await fetchImageBuffer(LOGO_URL);
    }
    // Crop logo into a circle
    const circleMask = Buffer.from(
      `<svg width="${diameter}" height="${diameter}"><circle cx="${diameter / 2}" cy="${diameter / 2}" r="${diameter / 2}" fill="#fff"/></svg>`
    );
    const resizedLogo = await sharp(logoCache)
      .resize(diameter, diameter, { fit: 'cover', position: 'centre' })
      .toBuffer();

    const circular = await sharp(resizedLogo)
      .composite([{ input: circleMask, blend: 'dest-in' }])
      .png()
      .toBuffer();

    imageCache.set(cacheKey, circular);
    return circular;
  } catch (err) {
    console.error('[Logo] Error:', err.message);
    return null;
  }
}

function escapeXml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapTextLines(text, maxCharsPerLine, maxLines) {
  const words = text.split(' ');
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = (line + ' ' + w).trim();
    if (test.length > maxCharsPerLine && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
    if (lines.length >= maxLines) break;
  }
  if (line && lines.length < maxLines) lines.push(line);
  return lines.slice(0, maxLines);
}

// ── Marpipe-style banner: лого+бранд горе, echo-ефект, заглавие, SHOP NOW бар ──
async function buildAdImage(mainImageUrl, productTitle) {
  const cacheKey = `ad_${mainImageUrl}_${productTitle}`;
  const cached = imageCache.get(cacheKey);
  if (cached) return cached;

  try {
    const SIZE = 1080;
    const HEADER_H = 130;          // лого + бранд зона
    const FOOTER_H = 150;          // заглавие + SHOP NOW бар зона
    const SHOP_BAR_H = 90;
    const PHOTO_H = SIZE - HEADER_H - FOOTER_H;
    const SIDE_ECHO_W = 90;        // ширина на страничните echo ленти

    // ── 1. Основна снимка (централна, по-висока резолюция) ──────────────────
    const mainBuf = await fetchImageBuffer(mainImageUrl);
    const centerImg = await sharp(mainBuf)
      .resize(SIZE - SIDE_ECHO_W * 2, PHOTO_H, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 92 })
      .toBuffer();

    // ── 2. Echo ленти (странични, замъглени/затъмнени копия) ────────────────
    const echoLeft = await sharp(mainBuf)
      .resize(SIDE_ECHO_W * 3, PHOTO_H, { fit: 'cover', position: 'left' })
      .extract({ left: 0, top: 0, width: SIDE_ECHO_W, height: PHOTO_H })
      .modulate({ brightness: 0.75 })
      .blur(1.5)
      .jpeg({ quality: 85 })
      .toBuffer();

    const echoRight = await sharp(mainBuf)
      .resize(SIDE_ECHO_W * 3, PHOTO_H, { fit: 'cover', position: 'right' })
      .extract({ left: SIDE_ECHO_W * 2, top: 0, width: SIDE_ECHO_W, height: PHOTO_H })
      .modulate({ brightness: 0.75 })
      .blur(1.5)
      .jpeg({ quality: 85 })
      .toBuffer();

    // ── 3. Лого кръг ──────────────────────────────────────────────────────
    const logoDiameter = 76;
    const logoCircle = await getLogoCircleBuffer(logoDiameter);

    // ── 4. Заглавие на продукта ──────────────────────────────────────────
    const titleLines = productTitle ? wrapTextLines(productTitle, 38, 2) : [];
    const titleFontSize = 26;

    // ── 5. SVG слоеве: header bg, текст бранд, заглавие, shop now бар ───────
    const headerSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
        <rect x="0" y="0" width="${SIZE}" height="${HEADER_H}" fill="#FFFFFF"/>
        <text x="${28 + logoDiameter + 22}" y="${HEADER_H / 2 + 10}" font-family="Arial,sans-serif" font-size="32" font-weight="800" letter-spacing="1" fill="#1a1a1a">${escapeXml(BRAND_NAME)}</text>
        <line x1="0" y1="${HEADER_H}" x2="${SIZE}" y2="${HEADER_H}" stroke="#EAEAEA" stroke-width="2"/>
      </svg>
    `;

    const footerStartY = HEADER_H + PHOTO_H;
    const titleY1 = footerStartY + 38;
    const titleSvgLines = titleLines.map((line, i) =>
      `<text x="${SIZE / 2}" y="${titleY1 + i * (titleFontSize + 8)}" font-family="Arial,sans-serif" font-size="${titleFontSize}" fill="#333333" text-anchor="middle">${escapeXml(line)}</text>`
    ).join('');

    const shopBarY = SIZE - SHOP_BAR_H;
    const footerSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
        <rect x="0" y="${footerStartY}" width="${SIZE}" height="${FOOTER_H - SHOP_BAR_H}" fill="#FFFFFF"/>
        ${titleSvgLines}
        <rect x="0" y="${shopBarY}" width="${SIZE}" height="${SHOP_BAR_H}" fill="#1a1a1a"/>
        <text x="40" y="${shopBarY + SHOP_BAR_H / 2 + 9}" font-family="Arial,sans-serif" font-size="26" font-weight="700" letter-spacing="2" fill="#FFFFFF">SHOP NOW</text>
        <text x="${SIZE - 40}" y="${shopBarY + SHOP_BAR_H / 2 + 9}" font-family="Arial,sans-serif" font-size="26" font-weight="700" fill="#FFFFFF" text-anchor="end">&#9658;</text>
      </svg>
    `;

    // ── 6. Сглобяване ─────────────────────────────────────────────────────
    const base = await sharp({
      create: { width: SIZE, height: SIZE, channels: 3, background: { r: 255, g: 255, b: 255 } }
    }).png().toBuffer();

    const composites = [
      { input: echoLeft, left: 0, top: HEADER_H },
      { input: centerImg, left: SIDE_ECHO_W, top: HEADER_H },
      { input: echoRight, left: SIZE - SIDE_ECHO_W, top: HEADER_H },
      { input: Buffer.from(headerSvg), left: 0, top: 0 },
      { input: Buffer.from(footerSvg), left: 0, top: 0 },
    ];

    if (logoCircle) {
      composites.push({ input: logoCircle, left: 28, top: (HEADER_H - logoDiameter) / 2 });
    }

    const result = await sharp(base)
      .composite(composites)
      .jpeg({ quality: 92 })
      .toBuffer();

    imageCache.set(cacheKey, result);
    return result;

  } catch (err) {
    console.error(`[Image] Error:`, err.message);
    return null;
  }
}

// ── Endpoint: снимка ─────────────────────────────────────────────────────────
app.get('/image', async (req, res) => {
  const { url, title } = req.query;
  if (!url) return res.status(400).send('Missing url');

  const buffer = await buildAdImage(
    decodeURIComponent(url),
    title ? decodeURIComponent(title) : null
  );

  if (!buffer) return res.status(502).send('Could not process image');
  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(buffer);
});

// ── Endpoint: XML фийд ───────────────────────────────────────────────────────
app.get('/feed.xml', async (req, res) => {
  try {
    const feed = await fetchFeed();
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const items = feed?.rss?.channel?.[0]?.item || [];

    const newItems = items.map(item => {
      const imageUrl = item['g:image_link']?.[0];
      const title = item['title']?.[0] || item['g:title']?.[0];

      if (imageUrl) {
        const encodedUrl = encodeURIComponent(imageUrl);
        const encodedTitle = title ? `&title=${encodeURIComponent(title)}` : '';
        item['g:image_link'] = [`${baseUrl}/image?url=${encodedUrl}${encodedTitle}`];
      }
      return item;
    });

    const builder = new Builder({
      xmldec: { version: '1.0', encoding: 'UTF-8' },
      renderOpts: { pretty: true }
    });

    const outputObj = {
      rss: {
        $: {
          'xmlns:g': 'http://base.google.com/ns/1.0',
          'xmlns:c': 'http://base.google.com/cns/1.0',
          version: '2.0'
        },
        channel: [{
          title: feed.rss.channel[0].title,
          link: feed.rss.channel[0].link,
          description: ['Bandittwear enriched feed'],
          item: newItems
        }]
      }
    };

    const xml = builder.buildObject(outputObj);
    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(xml);
  } catch (err) {
    console.error('[Feed] Error:', err.message);
    res.status(500).send('Feed generation error');
  }
});

app.get('/', (req, res) => res.json({ status: 'ok', feed: '/feed.xml' }));

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
