#include <mach-o/dyld.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <fcntl.h>
#include <signal.h>
#include <sys/wait.h>

/* Shared runtime resolver and external stdio entrypoint; no MCP client. */
static int compatible(const char *node) {
    if (!node || node[0] != '/' || access(node, X_OK) != 0) return 0;
    pid_t child = fork();
    if (child < 0) return 0;
    if (child == 0) {
        int sink = open("/dev/null", O_RDWR);
        if (sink < 0) _exit(1);
        dup2(sink, STDIN_FILENO); dup2(sink, STDOUT_FILENO); dup2(sink, STDERR_FILENO);
        close(sink);
        unsetenv("NODE_OPTIONS"); unsetenv("NODE_PATH");
        execl(node, node, "--eval", "process.exit(Number(process.versions.node.split('.')[0]) >= 22 ? 0 : 1)", (char *)NULL);
        _exit(1);
    }
    int status = 0;
    for (int attempt = 0; attempt < 100; attempt++) {
        pid_t result = waitpid(child, &status, WNOHANG);
        if (result == child) return WIFEXITED(status) && WEXITSTATUS(status) == 0;
        if (result < 0) return 0;
        usleep(50000);
    }
    kill(child, SIGKILL); waitpid(child, &status, 0);
    return 0;
}

#ifdef SFL_SYSTEM_NODE
static int system_node(char *runtime, size_t capacity) {
    const char *override = getenv("SFL_NODE_BINARY");
    if (override && *override) {
        if (!compatible(override)) return 0;
        return snprintf(runtime, capacity, "%s", override) < capacity;
    }
    const char *locations[] = { "/opt/homebrew/bin/node", "/usr/local/bin/node",
        "/opt/homebrew/opt/node@22/bin/node", "/usr/local/opt/node@22/bin/node",
        "/opt/homebrew/opt/node@24/bin/node", "/usr/local/opt/node@24/bin/node", NULL };
    for (int index = 0; locations[index]; index++) {
        if (compatible(locations[index])) return snprintf(runtime, capacity, "%s", locations[index]) < capacity;
    }
    const char *raw = getenv("PATH");
    char *paths = strdup(raw ? raw : "");
    if (!paths) return 0;
    char *state = NULL;
    for (char *directory = strtok_r(paths, ":", &state); directory; directory = strtok_r(NULL, ":", &state)) {
        if (directory[0] != '/') continue;
        if (snprintf(runtime, capacity, "%s/node", directory) < capacity && compatible(runtime)) { free(paths); return 1; }
    }
    free(paths);
    return 0;
}
#endif

int main(int argc, char **argv) {
    char executable[PATH_MAX], resolved[PATH_MAX], runtime[PATH_MAX], server[PATH_MAX];
    uint32_t size = sizeof(executable);
    if (_NSGetExecutablePath(executable, &size) != 0 || realpath(executable, resolved) == NULL) {
        perror("Cannot locate the SFL installation"); return 1;
    }
    char *separator = strrchr(resolved, '/');
    if (!separator) return 1;
    *separator = '\0';
#ifdef SFL_SYSTEM_NODE
    if (!system_node(runtime, sizeof(runtime))) {
        fputs("未找到 Node.js 22+。请选择本机 Node 可执行文件、安装 Node.js 22+，或下载内置 Node 版。\nNode.js 22+ was not found. Install Node, set SFL_NODE_BINARY to its absolute path, or use the bundled-Node installer.\n", stderr);
        return 1;
    }
#else
#if defined(__arm64__)
    const char *architecture = "arm64";
#else
    const char *architecture = "x64";
#endif
    if (snprintf(runtime, sizeof(runtime), "%s/../Resources/sfl/runtime/darwin-%s/node", resolved, architecture) >= sizeof(runtime) || !compatible(runtime)) {
        fputs("安装包缺少可用的 Node.js 22+ 运行时，请重新下载完整 DMG。\n", stderr); return 1;
    }
#endif
    if (argc == 2 && strcmp(argv[1], "--sfl-node-path") == 0) { puts(runtime); return 0; }
    if (snprintf(server, sizeof(server), "%s/../Resources/sfl/dist/index.js", resolved) >= sizeof(server)) return 1;
    char **arguments = calloc((size_t)argc + 2, sizeof(char *));
    if (!arguments) return 1;
    arguments[0] = runtime;
    arguments[1] = server;
    for (int index = 1; index < argc; index++) arguments[index + 1] = argv[index];
    unsetenv("NODE_OPTIONS"); unsetenv("NODE_PATH");
    execv(runtime, arguments);
    perror("Cannot start the SFL runtime");
    free(arguments);
    return 1;
}
