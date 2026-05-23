import { load } from 'cheerio';
import pMap from 'p-map';

import { config } from '@/config';
import ConfigNotFoundError from '@/errors/types/config-not-found';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import { parseDate } from '@/utils/parse-date';
import type { Page } from '@/utils/puppeteer';
import { getPuppeteerPage } from '@/utils/puppeteer';

const allowDomain = new Set(['avbase.net', 'www.avbase.net']);
const avbaseBrowserCloseTimeout = 90000;
const avbaseBrowserNavigationTimeout = 45000;
const avbaseDetailConcurrency = 1;
const avbaseAllowedResourceTypes = new Set(['document', 'script', 'xhr', 'fetch', 'other']);
let avbaseBrowserQueue = Promise.resolve();

type AvbaseListItem = {
    actors: string[];
    cover?: string;
    id: string;
    link: string;
    pubDate?: Date;
    titleText: string;
};

type AvbaseDetailResult = {
    author: string;
    description?: string;
    enclosure_type?: string;
    enclosure_url?: string;
    link: string;
    pubDate?: Date;
    title: string;
};

type AvbasePageSession = {
    destroy: () => Promise<void>;
    page: Page;
};

const parseAvbaseCookies = (cookie: string, hostname: string) =>
    cookie
        .split(';')
        .map((item) => item.trim())
        .filter((item) => item !== '')
        .map((item) => {
            const equalIndex = item.indexOf('=');
            if (equalIndex <= 0) {
                return;
            }

            return {
                name: item.slice(0, equalIndex).trim(),
                value: item.slice(equalIndex + 1).trim(),
                domain: hostname,
            };
        })
        .filter((item) => item !== undefined);

const applyAvbaseCookies = async (page: Page, hostname: string) => {
    if (!config.avbase?.cookies) {
        return;
    }

    const cookies = parseAvbaseCookies(config.avbase.cookies, hostname);
    if (cookies.length > 0) {
        await page.setCookie(...cookies);
    }
};

const withAvbaseBrowserGate = async <T>(task: () => Promise<T>) => {
    const previousTask = avbaseBrowserQueue;
    let releaseQueue: () => void;
    avbaseBrowserQueue = new Promise<void>((resolve) => {
        releaseQueue = resolve;
    });

    await previousTask;

    try {
        return await task();
    } finally {
        releaseQueue!();
    }
};

const setupPage = async (page: Page, hostname: string) => {
    page.setDefaultNavigationTimeout(avbaseBrowserNavigationTimeout);
    page.setDefaultTimeout(avbaseBrowserNavigationTimeout);
    await page.setRequestInterception(true);
    page.on('request', (request: any) => {
        avbaseAllowedResourceTypes.has(request.resourceType()) ? request.continue() : request.abort();
    });

    await applyAvbaseCookies(page, hostname);
};

const isRetryableAvbaseError = (error: unknown) =>
    error instanceof Error &&
    (error.message.includes('Execution context was destroyed') ||
        error.message.includes('Target page, context or browser has been closed') ||
        error.message.includes('frame was detached') ||
        error.message.includes('net::ERR_ABORTED') ||
        error.message.includes('Navigation failed because page was closed'));

const runAvbasePageSession = async <T>(url: string, hostname: string, runner: (page: Page) => Promise<T>, noGoto = false) => {
    let session: AvbasePageSession | undefined;
    try {
        session = (await getPuppeteerPage(url, {
            closeTimeout: avbaseBrowserCloseTimeout,
            gotoConfig: {
                timeout: avbaseBrowserNavigationTimeout,
                waitUntil: 'domcontentloaded',
            },
            noGoto,
            onBeforeLoad: async (page) => {
                await setupPage(page, hostname);
            },
        })) as unknown as AvbasePageSession;
        logger.http(`Requesting ${url}`);
        return await runner(session.page);
    } finally {
        if (session) {
            await session.destroy();
        }
    }
};

const withAvbasePage = <T>(url: string, hostname: string, runner: (page: Page) => Promise<T>, noGoto = false) =>
    withAvbaseBrowserGate(async () => {
        try {
            return await runAvbasePageSession(url, hostname, runner, noGoto);
        } catch (error) {
            if (isRetryableAvbaseError(error)) {
                logger.warn(`Retrying AVBASE page request for ${url}: ${error.message}`);
                return runAvbasePageSession(url, hostname, runner, noGoto);
            }
            throw error;
        }
    });

const waitForCloudflare = async (page: Page, url: string) => {
    try {
        await page.waitForFunction(() => document.title !== 'Just a moment...', { timeout: 12000 });
    } catch {
        logger.debug(`Cloudflare challenge may still be active for ${url}`);
    }
};

const waitForKnownSelector = async (page: Page, selector: string, url: string, type: 'list' | 'detail') => {
    try {
        await page.waitForSelector(selector, { timeout: 12000 });
    } catch {
        logger.debug(`No known AVBASE ${type} selectors found for ${url}`);
    }
};

const extractItemsFromLegacyCards = ($, rootUrl, limit): AvbaseListItem[] =>
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
        .filter((item): item is AvbaseListItem => item !== undefined);

const extractItemsFromWorkLinks = ($, rootUrl, limit): AvbaseListItem[] => {
    const workItems = new Map<string, AvbaseListItem>();

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

const buildFallbackItem = (item: AvbaseListItem): AvbaseDetailResult => ({
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
});

const fetchDetailItem = async (page: Page, item: AvbaseListItem): Promise<AvbaseDetailResult> => {
    await page.goto(item.link, { waitUntil: 'domcontentloaded', timeout: avbaseBrowserNavigationTimeout });
    await waitForCloudflare(page, item.link);
    await waitForKnownSelector(page, '#magnets-content, .bg-base-100, .chip', item.link, 'detail');

    const detailHtml = await page.content();
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
        .map((el) => content(el).attr('src'))
        .filter((src): src is string => src !== undefined && src !== '');
    const actorsList = content('.chip')
        .toArray()
        .map((el) => ({
            name: content(el).find('span').text().trim(),
            avatar: content(el).find('img').attr('src'),
        }));
    const tags = content('.flex.flex-wrap.gap-2 a')
        .toArray()
        .map((el) => content(el).text().trim())
        .filter((tag) => tag !== '');

    return {
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
            <div><strong>演员:</strong> ${actorsList.map((actor) => `<img src="${actor.avatar}" alt="${actor.name}" style="width:24px;height:24px;border-radius:50%;vertical-align:middle;margin-right:4px;">${actor.name}`).join(', ')}</div>
        `,
    };
};

const fetchDetails = (items: AvbaseListItem[], hostname: string) =>
    withAvbasePage(
        'about:blank',
        hostname,
        async (page) =>
            new Map(
                await pMap(
                    items,
                    async (item) => {
                        try {
                            const detail = await cache.tryGet(item.link, () => fetchDetailItem(page, item), 60 * 60 * 24, false);
                            return [item.link, detail] as const;
                        } catch (error) {
                            if (error instanceof Error && error.name === 'TimeoutError') {
                                logger.warn(`Timeout for ${item.link}, falling back to list data`);
                                return [item.link, null] as const;
                            }
                            throw error;
                        }
                    },
                    { concurrency: avbaseDetailConcurrency }
                )
            ),
        true
    );

const ProcessItems = async (ctx, currentUrl, title) => {
    const domain = ctx.req.query('domain') ?? 'avbase.net';
    const url = new URL(currentUrl, `https://${domain}`);

    if (!config.feature.allow_user_supply_unsafe_domain && !allowDomain.has(url.hostname)) {
        throw new ConfigNotFoundError("This RSS is disabled unless 'ALLOW_USER_SUPPLY_UNSAFE_DOMAIN' is set to 'true'.");
    }

    const rootUrl = `https://${domain}`;

    const { htmlTitle, items } = await withAvbasePage(url.href, url.hostname, async (page) => {
        await waitForCloudflare(page, url.href);
        await waitForKnownSelector(page, 'div.relative, a[href^="/works/"]', url.href, 'list');

        const listHtml = await page.content();
        const $ = load(listHtml);
        const htmlTitle = $('title').text();
        const limit = ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit')) : 20;

        const legacyItems = extractItemsFromLegacyCards($, rootUrl, limit);
        const items = legacyItems.length > 0 ? legacyItems : extractItemsFromWorkLinks($, rootUrl, limit);

        return { htmlTitle, items };
    });

    const detailMap = items.length > 0 ? await fetchDetails(items, url.hostname) : new Map<string, AvbaseDetailResult | null>();
    const processedItems = items.map((item) => detailMap.get(item.link) ?? buildFallbackItem(item));

    const subject = htmlTitle.includes('|') ? htmlTitle.split('|')[0] : '';
    return {
        title: subject === '' ? title : `${subject} - ${title}`,
        link: url.href,
        item: processedItems,
    };
};

export default { ProcessItems };
