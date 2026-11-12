
import { sendYtDlpRequest } from "./native.js";
import { addVideos } from "./video-store.js";


const tabs = new Map();
const attached = new Set();
const attaching = new Set();
const pendingResponses = new Map();
const version = "1.3";

function getState(tabId) {
    if (!tabs.has(tabId)) {
        tabs.set(tabId, {
            tabId,
            pageURL: "",
            updatedAt: Date.now(),
            headers: [],
            cookies: [],
            manifests: []
        });
    }

    return tabs.get(tabId);
}

function isWebURL(url) {
    return /^https?:\/\//i.test(url || "");
}

function getManifestType(url, mimeType = "") {
    const path = url.split("?")[0].toLowerCase();
    const mime = mimeType.toLowerCase();

    if (
        path.endsWith(".m3u8") ||
        mime.includes("mpegurl")
    ) return "HLS";

    if (
        path.endsWith(".mpd") ||
        mime.includes("dash+xml")
    ) return "DASH";

    return null;
}

function getHeader(headers, name) {
    return headers.find(
        header => header.name.toLowerCase() === name
    )?.value || "";
}

function decodeBody(body, base64Encoded) {
    if (!base64Encoded) return body;

    const binary = atob(body);
    const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));

    return new TextDecoder().decode(bytes);
}

async function save(tabId) {
    const state = tabs.get(tabId);

    if (!state) return;

    try {
        await chrome.storage.session.set({
            [`omniDL_${tabId}`]: state
        });
    } catch (error) {
        console.error("[OmniDL] 저장 실패", error.message);
    }
}

async function refreshCookies(tabId, url) {
    if (!isWebURL(url)) return;

    const state = getState(tabId);

    try {
        const cookies = await chrome.cookies.getAll({ url });

        if (tabs.get(tabId) !== state) return;

        state.cookies = cookies;
        state.updatedAt = Date.now();

        await save(tabId);

        console.log("[OmniDL] 쿠키 수집", {
            tabId,
            count: cookies.length,
            cookies
        });
    } catch (error) {
        console.error("[OmniDL] 쿠키 수집 실패", error.message);
    }
}

async function attachDebugger(tabId) {
    if (attached.has(tabId) || attaching.has(tabId)) return;

    attaching.add(tabId);

    const target = { tabId };

    try {
        await chrome.debugger.attach(target, version);
        attached.add(tabId);
        await chrome.debugger.sendCommand(target, "Network.enable");

        console.log("[OmniDL] 네트워크 디버거 연결", tabId);
    } catch (error) {
        console.error("[OmniDL] 디버거 연결 실패", {
            tabId,
            error: error.message
        });
    } finally {
        attaching.delete(tabId);
    }
}

function resetState(tabId, pageURL, clearManifests) {
    console.log("[OmniDL] 매니페스트 초기화 확인", {
        tabId,
        pageURL,
        clearManifests,
        previousCount: getState(tabId).manifests.length,
        timestamp: Date.now()
    });

    const state = getState(tabId);

    state.pageURL = pageURL;
    state.headers = [];
    state.cookies = [];

    if (clearManifests) {
        state.manifests = [];
    }

    state.updatedAt = Date.now();

    save(tabId);
}

function collectHeaders(details, headerType) {
    if (details.tabId < 0) return;

    const state = getState(details.tabId);

    if (!state.pageURL) return;

    const headerList = headerType === "request"
        ? details.requestHeaders || []
        : details.responseHeaders || [];

    state.headers.push({
        requestId: details.requestId,
        url: details.url,
        method: details.method,
        resourceType: details.type,
        headerType,
        statusCode: details.statusCode || null,
        headers: headerList,
        timestamp: Date.now()
    });

    if (state.headers.length > 100) {
        state.headers.shift();
    }

    state.updatedAt = Date.now();
    save(details.tabId);
}

async function collectManifest(tabId, requestId, metadata) {
    const target = { tabId };

    try {
        const result = await chrome.debugger.sendCommand(
            target,
            "Network.getResponseBody",
            { requestId }
        );

        const body = decodeBody(
            result.body,
            result.base64Encoded
        );

        if (body.length > 2000000) {
            console.warn("[OmniDL] 매니페스트 크기 초과", metadata.url);
            return;
        }

        const state = getState(tabId);

        const manifest = {
            type: metadata.type,
            url: metadata.url,
            mimeType: metadata.mimeType,
            status: metadata.status,
            responseHeaders: metadata.headers,
            body,
            collectedAt: Date.now()
        };

        const index = state.manifests.findIndex(
            item => item.url === manifest.url
        );

        if (index >= 0) {
            state.manifests[index] = manifest;
        } else {
            state.manifests.push(manifest);
        }

        state.updatedAt = Date.now();

        await save(tabId);

        const saveResult = await addVideos([{
            id: manifest.url,
            title: `${manifest.type} Manifest`,
            videoUrl: manifest.url,
            source: "m3u8dl",
            manifestType: manifest.type,
            mimeType: manifest.mimeType,
            status: manifest.status,
            responseHeaders: manifest.responseHeaders,
            body: manifest.body,
            collectedAt: manifest.collectedAt
        }]);

        state.manifests = state.manifests.filter(
            item => item.url !== manifest.url
        );

        state.updatedAt = Date.now();

        await save(tabId);

        console.log("[OmniDL] 매니페스트 처리 완료", {
            tabId,
            url: manifest.url,
            addedCount: saveResult.addedCount,
            totalCount: saveResult.totalCount,
            temporaryCount: state.manifests.length
        });

        if (index >= 0) {
            state.manifests[index] = manifest;
        } else {
            state.manifests.push(manifest);
        }

        state.updatedAt = Date.now();

        await save(tabId);

        console.log("[OmniDL] 매니페스트 저장 상태", {
            tabId,
            memoryCount: state.manifests.length,
            storageCount: (
                await chrome.storage.session.get(`omniDL_${tabId}`)
            )[`omniDL_${tabId}`]?.manifests?.length ?? 0,
            timestamp: Date.now()
        });

        console.log("[OmniDL] 매니페스트 수집 성공", {
            tabId,
            type: manifest.type,
            url: manifest.url,
            bodyLength: manifest.body.length,
            manifest
        });
    } catch (error) {
        console.error("[OmniDL] 매니페스트 본문 수집 실패", {
            url: metadata.url,
            error: error.message
        });
    }
}

export function initializeNetwork() {
    chrome.webRequest.onBeforeSendHeaders.addListener(
        details => {
            collectHeaders(details, "request");
        },
        { urls: ["<all_urls>"] },
        ["requestHeaders", "extraHeaders"]
    );

    chrome.webRequest.onHeadersReceived.addListener(
        details => {
            collectHeaders(details, "response");
        },
        { urls: ["<all_urls>"] },
        ["responseHeaders", "extraHeaders"]
    );

    
    chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
        if (!isWebURL(tab.url)) return;

        if (changeInfo.status === "loading") {
            resetState(tabId, tab.url, true);
            attachDebugger(tabId);
            refreshCookies(tabId, tab.url);

            console.log("[OmniDL] 웹사이트 최초 로드", {
                tabId,
                url: tab.url
            });

            return;
        }

        if (changeInfo.status === "complete") {
            const state = getState(tabId);

            if (state.pageURL !== tab.url) return;

            refreshCookies(tabId, tab.url).then(() => {
                if (tabs.get(tabId) !== state) return;

                //sendYtDlpRequest(tabId, "initial_load", state);
            });
        }
    });

    
    chrome.runtime.onMessage.addListener((message, sender) => {
        if (message.type !== "OMNIDL_MEDIA_PLAYING") return;
        if (!sender.tab) return;

        const tabId = sender.tab.id;
        const state = getState(tabId);

        state.headers = [];
        state.cookies = [];
        state.updatedAt = Date.now();

        save(tabId);
        refreshCookies(tabId, message.data.pageURL);

        console.log("[OmniDL] 미디어 재생 감지 및 데이터 갱신", {
            tabId,
            media: message.data
        });

        setTimeout(async () => {
            if (tabs.get(tabId) !== state) return;

            await refreshCookies(tabId, message.data.pageURL);

            if (tabs.get(tabId) !== state) return;

            sendYtDlpRequest(tabId, "media_playing", state);
        }, 1200);
    });

    chrome.debugger.onEvent.addListener((source, method, params) => {
        const tabId = source.tabId;

        if (tabId === undefined) return;

        if (method === "Network.responseReceived") {
            const response = params.response;

            const type = getManifestType(
                response.url,
                response.mimeType
            );

            if (!type) return;

            const key = `${tabId}:${params.requestId}`;

            pendingResponses.set(key, {
                tabId,
                type,
                url: response.url,
                mimeType: response.mimeType,
                status: response.status,
                headers: response.headers
            });

            console.log("[OmniDL] 매니페스트 응답 상세", {
                tabId,
                requestId: params.requestId,
                url: response.url,
                status: response.status,
                fromDiskCache: response.fromDiskCache,
                fromServiceWorker: response.fromServiceWorker,
                fromPrefetchCache: response.fromPrefetchCache,
                mimeType: response.mimeType,
                resourceType: params.type
            });

            console.log("[OmniDL] 매니페스트 응답 감지", {
                type,
                url: response.url
            });
        }

        if (method === "Network.loadingFinished") {
            const key = `${tabId}:${params.requestId}`;
            const metadata = pendingResponses.get(key);

            if (!metadata) return;

            pendingResponses.delete(key);

            collectManifest(tabId, params.requestId, metadata);
        }

        if (method === "Network.loadingFailed") {
            pendingResponses.delete(`${tabId}:${params.requestId}`);
        }
    });

    chrome.debugger.onDetach.addListener(source => {
        if (source.tabId === undefined) return;

        attached.delete(source.tabId);
        attaching.delete(source.tabId);

        console.log("[OmniDL] 디버거 연결 종료", source.tabId);
    });

    chrome.tabs.onRemoved.addListener(tabId => {
        tabs.delete(tabId);
        attached.delete(tabId);
        attaching.delete(tabId);

        for (const key of pendingResponses.keys()) {
            if (key.startsWith(`${tabId}:`)) {
                pendingResponses.delete(key);
            }
        }

        chrome.storage.session.remove(`omniDL_${tabId}`);
    });
}
