import { load } from 'cheerio';

import { config } from '@/config';
import ConfigNotFoundError from '@/errors/types/config-not-found';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import { parseDate } from '@/utils/parse-date';
import puppeteer from '@/utils/puppeteer'; // 引入 Puppeteer

const allowDomain = new Set(['javdb.com', 'javdb36.com', 'javdb007.com', 'javdb521.com']);

const ProcessItems = async (ctx, currentUrl, title) => {
    const domain = ctx.req.query('domain') ?? 'javdb.com';
    const url = new URL(currentUrl, `https://${domain}`);

    if (!config.feature.allow_user_supply_unsafe_domain && !allowDomain.has(url.hostname)) {
        throw new ConfigNotFoundError(`This RSS is disabled unless 'ALLOW_USER_SUPPLY_UNSAFE_DOMAIN' is set to 'true'.`);
    }

    const rootUrl = `https://${domain}`;
    const browser = await puppeteer();

    let items = [];
    let htmlTitle = '';

    try {
        const page = await browser.newPage();

        // 1. 设置 Cookie (处理登录 Session)
        if (config.javdb.session) {
            await page.setCookie({
                name: '_jdb_session',
                value: config.javdb.session,
                domain: url.hostname,
                path: '/',
            });
        }

        // 2. 访问列表页
        await page.goto(url.href, { waitUntil: 'domcontentloaded' });
        const listHtml = await page.content();
        const $ = load(listHtml);
        htmlTitle = $('title').text();

        $('.tags, .tag-can-play, .over18-modal').remove();

        const rawItems = $('div.item')
            .slice(0, ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit')) : 20)
            .toArray()
            .map((item) => {
                const $item = $(item);
                return {
                    title: $item.find('.video-title').text(),
                    link: new URL($item.find('.box').attr('href'), rootUrl).href,
                    pubDate: parseDate($item.find('.meta').text()),
                };
            });
        const CONCURRENCY = Number.parseInt(config.puppeteer_concurrency) || 2;
        const processedItems = [];

        // 将任务分块执行
        for (let i = 0; i < rawItems.length; i += CONCURRENCY) {
            const chunk = rawItems.slice(i, i + CONCURRENCY);

            // eslint-disable-next-line no-await-in-loop
            const chunkResults = await Promise.all(
                chunk.map((item) =>
                    cache.tryGet(item.link, async () => {
                        const detailPage = await browser.newPage();
                        try {
                            // 增加随机延迟，模拟真实用户，进一步降低 403 风险
                            await new Promise((r) => setTimeout(r, Math.random() * 1000));

                            await detailPage.goto(item.link, { waitUntil: 'domcontentloaded', timeout: 30000 });
                            const detailHtml = await detailPage.content();
                            const content = load(detailHtml);

                            // 解析逻辑
                            content('icon').remove();
                            // ... (中间的 content 处理逻辑同上)

                            const enclosure_url = content('#magnets-content button[data-clipboard-text]').first().attr('data-clipboard-text');
                            const category = content('.panel-block .value a')
                                .toArray()
                                .map((v) => content(v).text());
                            const author = content('.panel-block .value').last().parent().find('.value a').first().text();
                            const description =
                                (content('.cover-container, .column-video-cover').html() || '') + (content('.movie-panel-info').html() || '') + (content('#magnets-content').html() || '') + (content('.preview-images').html() || '');

                            return {
                                ...item,
                                enclosure_url,
                                enclosure_type: 'application/x-bittorrent',
                                category,
                                author,
                                description,
                            };
                        } catch (error) {
                            logger.error(`Failed to fetch detail for ${item.link}: ${error.message}`);
                            return item;
                        } finally {
                            await detailPage.close();
                        }
                    })
                )
            );
            processedItems.push(...chunkResults);
        }
        items = processedItems;
    } finally {
        await browser.close();
    }

    const subject = htmlTitle.includes('|') ? htmlTitle.split('|')[0] : '';

    return {
        title: subject === '' ? title : `${subject} - ${title}`,
        link: url.href,
        item: items,
    };
};

export default { ProcessItems };
