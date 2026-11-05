//go:build windows

// Command SFL is the Windows desktop shell for Scientific Figure Library. It
// starts the packaged Node backend without a console window, shows the local
// web UI in a WebView2 window and stops the backend when the window closes.
// Without the WebView2 runtime it falls back to the default browser.
package main

import (
	"errors"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sync/atomic"
	"time"

	webview2 "github.com/jchv/go-webview2"
	"github.com/jchv/go-webview2/webviewloader"
)

const (
	appTitle     = "Scientific Figure Library"
	windowClass  = "webview" // registered by go-webview2
	mutexName    = `Local\ScientificFigureLibrary.Desktop`
	startTimeout = 90 * time.Second
	stopTimeout  = 10 * time.Second
)

// externalLinks keeps the window on the local client: links and window.open
// calls that leave it go to the default browser through sflOpenExternal.
const externalLinks = `(() => {
  const external = (value) => {
    try {
      const target = new URL(String(value), location.href);
      return (target.protocol === "https:" || target.protocol === "http:") && target.origin !== location.origin ? target.href : "";
    } catch { return ""; }
  };
  document.addEventListener("click", (event) => {
    const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
    const href = anchor ? external(anchor.href) : "";
    if (!href) return;
    event.preventDefault();
    window.sflOpenExternal(href);
  }, true);
  const open = window.open;
  window.open = function (value, ...rest) {
    const href = value ? external(value) : "";
    if (!href) return open.call(window, value, ...rest);
    window.sflOpenExternal(href);
    return null;
  };
})();`

const loadingPage = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8">
<style>
:root { color-scheme: light dark; --bg: #f6f7f9; --fg: #4b5563; }
@media (prefers-color-scheme: dark) { :root { --bg: #17191d; --fg: #aeb4be; } }
html, body { height: 100%; margin: 0; background: var(--bg); color: var(--fg); font: 15px "Segoe UI", "Microsoft YaHei UI", sans-serif; }
body { display: flex; align-items: center; justify-content: center; }
</style></head><body>正在启动 Scientific Figure Library…</body></html>`

func main() {
	runtime.LockOSThread()
	enableDpiAwareness()
	smoke :=flag.Bool("smoke", false, "start the backend, check it and stop it without any window")
	browser := flag.Bool("browser", false, "use the default browser instead of a WebView2 window")
	flag.Parse()
	root, err := installRoot()
	if err == nil && *smoke {
		err = runSmoke(root)
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}
	if err == nil {
		err = run(root, *browser)
	}
	if err != nil {
		showError(0, err.Error())
		os.Exit(1)
	}
}

func installRoot() (string, error) {
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	return filepath.Dir(exe), nil
}

func dataDir() string {
	if base := os.Getenv("LOCALAPPDATA"); base != "" {
		return filepath.Join(base, "ScientificFigureLibrary")
	}
	base, _ := os.UserCacheDir()
	return filepath.Join(base, "ScientificFigureLibrary")
}

// openLog keeps the current and the previous session's backend output.
func openLog() (*os.File, string, error) {
	dir := filepath.Join(dataDir(), "logs")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return nil, "", err
	}
	current := filepath.Join(dir, "desktop.log")
	os.Rename(current, filepath.Join(dir, "desktop.previous.log"))
	file, err := os.Create(current)
	return file, current, err
}

func run(root string, useBrowser bool) error {
	release, first, err := singleInstance(mutexName)
	if err != nil {
		return err
	}
	defer release()
	if !first {
		if !focusWindow(windowClass, appTitle) {
			showInfo(0, "Scientific Figure Library 已在运行。")
		}
		return nil
	}
	log, logPath, err := openLog()
	if err != nil {
		return fmt.Errorf("无法创建日志文件：%v", err)
	}
	defer log.Close()
	if version, _ := webviewloader.GetInstalledVersion(); version == "" {
		useBrowser = true
	}
	if !useBrowser {
		return runInWindow(root, log, logPath)
	}
	return runInBrowser(root, log, logPath)
}

func withLog(err error, logPath string) error {
	return fmt.Errorf("%v\n\n日志：%s", err, logPath)
}

// runInBrowser has the backend open the default browser itself, exactly like
// Start SFL.cmd, and lives until the page's quit button stops the backend.
func runInBrowser(root string, log *os.File, logPath string) error {
	svc, err := backendService(root, true)
	if err != nil {
		return err
	}
	p, err := start(svc, log, startTimeout)
	if err != nil {
		return withLog(err, logPath)
	}
	<-p.done
	if p.err != nil {
		return withLog(fmt.Errorf("%s意外退出：%v", p.name, p.err), logPath)
	}
	return nil
}

func runInWindow(root string, log *os.File, logPath string) error {
	svc, err := backendService(root, false)
	if err != nil {
		return err
	}
	w := webview2.NewWithOptions(webview2.WebViewOptions{
		Debug:     os.Getenv("SFL_WEBVIEW_DEBUG") == "1",
		DataPath:  filepath.Join(dataDir(), "WebView2"),
		AutoFocus: true,
		WindowOptions: webview2.WindowOptions{
			Title:  appTitle,
			Width:  1280,
			Height: 840,
			IconId: 1,
			Center: true,
		},
	})
	if w == nil {
		// go-webview2 shows the window before embedding fails; remove it.
		if hwnd := findWindow(windowClass, appTitle); hwnd != 0 {
			destroyWindow(hwnd)
		}
		fmt.Fprintln(log, "[SFL desktop] WebView2 could not start; using the default browser")
		return runInBrowser(root, log, logPath)
	}
	w.SetSize(960, 640, webview2.HintMin)
	w.Init(externalLinks)
	if err := w.Bind("sflOpenExternal", openExternal); err != nil {
		return err
	}
	w.SetHtml(loadingPage)

	var closing atomic.Bool
	var backend atomic.Pointer[process]
	go func() {
		p, err := start(svc, log, startTimeout)
		if err != nil {
			w.Dispatch(func() {
				showError(uintptr(w.Window()), withLog(err, logPath).Error())
				w.Destroy()
			})
			return
		}
		backend.Store(p)
		w.Dispatch(func() { w.Navigate(p.launch.URL) })
		<-p.done
		if closing.Load() {
			return
		}
		// The page's quit button exits cleanly; anything else is a crash.
		w.Dispatch(func() {
			if p.err != nil {
				showError(uintptr(w.Window()), withLog(fmt.Errorf("%s意外退出：%v", p.name, p.err), logPath).Error())
			}
			w.Destroy()
		})
	}()
	w.Run()
	closing.Store(true)
	if p := backend.Load(); p != nil {
		p.stop(stopTimeout)
	}
	return nil
}

// runSmoke exercises node resolution, the launch handshake, an authenticated
// request and a clean shutdown, for packaging checks without a desktop.
func runSmoke(root string) error {
	svc, err := backendService(root, false)
	if err != nil {
		return err
	}
	p, err := start(svc, os.Stderr, startTimeout)
	if err != nil {
		return err
	}
	response, err := p.request(http.MethodGet, "/api/state")
	if err != nil {
		p.kill()
		return err
	}
	response.Body.Close()
	if response.StatusCode != http.StatusOK {
		p.kill()
		return fmt.Errorf("/api/state returned %s", response.Status)
	}
	p.stop(stopTimeout)
	if p.err != nil {
		return errors.New("backend did not exit cleanly: " + p.err.Error())
	}
	fmt.Printf("SFL desktop smoke passed: %s %s\n", svc.command, p.launch.Version)
	return nil
}
