#!/usr/bin/env python3
"""pty-bridge.py COLS ROWS CMD [ARGS...]: run CMD on a real pseudo-terminal of the
given size, wiring this process's stdin/stdout to it. Lets a test drive a
full-screen program (beckon run -- claude) that needs a terminal, from pipes."""
import fcntl, os, pty, select, struct, sys, termios

cols, rows, argv = int(sys.argv[1]), int(sys.argv[2]), sys.argv[3:]
pid, fd = pty.fork()
if pid == 0:
    fcntl.ioctl(0, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    os.execvp(argv[0], argv)
stdin_open = True
while True:
    rl = [fd] + ([0] if stdin_open else [])
    r, _, _ = select.select(rl, [], [])
    if fd in r:
        try:
            d = os.read(fd, 65536)
        except OSError:
            break
        if not d:
            break
        os.write(1, d)
    if 0 in r:
        d = os.read(0, 65536)
        if not d:
            stdin_open = False
        else:
            os.write(fd, d)
_, status = os.waitpid(pid, 0)
sys.exit(os.waitstatus_to_exitcode(status))
