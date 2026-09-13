using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

class Hooker
{
    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int key);
    static void Main(string[] args)
    {
        int parentId;
        if (args.Length != 1 || !int.TryParse(args[0], out parentId)) return;
        try
        {
            using (Process parent = Process.GetProcessById(parentId))
            using (var stdout = Console.OpenStandardOutput())
            {
                bool[] down = new bool[255];
                byte[] keyboard = Encoding.ASCII.GetBytes("{\"t\":\"kd\"}\n");
                byte[] mouse = Encoding.ASCII.GetBytes("{\"t\":\"md\"}\n");
                while (!parent.HasExited)
                {
                    bool keyPressed = false;
                    bool mousePressed = false;
                    for (int key = 1; key < 255; key++)
                    {
                        if (key > 2 && (key < 8 || key > 222)) continue;
                        bool pressed = (GetAsyncKeyState(key) & 0x8000) != 0;
                        if (pressed && !down[key])
                        {
                            if (key <= 2) mousePressed = true;
                            else keyPressed = true;
                        }
                        down[key] = pressed;
                    }
                    // Only activity pulses leave this process. Never emit key codes,
                    // text, titles or input content; nothing is saved or transmitted.
                    if (keyPressed) stdout.Write(keyboard, 0, keyboard.Length);
                    if (mousePressed) stdout.Write(mouse, 0, mouse.Length);
                    if (keyPressed || mousePressed) stdout.Flush();
                    System.Threading.Thread.Sleep(25);
                }
            }
        }
        catch { /* Parent exited or stdout pipe closed: terminate with it. */ }
    }
}
