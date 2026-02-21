import type { Route } from '@/types';
import utils from './utils';

export const route: Route = {
    path: '/:category?',
    categories: ['multimedia'],
    example: '/southplus/128',
    parameters: {
        category: '分类名（从各板块URL获取）',
    },
    features: {
        requireConfig: [
            {
                name: 'SOUTHPLUS_COOKIE',
                description: 'southplus_cookie用于访问部分帖子',
                optional: true,
            },
        ],
        requirePuppeteer: false,
        antiCrawler: true,
        supportBT: false,
        supportPodcast: false,
        supportScihub: false,
        nsfw: true,
    },
    name: 'South Plus路由',
    maintainers: ['cj'],
    handler,
    url: 'www.south-plus.net',
    description: '将 South Plus 官方 RSS 重构为结构化 RSS',
};

async function handler(ctx) {
    const limit = Number(ctx.req.query('limit') ?? 20);
    const category = ctx.req.param('category') ?? '';
    const title = `South Plus - ${category || '全部'}`;
    return await utils.ProcessItems(ctx, category, title);
}
