using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.ServiceProcess;
using System.Threading;

public class ElectronUpdateService : ServiceBase
{
    private Thread _thread;
    private volatile bool _running;

    public ElectronUpdateService()
    {
        ServiceName = "ElectronUpdateService";
    }

    protected override void OnStart(string[] args)
    {
        _running = true;
        _thread = new Thread(Run) { IsBackground = true };
        _thread.Start();
    }

    protected override void OnStop()
    {
        _running = false;
    }

    private void Run()
    {
        while (_running)
        {
            try
            {
                using (var pipe = new NamedPipeServerStream("ElectronUpdateService", PipeDirection.In, 1))
                {
                    pipe.WaitForConnection();
                    using (var reader = new StreamReader(pipe))
                    {
                        var installerPath = reader.ReadLine();
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
                }
            }
            catch (ThreadAbortException) { break; }
            catch { Thread.Sleep(2000); }
        }
    }
}
