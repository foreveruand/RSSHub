import { load } from 'cheerio';

import { config } from '@/config';
import CaptchaError from '@/errors/types/captcha';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';
import type { Page } from '@/utils/playwright';
import playwright, { getPlaywrightPage } from '@/utils/playwright';

const xiaohongshuBrowserCloseTimeout = 90000;
const xiaohongshuBrowserNavigationTimeout = 45000;
const xiaohongshuAllowedResourceTypes = new Set(['document', 'script', 'xhr', 'fetch', 'other']);
const xiaohongshuPageStatusPollTimeout = 3000;

// Common headers for requests
const getHeaders = (cookie?: string) => ({
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
    'Accept-Encoding': 'gzip, deflate, br',
    'Accept-Language': 'en-US,en;q=0.9',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    Host: 'www.xiaohongshu.com',
    Pragma: 'no-cache',
    'Sec-Ch-Ua': '"Chromium";v="122", "Not(A:Brand";v="24", "Google Chrome";v="122"',
    'Sec-Ch-Ua-Mobile': '?0',
    'Sec-Ch-Ua-Platform': '"Windows"',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Sec-Fetch-User': '?1',
    'Upgrade-Insecure-Requests': '1',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    ...(cookie ? { Cookie: cookie } : {}),
});

// Fetch HTML through proxy when configured
async function fetchWithProxy(url: string, cookie?: string): Promise<string> {
    const proxy = config.xiaohongshu.proxy;
    if (proxy) {
        const proxyUrl = `${proxy}?url=${encodeURIComponent(url)}`;
        logger.http(`Requesting ${url} via proxy`);
        return await ofetch(proxyUrl, { parseResponse: (txt) => txt });
    }
    logger.http(`Requesting ${url}`);
    return await ofetch(url, {
        headers: getHeaders(cookie),
    });
}

async function setupXiaohongshuPage(page: Page) {
    page.setDefaultNavigationTimeout(xiaohongshuBrowserNavigationTimeout);
    page.setDefaultTimeout(xiaohongshuBrowserNavigationTimeout);
    await page.setRequestInterception(true);
    page.on('request', (request) => {
        xiaohongshuAllowedResourceTypes.has(request.resourceType()) ? request.continue() : request.abort();
    });
}

async function waitForXiaohongshuUserPage(page: Page) {
    await waitForXiaohongshuUserPageStatus(page, Date.now());
}

async function waitForXiaohongshuUserPageStatus(page: Page, startedAt: number): Promise<void> {
    const elapsed = Date.now() - startedAt;
    if (elapsed >= xiaohongshuBrowserNavigationTimeout) {
        throw new Error('Timed out waiting for Xiaohongshu user page data');
    }

    try {
        const timeout = Math.min(xiaohongshuPageStatusPollTimeout, xiaohongshuBrowserNavigationTimeout - elapsed);
        const statusHandle = await page.waitForFunction(
            () => {
                if (document.querySelector('#red-captcha')) {
                    return 'captcha';
                }

                if (location.pathname.startsWith('/login') || location.pathname.startsWith('/website-login')) {
                    return 'login';
                }

                if (!!(window as any).__INITIAL_STATE__?.user || !!(window as any).__INITIAL_SSR_STATE__?.user || document.querySelector('div.reds-tab-item')) {
                    return 'ready';
                }

                return false;
            },
            undefined,
            { timeout }
        );
        const status = await statusHandle.jsonValue();

        if (status === 'captcha') {
            throw new CaptchaError('小红书风控校验，请稍后再试');
        }

        if (status === 'login') {
            throw new CaptchaError('小红书返回登录/错误页面，请确认 Playwright 连接的是已登录的小红书浏览器上下文');
        }

        if (status === 'ready') {
            return;
        }
    } catch (error) {
        if (error instanceof CaptchaError) {
            throw error;
        }

        const message = error instanceof Error ? error.message : String(error);
        if (!message.includes('Execution context was destroyed') && !message.includes('Target page, context or browser has been closed') && !message.includes('frame was detached') && !message.includes('Timeout')) {
            throw error;
        }
    }

    return waitForXiaohongshuUserPageStatus(page, startedAt);
}

async function getXiaohongshuInitialState(page: Page) {
    const initialState = await page.evaluate(() => (window as any).__INITIAL_STATE__);
    if (initialState?.user) {
        return initialState;
    }

    const html = await page.content();
    const $ = load(html);
    return JSON.parse(extractInitialState($));
}

function hasCollectTab(page: Page) {
    return page.evaluate(() => [...document.querySelectorAll<HTMLElement>('div.reds-tab-item')].some((element) => (element.textContent || '').includes('收藏')));
}

async function clickCollectTab(page: Page) {
    await page.evaluate(() => {
        const tab = [...document.querySelectorAll<HTMLElement>('div.reds-tab-item')].find((element) => (element.textContent || '').includes('收藏'));
        tab?.click();
    });
}

const getUser = (url, cache) =>
    cache.tryGet(
        url,
        async () => {
            // Use proxy if configured
            if (config.xiaohongshu.proxy) {
                const res = await fetchWithProxy(url);
                const $ = load(res);
                const script = extractInitialState($);
                const state = JSON.parse(script);

                let { userPageData, notes } = state.user;
                userPageData = userPageData._rawValue || userPageData;
                notes = notes._rawValue || notes;

                // Cannot get collect data without Playwright
                return { userPageData, notes, collect: '' };
            }

            // Use Playwright
            const { page, destroy } = await getPlaywrightPage(url, {
                closeTimeout: xiaohongshuBrowserCloseTimeout,
                noGoto: true,
                onBeforeLoad: setupXiaohongshuPage,
            });
            try {
                let collect = '';
                logger.http(`Requesting ${url}`);
                await page.goto(url, {
                    timeout: xiaohongshuBrowserNavigationTimeout,
                    waitUntil: 'domcontentloaded',
                });
                await waitForXiaohongshuUserPage(page);

                const initialState = await getXiaohongshuInitialState(page);

                if (!(await page.$('.lock-icon')) && (await hasCollectTab(page))) {
                    try {
                        const [response] = await Promise.all([
                            page.waitForResponse(
                                (res) => {
                                    const req = res.request();
                                    return req.url().includes('/api/sns/web/v2/note/collect/page') && req.method() === 'GET' && (req.resourceType() === 'xhr' || req.resourceType() === 'fetch');
                                },
                                { timeout: 5000 }
                            ),
                            clickCollectTab(page),
                        ]);
                        collect = await response.json();
                    } catch {
                        //
                    }
                }

                let { userPageData, notes } = initialState.user;
                userPageData = userPageData._rawValue || userPageData;
                notes = notes._rawValue || notes;

                return { userPageData, notes, collect };
            } finally {
                await destroy();
            }
        },
        config.cache.routeExpire,
        false
    );

const getBoard = (url, cache) =>
    cache.tryGet(
        url,
        async () => {
            // Use proxy if configured
            if (config.xiaohongshu.proxy) {
                const res = await fetchWithProxy(url);
                const $ = load(res);
                const script = extractInitialSsrState($);
                const state = JSON.parse(script);
                return state.Main;
            }

            // Use Playwright
            const browser = await playwright();
            try {
                const page = await browser.newPage();
                await page.setRequestInterception(true);
                page.on('request', (request) => {
                    request.resourceType() === 'document' || request.resourceType() === 'script' || request.resourceType() === 'xhr' ? request.continue() : request.abort();
                });
                logger.http(`Requesting ${url}`);
                await page.goto(url);
                await page.waitForSelector('.pc-container');
                const initialSsrState = await page.evaluate(() => (window as any).__INITIAL_SSR_STATE__);
                return initialSsrState.Main;
            } finally {
                await browser.close();
            }
        },
        config.cache.routeExpire,
        false
    );

const formatText = (text) => text.replaceAll(/(\r\n|\r|\n)/g, '<br>').replaceAll('\t', '&emsp;');

// tag_list.id has nothing to do with its url
const formatTagList = (tagList) => tagList.reduce((acc, item) => acc + `#${item.name} `, '');

const formatImageList = (imageList) => imageList.reduce((acc, item) => acc + `<img src="${item.url}"><br>`, '');

const formatNote = (url, note) => ({
    title: note.title,
    link: url + '/' + note.noteId,
    description: formatText(note.desc) + '<br><br>' + formatTagList(note.tagList) + '<br><br>' + formatImageList(note.imageList),
    author: note.user.nickname,
    pubDate: parseDate(note.time, 'x'),
    updated: parseDate(note.lastUpdateTime, 'x'),
});

async function renderNotesFulltext(notes, urlPrex, displayLivePhoto) {
    const data: Array<{
        title: string;
        link: string;
        description: string;
        author: string;
        guid: string;
        pubDate: Date;
        updated: Date;
    }> = [];
    const promises = notes.flatMap((note) =>
        note.map(async ({ noteCard, id }) => {
            const link = `${urlPrex}/${id}`;
            const guid = `${urlPrex}/${noteCard.noteId}`;
            const { title, description, pubDate, updated } = await getFullNote(link, displayLivePhoto);
            return {
                title,
                link,
                description,
                author: noteCard.user.nickName,
                guid,
                pubDate,
                updated,
            };
        })
    );
    data.push(...(await Promise.all(promises)));
    return data;
}

async function getFullNote(link, displayLivePhoto) {
    const data = (await cache.tryGet(link, async () => {
        const res = await fetchWithProxy(link, config.xiaohongshu.cookie);
        const $ = load(res);
        const script = extractInitialState($);
        const state = JSON.parse(script);
        const note = state.note.noteDetailMap[state.note.firstNoteId].note;
        const title = note.title;
        let desc = note.desc;
        desc = desc.replaceAll(/\[.*?\]/g, '');
        desc = desc.replaceAll(/#(.*?)#/g, '#$1');
        desc = desc.replaceAll('\n', '<br>');
        const pubDate = parseDate(note.time, 'x');
        const updated = parseDate(note.lastUpdateTime, 'x');

        let mediaContent = '';
        if (note.type === 'video') {
            const originVideoKey = note.video?.consumer?.originVideoKey;
            const videoUrls: string[] = [];

            if (originVideoKey) {
                videoUrls.push(`http://sns-video-al.xhscdn.com/${originVideoKey}`);
            }

            const streamTypes = ['av1', 'h264', 'h265', 'h266'];
            for (const type of streamTypes) {
                const streams = note.video?.media?.stream?.[type];
                if (streams?.length > 0) {
                    const stream = streams[0];
                    if (stream.masterUrl) {
                        videoUrls.push(stream.masterUrl);
                    }
                    if (stream.backupUrls?.length) {
                        videoUrls.push(...stream.backupUrls);
                    }
                }
            }

            const posterUrl = note.imageList?.[0]?.urlDefault;

            if (videoUrls.length > 0) {
                mediaContent = `<video controls ${posterUrl ? `poster="${posterUrl}"` : ''}>
                    ${videoUrls.map((url) => `<source src="${url}" type="video/mp4">`).join('\n')}
                </video><br>`;
            }
        } else {
            mediaContent = note.imageList
                .map((image) => {
                    if (image.livePhoto && displayLivePhoto) {
                        const videoUrls: string[] = [];

                        const streamTypes = ['av1', 'h264', 'h265', 'h266'];
                        for (const type of streamTypes) {
                            const streams = image.stream?.[type];
                            if (streams?.length > 0) {
                                if (streams[0].masterUrl) {
                                    videoUrls.push(streams[0].masterUrl);
                                }
                                if (streams[0].backupUrls?.length) {
                                    videoUrls.push(...streams[0].backupUrls);
                                }
                            }
                        }

                        if (videoUrls.length > 0) {
                            return `<video controls poster="${image.urlDefault}">
                            ${videoUrls.map((url) => `<source src="${url}" type="video/mp4">`).join('\n')}
                        </video>`;
                        }
                    }
                    return `<img src="${image.urlDefault}">`;
                })
                .join('<br>');
        }

        const description = `${mediaContent}<br>${desc}`;
        return {
            title: title || note.desc,
            description,
            pubDate,
            updated,
        };
    })) as Promise<{ title: string; description: string; pubDate: Date; updated: Date }>;
    return data;
}

async function getUserWithCookie(url: string) {
    const cookie = config.xiaohongshu.cookie;
    const res = await fetchWithProxy(url, cookie);
    const $ = load(res);
    const paths = $('#userPostedFeeds > section > div > a.cover.ld.mask').map((i, item) => item.attributes[3].value);
    const script = extractInitialState($);
    const state = JSON.parse(script);
    let index = 0;
    for (const item of state.user.notes.flat()) {
        const path = paths[index];
        if (path && path.includes('?')) {
            item.id = item.id + path?.slice(path.indexOf('?'));
        }
        index = index + 1;
    }
    return state.user;
}

// Add helper function to extract initial state
function extractInitialState($) {
    let script = $('script')
        .filter((i, script) => {
            const text = script.children[0]?.data;
            return text?.startsWith('window.__INITIAL_STATE__=');
        })
        .text();
    script = script.slice('window.__INITIAL_STATE__='.length);
    script = script.replaceAll('undefined', 'null');
    return script;
}

// Add helper function to extract initial SSR state
function extractInitialSsrState($) {
    let script = $('script')
        .filter((i, script) => {
            const text = script.children[0]?.data;
            return text?.includes('window.__INITIAL_SSR_STATE__=');
        })
        .text();
    const match = script.match(/window\.__INITIAL_SSR_STATE__\s*=\s*(\{[\s\S]*?\})\s*(?:;|$)/);
    if (match) {
        return match[1].replaceAll('undefined', 'null');
    }
    // Fallback: try simple extraction
    const startMarker = 'window.__INITIAL_SSR_STATE__=';
    const startIndex = script.indexOf(startMarker);
    if (startIndex !== -1) {
        script = script.slice(startIndex + startMarker.length);
        script = script.replaceAll('undefined', 'null');
        return script;
    }
    throw new Error('Cannot extract __INITIAL_SSR_STATE__');
}

async function checkCookie() {
    const cookie = config.xiaohongshu.cookie;
    const res = await ofetch('https://edith.xiaohongshu.com/api/sns/web/v2/user/me', {
        headers: getHeaders(cookie),
    });
    return res.code === 0 && !!res.data.user_id;
}

export { checkCookie, formatNote, formatText, getBoard, getFullNote, getUser, getUserWithCookie, renderNotesFulltext };
