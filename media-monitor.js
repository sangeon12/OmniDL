
(() => {
    if (window.__omniDLMonitor) return;
    window.__omniDLMonitor = true;

    document.addEventListener("playing", event => {
        const media = event.target;

        if (!(media instanceof HTMLMediaElement)) return;

        chrome.runtime.sendMessage({
            type: "OMNIDL_MEDIA_PLAYING",
            data: {
                pageURL: location.href,
                mediaURL: media.currentSrc || media.src || null,
                mediaType: media.tagName.toLowerCase(),
                detectedAt: Date.now()
            }
        }).catch(() => {});
    }, true);
})();
