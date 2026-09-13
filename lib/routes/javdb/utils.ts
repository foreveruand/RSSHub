import { load } from 'cheerio';

import { config } from '@/config';
import ConfigNotFoundError from '@/errors/types/config-not-found';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import { parseDate } from '@/utils/parse-date';
import playwright from '@/utils/playwright';

const allowDomain = new Set(['javdb.com', 'javdb571.com', 'javdb36.com', 'javdb007.com', 'javdb521.com']);

const parseCachedItem = <T>(value: string | T | null | undefined): T | null => {
    if (!value) {
        return null;
    }

    if (typeof value !== 'string') {
        return value;
    }

    try {
        return JSON.parse(value) as T;
    } catch {
        return null;
    }
};

const setupPage = async (page) => {
    await page.route('**/*', (route) => {
        if (['image', 'stylesheet', 'font', 'media'].includes(route.request().resourceType())) {
            route.abort();
        } else {
            route.continue();
        }
    });
};

const ProcessItems = async (ctx, currentUrl, title) => {
    const domain = ctx.req.query('domain') ?? 'javdb.com';
    const url = new URL(currentUrl, `https://${domain}`);

    if (!config.feature.allow_user_supply_unsafe_domain && !allowDomain.has(url.hostname)) {
        throw new ConfigNotFoundError(`This RSS is disabled unless 'ALLOW_USER_SUPPLY_UNSAFE_DOMAIN' is set to 'true'.`);
    }

    const rootUrl = `https://${domain}`;
    const context = await playwright();

    try {
        const listPage = await context.newPage();
        await setupPage(listPage);

        if (config.javdb.session) {
            await context.addCookies([
                {
                    name: '_jdb_session',
                    value: config.javdb.session,
                    domain: url.hostname,
                    path: '/',
                },
            ]);
        }

        await listPage.goto(url.href, { waitUntil: 'domcontentloaded', timeout: 30000 });
        const listHtml = await listPage.content();
        await listPage.close();

        const $ = load(listHtml);
        const htmlTitle = $('title').text();
        $('.tags, .tag-can-play, .over18-modal').remove();

        const rawItems = $('div.item')
            .slice(0, ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit')) : 20)
            .toArray()
            .flatMap((item) => {
                const $item = $(item);
                const href = $item.find('.box').attr('href');
                if (!href) {
                    return [];
                }

                return {
                    title: $item.find('.video-title').text(),
                    link: new URL(href, rootUrl).href,
                    pubDate: parseDate($item.find('.meta').text()),
                };
            });

        const needsDetail: typeof rawItems = [];
        const cachedResults = await Promise.all(
            rawItems.map(async (item) => {
                try {
                    const cached = await cache.get(item.link);
                    if (cached) {
                        return parseCachedItem<typeof item>(cached);
                    }
                } catch {
                    return null;
                }

                needsDetail.push(item);
                return null;
            })
        );

        const detailMap = new Map();

        if (needsDetail.length > 0) {
            const detailPage = await context.newPage();
            await setupPage(detailPage);

            for (const item of needsDetail) {
                try {
                    logger.http(`Requesting ${item.link}`);
                    // eslint-disable-next-line no-await-in-loop
                    const result = await cache.tryGet(item.link, async () => {
                        // eslint-disable-next-line no-await-in-loop
                        await detailPage.goto(item.link, { waitUntil: 'domcontentloaded', timeout: 30000 });
                        // eslint-disable-next-line no-await-in-loop
                        const detailHtml = await detailPage.content();
                        const content = load(detailHtml);

                        content('icon').remove();
                        content('#modal-review-watched, #modal-comment-warning, #modal-save-list').remove();
                        content('.review-buttons, .copy-to-clipboard, .preview-video-container, .play-button').remove();

                        content('.preview-images img').each((_, element) => {
                            content(element).removeAttr('data-src');
                            content(element).attr('src', content(element).parent().attr('href'));
                        });

                        return {
                            ...item,
                            enclosure_url: content('#magnets-content button[data-clipboard-text]').first().attr('data-clipboard-text'),
                            enclosure_type: 'application/x-bittorrent',
                            category: content('.panel-block .value a')
                                .toArray()
                                .map((v) => content(v).text()),
                            author: content('.panel-block .value').last().parent().find('.value a').first().text(),
                            description:
                                (content('.cover-container, .column-video-cover').html() ?? '') + (content('.movie-panel-info').html() ?? '') + (content('#magnets-content').html() ?? '') + (content('.preview-images').html() ?? ''),
                        };
                    });

                    detailMap.set(item.link, result);
                } catch (error) {
                    if (!(error instanceof Error) || error.name !== 'TimeoutError') {
                        throw error;
                    }
                    logger.warn(`Timeout for ${item.link}, falling back to list data`);
                    detailMap.set(item.link, null);
                }
            }

            await detailPage.close();
        }

        const processedItems = rawItems.map((item, index) => cachedResults[index] ?? detailMap.get(item.link) ?? item);
        const subject = htmlTitle.includes('|') ? htmlTitle.split('|', 1)[0] : '';

        return {
            title: subject === '' ? title : `${subject} - ${title}`,
            link: url.href,
            item: processedItems,
        };
    } finally {
        await context.close();
    }
};

export default { ProcessItems };
