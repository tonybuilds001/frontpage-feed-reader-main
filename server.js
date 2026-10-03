import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { convert } from 'html-to-text';
import Parser from 'rss-parser';

const app = express();
const port = Number(process.env.PORT) || 3000;
const root = path.dirname(fileURLToPath(import.meta.url));
const feedData = JSON.parse(await readFile(path.join(root, 'data/sample-feeds.json'), 'utf8'));
const parser = new Parser({ timeout: 10_000 });
const cacheDurationMs = 5 * 60 * 1000;
const maxFeedBytes = 10 * 1024 * 1024;
let cachedResult = null;
let lastFetchedAt = 0;
let activeRefresh = null;

const staticFiles = new Map([
  ['/index.html', 'index.html'],
  ['/styles.css', 'styles.css'],
  ['/script.js', 'script.js'],
  ['/firebase-config.js', 'firebase-config.js'],
  ['/starter/tokens.css', 'starter/tokens.css'],
  ['/data/sample-feeds.json', 'data/sample-feeds.json'],
]);

app.get('/', (request, response) => response.sendFile(path.join(root, 'index.html')));
for (const [route, file] of staticFiles) {
  app.get(route, (request, response) => response.sendFile(path.join(root, file)));
}

function getItemDate(item) {
  const rawDate = item.isoDate || item.pubDate || item.published || item.updated;
  if (!rawDate) return null;

  const date = new Date(rawDate);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function makeItemId(feedUrl, item) {
  const identity = item.guid || item.id || item.link || `${item.title || ''}:${item.isoDate || item.pubDate || ''}`;
  return createHash('sha256').update(`${feedUrl}|${identity}`).digest('hex').slice(0, 24);
}

function safeArticleUrl(value, fallback) {
  try {
    const url = new URL(value || fallback, fallback);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : fallback;
  } catch {
    return fallback;
  }
}

function toArticleText(item, fallback) {
  const content = item.content || item['content:encoded'] || item.summary || item.contentSnippet || fallback || '';
  return convert(String(content), {
    wordwrap: false,
    selectors: [{ selector: 'img', format: 'skip' }],
  }).replace(/\s+/g, ' ').trim().slice(0, 12_000);
}

async function fetchFeedOnce(feed, category) {
  const response = await fetch(feed.feedUrl, {
    headers: {
      accept: 'application/atom+xml, application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
      'user-agent': 'FrontpageFeedReader/1.0',
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`Feed returned HTTP ${response.status}`);
  }

  const contentLength = Number(response.headers.get('content-length'));
  if (contentLength > maxFeedBytes) {
    throw new Error('Feed response is larger than 2 MB');
  }

  const xml = await response.text();
  if (Buffer.byteLength(xml, 'utf8') > maxFeedBytes) {
    throw new Error('Feed response is larger than 2 MB');
  }

  const parsed = await parser.parseString(xml);
  const items = (parsed.items || []).map((item) => {
    const contentText = toArticleText(item, feed.description);
    return {
      id: makeItemId(feed.feedUrl, item),
      title: item.title?.trim() || 'Untitled article',
      source: feed.title || parsed.title || 'Unknown source',
      sourceUrl: safeArticleUrl(feed.siteUrl || parsed.link, feed.feedUrl),
      url: safeArticleUrl(item.link, feed.siteUrl || feed.feedUrl),
      category,
      author: item.creator || item.author || item['dc:creator'] || '',
      excerpt: contentText.slice(0, 420),
      contentText,
      publishedAt: getItemDate(item),
    };
  });

  return {
    items,
    status: {
      title: feed.title || parsed.title || feed.feedUrl,
      category,
      ok: true,
      itemCount: items.length,
      error: null,
    },
  };
}

async function fetchFeed(feed, category) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetchFeedOnce(feed, category);
    } catch (error) {
      if (attempt === 2 || error.message !== 'fetch failed') throw error;
      await new Promise((resolve) => setTimeout(resolve, 500 * (attempt + 1)));
    }
  }
}

async function mapWithLimit(entries, limit, callback) {
  const results = new Array(entries.length);
  let nextIndex = 0;

  async function worker() {
    while (nextIndex < entries.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await callback(entries[index]);
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, entries.length) }, worker));
  return results;
}

async function refreshFeeds(force) {
  const now = Date.now();
  const cacheIsFresh = cachedResult && now - lastFetchedAt < cacheDurationMs;

  if (cacheIsFresh && !force) return cachedResult;
  if (activeRefresh) return activeRefresh;

  activeRefresh = (async () => {
    const feeds = feedData.categories.flatMap((category) =>
      category.feeds.map((feed) => ({ feed, category: category.name }))
    );

    const results = await mapWithLimit(feeds, 3, async ({ feed, category }) => {
      try {
        return await fetchFeed(feed, category);
      } catch (error) {
        return {
          items: [],
          status: {
            title: feed.title,
            category,
            ok: false,
            itemCount: 0,
            error: error.name === 'TimeoutError' ? 'Feed request timed out' : error.message,
          },
        };
      }
    });

    const uniqueItems = new Map();
    results.forEach((result) => result.items.forEach((item) => uniqueItems.set(item.id, item)));

    cachedResult = {
      articles: [...uniqueItems.values()].sort((first, second) => {
        const firstDate = first.publishedAt ? Date.parse(first.publishedAt) : 0;
        const secondDate = second.publishedAt ? Date.parse(second.publishedAt) : 0;
        return secondDate - firstDate;
      }),
      feeds: results.map((result) => result.status),
      fetchedAt: new Date().toISOString(),
    };
    lastFetchedAt = Date.now();
    return cachedResult;
  })();

  try {
    return await activeRefresh;
  } finally {
    activeRefresh = null;
  }
}

app.get('/api/articles', async (request, response) => {
  response.set('Cache-Control', 'no-store');
  const category = typeof request.query.category === 'string' ? request.query.category : '';
  const validCategories = new Set(feedData.categories.map((entry) => entry.name));

  if (category && !validCategories.has(category)) {
    return response.status(400).json({ error: 'Unknown feed category' });
  }

  try {
    const result = await refreshFeeds(request.query.refresh === '1');
    const articles = category
      ? result.articles.filter((article) => article.category === category)
      : result.articles;

    return response.json({
      ...result,
      articles: articles.map(({ contentText, ...article }) => article),
    });
  } catch (error) {
    return response.status(502).json({ error: 'Unable to refresh feeds', details: error.message });
  }
});

app.get('/api/articles/:id', async (request, response) => {
  response.set('Cache-Control', 'no-store');
  const result = cachedResult || await refreshFeeds(false);
  const article = result.articles.find((item) => item.id === request.params.id);

  if (!article) return response.status(404).json({ error: 'Article not found in the latest feed data' });

  return response.json({ article });
});

app.listen(port, () => {
  console.log(`Frontpage is running at http://localhost:${port}`);
});
