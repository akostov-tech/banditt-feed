const express = require('express');
const axios = require('axios');
const { createCanvas, loadImage } = require('canvas');
const { parseStringPromise, Builder } = require('xml2js');
const NodeCache = require('node-cache');

const app = express();
const PORT = process.env.PORT || 3000;
const SOURCE_FEED = 'https://bandittwear.bg/wp-content/uploads/woo-feed/facebook/xml/facebook_catalog_export.xml';
const CACHE_TTL = 3600; // 1 час в секунди

// Cache: XML фийд се пази 1 час, снимките се пазят 24 часа
const feedCache = new NodeCache({ stdTTL: CACHE_TTL });
const imageCache = new NodeCache({ stdTTL: 86400 });

// ─── Изтегля и парси оригиналния фийд ───────────────────────────────────────
async function fetchFeed() {
  const cached = feedCache.get('feed');
  if (cached) return cached;

  console.log('[Feed] Изтегляне от Bandittwear...');
  const { data } = await axios.get(SOURCE_FEED, {
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FeedBot/1.0)' }
  });

  const parsed = await parseStringPromise(data, { explicitArray: true });
  feedCache.set('feed', parsed);
  console.log('[Feed] Кешован за 1 час.');
  return parsed;
}

// ─── Нанася цената като overlay върху снимката ───────────────────────────────
async function addPriceOverlay(imageUrl, priceText, salePriceText) {
  const cacheKey = `img_${imageUrl}_${priceText}`;
  const cached = imageCache.get(cacheKey);
  if (cached) return cached;

  try {
    // Изтегляме снимката
    const response = await axios.get(imageUrl, {
      responseType: 'arraybuffer',
      timeout: 10000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });
    const imgBuffer = Buffer.from(response.data);
    const img = await loadImage(imgBuffer);

    // Canvas с размерите на оригинала (max 1200x1200 за Мета)
    const size = Math.min(Math.max(img.width, img.height), 1200);
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext('2d');

    // Бял фон (за продукти с прозрачност)
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, size, size);

    // Центрираме снимката
    const scale = Math.min(size / img.width, size / img.height);
    const drawW = img.width * scale;
    const drawH = img.height * scale;
    const drawX = (size - drawW) / 2;
    const drawY = (size - drawH) / 2;
    ctx.drawImage(img, drawX, drawY, drawW, drawH);

    // ── Ценови badge (долу-дясно) ────────────────────────────────────────
    const isOnSale = salePriceText && salePriceText !== priceText;
    const displayPrice = isOnSale ? salePriceText : priceText;

    // Форматиране — вземаме само числото + BGN
    const formatPrice = (p) => {
      const match = p.match(/([\d.]+)/);
      return match ? `${parseFloat(match[1]).toFixed(2)} лв.` : p;
    };

    const priceLabel = formatPrice(displayPrice);
    const badgePad = Math.round(size * 0.025);
    const fontSize = Math.round(size * 0.058);
    const smallFontSize = Math.round(size * 0.038);

    ctx.font = `bold ${fontSize}px Arial, sans-serif`;
    const priceWidth = ctx.measureText(priceLabel).width;
    const badgeW = priceWidth + badgePad * 2.5;
    const badgeH = fontSize + badgePad * 1.6;
    const badgeX = size - badgeW - Math.round(size * 0.03);
    const badgeY = size - badgeH - Math.round(size * 0.03);
    const radius = Math.round(size * 0.018);

    // Shadow под badge
    ctx.shadowColor = 'rgba(0,0,0,0.35)';
    ctx.shadowBlur = Math.round(size * 0.015);
    ctx.shadowOffsetY = Math.round(size * 0.006);

    // Badge фон
    ctx.fillStyle = isOnSale ? '#E74C3C' : '#1a1a1a';
    roundRect(ctx, badgeX, badgeY, badgeW, badgeH, radius);
    ctx.fill();

    ctx.shadowColor = 'transparent';
    ctx.shadowBlur = 0;
    ctx.shadowOffsetY = 0;

    // Цена текст
    ctx.fillStyle = '#FFFFFF';
    ctx.font = `bold ${fontSize}px Arial, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(priceLabel, badgeX + badgeW / 2, badgeY + badgeH / 2);

    // Ако има намаление — показваме старата цена зачертана
    if (isOnSale) {
      const oldLabel = formatPrice(priceText);
      ctx.font = `${smallFontSize}px Arial, sans-serif`;
      const oldW = ctx.measureText(oldLabel).width;
      const oldBadgeW = oldW + badgePad * 1.8;
      const oldBadgeH = smallFontSize + badgePad * 1.2;
      const oldBadgeX = badgeX - oldBadgeW - Math.round(size * 0.012);
      const oldBadgeY = badgeY + (badgeH - oldBadgeH) / 2;

      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      roundRect(ctx, oldBadgeX, oldBadgeY, oldBadgeW, oldBadgeH, radius * 0.7);
      ctx.fill();

      ctx.fillStyle = '#CCCCCC';
      ctx.fillText(oldLabel, oldBadgeX + oldBadgeW / 2, oldBadgeY + oldBadgeH / 2);

      // Зачертаване
      const textY = oldBadgeY + oldBadgeH / 2;
      const textX = oldBadgeX + oldBadgeW / 2 - oldW / 2;
      ctx.strokeStyle = '#AAAAAA';
      ctx.lineWidth = Math.round(size * 0.003);
      ctx.beginPath();
      ctx.moveTo(textX, textY);
      ctx.lineTo(textX + oldW, textY);
      ctx.stroke();
    }

    const pngBuffer = canvas.toBuffer('image/png');
    imageCache.set(cacheKey, pngBuffer);
    return pngBuffer;

  } catch (err) {
    console.error(`[Image] Грешка за ${imageUrl}:`, err.message);
    return null;
  }
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

// ─── Endpoint: обработена снимка ─────────────────────────────────────────────
app.get('/image', async (req, res) => {
  const { url, price, sale_price } = req.query;
  if (!url || !price) return res.status(400).send('Липсва url или price');

  const buffer = await addPriceOverlay(
    decodeURIComponent(url),
    decodeURIComponent(price),
    sale_price ? decodeURIComponent(sale_price) : null
  );

  if (!buffer) return res.status(502).send('Не може да се обработи снимката');

  res.set('Content-Type', 'image/png');
  res.set('Cache-Control', 'public, max-age=86400');
  res.send(buffer);
});

// ─── Endpoint: генериран XML фийд ────────────────────────────────────────────
app.get('/feed.xml', async (req, res) => {
  try {
    const feed = await fetchFeed();
    const baseUrl = `${req.protocol}://${req.get('host')}`;
    const items = feed?.rss?.channel?.[0]?.item || [];

    // Rebuild XML с модифицирани image_link
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

    // Строим нов XML
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
          description: ['Bandittwear enriched feed - price overlay by Feed Proxy'],
          item: newItems
        }]
      }
    };

    const xml = builder.buildObject(outputObj);

    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=3600');
    res.send(xml);

  } catch (err) {
    console.error('[Feed] Грешка:', err.message);
    res.status(500).send('Грешка при генериране на фийда');
  }
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    status: 'ok',
    endpoints: {
      feed: '/feed.xml — Мета каталог фийд с цени върху снимките',
      image: '/image?url=...&price=...&sale_price=... — единична обработена снимка'
    },
    cache: {
      feed_ttl: '1 час',
      image_ttl: '24 часа'
    }
  });
});

app.listen(PORT, () => {
  console.log(`✅ Сървърът работи на порт ${PORT}`);
  console.log(`📦 Feed: http://localhost:${PORT}/feed.xml`);
});
