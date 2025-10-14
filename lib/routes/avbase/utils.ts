import cache from '@/utils/cache';
import got from '@/utils/got';
import { load } from 'cheerio';
import { parseDate } from '@/utils/parse-date';
import { config } from '@/config';
import { Cookie, CookieJar } from 'tough-cookie';

import ConfigNotFoundError from '@/errors/types/config-not-found';
const allowDomain = new Set(['avbase.net', 'www.avbase.net']);

const ProcessItems = async (ctx, currentUrl, title) => {
    const domain = ctx.req.query('domain') ?? 'avbase.net';
    const url = new URL(currentUrl, `https://${domain}`);
    if (!config.feature.allow_user_supply_unsafe_domain && !allowDomain.has(url.hostname)) {
        throw new ConfigNotFoundError(`This RSS is disabled unless 'ALLOW_USER_SUPPLY_UNSAFE_DOMAIN' is set to 'true'.`);
    }

    const rootUrl = `https://${domain}`;

    // const cookieJar = new CookieJar();

    // if (config.javdb.session) {
    //     const cookie = Cookie.fromJSON({
    //         key: '_jdb_session',
    //         value: config.javdb.session,
    //         domain,
    //         path: '/',
    //     });
    //     cookie && cookieJar.setCookie(cookie, rootUrl);
    // }

    const response = await got({
        method: 'get',
        url: url.href,
        // cookieJar,
        headers: {
            'User-Agent': config.trueUA,
        },
    });

    const $ = load(response.data);

    // $('.tags, .tag-can-play, .over18-modal').remove();

    let items = $('div.relative')
        .slice(0, ctx.req.query('limit') ? Number.parseInt(ctx.req.query('limit')) : 20)
        .toArray()
        .map((el) => {
            const item = $(el);

            const id = item.find('.font-bold.text-gray-500').text().trim(); // 番号
            const title = item.find('.text-md.font-bold').text().trim(); // 标题
            const link = rootUrl + item.find('.text-md.font-bold').attr('href');
            const cover = item.find('.w-28 img').attr('src');
            const pubDate = parseDate(item.find('.block.font-bold').text().trim());
            const actors = item.find('.chip span').map((_, e) => $(e).text().trim()).get();
            if (!title) return null; // 如果title获取不到，忽略这个item
            return {
                title: `${id} - ${title}`,
                link,
                pubDate,
                author: actors.join(', '),
                enclosure_url: cover,
                enclosure_type: 'image/jpeg',
            };
        }).filter(Boolean); // 去除title为空的item
    // ;

    items = await Promise.all(
        items.map((item) =>
            cache.tryGet(item.link, async () => {
                const detailResponse = await got({
                    method: 'get',
                    url: item.link,
                    headers: {
                        'User-Agent': config.trueUA,
                    },
                });

                const content = load(detailResponse.data);

                item.enclosure_type = 'application/x-bittorrent';
                item.enclosure_url = content('#magnets-content button[data-clipboard-text]').first().attr('data-clipboard-text');

                // 发售日
                const releaseDate = content('.bg-base-100 .text-xs:contains("発売日")').next('.text-sm').text().trim() ||
                    content('.bg-base-100 .text-xs').filter((_, el) => content(el).text().includes('発売日')).next('.text-sm').text().trim();

                // 封面
                const coverImg = content('.h-72 img').attr('src');

                // 剧照
                const screenshots = content('.h-44 .flex-none a img').map((_, el) => content(el).attr('src')).get();

                // 演员列表（含头像和名字）
                const actors = content('.chip').map((_, el) => {
                    const name = content(el).find('span').text().trim();
                    const avatar = content(el).find('img').attr('src');
                    return { name, avatar };
                }).get();

                // 标签
                const tags = content('.flex.flex-wrap.gap-2 a').map((_, el) => content(el).text().trim()).get();

                // 详细描述
                const descriptionHtml =
                    `<div><strong>发售日:</strong> ${releaseDate}</div>` +
                    `<div><strong>演员:</strong> ${actors.map(a => `<img src="${a.avatar}" alt="${a.name}" style="width:24px;height:24px;border-radius:50%;vertical-align:middle;margin-right:4px;">${a.name}`).join(', ')}</div>` +
                    `<div><strong>封面:</strong><br><img src="${coverImg}" style="max-width:300px;"></div>` +
                    `<div><strong>剧照:</strong><br>${screenshots.map(src => `<img src="${src}" style="max-width:120px;margin:2px;">`).join('')}</div>` +
                    `<div><strong>标签:</strong> ${tags.join(', ')}</div>` +
                    content('.cover-container, .column-video-cover').html() +
                    content('.movie-panel-info').html() +
                    content('#magnets-content').html() +
                    content('.preview-images').html();

                item.releaseDate = releaseDate;
                item.actors = actors;
                item.cover = coverImg;
                item.screenshots = screenshots;
                item.tags = tags;
                item.description = descriptionHtml;

                return item;
            })
        )
    );

    const htmlTitle = $('title').text();
    const subject = htmlTitle.includes('|') ? htmlTitle.split('|')[0] : '';

    return {
        title: subject === '' ? title : `${subject} - ${title}`,
        link: url.href,
        item: items,
    };
};

export default { ProcessItems };
