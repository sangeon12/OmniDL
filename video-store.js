
export const VIDEO_STORAGE_KEY = "omniDL_videos";

let storageQueue = Promise.resolve();

export function addVideos(videos) {
    const operation = async () => {
        const result = await chrome.storage.session.get(VIDEO_STORAGE_KEY);
        const existing = result[VIDEO_STORAGE_KEY] || [];
        const urls = new Set(existing.map(item => item.videoUrl));

        let addedCount = 0;

        for (const video of videos) {
            if (!video?.videoUrl || urls.has(video.videoUrl)) continue;

            existing.push(video);
            urls.add(video.videoUrl);
            addedCount++;
        }

        if (addedCount > 0) {
            await chrome.storage.session.set({
                [VIDEO_STORAGE_KEY]: existing
            });
        }

        return {
            addedCount,
            totalCount: existing.length
        };
    };

    const result = storageQueue.then(operation);
    storageQueue = result.catch(() => {});

    return result;
}
