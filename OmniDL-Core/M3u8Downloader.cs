
using System.Diagnostics;
using System.Text;
using System.Text.Json;

public static class M3u8Downloader
{
    public static async Task<MediaDownloadResult> DownloadAsync(
        JsonElement video)
    {
        string url = GetString(video, "videoUrl");
        string body = GetString(video, "body");
        string type = GetString(video, "manifestType");

        if (!Uri.TryCreate(url, UriKind.Absolute, out var uri) ||
            (uri.Scheme != "http" && uri.Scheme != "https"))
        {
            return new(false, "", "잘못된 매니페스트 URL입니다.");
        }

        string downloadPath = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.UserProfile),
            "Downloads",
            "OmniDL"
        );

        Directory.CreateDirectory(downloadPath);

        string saveName = "OmniDL_" + Guid.NewGuid().ToString("N");
        string tempPath = Path.Combine(
            Path.GetTempPath(),
            "OmniDL_" + Guid.NewGuid().ToString("N")
        );

        try
        {
            string executable = FindExecutable("N_m3u8DL-RE");

            Console.Error.WriteLine(
                $"[OmniDL-Core] 매니페스트 다운로드 시작: {type}"
            );

            var first = await ExecuteAsync(
                executable,
                url,
                downloadPath,
                saveName,
                null
            );

            // if (first.ExitCode != 0 && !string.IsNullOrWhiteSpace(body))
            // {
            //     Directory.CreateDirectory(tempPath);

            //     string extension = type.Equals(
            //         "DASH",
            //         StringComparison.OrdinalIgnoreCase
            //     ) ? ".mpd" : ".m3u8";

            //     string manifestPath = Path.Combine(
            //         tempPath,
            //         "manifest" + extension
            //     );

            //     await File.WriteAllTextAsync(
            //         manifestPath,
            //         body,
            //         new UTF8Encoding(false)
            //     );

            //     Console.Error.WriteLine(
            //         "[OmniDL-Core] 원본 매니페스트 본문으로 재시도"
            //     );

            //     var second = await ExecuteAsync(
            //         executable,
            //         manifestPath,
            //         downloadPath,
            //         saveName,
            //         url
            //     );

            //     if (second.ExitCode != 0)
            //     {
            //         return new(
            //             false,
            //             "",
            //             "매니페스트 URL: " + Limit(first.Error) +
            //             " / 매니페스트 본문: " + Limit(second.Error)
            //         );
            //     }
            // }
            // else if (first.ExitCode != 0)
            // {
            //     return new(false, "", Limit(first.Error));
            // }

            string[] files = Directory.GetFiles(
                downloadPath,
                saveName + "*.mp4"
            );

            if (files.Length == 0)
            {
                return new(
                    false,
                    "",
                    "다운로드 후 MP4 파일을 찾지 못했습니다."
                );
            }

            string filePath = files
                .OrderByDescending(File.GetLastWriteTimeUtc)
                .First();

            if (new FileInfo(filePath).Length == 0)
            {
                return new(
                    false,
                    "",
                    "생성된 파일 크기가 0입니다."
                );
            }

            Console.Error.WriteLine(
                $"[OmniDL-Core] 매니페스트 다운로드 완료: {filePath}"
            );

            return new(true, filePath, null);
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(
                $"[OmniDL-Core] 매니페스트 다운로드 실패: {error.Message}"
            );

            return new(false, "", error.Message);
        }
        finally
        {
            if (Directory.Exists(tempPath))
            {
                try
                {
                    Directory.Delete(tempPath, true);
                }
                catch (Exception error)
                {
                    Console.Error.WriteLine(error.Message);
                }
            }
        }
    }

    private static async Task<(int ExitCode, string Error)> ExecuteAsync(
        string executable,
        string input,
        string downloadPath,
        string saveName,
        string? baseUrl)
    {
        string logPath = Path.Combine(downloadPath, "m3u8dl-debug.log");
    
        void Log(string message)
        {
            string line = $"[{DateTime.Now:HH:mm:ss.fff}] {message}";
            File.AppendAllText(logPath, line + Environment.NewLine);
        }
    
        Log("========== 다운로드 시작 ==========");
        Log($"실행 파일: {executable}");
        Log($"입력 방식: {(File.Exists(input) ? "로컬 파일" : "URL")}");
        Log($"입력 파일 존재: {File.Exists(input)}");
    
        var info = new ProcessStartInfo
        {
            FileName = executable,
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true
        };
    
        string path = Environment.GetEnvironmentVariable("PATH") ?? "";
        path = "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:" + path;
    
        info.Environment["PATH"] = path;
        info.Environment["TERM"] = "xterm";
    
        AddArguments(
            info,
            input,
            //"--auto-select",
            "--select-audio", "lang=^en$:for=best",
            "--no-ansi-color",
            "--no-log",
            "--save-dir", downloadPath,
            "--save-name", saveName,
            "--mux-after-done", "format=mp4"
        );
    
        if (!string.IsNullOrEmpty(baseUrl))
        {
            AddArguments(info, "--base-url", baseUrl);
        }
    
        Log("프로세스 실행 요청");
    
        using var process = new Process
        {
            StartInfo = info
        };
    
        try
        {
            process.Start();
            Log($"프로세스 시작 성공: PID {process.Id}");
    
            var output = new StringBuilder();
            var error = new StringBuilder();
            object logLock = new();
    
            async Task ReadStreamAsync(
                StreamReader reader,
                StringBuilder buffer,
                string streamName)
            {
                string? line;
    
                while ((line = await reader.ReadLineAsync()) != null)
                {
                    buffer.AppendLine(line);
    
                    lock (logLock)
                    {
                        Log($"[{streamName}] {line}");
                    }
                }
    
                lock (logLock)
                {
                    Log($"{streamName} 스트림 종료");
                }
            }
    
            Task stdoutTask = ReadStreamAsync(
                process.StandardOutput,
                output,
                "STDOUT"
            );
    
            Task stderrTask = ReadStreamAsync(
                process.StandardError,
                error,
                "STDERR"
            );
    
            Log("프로세스 출력 수집 시작");
    
            await process.WaitForExitAsync();
    
            Log($"프로세스 종료 감지: {process.ExitCode}");
    
            await Task.WhenAll(stdoutTask, stderrTask);
            Log("========== 다운로드 파일 분석 ==========");

            string[] mediaFiles = Directory.GetFiles(downloadPath)
                .Where(file =>
                    Path.GetFileName(file).StartsWith(saveName, StringComparison.Ordinal) &&
                    new[] { ".mp4", ".m4a", ".mkv", ".webm", ".mp3", ".aac", ".opus" }
                        .Contains(Path.GetExtension(file).ToLowerInvariant()))
                .ToArray();

            foreach (string file in mediaFiles)
            {
                Log($"파일: {Path.GetFileName(file)}");
                Log($"크기: {new FileInfo(file).Length} bytes");

                var probeInfo = new ProcessStartInfo
                {
                    FileName = "/opt/homebrew/bin/ffprobe",
                    UseShellExecute = false,
                    RedirectStandardOutput = true,
                    RedirectStandardError = true,
                    CreateNoWindow = true
                };

                AddArguments(
                    probeInfo,
                    "-v", "error",
                    "-show_entries",
                    "stream=index,codec_type,codec_name,sample_rate,channels:stream_tags=language",
                    "-of", "json",
                    file
                );

                try
                {
                    using var probe = Process.Start(probeInfo);

                    if (probe == null)
                    {
                        Log("FFprobe 실행 실패");
                        continue;
                    }

                    Task<string> probeOutput = probe.StandardOutput.ReadToEndAsync();
                    Task<string> probeError = probe.StandardError.ReadToEndAsync();

                    await probe.WaitForExitAsync();

                    Log(await probeOutput);
                    string errorText = await probeError;

                    if (!string.IsNullOrWhiteSpace(errorText))
                        Log($"FFprobe 오류: {errorText}");

                    Log($"FFprobe 종료 코드: {probe.ExitCode}");
                }
                catch (Exception ex)
                {
                    Log($"파일 분석 오류: {ex.Message}");
                }
            }

            Log("========== 파일 분석 완료 ==========");
    
            Log($"최종 종료 코드: {process.ExitCode}");
            Log("========== 다운로드 종료 ==========");
    
            return (
                process.ExitCode,
                error.ToString() + output.ToString()
            );
        }
        catch (Exception ex)
        {
            Log($"실행 예외: {ex}");
            throw;
        }
    }

    private static void AddArguments(
        ProcessStartInfo info,
        params string[] arguments)
    {
        foreach (string argument in arguments)
        {
            info.ArgumentList.Add(argument);
        }
    }

    private static string FindExecutable(string name)
    {
        string fileName = OperatingSystem.IsWindows()
            ? name + ".exe"
            : name;

        string[] paths =
        {
            Path.Combine(AppContext.BaseDirectory, "tools", fileName),
            Path.GetFullPath(
                Path.Combine(AppContext.BaseDirectory, "..", "tools", fileName)
            ),
            Path.Combine(AppContext.BaseDirectory, fileName),
            "/opt/homebrew/bin/" + fileName,
            "/usr/local/bin/" + fileName
        };

        return paths.FirstOrDefault(File.Exists) ?? fileName;
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

    private static string Limit(string value)
    {
        return value.Length > 2000 ? value[..2000] : value;
    }
}
