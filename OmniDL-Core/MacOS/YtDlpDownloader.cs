
using System.Diagnostics;
using System.Text.Json;

public static class YtDlpDownloader
{
    public static async Task<MediaDownloadResult> DownloadAsync(
        string source,
        JsonElement video)
    {
        if (video.ValueKind != JsonValueKind.Object)
            return new(false, "", "영상 데이터가 없습니다.");

        string url = GetString(video, "videoUrl");

        if (!IsHttpUrl(url))
            return new(false, "", "올바르지 않은 영상 URL입니다.");

        if (source != "yt-dlp" && source != "m3u8dl")
            return new(false, "", "지원하지 않는 다운로드 유형입니다.");

        string directory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "Downloads",
            "OmniDL"
        );

        Directory.CreateDirectory(directory);

        string title = GetString(video, "title");

        if (string.IsNullOrWhiteSpace(title))
            title = "OmniDL_Video";

        string fileName = SanitizeFileName(title);

        if (fileName.Length > 100)
            fileName = fileName[..100].TrimEnd();

        if (string.IsNullOrWhiteSpace(fileName))
            fileName = "OmniDL_Video";

        string outputPath = Path.Combine(
            directory,
            $"{fileName}_{Guid.NewGuid():N}.mp4"
        );

        var timer = Stopwatch.StartNew();
        bool completed = false;

        try
        {
            List<string> inputUrls;

            if (source == "yt-dlp")
            {
                Console.Error.WriteLine(
                    "[OmniDL-Core] yt-dlp 스트림 URL 추출 시작"
                );

                inputUrls = await ResolveYtDlpUrlsAsync(url);
            }
            else
            {
                Console.Error.WriteLine(
                    "[OmniDL-Core] HLS/DASH 매니페스트 입력"
                );

                inputUrls = new List<string> { url };
            }

            if (inputUrls.Count == 0 || inputUrls.Count > 2)
                return new(false, "", "유효한 미디어 스트림을 찾지 못했습니다.");

            Console.Error.WriteLine(
                $"[OmniDL-Core] FFmpeg 다운로드 시작: {source}"
            );

            var info = CreateProcessInfo("ffmpeg");

            AddArguments(info,
                "-hide_banner",
                "-loglevel", "error",
                "-nostdin",
                "-y"
            );

            foreach (string inputUrl in inputUrls)
            {
                AddArguments(info, "-i", inputUrl);
            }

            AddArguments(info, "-map", "0:v:0");

            if (inputUrls.Count == 2)
            {
                AddArguments(info, "-map", "1:a:0?");
            }
            else
            {
                AddArguments(info, "-map", "0:a:0?");
            }

            AddArguments(info,
                "-c:v", "libx264",
                "-preset", "veryfast",
                "-crf", "21",
                "-vf", "pad=ceil(iw/2)*2:ceil(ih/2)*2",
                "-pix_fmt", "yuv420p",
                "-c:a", "aac",
                "-b:a", "192k",
                "-movflags", "+faststart",
                "-f", "mp4",
                outputPath
            );

            var result = await RunProcessAsync(info);

            Console.Error.WriteLine(
                $"[OmniDL-Core] FFmpeg 종료 코드: {result.ExitCode}"
            );

            if (result.ExitCode != 0)
            {
                Console.Error.WriteLine(
                    $"[OmniDL-Core] FFmpeg 오류: {result.Stderr}"
                );

                return new(false, "", result.Stderr);
            }

            if (!File.Exists(outputPath))
                return new(false, "", "출력 파일이 생성되지 않았습니다.");

            var file = new FileInfo(outputPath);

            if (file.Length == 0)
                return new(false, "", "출력 파일 크기가 0입니다.");

            completed = true;

            Console.Error.WriteLine(
                $"[OmniDL-Core] 다운로드 완료: {outputPath}"
            );

            Console.Error.WriteLine(
                $"[OmniDL-Core] 소요 시간: {timer.Elapsed.TotalSeconds:F2}초"
            );

            return new(true, outputPath, null);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(
                $"[OmniDL-Core] 다운로드 실패: {error.Message}"
            );

            return new(false, "", error.Message);
        }
        finally
        {
            if (!completed && File.Exists(outputPath))
            {
                try
                {
                    File.Delete(outputPath);
                }
                catch (Exception error)
                {
                    Console.Error.WriteLine(
                        $"[OmniDL-Core] 임시 파일 삭제 실패: {error.Message}"
                    );
                }
            }
        }
    }

    private static async Task<List<string>> ResolveYtDlpUrlsAsync(
        string pageURL)
    {
        var info = CreateProcessInfo("yt-dlp");

        AddArguments(info,
            "--ignore-config",
            "--no-playlist",
            "--no-warnings",
            "--ffmpeg-location",
            Path.Combine(AppContext.BaseDirectory, "tools"),
            "--get-url",
            "--format", "bv+ba/b",
            "--",
            pageURL
        );

        var result = await RunProcessAsync(info);

        if (result.ExitCode != 0)
        {
            throw new Exception(
                $"yt-dlp URL 추출 실패: {result.Stderr}"
            );
        }

        var urls = result.Stdout
            .Split('\n', StringSplitOptions.RemoveEmptyEntries)
            .Select(item => item.Trim())
            .Where(IsHttpUrl)
            .ToList();

        if (urls.Count == 0)
            throw new Exception("yt-dlp가 미디어 URL을 반환하지 않았습니다.");

        Console.Error.WriteLine(
            $"[OmniDL-Core] 스트림 URL 추출 성공: {urls.Count}개"
        );

        return urls;
    }

    private static ProcessStartInfo CreateProcessInfo(string name)
    {
        return new ProcessStartInfo
        {
            FileName = FindExecutable(name),
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
    }

    private static string FindExecutable(string name)
    {
        string executable = Path.Combine(
            AppContext.BaseDirectory,
            "tools",
            name
        );

        if (!File.Exists(executable))
        {
            throw new FileNotFoundException(
                $"실행 파일을 찾을 수 없습니다: {executable}"
            );
        }

        return executable;
    }

    private static async Task<(int ExitCode, string Stdout, string Stderr)>
        RunProcessAsync(ProcessStartInfo info)
    {
        using var process = new Process
        {
            StartInfo = info
        };

        process.Start();

        Task<string> stdoutTask =
            process.StandardOutput.ReadToEndAsync();

        Task<string> stderrTask =
            process.StandardError.ReadToEndAsync();

        await process.WaitForExitAsync();

        return (
            process.ExitCode,
            await stdoutTask,
            await stderrTask
        );
    }

    private static void AddArguments(
        ProcessStartInfo info,
        params string[] arguments)
    {
        foreach (string argument in arguments)
            info.ArgumentList.Add(argument);
    }

    private static bool IsHttpUrl(string value)
    {
        return Uri.TryCreate(
            value,
            UriKind.Absolute,
            out var uri
        ) && (
            uri.Scheme == Uri.UriSchemeHttp ||
            uri.Scheme == Uri.UriSchemeHttps
        );
    }

    private static string GetString(JsonElement element, string name)
    {
        if (element.TryGetProperty(name, out var value) &&
            value.ValueKind == JsonValueKind.String)
        {
            return value.GetString() ?? "";
        }

        return "";
    }

    private static string SanitizeFileName(string name)
    {
        char[] invalid = Path.GetInvalidFileNameChars();

        string result = new string(name
            .Select(c =>
                invalid.Contains(c) ||
                "<>:\"/\\|?*".Contains(c)
                    ? '_'
                    : c)
            .ToArray());

        return result.Trim().TrimEnd('.');
    }
}

public record MediaDownloadResult(
    bool Success,
    string FilePath,
    string? Error
);
