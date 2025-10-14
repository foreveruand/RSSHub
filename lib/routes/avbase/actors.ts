import { Route } from '@/types';
import utils from './utils';

export const route: Route = {
    path: '/actors/:name/:filter?',
    categories: ['multimedia'],
    example: '/avbase/actors/美乃すずめ',
    parameters: { name: '演员名（日文）', filter: '过滤条件' },
    features: {
        requireConfig: [
            {
                name: 'AVBASE_SESSION',
                description: 'AVBASE登陆后的session值，可在控制台的cookie下查找 `_jdb_session` 的值，即可获取',
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
    radar: [
        {
            source: ['avbase.net/'],
            target: '',
        },
    ],
    name: '演員',
    maintainers: ['cj'],
    handler,
    url: 'www.avbase.net/',
    description: ``,
};

async function handler(ctx) {
    const name = ctx.req.param('name');
    const filter = ctx.req.param('filter') ?? '';
    const addonTags = ctx.req.query('addon_tags') ?? '';

    const currentUrl = `/talents/${name}`;

    const title = `AVBASE - ${name}`;
    return await utils.ProcessItems(ctx, currentUrl, title);
}
