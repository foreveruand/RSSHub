import { load } from 'cheerio';

import { config } from '@/config';
import ConfigNotFoundError from '@/errors/types/config-not-found';
import cache from '@/utils/cache';
import { parseDate } from '@/utils/parse-date';
import puppeteer from '@/utils/puppeteer'; // 引入 Puppeteer 运行环境

const allowDomain = new Set(['avbase.net', 'www.avbase.net']);

const ProcessItems = async (ctx, currentUrl, title) => {
    const domain = ctx.req.query('domain') ?? 'avbase.net';
    const url = new URL(currentUrl, `https://${domain}`);

    if (!config.feature.allow_user_supply_unsafe_domain && !allowDomain.has(url.hostname)) {
        throw new ConfigNotFoundError("This RSS is disabled unless 'ALLOW_USER_SUPPLY_UNSAFE_DOMAIN' is set to 'true'.");
    }

    const rootUrl = `https://${domain}`;

    // 1. 启动浏览器
    const browser = await puppeteer();
    const page = await browser.newPage();

    /* eslint-disable-next-line no-useless-assignment */
    let items = [];
    /* eslint-disable-next-line no-useless-assignment */
    let htmlTitle = '';

    try {
        // 2. 访问列表页
        // 设置 Cookie (如果配置中有)
        if (config.avbase.cookies) {
            const cookieArray = config.avbase.cookies.split(';').map((c) => {
                const [name, value] = c.split('=');
                return { name: name.trim(), value: value.trim(), domain: url.hostname };
            });
            await page.setCookie(...cookieArray);
        }

        // 模拟真实用户访问
        await page.goto(url.href, {
            waitUntil: 'domcontentloaded', // 或者 'networkidle2' 视情况而定
        });

        const responseData = await page.content();
        const $ = load(responseData);
        htmlTitle = $('title').text();

        items = $('div.relative')
            .slice(0, ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit')) : 20)
            .toArray()
            .map((el) => {
                const item = $(el);
                const id = item.find('.font-bold.text-gray-500').text().trim();
                const titleText = item.find('.text-md.font-bold').text().trim();
                const link = new URL(item.find('.text-md.font-bold').attr('href'), rootUrl).href;
                const cover = item.find('.w-28 img').attr('src');
                const pubDate = parseDate(item.find('.block.font-bold').text().trim());
                const actors = item
                    .find('.chip span')
                    .toArray()
                    .map((e) => $(e).text().trim());

                if (!titleText) {
                    return null;
                }
                return {
                    title: `${id} - ${titleText}`,
                    link,
                    pubDate,
                    author: actors.join(', '),
                    enclosure_url: cover,
                    enclosure_type: 'image/jpeg',
                };
            })
            .filter(Boolean);

        const CONCURRENCY = Number.parseInt(config.puppeteer_concurrency) || 2;
        const processedItems = [];

        // 将 items 按并发数分块处理
        for (let i = 0; i < items.length; i += CONCURRENCY) {
            const chunk = items.slice(i, i + CONCURRENCY);

            // eslint-disable-next-line no-await-in-loop
            const chunkResults = await Promise.all(
                chunk.map((item) =>
                    cache.tryGet(item.link, async () => {
                        // 每个并发任务必须开启独立的标签页
                        const detailPage = await browser.newPage();
                        try {
                            // 可选：增加微小的随机延迟，防止并发请求特征过于明显
                            await new Promise((r) => setTimeout(r, Math.random() * 1000));

                            await detailPage.goto(item.link, {
                                waitUntil: 'domcontentloaded',
                                timeout: 30000,
                            });

                            const detailHtml = await detailPage.content();
                            const content = load(detailHtml);

                            // --- 解析逻辑开始 ---
                            const magnet = content('#magnets-content button[data-clipboard-text]').first().attr('data-clipboard-text');

                            // 优化后的发售日获取逻辑
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

                            item.enclosure_url = magnet;
                            item.enclosure_type = 'application/x-bittorrent';
                            item.description = `
                                <div><strong>封面:</strong><br><img src="${coverImg}" style="max-width:300px;"></div>
                                <div><strong>发售日:</strong> ${releaseDate}</div>
                                <div><strong>剧照:</strong><br>${screenshots.map((src) => `<img src="${src}" style="max-width:120px;margin:2px;">`).join('')}</div>
                                <div><strong>标签:</strong> ${tags.join(', ')}</div>
                                <div><strong>演员:</strong> ${actorsList.map((a) => `<img src="${a.avatar}" alt="${a.name}" style="width:24px;height:24px;border-radius:50%;vertical-align:middle;margin-right:4px;">${a.name}`).join(', ')}</div>
                                ${content('.cover-container, .column-video-cover').html() || ''}
                                ${content('.movie-panel-info').html() || ''}
                                ${content('#magnets-content').html() || ''}
                            `;
                            // --- 解析逻辑结束 ---

                            return item;
                        } catch (error) {
                            // 替换为 RSSHub 的 logger
                            logger.error(`Error processing ${item.link}: ${error.message}`);
                            return item;
                        } finally {
                            // 必须在 finally 中关闭当前标签页，防止内存泄漏
                            await detailPage.close();
                        }
                    })
                )
            );
            processedItems.push(...chunkResults);
        }

        items = processedItems;
    } finally {
        await browser.close(); // 4. 必须关闭浏览器，否则会导致内存泄漏
    }

    const subject = htmlTitle.includes('|') ? htmlTitle.split('|')[0] : '';
    return {
        title: subject === '' ? title : `${subject} - ${title}`,
        link: url.href,
        item: items,
    };
};

export default { ProcessItems };
