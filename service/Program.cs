using Microsoft.Extensions.Hosting;

var builder = Host.CreateApplicationBuilder(args);
builder.Services.AddWindowsService(options =>
{
    options.ServiceName = "Electron Update Service";
});
builder.Services.AddHostedService<Worker>();

builder.Build().Run();
