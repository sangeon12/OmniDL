
const excludedTypes = new Set([
  "text/html",
  "text/css",
  "text/javascript",
  "application/javascript",
  "application/x-javascript",
  "application/ecmascript",
  "application/wasm",
  "application/pdf",
  "application/manifest+json",
  "application/x-www-form-urlencoded"
]);

const excludedPrefixes = ["font/"];

// 메타데이터 후보 MIME 타입
const metadataTypes = new Set([
  "application/json",
  "application/ld+json",
  "application/xml",
  "text/xml"
]);

// 매니페스트 MIME 타입
const manifestTypes = new Set([
  "application/vnd.apple.mpegurl",
  "application/x-mpegurl",
  "audio/mpegurl",
  "audio/x-mpegurl",
  "application/dash+xml"
]);

// 메타데이터 판별 후 실행
async function detectMetadata(details) {
  try {
    const response = await fetch(details.url, {
      credentials: "include"
    });

    if (!response.ok) return false;

    const contentType = response.headers
      .get("content-type")
      ?.toLowerCase() ?? "";

    const body = await response.text();

    let isMetadata = false;
    let data = null;

    if (contentType.includes("json")) {
      data = JSON.parse(body);

      const keys = [
        "videoId", "video_id",
        "duration", "width", "height",
        "streams", "formats",
        "sources", "tracks",
        "playbackUrl", "streamUrl"
      ];

      isMetadata = data !== null &&
        typeof data === "object" &&
        keys.some(key => key in data);
    }

    else if (contentType.includes("xml")) {
      data = body;

      isMetadata =
        /<(video|audio|media|track|duration|stream)\b/i
          .test(body);
    }

    console.log("[Metadata 분석]", {
      url: details.url,
      detected: isMetadata,
      data
    });

    return isMetadata;

  } catch (error) {
    console.error("[Metadata 오류]", details.url, error);
    return false;
  }
}

// 매니페스트 판별 후 실행
async function detectManifest(details) {
  try {
    const response = await fetch(details.url, {
      credentials: "include"
    });

    if (!response.ok) return false;

    const body = await response.text();

    // 공통: 속성 추출
    function parseAttributes(text, isXML = false) {
      const attrs = {};

      const regex = isXML
        ? /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g
        : /([A-Z0-9-]+)\s*=\s*("(?:[^"]*)"|[^,]*)/g;

      for (const match of text.matchAll(regex)) {
        attrs[match[1]] = isXML
          ? (match[2] ?? match[3])
          : match[2].replace(/^"|"$/g, "");
      }

      return attrs;
    }

    // 비어 있는 배열은 null로 변환
    const optional = arr => arr.length ? arr : null;

    // ==================================
    // 1. HLS
    // ==================================
    if (body.trimStart().startsWith("#EXTM3U")) {
      const lines = body.split(/\r?\n/)
        .map(line => line.trim())
        .filter(Boolean);

      const isMaster = lines.some(
        line => line.startsWith("#EXT-X-STREAM-INF:")
      );

      const isMedia = lines.some(
        line => line.startsWith("#EXT-X-TARGETDURATION:")
      );

      if (!isMaster && !isMedia) return false;

      const variantsList = [];
      const tracksList = [];
      const segmentsList = [];
      const initializationList = [];

      let targetDuration = null;
      let mediaSequence = null;
      let endList = false;

      let pendingVariant = null;
      let pendingDuration = null;
      let pendingByteRange = null;

      const resolveUrl = uri =>
        new URL(uri, details.url).href;

      for (const line of lines) {

        if (line.startsWith("#EXT-X-STREAM-INF:")) {
          pendingVariant = parseAttributes(
            line.slice("#EXT-X-STREAM-INF:".length)
          );
        }

        else if (line.startsWith("#EXT-X-MEDIA:")) {
          const track = parseAttributes(
            line.slice("#EXT-X-MEDIA:".length)
          );

          if (track.URI) {
            track.URI = resolveUrl(track.URI);
          }

          tracksList.push(track);
        }

        else if (line.startsWith("#EXT-X-MAP:")) {
          const init = parseAttributes(
            line.slice("#EXT-X-MAP:".length)
          );

          if (init.URI) {
            init.URI = resolveUrl(init.URI);
          }

          initializationList.push(init);
        }

        else if (line.startsWith("#EXT-X-TARGETDURATION:")) {
          targetDuration = Number(
            line.slice("#EXT-X-TARGETDURATION:".length)
          );
        }

        else if (line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) {
          mediaSequence = Number(
            line.slice("#EXT-X-MEDIA-SEQUENCE:".length)
          );
        }

        else if (line.startsWith("#EXT-X-BYTERANGE:")) {
          pendingByteRange = line.slice(
            "#EXT-X-BYTERANGE:".length
          );
        }

        else if (line.startsWith("#EXTINF:")) {
          pendingDuration = Number(
            line.slice("#EXTINF:".length).split(",")[0]
          );
        }

        else if (line === "#EXT-X-ENDLIST") {
          endList = true;
        }

        else if (!line.startsWith("#")) {
          const url = resolveUrl(line);

          if (pendingVariant) {
            variantsList.push({
              ...pendingVariant,
              url
            });

            pendingVariant = null;
          }

          else if (pendingDuration !== null) {
            segmentsList.push({
              index: segmentsList.length,
              url,
              duration: pendingDuration,
              byteRange: pendingByteRange
            });

            pendingDuration = null;
            pendingByteRange = null;
          }
        }
      }

      // 기존 검증 조건 유지
      const valid = isMaster
        ? variantsList.length > 0
        : targetDuration > 0 && segmentsList.length > 0;

      if (!valid) return false;

      // 추출 정보 개별 변수 저장
      const type = "HLS";
      const playlistType = isMaster ? "Master" : "Media";
      const variants = optional(variantsList);
      const tracks = optional(tracksList);
      const segments = optional(segmentsList);
      const initialization = optional(initializationList);

      // 개별 로그
      console.groupCollapsed("[OmniDL] HLS Manifest");

      console.log("URL:", details.url);
      console.log("Type:", type);
      console.log("Playlist Type:", playlistType);
      console.log("Variants:", variants);
      console.log("Tracks:", tracks);
      console.log("Segments:", segments);
      console.log("Initialization:", initialization);
      console.log("Target Duration:", targetDuration);
      console.log("Media Sequence:", mediaSequence);
      console.log("End List:", endList);

      console.groupEnd();

      return true;
    }

    // ==================================
    // 2. MPEG-DASH
    // ==================================
    const mpdMatch = body.match(
      /<MPD(?=[\s/>])([^>]*?)>/i
    );

    if (mpdMatch) {
      const mpdAttributes = parseAttributes(
        mpdMatch[1], true
      );

      if (
        mpdAttributes.xmlns !==
        "urn:mpeg:dash:schema:mpd:2011"
      ) {
        return false;
      }

      // XML 태그 및 속성 추출
      function extractTags(tag) {
        const regex = new RegExp(
          `<${tag}(?=[\\s/>])([^>]*?)>`,
          "gi"
        );

        return [...body.matchAll(regex)].map(
          match => parseAttributes(match[1], true)
        );
      }

      const baseURLRegex =
        /<BaseURL(?:\s[^>]*)?>([\s\S]*?)<\/BaseURL>/gi;

      const periodsList = extractTags("Period");
      const adaptationSetsList = extractTags("AdaptationSet");
      const representationsList = extractTags("Representation");

      // 기존 검증 조건 유지
      const valid =
        /<\/MPD\s*>/i.test(body) &&
        periodsList.length > 0 &&
        adaptationSetsList.length > 0 &&
        representationsList.length > 0;

      if (!valid) return false;

      // 추출 정보 개별 변수 저장
      const type = "DASH";
      const mpd = mpdAttributes;

      const periods = optional(periodsList);
      const adaptationSets = optional(adaptationSetsList);
      const representations = optional(representationsList);

      const baseURLs = optional(
        [...body.matchAll(baseURLRegex)]
          .map(match => match[1].trim())
      );

      const segmentTemplates = optional(
        extractTags("SegmentTemplate")
      );

      const segmentLists = optional(
        extractTags("SegmentList")
      );

      const segmentURLs = optional(
        extractTags("SegmentURL")
      );

      const segmentBases = optional(
        extractTags("SegmentBase")
      );

      const initialization = optional(
        extractTags("Initialization")
      );

      const timelines = optional(
        extractTags("S")
      );

      // 개별 로그
      console.groupCollapsed("[OmniDL] DASH Manifest");

      console.log("URL:", details.url);
      console.log("Type:", type);
      console.log("MPD:", mpd);
      console.log("Periods:", periods);
      console.log("Adaptation Sets:", adaptationSets);
      console.log("Representations:", representations);
      console.log("Base URLs:", baseURLs);
      console.log("Segment Templates:", segmentTemplates);
      console.log("Segment Lists:", segmentLists);
      console.log("Segment URLs:", segmentURLs);
      console.log("Segment Bases:", segmentBases);
      console.log("Initialization:", initialization);
      console.log("Timelines:", timelines);

      console.groupEnd();

      return true;
    }

    return false;

  } catch (error) {
    console.error("[Manifest Error]", details.url, error);
    return false;
  }
}

// 자체 알고리즘 실행
async function detectCustom(details) {
  // TODO: 자체 영상 분석 알고리즘
}

// 단계별 판별

async function analyzeMedia(details, contentType) {

//   if (metadataTypes.has(contentType)) {
//     console.log("[Metadata 후보]", details.url);

//     if (await detectMetadata(details)) return;
//   }

  if (manifestTypes.has(contentType)) {
    console.log("[Manifest 후보]", details.url);

    if (await detectManifest(details)) return;
  }

  //console.log("[Custom]", details.url);
  await detectCustom(details);
}

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    console.log("[HTTP 요청]", {
      url: details.url,
      method: details.method,
      type: details.type,
      requestId: details.requestId,
      timeStamp: details.timeStamp
    });
  },
  {
    urls: ["<all_urls>"]
  }
);

// HTTP 응답 감지
chrome.webRequest.onHeadersReceived.addListener(
  (details) => {
    if (details.initiator === `chrome-extension://${chrome.runtime.id}`) {
      return;
    }
    if (details.statusCode !== 200 && details.statusCode !== 206) {
      return;
    }

    const headers = details.responseHeaders ?? [];

    const contentType = headers
      .find((h) => h.name.toLowerCase() === "content-type")
      ?.value?.split(";")[0].trim().toLowerCase();

    if (contentType) {
      if (excludedTypes.has(contentType)) return;

      if (excludedPrefixes.some(
        (prefix) => contentType.startsWith(prefix)
      )) return;
    }

    const contentLength = headers.find(
      (h) => h.name.toLowerCase() === "content-length"
    );

    if (contentLength && Number(contentLength.value) === 0) {
      return;
    }

    void analyzeMedia(
      details,
      contentType ?? ""
    ).catch(console.error);
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);
