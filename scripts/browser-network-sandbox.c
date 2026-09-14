/* Chromium runs without IP sockets. HTTP is fulfilled by the Node public-source
 * broker; even an un-intercepted browser request cannot bypass its socket policy.
 * The filter survives exec/fork. Only Unix-domain sockets needed by Chromium IPC
 * are allowed; io_uring cannot provide an alternate socket creation path. */
#include <errno.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/socket.h>
#include <sys/syscall.h>
#include <unistd.h>

#if defined(__x86_64__)
#define NATIVE_ARCH AUDIT_ARCH_X86_64
#elif defined(__aarch64__)
#define NATIVE_ARCH AUDIT_ARCH_AARCH64
#else
#error Unsupported browser sandbox architecture
#endif

int main(int argc, char **argv) {
  struct sock_filter rules[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, NATIVE_ARCH, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    /* Reject the x32 syscall ABI, which uses the x86_64 audit architecture. */
    BPF_JUMP(BPF_JMP | BPF_JGE | BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 3, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socketpair, 2, 0),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_io_uring_setup, 4, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EACCES),
  };
  struct sock_fprog program = { .len = sizeof(rules) / sizeof(rules[0]), .filter = rules };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
      prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) {
    fputs("Browser network sandbox unavailable.\n", stderr);
    return 126;
  }
  if (argc == 2 && strcmp(argv[1], "--self-test") == 0) {
    int families[] = {AF_INET, AF_INET6};
    for (unsigned int i = 0; i < sizeof(families) / sizeof(families[0]); i++) {
      if (socket(families[i], SOCK_STREAM, 0) != -1 || errno != EACCES ||
          socket(families[i], SOCK_DGRAM, 0) != -1 || errno != EACCES) return 1;
    }
    int ipc[2];
    if (socketpair(AF_UNIX, SOCK_STREAM, 0, ipc)) return 1;
    close(ipc[0]); close(ipc[1]);
    puts("Browser IPv4/IPv6 TCP/UDP denied; Unix IPC available.");
    return 0;
  }
  argv[0] = "/usr/local/bin/chromium";
  execv(argv[0], argv);
  fputs("Sandboxed Chromium unavailable.\n", stderr);
  return 126;
}
