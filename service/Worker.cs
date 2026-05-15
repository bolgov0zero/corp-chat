using System.Diagnostics;
using System.IO.Pipes;

public class Worker : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                using var pipe = new NamedPipeServerStream(
                    "ElectronUpdateService",
                    PipeDirection.In,
                    1,
                    PipeTransmissionMode.Byte,
                    PipeOptions.Asynchronous);

                await pipe.WaitForConnectionAsync(stoppingToken);

                using var reader = new StreamReader(pipe);
                var installerPath = await reader.ReadLineAsync(stoppingToken);

                if (!string.IsNullOrEmpty(installerPath) && File.Exists(installerPath))
                {
                    Process.Start(new ProcessStartInfo
                    {
                        FileName = installerPath,
                        Arguments = "/S",
                        UseShellExecute = true
                    });
                }
            }
            catch (OperationCanceledException) { break; }
            catch { await Task.Delay(2000, stoppingToken); }
        }
    }
}
