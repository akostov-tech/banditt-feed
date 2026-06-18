const express = require('express');
const axios = require('axios');
const sharp = require('sharp');
const { parseStringPromise, Builder } = require('xml2js');
const NodeCache = require('node-cache');

const app = express();
const PORT = process.env.PORT || 3000;
const SOURCE_FEED = 'https://bandittwear.bg/wp-content/uploads/woo-feed/facebook/xml/facebook_catalog_export.xml';

const feedCache = new NodeCache({ stdTTL: 3600 });
const imageCache = new NodeCache({ stdTTL: 86400 });

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

function formatPrice(p) {
  const match = p.match(/([\d.]+)/);
  return match ? `${parseFloat(match[1]).toFixed(2)} lv.` : p;
}

async function fetchImageBuffer(url) {
  const res = await axios.get(url, {
    responseType: 'arraybuffer',
    timeout: 10000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  return Buffer.from(res.data);
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

async function buildAdImage(mainImageUrl, secondImageUrl, priceText, salePriceText, productTitle) {
  const cacheKey = `ad_${mainImageUrl}_${secondImageUrl}_${priceText}_${salePriceText}_${productTitle}`;
  const cached = imageCache.get(cacheKey);
  if (cached) return cached;

  try {
    const SIZE = 1080;          // финален квадрат 1080x1080
    const LEFT_W = 600;         // лява зона (продуктова снимка)
    const RIGHT_W = SIZE - LEFT_W; // дясна зона (480px)
    const PAD = 24;

    // ── 1. Лява снимка ──────────────────────────────────────────────────────
    const mainBuf = await fetchImageBuffer(mainImageUrl);
    const leftImg = await sharp(mainBuf)
      .resize(LEFT_W, SIZE, { fit: 'cover', position: 'centre' })
      .jpeg({ quality: 92 })
      .toBuffer();

    // ── 2. Дясна зона — бял фон ─────────────────────────────────────────────
    // Втора снимка (горна половина на дясната зона)
    const RIGHT_IMG_H = Math.round(SIZE * 0.46);
    let rightImgResized;
    if (secondImageUrl) {
      try {
        const secBuf = await fetchImageBuffer(secondImageUrl);
        rightImgResized = await sharp(secBuf)
          .resize(RIGHT_W - PAD * 2, RIGHT_IMG_H - PAD * 2, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
          .png()
          .toBuffer();
      } catch (_) { rightImgResized = null; }
    }

    // ── 3. SVG за дясната зона ──────────────────────────────────────────────
    const isOnSale = salePriceText && salePriceText !== priceText;
    const displayPrice = formatPrice(isOnSale ? salePriceText : priceText);
    const oldPrice = isOnSale ? formatPrice(priceText) : null;

    const titleFontSize = 30;
    const priceFontSize = 48;
    const oldPriceFontSize = 30;
    const btnH = 72;
    const btnY = SIZE - PAD * 3 - btnH;
    const btnX = PAD;
    const btnW = RIGHT_W - PAD * 2;
    const btnR = 8;

    // Заглавие — под втора снимка
    const titleStartY = RIGHT_IMG_H + PAD + titleFontSize;
    const titleLines = productTitle ? wrapTextLines(productTitle, 26, 2) : [];
    const titleSvgLines = titleLines.map((line, i) =>
      `<text x="${PAD}" y="${titleStartY + i * (titleFontSize + 6)}" font-family="Arial,sans-serif" font-size="${titleFontSize}" font-weight="600" fill="#222222">${escapeXml(line)}</text>`
    ).join('');
    const titleBlockH = titleLines.length * (titleFontSize + 6);

    // Цена позиция — под заглавието
    const priceY = titleStartY + titleBlockH + priceFontSize - 4;
    const oldPriceY = priceY + oldPriceFontSize + 8;

    let oldPriceSvg = '';
    if (oldPrice) {
      oldPriceSvg = `
        <text x="${PAD}" y="${oldPriceY}" font-family="Arial,sans-serif" font-size="${oldPriceFontSize}" fill="#AAAAAA">${oldPrice}</text>
        <line x1="${PAD}" y1="${oldPriceY - oldPriceFontSize * 0.4}" x2="${PAD + oldPrice.length * oldPriceFontSize * 0.55}" y2="${oldPriceY - oldPriceFontSize * 0.4}" stroke="#AAAAAA" stroke-width="2"/>
      `;
    }

    // Разделителна линия между ляво и дясно
    const dividerSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}">
        <line x1="${LEFT_W}" y1="40" x2="${LEFT_W}" y2="${SIZE - 40}" stroke="#E0E0E0" stroke-width="1"/>
      </svg>
    `;

    // SVG за дясна зона (текст, заглавие и бутон — снимката се composite-ва отделно)
    const rightSvg = `
      <svg xmlns="http://www.w3.org/2000/svg" width="${RIGHT_W}" height="${SIZE}">
        <rect width="${RIGHT_W}" height="${SIZE}" fill="#FFFFFF"/>

        <!-- Заглавие на продукта -->
        ${titleSvgLines}

        <!-- Цена -->
        <text x="${PAD}" y="${priceY}" font-family="Arial,sans-serif" font-size="${priceFontSize}" font-weight="bold" fill="#1a1a1a">${displayPrice}</text>
        ${oldPriceSvg}

        <!-- Бутон "Купи сега" -->
        <rect x="${btnX}" y="${btnY}" width="${btnW}" height="${btnH}" rx="${btnR}" fill="#1a1a1a"/>
        <text x="${btnX + btnW / 2}" y="${btnY + btnH / 2 + 10}" font-family="Arial,sans-serif" font-size="26" font-weight="bold" fill="#FFFFFF" text-anchor="middle">Купи сега</text>
      </svg>
    `;

    // ── 4. Сглобяване ───────────────────────────────────────────────────────
    // Бял canvas 1080x1080
    const base = await sharp({
      create: { width: SIZE, height: SIZE, channels: 3, background: { r: 255, g: 255, b: 255 } }
    }).png().toBuffer();

    const composites = [
      // Лява снимка
      { input: leftImg, left: 0, top: 0 },
      // Дясна SVG зона
      { input: Buffer.from(rightSvg), left: LEFT_W, top: 0 },
      // Разделителна линия
      { input: Buffer.from(dividerSvg), left: 0, top: 0 },
    ];

    // Втора снимка в дясната зона (горе)
    if (rightImgResized) {
      composites.push({
        input: rightImgResized,
        left: LEFT_W + PAD,
        top: PAD
      });
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
  const { url, url2, price, sale_price, title } = req.query;
  if (!url || !price) return res.status(400).send('Missing url or price');

  const buffer = await buildAdImage(
    decodeURIComponent(url),
    url2 ? decodeURIComponent(url2) : null,
    decodeURIComponent(price),
    sale_price ? decodeURIComponent(sale_price) : null,
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
      const price = item['g:price']?.[0];
      const salePrice = item['g:sale_price']?.[0];
      const title = item['title']?.[0] || item['g:title']?.[0];

      // Взимаме втората снимка ако съществува
      const additionalImages = item['g:additional_image_link'] || [];
      const secondImage = additionalImages.find(u => u && u.startsWith('http'));

      if (imageUrl && price) {
        const encodedUrl = encodeURIComponent(imageUrl);
        const encodedPrice = encodeURIComponent(price);
        const encodedSale = salePrice ? `&sale_price=${encodeURIComponent(salePrice)}` : '';
        const encodedUrl2 = secondImage ? `&url2=${encodeURIComponent(secondImage)}` : '';
        const encodedTitle = title ? `&title=${encodeURIComponent(title)}` : '';
        item['g:image_link'] = [`${baseUrl}/image?url=${encodedUrl}&price=${encodedPrice}${encodedSale}${encodedUrl2}${encodedTitle}`];
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
