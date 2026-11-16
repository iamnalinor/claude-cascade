import grp
import ipaddress
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


directory, address = sys.argv[1:]
address = str(ipaddress.IPv4Address(address))
store = Path(directory)
certificate = store / "server.crt"
key = store / "server.key"
group = grp.getgrnam("happ-exit").gr_gid
created = not certificate.exists() and not key.exists()
if created:
    with tempfile.TemporaryDirectory(prefix=".generate-tls-", dir=store.parent) as directory:
        temporary = Path(directory)
        generated_cert, generated_key = temporary / certificate.name, temporary / key.name
        subprocess.run(
            [
                "openssl", "req", "-x509", "-newkey", "ec",
                "-pkeyopt", "ec_paramgen_curve:prime256v1",
                "-nodes", "-days", "1095", "-subj", "/CN=Claude Cascade EXIT2",
                "-addext", f"subjectAltName=IP:{address}", "-addext", "extendedKeyUsage=serverAuth",
                "-keyout", str(generated_key), "-out", str(generated_cert),
            ],
            check=True, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, timeout=15,
        )
        for source in (generated_cert, generated_key):
            os.chown(source, 0, group)
            source.chmod(0o640)
        os.chown(temporary, 0, group)
        temporary.chmod(0o750)
        os.replace(temporary, store)
elif not certificate.is_file() or not key.is_file():
    raise SystemExit("The existing TLS certificate and key must be restored as a pair.")

subprocess.run(
    ["openssl", "verify", "-CAfile", str(certificate), "-verify_ip", address, str(certificate)],
    check=True, stdout=subprocess.DEVNULL, timeout=5,
)
certificate_public_key = subprocess.check_output(
    ["openssl", "x509", "-in", str(certificate), "-pubkey", "-noout"], timeout=5,
)
private_public_key = subprocess.check_output(
    ["openssl", "pkey", "-in", str(key), "-pubout"], timeout=5,
)
if certificate_public_key != private_public_key:
    raise SystemExit("The TLS certificate and key do not match.")

print(json.dumps({"certificate": certificate.read_text().splitlines(), "changed": created}))
