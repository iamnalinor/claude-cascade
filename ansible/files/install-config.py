import grp
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile


binary, directory = sys.argv[1:]
root = Path(directory)
target = root / "config.json"
config = json.load(sys.stdin)
if isinstance(config, str):
    config = json.loads(config)
with (root / "identity.json").open() as identity:
    config["inbounds"][0]["streamSettings"]["realitySettings"]["privateKey"] = json.load(identity)["private_key"]

group = grp.getgrnam("happ-exit").gr_gid
if target.is_file() and not target.is_symlink():
    info = target.stat()
    if (info.st_uid, info.st_gid, stat.S_IMODE(info.st_mode)) == (0, group, 0o640):
        try:
            with target.open() as current:
                if json.load(current) == config:
                    sys.exit(0)
        except (ValueError, UnicodeError):
            pass

fd, temporary = tempfile.mkstemp(prefix=".config-", suffix=".json", dir=root)
try:
    with os.fdopen(fd, "w") as output:
        json.dump(config, output)
        output.write("\n")
        output.flush()
        os.fsync(output.fileno())
        os.fchown(output.fileno(), 0, group)
        os.fchmod(output.fileno(), 0o640)
    subprocess.run([binary, "run", "-test", "-config", temporary], check=True, stdout=subprocess.DEVNULL, timeout=15)
    os.replace(temporary, target)
    print("changed")
finally:
    Path(temporary).unlink(missing_ok=True)
