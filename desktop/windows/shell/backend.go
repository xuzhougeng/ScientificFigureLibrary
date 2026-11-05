//go:build windows

package main

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// launchSchema is the private handshake the backend prints on stdout when it
// runs with --local and without --quiet (src/local/launch.ts).
const launchSchema = "figure-library.local-launch.v1"

const minimumNodeMajor = 22

type launchInfo struct {
	Schema  string `json:"schema"`
	Version string `json:"version"`
	Origin  string `json:"origin"`
	Token   string `json:"token"`
	URL     string `json:"url"`
}

// service is one supervised backend process. Only the SFL backend exists
// today; further local services are expected to speak the same handshake.
type service struct {
	name    string
	command string
	args    []string
	dir     string
	env     []string
}

type process struct {
	name   string
	cmd    *exec.Cmd
	job    windows.Handle
	launch launchInfo
	done   chan struct{}
	err    error
}

func parseLaunch(line string) (launchInfo, bool) {
	var info launchInfo
	if json.Unmarshal([]byte(strings.TrimSpace(line)), &info) != nil || info.Schema != launchSchema {
		return launchInfo{}, false
	}
	if !strings.HasPrefix(info.Origin, "http://127.0.0.1:") || info.Token == "" || !strings.HasPrefix(info.URL, info.Origin+"/") {
		return launchInfo{}, false
	}
	return info, true
}

var nodeVersionPattern = regexp.MustCompile(`^v(\d+)\.\d+\.\d+`)

func parseNodeMajor(output string) (int, error) {
	match := nodeVersionPattern.FindStringSubmatch(strings.TrimSpace(output))
	if match == nil {
		return 0, fmt.Errorf("无法识别 Node.js 版本：%q", strings.TrimSpace(output))
	}
	return strconv.Atoi(match[1])
}

// backendEnv drops variables that would inject code or modules into the
// bundled runtime, matching Start SFL.cmd and the macOS client.
func backendEnv(environ []string) []string {
	out := make([]string, 0, len(environ))
	for _, entry := range environ {
		name, _, _ := strings.Cut(entry, "=")
		if strings.EqualFold(name, "NODE_OPTIONS") || strings.EqualFold(name, "NODE_PATH") {
			continue
		}
		out = append(out, entry)
	}
	return out
}

func hiddenAttr() *syscall.SysProcAttr {
	return &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
}

func runtimeMode(root string) (string, error) {
	bytes, err := os.ReadFile(filepath.Join(root, "runtime-mode.json"))
	if err != nil {
		return "", fmt.Errorf("安装目录不完整，缺少 runtime-mode.json。请重新解压完整的安装包。")
	}
	var value struct {
		Mode string `json:"mode"`
	}
	if json.Unmarshal(bytes, &value) != nil || (value.Mode != "bundled" && value.Mode != "system") {
		return "", errors.New("runtime-mode.json 无效。请重新解压完整的安装包。")
	}
	return value.Mode, nil
}

func resolveNode(root, mode string) (string, error) {
	if mode == "bundled" {
		node := filepath.Join(root, "runtime", "node.exe")
		if _, err := os.Stat(node); err != nil {
			return "", errors.New("找不到内置的 runtime\\node.exe。请重新解压完整的安装包。")
		}
		return node, nil
	}
	node := os.Getenv("SFL_NODE_BINARY")
	if node != "" {
		if info, err := os.Stat(node); !filepath.IsAbs(node) || err != nil || info.IsDir() {
			return "", errors.New("SFL_NODE_BINARY 必须是已存在的 Node.js 可执行文件的绝对路径。")
		}
	} else {
		found, err := exec.LookPath("node.exe")
		if err != nil {
			return "", errors.New("未找到 Node.js 22+。请安装 Node.js、设置 SFL_NODE_BINARY，或下载内置 Node 的安装包。")
		}
		node = found
	}
	check := exec.Command(node, "--version")
	check.SysProcAttr = hiddenAttr()
	check.Env = backendEnv(os.Environ())
	output, err := check.Output()
	if err != nil {
		return "", fmt.Errorf("无法运行 %s：%v", node, err)
	}
	major, err := parseNodeMajor(string(output))
	if err != nil {
		return "", err
	}
	if major < minimumNodeMajor {
		return "", fmt.Errorf("需要 Node.js %d+，当前为 %s。请升级 Node.js，或下载内置 Node 的安装包。", minimumNodeMajor, strings.TrimSpace(string(output)))
	}
	return node, nil
}

func backendService(root string, openBrowser bool) (service, error) {
	mode, err := runtimeMode(root)
	if err != nil {
		return service{}, err
	}
	node, err := resolveNode(root, mode)
	if err != nil {
		return service{}, err
	}
	args := []string{filepath.Join(root, "dist", "index.js"), "--local"}
	if !openBrowser {
		args = append(args, "--no-open")
	}
	return service{name: "SFL 本地服务", command: node, args: args, dir: root, env: backendEnv(os.Environ())}, nil
}

// newKillOnCloseJob returns a job object that terminates every process in it
// when the shell exits, so a crashed shell never leaves the backend running.
func newKillOnCloseJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	limits := windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION{}
	limits.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	if _, err := windows.SetInformationJobObject(job, windows.JobObjectExtendedLimitInformation, uintptr(unsafe.Pointer(&limits)), uint32(unsafe.Sizeof(limits))); err != nil {
		windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}

func assignToJob(job windows.Handle, pid int) error {
	handle, err := windows.OpenProcess(windows.PROCESS_SET_QUOTA|windows.PROCESS_TERMINATE, false, uint32(pid))
	if err != nil {
		return err
	}
	defer windows.CloseHandle(handle)
	return windows.AssignProcessToJobObject(job, handle)
}

// start launches svc and waits for its launch handshake. Output other than
// the handshake goes to log; the handshake itself carries the session token
// and is never logged.
func start(svc service, log *os.File, timeout time.Duration) (*process, error) {
	job, err := newKillOnCloseJob()
	if err != nil {
		return nil, fmt.Errorf("无法创建进程作业对象：%v", err)
	}
	reader, writer, err := os.Pipe()
	if err != nil {
		windows.CloseHandle(job)
		return nil, err
	}
	cmd := exec.Command(svc.command, svc.args...)
	cmd.Dir = svc.dir
	cmd.Env = svc.env
	cmd.Stdout = writer
	cmd.Stderr = log
	cmd.SysProcAttr = hiddenAttr()
	if err := cmd.Start(); err != nil {
		reader.Close()
		writer.Close()
		windows.CloseHandle(job)
		return nil, fmt.Errorf("无法启动%s：%v", svc.name, err)
	}
	writer.Close()
	p := &process{name: svc.name, cmd: cmd, job: job, done: make(chan struct{})}
	if err := assignToJob(job, cmd.Process.Pid); err != nil {
		fmt.Fprintf(log, "[SFL desktop] could not attach %s to the job object: %v\n", svc.name, err)
	}
	ready := make(chan launchInfo, 1)
	go func() {
		defer reader.Close()
		lines := bufio.NewReader(reader)
		found := false
		for {
			line, err := lines.ReadString('\n')
			if line != "" {
				if info, ok := parseLaunch(line); ok && !found {
					found = true
					ready <- info
				} else {
					io.WriteString(log, line)
				}
			}
			if err != nil {
				return
			}
		}
	}()
	go func() {
		p.err = cmd.Wait()
		close(p.done)
	}()
	select {
	case info := <-ready:
		p.launch = info
		fmt.Fprintf(log, "[SFL desktop] %s %s ready at %s\n", svc.name, info.Version, info.Origin)
		return p, nil
	case <-p.done:
		windows.CloseHandle(job)
		return nil, fmt.Errorf("%s启动失败：%v", svc.name, p.err)
	case <-time.After(timeout):
		p.kill()
		return nil, fmt.Errorf("%s在 %s 内没有就绪", svc.name, timeout)
	}
}

func (p *process) running() bool {
	select {
	case <-p.done:
		return false
	default:
		return true
	}
}

func (p *process) request(method, path string) (*http.Response, error) {
	request, err := http.NewRequest(method, p.launch.Origin+path, strings.NewReader("{}"))
	if err != nil {
		return nil, err
	}
	request.Header.Set("Authorization", "Bearer "+p.launch.Token)
	request.Header.Set("Content-Type", "application/json")
	return (&http.Client{Timeout: 5 * time.Second}).Do(request)
}

// stop asks the backend to shut down through its own endpoint, so it can
// close the Library cleanly, and terminates it only after timeout.
func (p *process) stop(timeout time.Duration) {
	if p.running() {
		if response, err := p.request(http.MethodPost, "/api/shutdown"); err == nil {
			response.Body.Close()
		}
		select {
		case <-p.done:
		case <-time.After(timeout):
			p.kill()
		}
	}
	windows.CloseHandle(p.job)
}

func (p *process) kill() {
	windows.TerminateJobObject(p.job, 1)
	if p.running() {
		p.cmd.Process.Kill()
	}
	<-p.done
}
