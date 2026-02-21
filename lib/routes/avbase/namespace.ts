import type { Namespace } from '@/types';

export const namespace: Namespace = {
    name: 'AVbase',
    url: 'www.avbase.net',
    description: `
::: tip
你可以通过指定 \`limit\` 参数来获取特定数量的条目，即可以通过在路由后方加上 \`?limit=25\`，默认为单次获取 20 个条目，即默认 \`?limit=20\`

因为该站有反爬检测，所以不应将此值调整过高
:::`,
    lang: 'ja',
};
