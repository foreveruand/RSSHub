import cache from '@/utils/cache';
import { load } from 'cheerio';
import { parseDate } from '@/utils/parse-date';
import { config } from '@/config';
import puppeteer from '@/utils/puppeteer'; // 引入 Puppeteer 运行环境
import ConfigNotFoundError from '@/errors/types/config-not-found';

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

    let items = [];
    let htmlTitle = '';

    try {
        // 2. 访问列表页
        // 设置 Cookie (如果配置中有)
        if (config.avbase.cookies) {
            const cookieArray = config.avbase.cookies.split(';').map(c => {
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
                const actors = item.find('.chip span').map((_, e) => $(e).text().trim()).get();
                
                if (!titleText) return null;
                return {
                    title: `${id} - ${titleText}`,
                    link,
                    pubDate,
                    author: actors.join(', '),
                    enclosure_url: cover,
                    enclosure_type: 'image/jpeg',
                };
            }).filter(Boolean);

        // 3. 详情页处理
        // 注意：为避免性能崩溃，Puppeteer 处理详情页建议串行或限制并发
        // ！！！修改点：不再使用 Promise.all，改为普通的 for 循环串行抓取 ！！！
        const processedItems = [];
        
        // 我们可以共用同一个 detailPage，或者在循环内开关，串行执行不会导致 session 丢失
        const detailPage = await browser.newPage(); 

        for (const item of items) {
            const cachedItem = await cache.tryGet(item.link, async () => {
                try {
                    // 设置超时，防止某个页面卡死导致整个路由挂掉
                    await detailPage.goto(item.link, { 
                        waitUntil: 'domcontentloaded', 
                        timeout: 30000 
                    });
                    
                    const detailHtml = await detailPage.content();
                    const content = load(detailHtml);

                    // --- 原有的解析逻辑开始 ---
                    const magnet = content('#magnets-content button[data-clipboard-text]').first().attr('data-clipboard-text');
                    const releaseDate = content('.bg-base-100 .text-xs:contains("発売日")').next('.text-sm').text().trim() ||
                                    content('.bg-base-100 .text-xs').filter((_, el) => content(el).text().includes('発売日')).next('.text-sm').text().trim();
                    const coverImg = content('.h-72 img').attr('src');
                    const screenshots = content('.h-44 .flex-none a img').map((_, el) => content(el).attr('src')).get();
                    const actorsList = content('.chip').map((_, el) => ({
                        name: content(el).find('span').text().trim(),
                        avatar: content(el).find('img').attr('src')
                    })).get();
                    const tags = content('.flex.flex-wrap.gap-2 a').map((_, el) => content(el).text().trim()).get();

                    item.enclosure_url = magnet;
                    item.enclosure_type = 'application/x-bittorrent';
                    item.description = `
                        <div><strong>封面:</strong><br><img src="${coverImg}" style="max-width:300px;"></div>
                        <div><strong>发售日:</strong> ${releaseDate}</div>
                        <div><strong>剧照:</strong><br>${screenshots.map(src => `<img src="${src}" style="max-width:120px;margin:2px;">`).join('')}</div>
                        <div><strong>标签:</strong> ${tags.join(', ')}</div>
                        <div><strong>演员:</strong> ${actorsList.map(a => `<img src="${a.avatar}" alt="${a.name}" style="width:24px;height:24px;border-radius:50%;vertical-align:middle;margin-right:4px;">${a.name}`).join(', ')}</div>
                        ${content('.cover-container, .column-video-cover').html() || ''}
                        ${content('.movie-panel-info').html() || ''}
                        ${content('#magnets-content').html() || ''}
                    `;
                    // --- 原有的解析逻辑结束 ---

                    return item;
                } catch (err) {
                    console.error(`Error processing ${item.link}:`, err);
                    return item; // 报错了也返回基础信息，不影响其他 item
                }
            });
            processedItems.push(cachedItem);
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
