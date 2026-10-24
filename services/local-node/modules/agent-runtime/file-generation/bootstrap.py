"""File generation guardrails, not a hardened sandbox. No workspace writes here."""
import hashlib
import json
import os
import runpy
import stat
import sys
import types

PRIVATE = os.path.normcase(os.path.realpath(os.path.dirname(__file__)))
with open(os.path.join(PRIVATE, "config.json"), encoding="utf-8") as config_file:
    CONFIG = json.load(config_file)
ROOT = os.path.normcase(os.path.realpath(os.getcwd()))
RUNTIME = os.path.normcase(os.path.realpath(sys.base_prefix))
MAX_FILE = 8 * 1024 * 1024
MAX_TOTAL = 64 * 1024 * 1024
pending = {}
requested = {}
reads = {}
destructive = set()
moves = {}
violation = None


def inside(target, root):
    try:
        return os.path.commonpath([target, root]) == root
    except ValueError:
        return False


def canonical(value):
    if not isinstance(value, (str, bytes, os.PathLike)):
        raise PermissionError("File descriptors are not supported")
    return os.path.normcase(os.path.realpath(os.fsdecode(value)))


def workspace_path(value):
    target = canonical(value)
    roots = [ROOT] + [os.path.normcase(root) for root in CONFIG["readRoots"]]
    root = next((root for root in roots if inside(target, root)), None)
    if root is None:
        raise PermissionError("Read escapes workspace: " + str(value))
    if os.path.splitext(target)[1].lower() in CONFIG["blockedExtensions"]:
        raise PermissionError("Read has blocked extension: " + str(value))
    if len(os.path.relpath(target, root).split(os.sep)) > CONFIG["maxDepth"]:
        raise PermissionError("Read exceeds maximum path depth")
    return target


def audit(event, args):
    global violation
    try:
        if event == "open":
            target = canonical(args[0])
            mode, flags = args[1], args[2]
            writing = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
                isinstance(flags, int) and flags & (os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND))
            if writing:
                if not inside(target, PRIVATE):
                    raise PermissionError("Direct writes are forbidden; use synax.write/delete/move")
            elif not inside(target, PRIVATE) and not inside(target, RUNTIME):
                workspace_path(target)
        elif event in ("os.listdir", "os.scandir"):
            target = canonical(args[0] if args[0] is not None else ".")
            if not inside(target, PRIVATE) and not inside(target, RUNTIME):
                workspace_path(target)
        elif event in ("os.remove", "os.rename", "os.mkdir", "os.rmdir", "os.chmod", "os.chown",
                       "os.link", "os.symlink", "os.truncate", "os.utime", "os.setxattr", "os.removexattr"):
            # dir_fd can change the meaning of a relative path: never permit it.
            paths = args[:2] if event in ("os.rename", "os.link", "os.symlink") else args[:1]
            if any(not os.path.isabs(os.fsdecode(p)) or not inside(canonical(p), PRIVATE) for p in paths):
                raise PermissionError("Filesystem mutations are restricted to private staging")
            if event in ("os.symlink", "os.link"):
                raise PermissionError("Links are not supported")
        elif (event.startswith(("subprocess.", "socket.", "ctypes.", "os.exec", "os.spawn", "os.posix_spawn", "os.startfile"))
              or event == "_winapi.CreateProcess"
              or event in ("os.system", "os.fork", "os.forkpty", "os.chdir", "os.fchdir", "os.kill", "os.killpg", "os.putenv", "os.unsetenv")):
            raise PermissionError("Operation is forbidden: " + event)
    except (PermissionError, TypeError, ValueError) as error:
        violation = str(error)
        # atexit callbacks run after the manifest is published and Python may
        # ignore their exceptions. Persist a sticky failure for the host too.
        with open(os.path.join(PRIVATE, "denied"), "w", encoding="utf-8") as failure:
            failure.write(violation[:8192])
        raise


sys.addaudithook(audit)


def remember(value):
    if not isinstance(value, str) or not value or "\0" in value:
        raise ValueError("Expected a nonempty file path")
    target = canonical(value)
    requested[target] = value
    if len(requested) > 120:
        raise ValueError("file.generate supports at most 120 files; split the request")
    return target


def check_size():
    if sum(len(value) for value in pending.values() if value is not None) > MAX_TOTAL:
        raise ValueError("file.generate exceeds 64 MB; split the request")


def read(value):
    target = workspace_path(value)
    if target in pending:
        data = pending[target]
        if data is None:
            raise FileNotFoundError(value)
        return data.decode("utf-8")
    with open(target, "rb") as source:
        before = os.fstat(source.fileno())
        if not stat.S_ISREG(before.st_mode) or before.st_size > MAX_FILE:
            raise ValueError("Expected a regular text file of at most 8 MB")
        data = source.read(MAX_FILE + 1)
        after = os.fstat(source.fileno())
    if len(data) > MAX_FILE or (before.st_mtime_ns, before.st_size) != (after.st_mtime_ns, after.st_size):
        raise ValueError("File changed during read or exceeds 8 MB")
    text = data.decode("utf-8")
    if "\0" in text:
        raise ValueError("NUL text is not supported")
    digest = hashlib.sha256(data).hexdigest()
    if target in reads and reads[target]["sha256"] != digest:
        raise ValueError("File changed during script execution")
    reads[target] = {"type": "read", "path": target, "sha256": digest, "bytes": len(data)}
    if len(reads) > 120 or sum(item["bytes"] for item in reads.values()) > MAX_TOTAL:
        raise ValueError("Read limit exceeded; split the request")
    return text


def write(value, content):
    target = remember(value)
    if not isinstance(content, str) or "\0" in content:
        raise ValueError("Expected UTF-8 text without NUL bytes")
    data = content.encode("utf-8")
    if len(data) > MAX_FILE:
        raise ValueError("Single file exceeds 8 MB; split the request")
    pending[target] = data
    moves.pop(target, None)
    check_size()


def delete(value):
    target = remember(value)
    destructive.add(value)
    pending[target] = None
    moves.pop(target, None)


def move(source, destination):
    src, dest = remember(source), remember(destination)
    if src == dest:
        raise ValueError("Move source and destination must differ")
    content = read(source)
    origin = next((key for key, value in moves.items() if value == src), src)
    write(destination, content)
    delete(source)
    moves[origin] = dest


def exists(value):
    target = workspace_path(value)
    return pending[target] is not None if target in pending else os.path.exists(target)


def list_dir(value="."):
    target = workspace_path(value)
    if os.path.exists(target):
        names = set(os.listdir(target))
    elif any(content is not None and inside(item, target) for item, content in pending.items()):
        names = set()
    else:
        raise FileNotFoundError(value)
    for item, content in pending.items():
        if item != target and inside(item, target):
            relative = os.path.relpath(item, target)
            name = relative.split(os.sep)[0]
            if content is not None:
                names.add(name)
            elif os.sep not in relative:
                names.discard(name)
    return sorted(names)


synax = types.ModuleType("synax")
for function in (write, delete, move, read, exists, list_dir):
    setattr(synax, function.__name__, function)
sys.modules["synax"] = synax
runpy.run_path(os.path.join(PRIVATE, "user_script.py"), run_name="__main__")
if violation:
    raise PermissionError("Script attempted a forbidden operation: " + violation)

# Only publish a manifest after normal completion. SystemExit(0) is not completion.
with open(os.path.join(PRIVATE, "manifest.jsonl"), "w", encoding="utf-8", newline="\n") as manifest:
    def emit(item):
        manifest.write(json.dumps(item, ensure_ascii=True) + "\n")
    for item in reads.values():
        emit(item)
    for target in sorted(destructive):
        emit({"type": "requiresDelete", "path": target})
    for index, (target, content) in enumerate(pending.items()):
        item = {"type": "delete" if content is None else "write", "path": requested[target]}
        if content is not None:
            item["contentFile"] = str(index) + ".txt"
            with open(os.path.join(PRIVATE, "staging", item["contentFile"]), "wb") as staged:
                staged.write(content)
        elif target in moves and pending.get(moves[target]) is not None:
            item["movePath"] = requested[moves[target]]
        emit(item)
    emit({"type": "complete", "version": 1})
