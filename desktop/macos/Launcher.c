#include <mach-o/dyld.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* External MCP entrypoint: execute the bundled Node server, preserving stdio. */
int main(int argc, char **argv) {
    char executable[PATH_MAX], resolved[PATH_MAX], runtime[PATH_MAX], server[PATH_MAX];
    uint32_t size = sizeof(executable);
    if (_NSGetExecutablePath(executable, &size) != 0 || realpath(executable, resolved) == NULL) {
        perror("Cannot locate the SFL installation"); return 1;
    }
    char *separator = strrchr(resolved, '/');
    if (!separator) return 1;
    *separator = '\0';
#if defined(__arm64__)
    const char *architecture = "arm64";
#else
    const char *architecture = "x64";
#endif
    if (snprintf(runtime, sizeof(runtime), "%s/../Resources/sfl/runtime/darwin-%s/node", resolved, architecture) >= sizeof(runtime) ||
        snprintf(server, sizeof(server), "%s/../Resources/sfl/dist/index.js", resolved) >= sizeof(server)) return 1;
    char **arguments = calloc((size_t)argc + 2, sizeof(char *));
    if (!arguments) return 1;
    arguments[0] = runtime;
    arguments[1] = server;
    for (int index = 1; index < argc; index++) arguments[index + 1] = argv[index];
    execv(runtime, arguments);
    perror("Cannot start the bundled SFL runtime");
    free(arguments);
    return 1;
}
