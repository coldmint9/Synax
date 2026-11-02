"""python.run guardrails: workspace boundary, no network, no child processes.

The host runs the interpreter in isolated mode (-I -B) with a private HOME and no
inherited environment, so this module only has to keep one script inside the
workspace and sandbox it was given. It is a guardrail, not a hardened jail: the
host never claims a containment guarantee for arbitrary code.
"""
import io
import json
import os
import sys
import types

# event -> (path argument index, dir_fd argument index). A dir_fd other than
# AT_FDCWD makes the OS resolve the name inside that descriptor, so the target is
# resolved through the descriptor instead of the live cwd.
MUTATION_EVENTS = {
    "os.remove": ((0, 1),),
    "os.rmdir": ((0, 1),),
    "os.mkdir": ((0, 2),),
    "os.chmod": ((0, 2),),
    "os.chown": ((0, 3),),
    "os.utime": ((0, 3),),
    "os.truncate": ((0, None),),
    "os.mkfifo": ((0, 2),),
    "os.mknod": ((0, None),),
    "os.rename": ((0, 2), (1, 3)),
    "os.replace": ((0, 2), (1, 3)),
    "os.setxattr": ((0, None),),
    "os.removexattr": ((0, None),),
}
CHILD_EVENTS = (
    "subprocess.",
    "socket.",
    "ctypes.",
    "os.exec",
    "os.spawn",
    "os.posix_spawn",
    "os.startfile",
    "os.fork",
    "os.forkpty",
)
DEVICE_PATHS = {"/dev/null", "/dev/urandom", "/dev/random"}


def canonical(value):
    return os.path.normcase(os.path.realpath(os.fsdecode(value)))


def inside(target, root):
    try:
        return os.path.commonpath([target, root]) == root
    except ValueError:
        return False


class Sandbox:
    def __init__(self, config):
        self.private = canonical(config["private"])
        self.guard = canonical(__file__)
        self.script = canonical(config["script"])
        self.root = canonical(config["sandbox"])
        self.read_roots = [canonical(root) for root in config["readRoots"]]
        self.write_roots = [canonical(root) for root in config["writeRoots"]]
        self.blocked = {extension.lower() for extension in config["blockedExtensions"]}
        self.max_depth = int(config["maxDepth"])
        self.restricted = bool(config["restricted"])
        self.runtime = canonical(sys.base_prefix)
        self.violation_file = os.path.join(self.private, "denied")
        self.violation = None
        self.denying = False

    # -- boundary checks ---------------------------------------------------
    @staticmethod
    def _root_of(target, roots):
        return next((root for root in roots if inside(target, root)), None)

    def _check_depth(self, target, root):
        depth = len([part for part in os.path.relpath(target, root).split(os.sep) if part not in ("", ".")])
        if depth > self.max_depth:
            raise PermissionError("Path depth %d exceeds the sandbox maximum of %d: %s" % (depth, self.max_depth, target))

    def _check_extension(self, target):
        extension = os.path.splitext(target)[1].lower()
        if extension in self.blocked:
            raise PermissionError("Blocked extension %s: %s" % (extension, target))

    def check_read(self, target):
        if target in DEVICE_PATHS:
            return
        # Traceback formatting may read the fixed bootstrap outside the workspace.
        if target == self.guard:
            return
        if inside(target, self.runtime) or inside(target, self.private):
            return
        root = self._root_of(target, self.read_roots)
        if root is None:
            raise PermissionError("Read escapes the workspace: " + target)
        self._check_extension(target)
        self._check_depth(target, root)

    def check_write(self, target):
        if target in DEVICE_PATHS:
            return
        if inside(target, self.private):
            return
        root = self._root_of(target, self.write_roots)
        if root is None:
            raise PermissionError("Write escapes the workspace or its assigned write scope: " + target)
        self._check_extension(target)
        self._check_depth(target, root)

    @staticmethod
    def _writing(mode, flags):
        if isinstance(mode, str) and any(character in mode for character in "wax+"):
            return True
        return isinstance(flags, int) and bool(
            flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND)
        )

    @staticmethod
    def _bare_name(value):
        separators = {separator for separator in (os.sep, os.altsep) if separator}
        return value not in ("", ".", "..") and not os.path.isabs(value) and not any(
            separator in value for separator in separators
        )

    @staticmethod
    def _fd_directory(fd):
        """Best-effort directory behind a descriptor; None when it cannot be read."""
        try:
            return canonical(os.readlink(os.path.join("/dev", "fd", str(fd))))
        except OSError:
            return None

    def _check_mutation(self, event, args):
        for path_index, dir_fd_index in MUTATION_EVENTS[event]:
            if path_index >= len(args):
                continue
            value = os.fsdecode(args[path_index])
            base = None
            if dir_fd_index is not None and dir_fd_index < len(args):
                fd = args[dir_fd_index]
                if isinstance(fd, int) and not isinstance(fd, bool) and fd != -1:
                    base = self._fd_directory(fd)
                    if base is None:
                        # The descriptor cannot be resolved, but the script could
                        # only obtain it through a path this hook already checked,
                        # so a bare name stays inside it.
                        if not self._bare_name(value):
                            raise PermissionError(
                                "Unresolvable dir_fd accepts only a plain file name: " + value
                            )
                        continue
            self.check_write(canonical(value if base is None else os.path.join(base, value)))

    # -- audit hook --------------------------------------------------------
    def audit(self, event, args):
        # Writing the sticky violation report would otherwise re-enter this hook.
        if self.denying:
            return
        try:
            if event == "open":
                # An integer path is an already-open descriptor (stdin/stdout or a
                # handle the script opened by path and this hook already checked).
                # Only path arguments can introduce a new outside location.
                if not isinstance(args[0], (str, bytes, os.PathLike)):
                    return
                target = canonical(args[0])
                if self._writing(args[1], args[2]):
                    self.check_write(target)
                else:
                    self.check_read(target)
            elif event in ("os.listdir", "os.scandir", "os.chdir"):
                # A descriptor is an already-vetted directory; only paths need checks.
                if args and not isinstance(args[0], (str, bytes, os.PathLike)):
                    return
                value = args[0] if args and args[0] is not None else os.getcwd()
                self.check_read(canonical(value))
            elif event in MUTATION_EVENTS:
                self._check_mutation(event, args)
            elif event in ("os.link", "os.symlink"):
                raise PermissionError("Links are not permitted in the python.run sandbox")
            elif event in ("os.system", "os.kill", "os.killpg", "_winapi.CreateProcess") or event.startswith(CHILD_EVENTS):
                raise PermissionError("Operation is blocked in the python.run sandbox: " + event)
        except (PermissionError, TypeError, ValueError) as error:
            self._deny(error)

    def _deny(self, error):
        self.violation = str(error)
        self.denying = True
        try:
            with open(self.violation_file, "w", encoding="utf-8") as failure:
                failure.write(self.violation[:8192])
        except OSError:
            pass
        finally:
            self.denying = False
        raise error if isinstance(error, PermissionError) else PermissionError(str(error))


def main():
    # This pipe belongs to the host protocol, not the user's stdin. Consume it
    # completely so raw fd reads cannot expose any source/config envelope bytes.
    envelope = json.loads(sys.stdin.buffer.read().decode("utf-8"))
    if envelope.get("version") != 1:
        raise ValueError("Unsupported python.run envelope version")
    sandbox = Sandbox(envelope["config"])
    # Compile the entire source before executing any user statement: a syntax
    # error after a write must not leave that earlier write behind.
    program = compile(envelope["code"], sandbox.script, "exec")
    user_stdin = io.TextIOWrapper(io.BytesIO(envelope["stdin"].encode("utf-8")), encoding="utf-8")
    sys.stdin = sys.__stdin__ = user_stdin
    # The original fd 0 remains at EOF. The memory stream supports input(),
    # text reads and .buffer, but deliberately has no OS descriptor/fileno().
    sys.argv[:] = [sandbox.script, *envelope["args"]]
    del envelope
    if sandbox.restricted:
        sys.addaudithook(sandbox.audit)
    # -I implies -P, so the host inserts the places a script may import from
    # explicitly. Appending keeps the standard library authoritative.
    sys.path.extend([os.getcwd(), sandbox.root])
    module = types.ModuleType("__main__")
    module.__file__ = sandbox.script
    module.__builtins__ = __builtins__
    sys.modules["__main__"] = module
    exec(program, module.__dict__)


if __name__ == "__main__":
    main()
