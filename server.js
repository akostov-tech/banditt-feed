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
  console.log('[Feed] Fetching from Bandittwear...');
  const { data } = await axios.get(SOURCE_FEED, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FeedBot/1.0)' }
  });
  const parsed = await parseStringPromise(data, { explicitArray: true });
  feedCache.set('feed', parsed);
  console.log('[Feed] Cached for 1 hour.');
  return parsed;
}

function formatPrice(p) {
  const match = p.match(/([\d.]+)/);
  return match ? `${parseFloat(match[1]).toFixed(2)} lv.` : p;
}

function makePriceSvg(priceText, salePriceText, width) {
  const isOnSale = salePriceText && salePriceText !== priceText;
  const displayPrice = formatPrice(isOnSale ? salePriceText : priceText);
  const oldPrice = isOnSale ? formatPrice(priceText) : null;

  const badgeBg = isOnSale ? '#E74C3C' : '#1a1a1a';
  const fontSize = Math.round(width * 0.07);
  const smallFont = Math.round(width * 0.045);
  const pad = Math.round(width * 0.03);
  const bh = fontSize + pad * 2;
  const charW = fontSize * 0.6;
  const bw = Math.round(displayPrice.length * charW + pad * 3);
  const bx = width - bw - pad;
  const by = width - bh - pad;
  const r = Math.round(width * 0.02);

  let oldPriceSvg = '';
  if (oldPrice) {
    const ow = Math.round(oldPrice.length * smallFont * 0.6 + pad * 2);
    const oh = smallFont + pad * 1.5;
    const ox = bx - ow - Math.round(width * 0.015);
    const oy = by + (bh - oh) / 2;
    const or2 = Math.round(width * 0.013);
    const textX = ox + ow / 2;
    const textY = oy + oh / 2 + smallFont * 0.35;
    const strikeY = oy + oh / 2;
    const strikeX1 = ox + pad * 0.8;
    const strikeX2 = ox + ow - pad * 0.8;
    oldPriceSvg = `
      <rect x="${ox}" y="${oy}" width="${ow}" height="${oh}" rx="${or2}" fill="rgba(0,0,0,0.6)"/>
      <text x="${textX}" y="${textY}" font-family="Arial,sans-serif" font-size="${smallFont}" fill="#CCCCCC" text-anchor="middle">${oldPrice}</text>
      <line x1="${strikeX1}" y1="${strikeY}" x2="${strikeX2}" y2="${strikeY}" stroke="#AAAAAA" stroke-width="2"/>
    `;
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${width}">
    ${oldPriceSvg}
    <rect x="${bx}" y="${by}" width="${bw}" height="${bh}" rx="${r}" fill="${badgeBg}"/>
    <text x="${bx + bw / 2}" y="${by + bh / 2 + fontSize * 0.35}" font-family="Arial,sans-serif" font-size="${fontSize}" font-weight="bold" fill="#FFFFFF" text-anchor="middle">${displayPrice}</text>
  </svg>`;
}

async function addPriceOverlay(imageUrl, priceText, salePriceText) {
  const cacheKey = `img_${imageUrl}_${priceText}_${salePriceText}`;
  const cached = imageCache.get(cacheKey);
  if (cached) return cached;

  try {
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const imgBuffer = Buffer.from(response.data);
    const meta = await sharp(imgBuffer).metadata();
    const size = Math.min(Math.max(meta.width, meta.height), 1200);

    // Resize to square with white background
    const resized = await sharp(imgBuffer)
      .resize(size, size, { fit: 'contain', background: { r: 255, g: 255, b: 255, alpha: 1 } })
      .png()
      .toBuffer();

    // Create SVG overlay with price
    const svgOverlay = Buffer.from(makePriceSvg(priceText, salePriceText, size));

    const result = await sharp(resized)
      .composite([{ input: svgOverlay, top: 0, left: 0 }])
      .jpeg({ quality: 90 })
      .toBuffer();

    imageCache.set(cacheKey, result);
    return result;
  } catch (err) {
    console.error(`[Image] Error for ${imageUrl}:`, err.message);
    return null;
  }
}

app.get('/image', async (req, res) => {
  const { url, price, sale_price } = req.query;
  if (!url || !price) return res.status(400).send('Missing url or price');

  const buffer = await addPriceOverlay(
    decodeURIComponent(url),
    decodeURIComponent(price),
    sale_price ? decodeURIComponent(sale_price) : null
  );

  if (!buffer) return res.status(502).send('Could not process image');

  res.set('Content-Type', 'image/jpeg');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(buffer);
});

app.get('/feed.xml', async (req, res) => {
  try {
    const feed = await fetchFeed();
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const items = feed?.rss?.channel?.[0]?.item || [];

    const newItems = items.map(item => {
      const imageUrl = item['g:image_link']?.[0];
      const price = item['g:price']?.[0];
      const salePrice = item['g:sale_price']?.[0];

      if (imageUrl && price) {
        const encodedUrl = encodeURIComponent(imageUrl);
        const encodedPrice = encodeURIComponent(price);
        const encodedSale = salePrice ? `&sale_price=${encodeURIComponent(salePrice)}` : '';
        item['g:image_link'] = [`${baseUrl}/image?url=${encodedUrl}&price=${encodedPrice}${encodedSale}`];
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
          description: ['Bandittwear enriched feed with price overlay'],
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

app.get('/', (req, res) => {
  res.json({ status: 'ok', feed: '/feed.xml' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
