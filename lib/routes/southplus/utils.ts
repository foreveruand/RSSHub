import { load } from 'cheerio';
import { parseStringPromise } from 'xml2js';

import cache from '@/utils/cache';
import got from '@/utils/got';

const RSS_URL = 'https://www.south-plus.net/rss.php';

function extractImages(desc: string): string[] {
    const regex = /\[img\](.*?)\[\/img\]/gi;
    const imgs: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = regex.exec(desc)) !== null) {
        imgs.push(m[1]);
    }
    return imgs;
}

function cleanContent(desc: string): string {
    return desc
        .replaceAll(/\[img\].*?\[\/img\]/gi, '')
        .replaceAll(/\[\/?.*?\]/g, '')
        .trim();
}

async function fetchCoverFromPage(url: string): Promise<string> {
    try {
        const res = await got({
            method: 'get',
            url,
        });
        const $ = load(res.data);
        return $('img').first().attr('src') ?? '';
    } catch {
        return '';
    }
}

export const ProcessItems = async (ctx, category?: string, title?: string) => {
    const url = category ? `${RSS_URL}?fid=${category}` : RSS_URL;
    const response = await got({
        method: 'get',
        url,
    });

    const parsed = await parseStringPromise(response.data, { explicitArray: false });
    let items = parsed.rss.channel.item;

    if (!Array.isArray(items)) {
        items = [items];
    }

    const limit = ctx.req.query('limit') ? Number(ctx.req.query('limit')) : 20;
    items = items.slice(0, limit);

    let result = items.map((item) => {
        const link = item.link.startsWith('http') ? item.link : 'https:' + item.link;
        const raw = item.description ?? '';
        const images = extractImages(raw);

        const cover = images[0] || '';
        const screenshots = images.slice(1);

        return {
            title: item.title,
            link,
            pubDate: item.pubdate,
            author: item.author,
            category: item.category,
            _raw: raw, // 后面 detail 用
            _cover: cover,
            _screenshots: screenshots,
        };
    });

    // 模拟 AVbase 的 cache + detail 处理流程（虽然 SouthPlus 没详情页字段，但结构保持一致）
    result = await Promise.all(
        result.map((item) =>
            cache.tryGet(item.link, async () => {
                let coverImg = item._cover;

                // description 没图 → 尝试进帖子页找封面
                if (!coverImg && item.link) {
                    coverImg = await fetchCoverFromPage(item.link);
                }

                const screenshots = item._screenshots;
                const tags = item.category ? [item.category] : [];
                const releaseDate = new Date(item.pubDate).toISOString().split('T')[0];
                const contentText = cleanContent(item._raw || '');

                // 保持你原来的 description 拼装风格
                const descriptionHtml =
                    `<div><strong>封面:</strong><br>${coverImg ? `<img src="${coverImg}" style="max-width:300px;">` : '无'}</div>` +
                    `<div><strong>发帖日期:</strong> ${releaseDate}</div>` +
                    `<div><strong>版块:</strong> ${tags.join(', ')}</div>` +
                    `<hr>` +
                    `<pre>${contentText || '无内容'}</pre>`;

                item.releaseDate = releaseDate;
                item.actors = [];
                item.cover = coverImg;
                item.screenshots = screenshots;
                item.tags = tags;
                item.description = descriptionHtml;

                delete item._raw;
                delete item._cover;
                delete item._screenshots;

                return item;
            })
        )
    );

    return {
        title: title || `South Plus - ${category || '全部'}`,
        link: url,
        item: result,
    };
};

export default { ProcessItems };
