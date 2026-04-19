import { load } from 'cheerio';

import { config } from '@/config';
import ConfigNotFoundError from '@/errors/types/config-not-found';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import { parseDate } from '@/utils/parse-date';
import puppeteer from '@/utils/puppeteer';

const allowDomain = new Set(['avbase.net', 'www.avbase.net']);

const setupPage = async (page) => {
    await page.setRequestInterception(true);
    page.on('request', (req) => {
        if (['image', 'stylesheet', 'font', 'media'].includes(req.resourceType())) {
            req.abort();
        } else {
            req.continue();
        }
    });
};

const extractItemsFromLegacyCards = ($, rootUrl, limit) =>
    $('div.relative')
        .slice(0, limit)
        .toArray()
        .map((el) => {
            const item = $(el);
            const id = item.find('.font-bold.text-gray-500').text().trim();
            const titleText = item.find('.text-md.font-bold').text().trim();
            const href = item.find('.text-md.font-bold').attr('href');
            if (!titleText || !href) {
                return;
            }

            const link = new URL(href, rootUrl).href;
            const cover = item.find('.w-28 img').attr('src');
            const pubDate = parseDate(item.find('.block.font-bold').text().trim());
            const actors = item
                .find('.chip span')
                .toArray()
                .map((e) => $(e).text().trim());

            return { id, titleText, link, cover, pubDate, actors };
        })
        .filter((item) => !!item);

const extractItemsFromWorkLinks = ($, rootUrl, limit) => {
    const workItems = new Map();

    $('a[href^="/works/"]').each((_, el) => {
        if (workItems.size >= limit) {
            return false;
        }

        const anchor = $(el);
        const href = anchor.attr('href');
        const titleText = anchor.text().trim();

        if (!href || !titleText) {
            return;
        }

        const link = new URL(href, rootUrl).href;
        if (workItems.has(link)) {
            return;
        }

        const container = anchor.closest('li,article,section,div,tr');
        const containerText = container.text().replaceAll(/\s+/g, ' ').trim();
        const codeMatch = containerText.match(/\b[A-Z]{2,6}-\d{2,5}\b/);
        const dateMatch = containerText.match(/\b\d{4}\/\d{2}\/\d{2}\b/);

        const actors = container
            .find('a[href^="/talents/"]')
            .toArray()
            .map((actor) => $(actor).text().trim())
            .filter((name) => !!name && !name.startsWith('他 '));
        const cover = container.find('img').first().attr('src');

        workItems.set(link, {
            id: codeMatch?.[0] ?? href.split('/').findLast(Boolean) ?? '',
            titleText,
            link,
            cover,
            pubDate: dateMatch ? parseDate(dateMatch[0]) : undefined,
            actors,
        });
    });

    return [...workItems.values()];
};

const ProcessItems = async (ctx, currentUrl, title) => {
    const domain = ctx.req.query('domain') ?? 'avbase.net';
    const url = new URL(currentUrl, `https://${domain}`);

    if (!config.feature.allow_user_supply_unsafe_domain && !allowDomain.has(url.hostname)) {
        throw new ConfigNotFoundError("This RSS is disabled unless 'ALLOW_USER_SUPPLY_UNSAFE_DOMAIN' is set to 'true'.");
    }

    const rootUrl = `https://${domain}`;
    const browser = await puppeteer();

    try {
        // 1. 列表页
        const listPage = await browser.newPage();
        await setupPage(listPage);

        if (config.avbase?.cookies) {
            const cookieArray = config.avbase.cookies.split(';').map((c) => {
                const eqIndex = c.indexOf('=');
                return {
                    name: c.slice(0, eqIndex).trim(),
                    value: c.slice(eqIndex + 1).trim(),
                    domain: url.hostname,
                };
            });
            await listPage.setCookie(...cookieArray);
        }

        await listPage.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
        try {
            await listPage.waitForFunction(() => document.title !== 'Just a moment...', { timeout: 12000 });
        } catch {
            logger.debug(`Cloudflare challenge may still be active for ${url.href}`);
        }
        try {
            await listPage.waitForSelector('div.relative, a[href^="/works/"]', { timeout: 12000 });
        } catch {
            logger.debug(`No known AVBASE list selectors found for ${url.href}`);
        }
        const listHtml = await listPage.content();
        await listPage.close();

        const $ = load(listHtml);
        const htmlTitle = $('title').text();
        const limit = ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit')) : 20;

        const legacyItems = extractItemsFromLegacyCards($, rootUrl, limit);
        const items = legacyItems.length > 0 ? legacyItems : extractItemsFromWorkLinks($, rootUrl, limit);

        const needsDetail: typeof items = [];
        const cachedResults = await Promise.all(
            items.map(async (item) => {
                try {
                    const cached = await cache.get(item.link);
                    if (cached) {
                        return cached;
                    }
                } catch {
                    // Ignore cache read failures and continue with detail fetch.
                }
                needsDetail.push(item);
                return null;
            })
        );

        const detailMap = new Map();

        if (needsDetail.length > 0) {
            const detailPage = await browser.newPage();
            await setupPage(detailPage);

            for (const item of needsDetail) {
                try {
                    // eslint-disable-next-line no-await-in-loop
                    await detailPage.goto(item.link, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    // eslint-disable-next-line no-await-in-loop
                    const detailHtml = await detailPage.content();
                    const content = load(detailHtml);

                    const magnet = content('#magnets-content button[data-clipboard-text]').first().attr('data-clipboard-text');
                    const releaseDate =
                        content('.bg-base-100 .text-xs:contains("発売日")').next('.text-sm').text().trim() ||
                        content('.bg-base-100 .text-xs')
                            .filter((_, el) => content(el).text().includes('発売日'))
                            .next('.text-sm')
                            .text()
                            .trim();
                    const coverImg = content('.h-72 img').attr('src');
                    const screenshots = content('.h-44 .flex-none a img')
                        .toArray()
                        .map((el) => content(el).attr('src'));
                    const actorsList = content('.chip')
                        .toArray()
                        .map((el) => ({
                            name: content(el).find('span').text().trim(),
                            avatar: content(el).find('img').attr('src'),
                        }));
                    const tags = content('.flex.flex-wrap.gap-2 a')
                        .toArray()
                        .map((el) => content(el).text().trim());

                    const result = {
                        title: `${item.id} - ${item.titleText}`,
                        link: item.link,
                        pubDate: item.pubDate,
                        author: item.actors.join(', '),
                        enclosure_url: magnet,
                        enclosure_type: 'application/x-bittorrent',
                        description: `
                            <div><strong>封面:</strong><br><img src="${coverImg}" style="max-width:300px;"></div>
                            <div><strong>发售日:</strong> ${releaseDate}</div>
                            <div><strong>剧照:</strong><br>${screenshots.map((src) => `<img src="${src}" style="max-width:120px;margin:2px;">`).join('')}</div>
                            <div><strong>标签:</strong> ${tags.join(', ')}</div>
                            <div><strong>演员:</strong> ${actorsList.map((a) => `<img src="${a.avatar}" alt="${a.name}" style="width:24px;height:24px;border-radius:50%;vertical-align:middle;margin-right:4px;">${a.name}`).join(', ')}</div>
                        `,
                    };

                    detailMap.set(item.link, result);
                    // eslint-disable-next-line no-await-in-loop
                    await cache.set(item.link, result, 60 * 60 * 24);
                } catch (error) {
                    if (error.name !== 'TimeoutError') {
                        throw error;
                    }
                    logger.warn(`Timeout for ${item.link}, falling back to list data`);
                    detailMap.set(item.link, null);
                }
            }

            await detailPage.close();
        }

        const processedItems = items.map((item, index) => {
            if (cachedResults[index]) {
                return cachedResults[index];
            }
            const detail = detailMap.get(item.link);
            if (!detail) {
                return {
                    title: `${item.id} - ${item.titleText}`,
                    link: item.link,
                    pubDate: item.pubDate,
                    author: item.actors.join(', '),
                    ...(item.cover
                        ? {
                              enclosure_url: item.cover,
                              enclosure_type: 'image/jpeg',
                              description: `<div><strong>封面:</strong><br><img src="${item.cover}" style="max-width:300px;"></div>`,
                          }
                        : {}),
                };
            }
            return detail;
        });

        const subject = htmlTitle.includes('|') ? htmlTitle.split('|')[0] : '';
        return {
            title: subject === '' ? title : `${subject} - ${title}`,
            link: url.href,
            item: processedItems,
        };
    } finally {
        await browser.close();
    }
};

export default { ProcessItems };
