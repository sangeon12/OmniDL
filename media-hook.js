
(() => {
    if (window.__onmidlMediaHook) return;
    window.__onmidlMediaHook = true;

    const sourceTypes = new WeakMap();
    const sourceBuffers = new WeakMap();
    const objectURLs = new Map();
    const bufferDetails = new WeakMap();

    const originalAddSourceBuffer = MediaSource.prototype.addSourceBuffer;
    const originalAppendBuffer = SourceBuffer.prototype.appendBuffer;
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;

    MediaSource.prototype.addSourceBuffer = function(type) {
        const buffer = originalAddSourceBuffer.call(this, type);

        sourceTypes.set(buffer, type);
        sourceBuffers.set(buffer, this);

        if (!bufferDetails.has(this)) {
            bufferDetails.set(this, new Map());
        }

        bufferDetails.get(this).set(buffer, {
            mimeType: type,
            appendCount: 0,
            totalBytes: 0,
            lastAppendBytes: 0
        });

        return buffer;
    };

    SourceBuffer.prototype.appendBuffer = function(data) {
        const source = sourceBuffers.get(this);

        if (source) {
            const detail = bufferDetails.get(source)?.get(this);

            if (detail) {
                const bytes = data.byteLength;

                detail.appendCount++;
                detail.totalBytes += bytes;
                detail.lastAppendBytes = bytes;
            }
        }

        return originalAppendBuffer.call(this, data);
    };

    URL.createObjectURL = function(object) {
        const url = originalCreateObjectURL.call(this, object);

        if (object instanceof MediaSource) {
            objectURLs.set(url, object);
        }

        return url;
    };

    URL.revokeObjectURL = function(url) {
        objectURLs.delete(url);
        return originalRevokeObjectURL.call(this, url);
    };

    const getRanges = ranges => {
        const result = [];

        for (let i = 0; i < ranges.length; i++) {
            result.push({
                start: ranges.start(i),
                end: ranges.end(i)
            });
        }

        return result;
    };

    const getSourceData = media => {
        const url = media.currentSrc || media.src;
        const source = objectURLs.get(url);

        if (!source) return null;

        const details = bufferDetails.get(source);

        return {
            readyState: source.readyState,
            sourceBuffers: details
                ? [...details.entries()].map(([buffer, detail]) => ({
                    ...detail,
                    buffered: getRanges(buffer.buffered),
                    updating: buffer.updating
                }))
                : []
        };
    };

    document.addEventListener("playing", event => {
        const media = event.target;

        if (!(media instanceof HTMLMediaElement)) return;

        const data = {
            detected: true,
            pageURL: location.href,
            mediaURL: media.currentSrc || media.src || null,
            mediaType: media.tagName.toLowerCase(),
            currentTime: media.currentTime,
            duration: Number.isFinite(media.duration) ? media.duration : null,
            paused: media.paused,
            readyState: media.readyState,
            networkState: media.networkState,
            buffered: getRanges(media.buffered),
            videoWidth: media instanceof HTMLVideoElement ? media.videoWidth : null,
            videoHeight: media instanceof HTMLVideoElement ? media.videoHeight : null,
            mediaSource: getSourceData(media),
            detectedAt: new Date().toISOString()
        };

        console.log("[OnmiDL] 미디어 재생 감지", data);
    }, true);
})();
