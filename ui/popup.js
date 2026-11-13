
const list = document.getElementById("video-list");
const STORAGE_KEY = "omniDL_videos";

async function loadVideos() {
    const result = await chrome.storage.session.get(STORAGE_KEY);
    const videos = result[STORAGE_KEY] || [];

    list.replaceChildren();

    if (videos.length === 0) {
        list.textContent = "영상 없음";
        return;
    }

    for (const video of videos) {
        const item = document.createElement("div");
        const title = document.createElement("div");
        const url = document.createElement("div");
        const source = document.createElement("div");
        const button = document.createElement("button");

        title.textContent = video.title || "제목 없음";
        url.textContent = video.videoUrl;
        source.textContent = `유형: ${video.source}`;
        button.textContent = "다운로드";

        button.addEventListener("click", async () => {
            try {
                const response = await chrome.runtime.sendMessage({
                    type: "OMNIDL_DOWNLOAD_REQUEST",
                    video
                });
            
                if (!response?.success) {
                    console.error("[OmniDL] 다운로드 요청 실패", response?.error);
                    return;
                }
            
                console.log("[OmniDL] 다운로드 요청 전달 완료", {
                    requestId: response.requestId,
                    source: video.source,
                    videoUrl: video.videoUrl
                });
            } catch (error) {
                console.error("[OmniDL] 다운로드 통신 오류", error);
            }
        });

        item.append(title, url, source, button);
        item.append(document.createElement("hr"));

        list.appendChild(item);
    }
}

chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "session") return;

    if (changes[STORAGE_KEY]) {
        loadVideos();
    }
});

loadVideos();
