//go:build windows

package main

import (
	"errors"
	"net"
	"net/url"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var (
	user32                  = windows.NewLazySystemDLL("user32.dll")
	procFindWindowW         = user32.NewProc("FindWindowW")
	procShowWindow          = user32.NewProc("ShowWindow")
	procIsIconic            = user32.NewProc("IsIconic")
	procSetForegroundWindow = user32.NewProc("SetForegroundWindow")
	procDestroyWindow       = user32.NewProc("DestroyWindow")
	procSetDpiAwareness     = user32.NewProc("SetProcessDpiAwarenessContext")
)

const (
	swRestore                   = 9
	dpiAwarenessPerMonitorAware = ^uintptr(3) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 (-4)
)

// enableDpiAwareness keeps the window sharp on scaled displays. The embedded
// manifest declares the same; this covers builds without resources.
func enableDpiAwareness() {
	if procSetDpiAwareness.Find() == nil {
		procSetDpiAwareness.Call(dpiAwarenessPerMonitorAware)
	}
}

// singleInstance reports whether this is the first shell for the current
// user session; release must run before exit.
func singleInstance(name string) (release func(), first bool, err error) {
	handle, err := windows.CreateMutex(nil, false, windows.StringToUTF16Ptr(name))
	if handle == 0 {
		return nil, false, err
	}
	release = func() { windows.CloseHandle(handle) }
	return release, !errors.Is(err, windows.ERROR_ALREADY_EXISTS), nil
}

func findWindow(className, title string) uintptr {
	hwnd, _, _ := procFindWindowW.Call(uintptr(unsafe.Pointer(utf16OrNil(className))), uintptr(unsafe.Pointer(utf16OrNil(title))))
	return hwnd
}

// focusWindow brings the running shell's window to the front.
func focusWindow(className, title string) bool {
	hwnd := findWindow(className, title)
	if hwnd == 0 {
		return false
	}
	if iconic, _, _ := procIsIconic.Call(hwnd); iconic != 0 {
		procShowWindow.Call(hwnd, swRestore)
	}
	procSetForegroundWindow.Call(hwnd)
	return true
}

func destroyWindow(hwnd uintptr) {
	procDestroyWindow.Call(hwnd)
}

func messageBox(owner uintptr, text string, flags uint32) {
	windows.MessageBox(windows.HWND(owner), windows.StringToUTF16Ptr(text), windows.StringToUTF16Ptr(appTitle), flags|windows.MB_SETFOREGROUND)
}

func showError(owner uintptr, text string) { messageBox(owner, text, windows.MB_OK|windows.MB_ICONERROR) }

func showInfo(owner uintptr, text string) {
	messageBox(owner, text, windows.MB_OK|windows.MB_ICONINFORMATION)
}

// externalURL accepts only http(s) links that leave the local client, so the
// page cannot use the bridge to launch arbitrary programs or local files.
func externalURL(raw string) (string, error) {
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "https" && parsed.Scheme != "http") || parsed.Host == "" {
		return "", errors.New("only http(s) links can be opened externally")
	}
	host := strings.ToLower(parsed.Hostname())
	if ip := net.ParseIP(host); host == "localhost" || (ip != nil && ip.IsLoopback()) {
		return "", errors.New("local addresses stay inside the window")
	}
	return parsed.String(), nil
}

func openExternal(raw string) error {
	link, err := externalURL(raw)
	if err != nil {
		return err
	}
	return windows.ShellExecute(0, windows.StringToUTF16Ptr("open"), windows.StringToUTF16Ptr(link), nil, nil, windows.SW_SHOWNORMAL)
}

func utf16OrNil(value string) *uint16 {
	if value == "" {
		return nil
	}
	return windows.StringToUTF16Ptr(value)
}
