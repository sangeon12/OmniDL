
using System.Buffers.Binary;
using System.Diagnostics;
using System.Text;
using System.Text.Json;

using var input = Console.OpenStandardInput();
using var output = Console.OpenStandardOutput();

while (true)
{
    try
    {
        byte[] header = new byte[4];

        int first = await input.ReadAsync(header.AsMemory(0, 1));
        if (first == 0) break;

        await input.ReadExactlyAsync(header.AsMemory(1, 3));

        int length = BinaryPrimitives.ReadInt32LittleEndian(header);
        if (length <= 0 || length > 64 * 1024 * 1024) break;

        byte[] buffer = new byte[length];
        await input.ReadExactlyAsync(buffer);

        using var document = JsonDocument.Parse(buffer);
        var root = document.RootElement;

        string type = GetString(root, "type");

        if (type == "ping")
        {
            await SendAsync(output, new
            {
                type = "pong",
                success = true,
                message = "OmniDL-Core 연결 성공"
            });

            continue;
        }

        if (type == "extract")
        {
            int requestId = GetInt(root, "requestId");
            int tabId = GetInt(root, "tabId");
            string reason = GetString(root, "reason");

            Console.Error.WriteLine(
                $"[OmniDL-Core] yt-dlp 요청 수신: {reason}"
            );

            ExtractionResult result = await ExtractAsync(root);

            await SendAsync(output, new
            {
                type = "extract_result",
                requestId,
                tabId,
                reason,
                success = result.Success,
                videos = result.Videos,
                error = result.Error
            });

            Console.Error.WriteLine(
                $"[OmniDL-Core] 추출 완료: {result.Videos.Count}개"
            );
        }
    }
    catch (Exception error)
    {
        Console.Error.WriteLine(
            $"[OmniDL-Core] 처리 오류: {error.Message}"
        );

        break;
    }
}

static string GetString(JsonElement element, string name)
{
    if (element.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.String)
    {
        return value.GetString() ?? "";
    }

    return "";
}

static int GetInt(JsonElement element, string name)
{
    if (element.TryGetProperty(name, out var value) &&
        value.ValueKind == JsonValueKind.Number &&
        value.TryGetInt32(out int number))
    {
        return number;
    }

    return 0;
}

static double? GetDuration(JsonElement element)
{
    if (element.TryGetProperty("duration", out var value) &&
        value.ValueKind == JsonValueKind.Number &&
        value.TryGetDouble(out double duration))
    {
        return duration;
    }

    return null;
}

static string GetYtDlpPath()
{
    string[] paths =
    {
        "/opt/homebrew/bin/yt-dlp",
        "/usr/local/bin/yt-dlp"
    };

    foreach (string path in paths)
    {
        if (File.Exists(path)) return path;
    }

    return "yt-dlp";
}

static VideoItem? ParseVideo(JsonElement element)
{
    if (element.ValueKind != JsonValueKind.Object) return null;

    string url = GetString(element, "webpage_url");

    if (string.IsNullOrEmpty(url))
        url = GetString(element, "url");

    if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
        (uri.Scheme != "http" && uri.Scheme != "https"))
    {
        return null;
    }

    return new VideoItem(
        GetString(element, "id"),
        GetString(element, "title"),
        url.Length > 3000 ? url[..3000] : url,
        GetString(element, "extractor_key"),
        GetDuration(element)
    );
}

static async Task<ExtractionResult> ExtractAsync(JsonElement root)
{
    var videos = new List<VideoItem>();
    string? cookieFilePath = null;
    string pageURL = GetString(root, "pageURL");

    if (!Uri.TryCreate(pageURL, UriKind.Absolute, out var pageUri) ||
        (pageUri.Scheme != "http" && pageUri.Scheme != "https"))
    {
        return new ExtractionResult(false, videos, "잘못된 웹페이지 URL");
    }

    var startInfo = new ProcessStartInfo
    {
        FileName = GetYtDlpPath(),
        RedirectStandardOutput = true,
        RedirectStandardError = true,
        UseShellExecute = false,
        CreateNoWindow = true
    };

    string[] options =
    {
        "--ignore-config",
        "--dump-single-json",
        "--skip-download",
        "--flat-playlist",
        "--playlist-end",
        "40",
        "--no-warnings"
    };

    foreach (string option in options)
        startInfo.ArgumentList.Add(option);
        startInfo.Environment["PATH"] = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" +Environment.GetEnvironmentVariable("PATH");

    if (root.TryGetProperty("headers", out var headers) &&
        headers.ValueKind == JsonValueKind.Array)
    {
        foreach (var header in headers.EnumerateArray())
        {
            string name = GetString(header, "name");
            string value = GetString(header, "value");

            if (string.IsNullOrWhiteSpace(value) ||
                value.Contains('\r') ||
                value.Contains('\n'))
            {
                continue;
            }

            if (!new[]
            {
                "user-agent",
                "referer",
                "origin",
                "accept-language"
            }.Contains(name.ToLowerInvariant()))
            {
                continue;
            }

            startInfo.ArgumentList.Add("--add-headers");
            startInfo.ArgumentList.Add($"{name}:{value}");
        }
    }

    if (root.TryGetProperty("cookies", out var cookies) &&
        cookies.ValueKind == JsonValueKind.Array &&
        cookies.GetArrayLength() > 0)
    {
        var lines = new List<string>
        {
            "# Netscape HTTP Cookie File"
        };

        foreach (var cookie in cookies.EnumerateArray())
        {
            string name = GetString(cookie, "name");
            string value = GetString(cookie, "value");
            string domain = GetString(cookie, "domain");
            string path = GetString(cookie, "path");

            if (string.IsNullOrWhiteSpace(domain))
                domain = pageUri.Host;

            if (string.IsNullOrEmpty(path))
                path = "/";

            if (string.IsNullOrWhiteSpace(name) ||
                new[] { name, value, domain, path }
                    .Any(s => s.Contains('\t') || s.Contains('\r') || s.Contains('\n')))
            {
                continue;
            }

            bool secure = cookie.TryGetProperty("secure", out var secureValue) &&
                          secureValue.ValueKind == JsonValueKind.True;

            bool hostOnly = cookie.TryGetProperty("hostOnly", out var hostValue) &&
                            hostValue.ValueKind == JsonValueKind.True;

            long expires = 0;

            if (cookie.TryGetProperty("expirationDate", out var expiry) &&
                expiry.ValueKind == JsonValueKind.Number)
            {
                expires = (long)expiry.GetDouble();
            }

            if (hostOnly)
                domain = domain.TrimStart('.');
            else if (!domain.StartsWith('.'))
                domain = "." + domain;

            lines.Add(string.Join("\t",
                domain,
                hostOnly ? "FALSE" : "TRUE",
                path,
                secure ? "TRUE" : "FALSE",
                expires.ToString(),
                name,
                value
            ));
        }

        if (lines.Count > 1)
        {
            cookieFilePath = Path.Combine(
                Path.GetTempPath(),
                $"omnidl-{Guid.NewGuid():N}.txt"
            );

            using (var file = new FileStream(cookieFilePath, new FileStreamOptions
            {
                Mode = FileMode.CreateNew,
                Access = FileAccess.Write,
                Share = FileShare.None,
                UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite
            }))
            using (var writer = new StreamWriter(file, new UTF8Encoding(false)))
            {
                foreach (string line in lines)
                    writer.WriteLine(line);
            }

            startInfo.ArgumentList.Add("--cookies");
            startInfo.ArgumentList.Add(cookieFilePath);
        }
    }

    startInfo.ArgumentList.Add("--");
    startInfo.ArgumentList.Add(pageURL);

    try
    {
        using var process = new Process
        {
            StartInfo = startInfo
        };

        process.Start();

        using var timeout = new CancellationTokenSource(
            TimeSpan.FromSeconds(60)
        );

        Task<string> stdoutTask = process.StandardOutput.ReadToEndAsync();
        Task<string> stderrTask = process.StandardError.ReadToEndAsync();

        try
        {
            await process.WaitForExitAsync(timeout.Token);
        }
        catch (OperationCanceledException)
        {
            if (!process.HasExited)
                process.Kill(true);

            await Task.WhenAll(stdoutTask, stderrTask);

            return new ExtractionResult(
                false,
                videos,
                "yt-dlp 실행 시간 초과"
            );
        }

        string stdout = await stdoutTask;
        string stderr = await stderrTask;

        if (process.ExitCode != 0)
        {
            string error = stderr.Length > 500
                ? stderr[..500]
                : stderr;

            return new ExtractionResult(
                false,
                videos,
                error
            );
        }

        using var document = JsonDocument.Parse(stdout);
        JsonElement data = document.RootElement;

        if (data.TryGetProperty("entries", out var entries) &&
            entries.ValueKind == JsonValueKind.Array)
        {
            foreach (var entry in entries.EnumerateArray())
            {
                VideoItem? video = ParseVideo(entry);

                if (video != null)
                    videos.Add(video);

                if (videos.Count >= 40) break;
            }
        }
        else
        {
            VideoItem? video = ParseVideo(data);

            if (video != null)
                videos.Add(video);
        }

        return new ExtractionResult(
            videos.Count > 0,
            videos,
            videos.Count == 0 ? "추출된 영상 없음" : null
        );
    }
    catch (Exception error)
    {
        return new ExtractionResult(
            false,
            videos,
            error.Message
        );
    }
    finally
    {
        if (cookieFilePath != null && File.Exists(cookieFilePath))
        {
            try
            {
                File.Delete(cookieFilePath);
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(
                    $"[OmniDL-Core] 쿠키 파일 삭제 실패: {error.Message}"
                );
            }
        }
    }
}

static async Task SendAsync(Stream output, object message)
{
    byte[] data = JsonSerializer.SerializeToUtf8Bytes(
        message,
        new JsonSerializerOptions
        {
            PropertyNamingPolicy = JsonNamingPolicy.CamelCase
        }
    );

    byte[] header = new byte[4];

    BinaryPrimitives.WriteInt32LittleEndian(
        header,
        data.Length
    );

    await output.WriteAsync(header);
    await output.WriteAsync(data);
    await output.FlushAsync();
}

record VideoItem(
    string Id,
    string Title,
    string VideoUrl,
    string Extractor,
    double? Duration
);

record ExtractionResult(
    bool Success,
    List<VideoItem> Videos,
    string? Error
);
