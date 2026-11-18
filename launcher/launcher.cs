using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Windows.Forms;

// Dreamcatcher 启动器：真正的 Electron 程序是 DreamcatcherApp.exe。
// 本机 Chromium 沙箱初始化会崩溃，所以这里统一补上 --no-sandbox 再启动。
static class Program
{
    [STAThread]
    static void Main(string[] args)
    {
        string dir = AppDomain.CurrentDomain.BaseDirectory;
        string exe = Path.Combine(dir, "DreamcatcherApp.exe");
        if (!File.Exists(exe))
        {
            MessageBox.Show("找不到 DreamcatcherApp.exe，请保持程序目录完整。", "Dreamcatcher");
            return;
        }

        var sb = new StringBuilder();
        foreach (string a in args) sb.Append(Quote(a)).Append(' ');
        sb.Append("--no-sandbox");

        var psi = new ProcessStartInfo(exe, sb.ToString());
        psi.WorkingDirectory = dir;
        psi.UseShellExecute = false;
        try { Process.Start(psi); }
        catch (Exception e) { MessageBox.Show(e.Message, "Dreamcatcher 启动失败"); }
    }

    static string Quote(string s)
    {
        return s != null && s.Contains(" ") ? "\"" + s + "\"" : s;
    }
}
