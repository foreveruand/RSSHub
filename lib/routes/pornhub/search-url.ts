import { load } from 'cheerio';

import InvalidParameterError from '@/errors/types/invalid-parameter';
import type { Route } from '@/types';
import got from '@/utils/got';
import { isValidHost } from '@/utils/valid-host';

import { headers, parseItems } from './utils';

export const route: Route = {
    path: '/search_url/:keyword/:language?',
    categories: ['multimedia'],
    example: '/pornhub/search_url/stepsister/cn',
    parameters: {
        keyword: '搜索关键词',
        language: '语言代码，默认 www，可选 cn, jp 等',
    },
    features: {
        requireConfig: false,
        requirePuppeteer: false,
        antiCrawler: true,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
        nsfw: true,
    },
    name: 'Keyword Search (HTML)',
    maintainers: ['nczitzk', 'I2IMk'],
    handler,
};

async function handler(ctx) {
    const { keyword, language = 'www' } = ctx.req.param();

    // 验证 host 确保安全
    if (!isValidHost(language)) {
        throw new InvalidParameterError('Invalid language');
    }

    // 构建真实的搜索 URL
    // 格式通常为: https://www.pornhub.com/video/search?search=keyword
    const link = `https://${language}.pornhub.com/video/search?search=${encodeURIComponent(keyword)}`;

    const { data: response } = await got(link, { headers });
    const $ = load(response);

    // 复用 category_url 的解析逻辑
    // 搜索页面的视频列表选择器通常也是 .videoBox
    const items = $('#videoSearchResult .videoBox, #videoCategory .videoBox')
        .toArray()
        .map((e) => parseItems($(e)));

    return {
        title: `Pornhub Search - ${keyword}`,
        link,
        language: $('html').attr('lang'),
        item: items,
    };
}
