"""Keep one writable app process per intact Workspace mount (issue #354).

The kernel owns the lock lifetime, including SIGKILL and container restart.
Never unlink the lock file: a second inode would admit a competing writer.
This is an advisory local-filesystem lock, not distributed coordination.
"""

import fcntl
import os
import sys


workspace = os.environ.get("WORKSPACE_DIR", "./workspace")
os.makedirs(workspace, exist_ok=True)
descriptor = os.open(os.path.join(workspace, ".writer.lock"), os.O_CREAT | os.O_RDWR, 0o600)
try:
    fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
except BlockingIOError:
    sys.stderr.write("Workspace is already open by another writable app process.\n")
    sys.exit(73)

# exec keeps Node as PID 1, so Docker signals reach it directly. The inherited
# descriptor retains the lock until Node exits, without heartbeat expiry races.
os.set_inheritable(descriptor, True)
os.execvp(sys.argv[1], sys.argv[1:])
