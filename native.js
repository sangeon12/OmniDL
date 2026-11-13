import { addVideos } from "./video-store.js";

const HOST_NAME = "com.omnidl.core";

let nativePort = null;
let requestCounter = 0;

function awaitStorage(tabId, videoKey, networkKey) {
    return chrome.storage.session.get([videoKey, networkKey]);
}

export function connectCore() {
    if (nativePort) return nativePort;

    nativePort = chrome.runtime.connectNative(HOST_NAME);

    nativePort.onMessage.addListener(message => {
        if (message.type === "pong") {
            console.log("[OmniDL] Core 연결 확인", message);
            return;
        }

        
        if (message.type === "extract_result") {
            console.log("[OmniDL] yt-dlp 추출 결과", {
                tabId: message.tabId,
                success: message.success,
                count: message.videos?.length || 0,
                error: message.error
            });
        
            if (message.success !== true || !Array.isArray(message.videos)) {
                console.log("[OmniDL] yt-dlp 추출 실패, 저장 생략");
                return;
            }
        
            const videos = message.videos.map(video => ({
                ...video,
                source: "yt-dlp"
            }));
        
            addVideos(videos).then(saveResult => {
                console.log("[OmniDL] yt-dlp 영상 저장 완료", {
                    addedCount: saveResult.addedCount,
                    totalCount: saveResult.totalCount
                });
            }).catch(error => {
                console.error("[OmniDL] yt-dlp 영상 저장 실패", error);
            });
        
            return;
        }

        console.log("[OmniDL] Core 메시지 수신", message);

        if (message.type === "download_result") {
            console.log("[OmniDL] 다운로드 결과 수신", {
                requestId: message.requestId,
                source: message.source,
                success: message.success,
                filePath: message.filePath,
                error: message.error
            });
        
            return;
        }
    });

    nativePort.onDisconnect.addListener(() => {
        const error = chrome.runtime.lastError;

        console.error(
            "[OmniDL] Core 연결 종료",
            error?.message || "연결 종료"
        );

        nativePort = null;
    });

    console.log("[OmniDL] Core 연결 요청");

    nativePort.postMessage({
        type: "ping"
    });

    return nativePort;
}

export function sendYtDlpRequest(tabId, reason, state) {
    if (!state?.pageURL) return;

    const port = connectCore();
    const requestId = ++requestCounter;

    const pageOrigin = new URL(state.pageURL).origin;

    const requestHeaders = state.headers
        .filter(item => {
            if (item.headerType !== "request") return false;

            try {
                return new URL(item.url).origin === pageOrigin;
            } catch {
                return false;
            }
        })
        .reverse();

    const headers = new Map();

    for (const request of requestHeaders) {
        for (const header of request.headers) {
            const name = header.name.toLowerCase();

            if (![
                "user-agent",
                "referer",
                "origin",
                "accept-language"
            ].includes(name)) continue;

            if (!headers.has(name)) {
                headers.set(name, {
                    name: header.name,
                    value: header.value
                });
            }
        }
    }

    port.postMessage({
        type: "extract",
        requestId,
        tabId,
        reason,
        pageURL: state.pageURL,
        headers: [...headers.values()],
        cookies: state.cookies.map(cookie => ({
            name: cookie.name,
            value: cookie.value,
            domain: cookie.domain,
            path: cookie.path,
            secure: cookie.secure,
            hostOnly: cookie.hostOnly,
            expirationDate: cookie.expirationDate ?? 0
        }))
    });

    console.log("[OmniDL] yt-dlp 요청 송신", {
        requestId,
        tabId,
        reason,
        pageURL: state.pageURL,
        headerCount: headers.size,
        cookieCount: state.cookies.length
    });
}

export function sendDownloadRequest(video) {
    const port = connectCore();

    const requestId = ++requestCounter;

    port.postMessage({
        type: "download",
        requestId,
        source: video.source,
        video
    });

    console.log("[OmniDL] 다운로드 요청 송신", {
        requestId,
        source: video.source,
        title: video.title,
        videoUrl: video.videoUrl,
        dataKeys: Object.keys(video)
    });

    return requestId;
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type !== "OMNIDL_DOWNLOAD_REQUEST") return;

    if (sender.url !== chrome.runtime.getURL("ui/popup.html")) return;

    try {
        const requestId = sendDownloadRequest(message.video);

        sendResponse({
            success: true,
            requestId
        });
    } catch (error) {
        console.error("[OmniDL] 다운로드 요청 송신 실패", error);

        sendResponse({
            success: false,
            error: error.message
        });
    }
});