import { load } from 'cheerio';
import pMap from 'p-map';

import { config } from '@/config';
import CaptchaError from '@/errors/types/captcha';
import cache from '@/utils/cache';
import logger from '@/utils/logger';
import ofetch from '@/utils/ofetch';
import { parseDate } from '@/utils/parse-date';
import type { Page } from '@/utils/playwright';
import { getPlaywrightPage } from '@/utils/playwright';

const xiaohongshuBrowserCloseTimeout = 90000;
const xiaohongshuBrowserNavigationTimeout = 45000;
const xiaohongshuNoteConcurrency = 2;
const xiaohongshuAllowedResourceTypes = new Set(['document', 'script', 'xhr', 'fetch', 'other']);
let xiaohongshuBrowserQueue = Promise.resolve();

type XiaohongshuFulltextItem = {
    noteCard: {
        noteId: string;
        user: {
            nickName: string;
        };
    };
    id: string;
};

type XiaohongshuFulltextResult = {
    author: string;
    description: string;
    guid: string;
    link: string;
    pubDate: Date;
    title: string;
    updated: Date;
};

type XiaohongshuPageSession = {
    destroy: () => Promise<void>;
    page: Page;
};

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

async function applyCookie(page: Page, cookie: string) {
    const cookies = cookie
        .split(';')
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => {
            const equalIndex = item.indexOf('=');
            if (equalIndex <= 0) {
                return;
            }

            return {
                name: item.slice(0, equalIndex).trim(),
                value: item.slice(equalIndex + 1).trim(),
                domain: '.xiaohongshu.com',
                path: '/',
            };
        })
        .filter((item) => item !== undefined);

    if (cookies.length > 0) {
        await page.setCookie(...cookies);
    }
}

async function withXiaohongshuBrowserGate<T>(task: () => Promise<T>) {
    const previousTask = xiaohongshuBrowserQueue;
    let releaseQueue: () => void;
    xiaohongshuBrowserQueue = new Promise<void>((resolve) => {
        releaseQueue = resolve;
    });

    await previousTask;

    try {
        return await task();
    } finally {
        releaseQueue!();
    }
}

async function setupXiaohongshuPage(page: Page, cookie?: string) {
    page.setDefaultNavigationTimeout(xiaohongshuBrowserNavigationTimeout);
    page.setDefaultTimeout(xiaohongshuBrowserNavigationTimeout);
    await page.setRequestInterception(true);
    page.on('request', (request: any) => {
        xiaohongshuAllowedResourceTypes.has(request.resourceType()) ? request.continue() : request.abort();
    });

    if (cookie) {
        await applyCookie(page, cookie);
    }
}

function isRetryableXiaohongshuError(error: unknown) {
    if (error instanceof CaptchaError) {
        return false;
    }

    return (
        error instanceof Error &&
        (error.message.includes('Execution context was destroyed') ||
            error.message.includes('Target page, context or browser has been closed') ||
            error.message.includes('frame was detached') ||
            error.message.includes('net::ERR_ABORTED') ||
            error.message.includes('Navigation failed because page was closed'))
    );
}

async function runXiaohongshuPageSession<T>(url: string, runner: (page: Page) => Promise<T>, cookie?: string) {
    let session: XiaohongshuPageSession | undefined;
    try {
        session = (await getPlaywrightPage(url, {
            closeTimeout: xiaohongshuBrowserCloseTimeout,
            gotoConfig: {
                timeout: xiaohongshuBrowserNavigationTimeout,
                waitUntil: 'domcontentloaded',
            },
            onBeforeLoad: async (page) => {
                await setupXiaohongshuPage(page, cookie);
            },
        })) as unknown as XiaohongshuPageSession;
        logger.http(`Requesting ${url}`);
        return await runner(session.page);
    } finally {
        if (session) {
            await session.destroy();
        }
    }
}

function withXiaohongshuPage<T>(url: string, runner: (page: Page) => Promise<T>, cookie?: string) {
    return withXiaohongshuBrowserGate(async () => {
        try {
            return await runXiaohongshuPageSession(url, runner, cookie);
        } catch (error) {
            if (isRetryableXiaohongshuError(error)) {
                logger.warn(`Retrying Xiaohongshu page request for ${url}: ${error instanceof Error ? error.message : error}`);
                return runXiaohongshuPageSession(url, runner, cookie);
            }
            throw error;
        }
    });
}

async function waitForXiaohongshuUserState(page: Page) {
    await page.waitForSelector('body', { timeout: 10000 });
    await page.waitForFunction(() => !!(window as any).__INITIAL_STATE__ || !!(window as any).__INITIAL_SSR_STATE__ || !!document.querySelector('#red-captcha'), {
        timeout: 15000,
    });

    if (await page.$('#red-captcha')) {
        throw new CaptchaError('小红书风控校验，请稍后再试');
    }
}

async function getXiaohongshuInitialStates(page: Page) {
    const initialState = await page.evaluate(() => (window as any).__INITIAL_STATE__);
    const initialSsrState = await page.evaluate(() => (window as any).__INITIAL_SSR_STATE__);
    return { initialSsrState, initialState };
}

function hasCollectAccess(page: Page) {
    return page.$('.lock-icon');
}

function hasCollectTab(page: Page) {
    return page.evaluate(() => [...document.querySelectorAll<HTMLElement>('div.reds-tab-item')].some((element) => (element.textContent || '').includes('收藏')));
}

async function clickCollectTabAndGetResponse(page: Page) {
    const response = await Promise.all([
        page.waitForResponse(
            (res) => {
                const req = res.request();
                return req.url().includes('/api/sns/web/v2/note/collect/page') && req.method() === 'GET' && (req.resourceType() === 'xhr' || req.resourceType() === 'fetch');
            },
            { timeout: 5000 }
        ),
        page.evaluate(() => {
            const tab = [...document.querySelectorAll<HTMLElement>('div.reds-tab-item')].find((element) => (element.textContent || '').includes('收藏'));
            tab?.click();
        }),
    ]);
    return response[0].json();
}

function getUserStateFromParsedStates(initialState: any, initialSsrState: any) {
    return initialState?.user || initialSsrState?.user || initialSsrState?.Main?.user || initialSsrState?.main?.user || initialSsrState?.User?.user;
}

function getUserStateFromHtml(html: string) {
    const $ = load(html);
    let initialState;
    let initialSsrState;

    try {
        initialState = JSON.parse(extractInitialState($));
    } catch {
        // Ignore missing __INITIAL_STATE__ and continue with SSR state.
    }

    try {
        initialSsrState = JSON.parse(extractInitialSsrState($));
    } catch {
        // Ignore missing __INITIAL_SSR_STATE__ and rely on the initial state when available.
    }

    const userState = getUserStateFromParsedStates(initialState, initialSsrState);

    if (!userState?.userPageData || !userState?.notes) {
        throw new Error('Failed to parse user data from Xiaohongshu page. Try using cookie or proxy.');
    }

    return { $, userState };
}

function normalizeUserState(userState: any) {
    const validUserState = ensureValidUserState(userState);
    let { userPageData, notes } = validUserState;
    userPageData = userPageData._rawValue || userPageData;
    notes = notes._rawValue || notes;
    return { notes, userPageData };
}

function extractNoteQueryParamsFromPaths(paths: Array<string | undefined>, notes: XiaohongshuFulltextItem[][]) {
    let index = 0;
    for (const item of notes.flat()) {
        const path = paths[index];
        if (path && path.includes('?')) {
            item.id += path.slice(path.indexOf('?'));
        }
        index += 1;
    }
}

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

const getUser = (url: string, cacheStorage: typeof cache, includeCollect = false) =>
    cacheStorage.tryGet(
        `${url}#${includeCollect ? 'collect' : 'notes'}`,
        async () => {
            // Use proxy if configured
            if (config.xiaohongshu.proxy) {
                const res = await fetchWithProxy(url);
                const { userState } = getUserStateFromHtml(res);
                const { userPageData, notes } = normalizeUserState(userState);

                // Cannot get collect data without Playwright
                return { userPageData, notes, collect: '' };
            }

            return withXiaohongshuPage(url, async (page) => {
                let collect = '';
                await waitForXiaohongshuUserState(page);

                const { initialState, initialSsrState } = await getXiaohongshuInitialStates(page);
                const userState = await resolveUserState(page, initialState, initialSsrState);
                const { userPageData, notes } = normalizeUserState(userState);

                if (includeCollect && !(await hasCollectAccess(page)) && (await hasCollectTab(page))) {
                    try {
                        collect = await clickCollectTabAndGetResponse(page);
                    } catch {
                        // Ignore collect fetch failures and return the main notes feed.
                    }
                }

                return { userPageData, notes, collect };
            });
        },
        config.cache.routeExpire,
        false
    );

const getBoard = (url: string, cacheStorage: typeof cache) =>
    cacheStorage.tryGet(
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

            return withXiaohongshuPage(url, async (page) => {
                await page.waitForSelector('body', { timeout: 10000 });
                await page.waitForFunction(() => !!(window as any).__INITIAL_SSR_STATE__ || !!document.querySelector('#red-captcha'), {
                    timeout: 15000,
                });

                if (await page.$('#red-captcha')) {
                    throw new CaptchaError('小红书风控校验，请稍后再试');
                }

                const initialSsrState = await page.evaluate(() => (window as any).__INITIAL_SSR_STATE__);
                return initialSsrState.Main;
            });
        },
        config.cache.routeExpire,
        false
    );

const formatText = (text: string) => text.replaceAll(/(\r\n|\r|\n)/g, '<br>').replaceAll('\t', '&emsp;');

// tag_list.id has nothing to do with its url
const formatTagList = (tagList: Array<{ name: string }>) => tagList.reduce((acc, item) => acc + `#${item.name} `, '');

const formatImageList = (imageList: Array<{ url: string }>) => imageList.reduce((acc, item) => acc + `<img src="${item.url}"><br>`, '');

const formatNote = (url: string, note: any) => ({
    title: note.title,
    link: url + '/' + note.noteId,
    description: formatText(note.desc) + '<br><br>' + formatTagList(note.tagList) + '<br><br>' + formatImageList(note.imageList),
    author: note.user.nickname,
    pubDate: parseDate(note.time, 'x'),
    updated: parseDate(note.lastUpdateTime, 'x'),
});

function renderNotesFulltext(notes: XiaohongshuFulltextItem[][], urlPrex: string, displayLivePhoto: boolean): Promise<XiaohongshuFulltextResult[]> {
    const flattenedNotes: XiaohongshuFulltextItem[] = notes.flatMap((note) => note.map(({ noteCard, id }) => ({ id, noteCard })));
    return pMap(
        flattenedNotes,
        async ({ noteCard, id }) => {
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
        },
        { concurrency: xiaohongshuNoteConcurrency }
    );
}

async function getFullNote(link: string, displayLivePhoto: boolean) {
    const data = await cache.tryGet<{ title: string; description: string; pubDate: Date; updated: Date }>(link, async () => {
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
                .map((image: any) => {
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
    });
    return data;
}

function getUserWithCookie(url: string) {
    const cookie = config.xiaohongshu.cookie;

    return cache.tryGet(
        `${url}#cookie`,
        () =>
            withXiaohongshuPage(
                url,
                async (page) => {
                    await waitForXiaohongshuUserState(page);

                    const { initialState, initialSsrState } = await getXiaohongshuInitialStates(page);
                    const userState = await resolveUserState(page, initialState, initialSsrState);
                    const normalizedUserState = normalizeUserState(userState);
                    const notePaths = await page.evaluate(() => [...document.querySelectorAll<HTMLAnchorElement>('#userPostedFeeds a.cover')].map((item) => item.getAttribute('href') ?? undefined));
                    extractNoteQueryParamsFromPaths(notePaths, normalizedUserState.notes);

                    return normalizedUserState;
                },
                cookie
            ),
        config.cache.routeExpire,
        false
    );
}

// Add helper function to extract initial state
function extractInitialState($: any) {
    const scriptText = $('script')
        .toArray()
        .map((script: any) => script.children[0]?.data || '')
        .join('\n');
    const match = scriptText.match(/window\.__INITIAL_STATE__\s*=\s*(\{[\s\S]*?\})\s*(?:;|$)/);

    if (!match) {
        throw new Error('Cannot extract __INITIAL_STATE__');
    }

    return match[1].replaceAll('undefined', 'null');
}

// Add helper function to extract initial SSR state
function extractInitialSsrState($: any) {
    let script = $('script')
        .filter((_: any, script: any) => {
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

async function resolveUserState(page: Page, initialState: any, initialSsrState: any) {
    const userState = getUserStateFromParsedStates(initialState, initialSsrState);

    if (userState?.userPageData && userState?.notes) {
        return userState;
    }

    const html = await page.content();
    const { userState: fallbackUserState } = getUserStateFromHtml(html);

    if (fallbackUserState?.userPageData && fallbackUserState?.notes) {
        return fallbackUserState;
    }

    throw new Error('Failed to parse user data from Xiaohongshu page. Try using cookie or proxy.');
}

function ensureValidUserState(userState: any) {
    if (!userState?.userPageData?.basicInfo) {
        throw new CaptchaError('小红书返回登录/验证页面，请使用有效 Cookie 或稍后再试');
    }
    return userState;
}

async function checkCookie() {
    const cookie = config.xiaohongshu.cookie;
    const res = await ofetch('https://edith.xiaohongshu.com/api/sns/web/v2/user/me', {
        headers: getHeaders(cookie),
    });
    return res.code === 0 && !!res.data.user_id;
}

export { checkCookie, formatNote, formatText, getBoard, getFullNote, getUser, getUserWithCookie, renderNotesFulltext };
