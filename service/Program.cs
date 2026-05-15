using System.ServiceProcess;

static class Program
{
    static void Main()
    {
        ServiceBase.Run(new ElectronUpdateService());
    }
}
