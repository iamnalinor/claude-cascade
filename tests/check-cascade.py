"""Loopback integration test of the generated cascade using a trusted TLS fixture."""

import contextlib
import http.server
import json
import os
import socket
import subprocess
import tempfile
import threading
import time
from pathlib import Path

XRAY = os.environ.get("XRAY_BIN", "xray")
UUID = "66503fc8-b327-4ae1-a6a5-dd6964910bb4"
TARGET = "api.anthropic.com"
IP_CHECK = "ip.net.coffee"


class Echo(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(self.client_address[0].encode())

    def log_message(self, *_args):
        pass


def free_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def wait_port(port, process):
    deadline = time.monotonic() + 5
    while time.monotonic() < deadline and process.poll() is None:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=0.2):
                return
        except OSError:
            time.sleep(0.04)
    raise RuntimeError(f"Listener failed on TCP {port}")


def start(stack, state, name, arguments, port):
    stderr = stack.enter_context((state / f"{name}.log").open("wb"))
    proc = subprocess.Popen(arguments, stdout=stderr, stderr=stderr)
    stack.callback(stop, proc)
    try:
        wait_port(port, proc)
    except RuntimeError:
        stderr.flush()
        print((state / f"{name}.log").read_text())
        raise
    return proc


def stop(proc):
    if proc.poll() is None:
        proc.terminate()
        proc.wait(timeout=5)


def start_xray(stack, state, name, config, port):
    settings = state / f"{name}.json"
    settings.write_text(json.dumps(config))
    subprocess.run([XRAY, "run", "-test", "-config", str(settings)], check=True, stdout=subprocess.DEVNULL)
    return start(stack, state, name, [XRAY, "run", "-config", str(settings)], port)


def server_config(port, egress, allowed_ports):
    return {
        "log": {"loglevel": "debug"},
        "inbounds": [{
            "listen": "127.0.0.1",
            "port": port,
            "protocol": "vless",
            "settings": {"decryption": "none", "clients": [{"id": UUID}]},
        }],
        "outbounds": [{
            "protocol": "freedom",
            "sendThrough": egress,
            "settings": {"finalRules": [{
                "action": "allow",
                "ip": ["127.0.0.1/32"],
                "network": "tcp",
                "port": ",".join(map(str, allowed_ports)),
            }]},
        }],
    }


def client_config(ports, ca):
    proxy, first, second = ports
    template = """
    import {cascade} from './src/routing.ts';
    const [socks, first, second, ca] = JSON.parse(await Bun.stdin.text());
    const user = {encryption:'none', id:'66503fc8-b327-4ae1-a6a5-dd6964910bb4'};
    const settings = (address, port) => ({vnext:[{address, port, users:[user]}]});
    const profile = {
      dns:{hosts:{'ordinary.example':'127.0.0.1','other.ip.net.coffee':'127.0.0.1'}},
      inbounds:[{listen:'127.0.0.1',port:socks,protocol:'socks'}],
      outbounds:[{protocol:'vless',settings:settings('10.0.0.10',first),tag:'main'}],
    };
    const bridge = {
      protocol:'vless',
      settings:settings('192.0.2.20',second),
      streamSettings:{network:'raw',security:'tls',tlsSettings:{
        serverName:'test.example',disableSystemRoot:true,
        certificates:[{certificateFile:ca,usage:'verify'}],
      }},
    };
    const config = cascade(profile,bridge);
    config.outbounds[0].settings.vnext[0].address = '127.0.0.1';
    config.outbounds[1].settings.vnext[0].address = '127.0.0.1';
    console.log(JSON.stringify(config));
    """
    result = subprocess.run(
        ["bun", "--no-env-file", "-e", template],
        input=json.dumps([proxy, first, second, str(ca)]), text=True, check=True, capture_output=True,
    )
    return json.loads(result.stdout)


def request(host, proxy_port, echo_port):
    return subprocess.run([
        "curl", "--silent", "--show-error", "--max-time", "4",
        "--socks5", f"127.0.0.1:{proxy_port}",
        "--resolve", f"{host}:{echo_port}:127.0.0.1",
        f"http://{host}:{echo_port}/",
    ], capture_output=True, text=True)


def check_routes(proxy_port, echo_port):
    for host, expected in [(TARGET, "127.0.0.3"), (IP_CHECK, "127.0.0.3"),
                           ("other.ip.net.coffee", "127.0.0.2"),
                           ("ordinary.example", "127.0.0.2"), ("example.ru", "127.0.0.1")]:
        hit = request(host, proxy_port, echo_port)
        assert (hit.returncode, hit.stdout) == (0, expected), (host, hit.returncode, hit.stdout, hit.stderr)


def main():
    with tempfile.TemporaryDirectory(prefix="happ-xray-") as directory, contextlib.ExitStack() as stack:
        state = Path(directory)
        echo = stack.enter_context(http.server.ThreadingHTTPServer(("127.0.0.1", 0), Echo))
        thread = threading.Thread(target=echo.serve_forever, daemon=True)
        thread.start()
        stack.callback(echo.shutdown)
        echo_port = echo.server_port
        proxy, first, second = (free_port() for _ in range(3))
        key = state / "tls.key"
        certificate = state / "tls.pem"
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", "/CN=test.example", "-addext", "subjectAltName=DNS:test.example",
            "-keyout", str(key), "-out", str(certificate),
        ], check=True, capture_output=True)
        exit_config = server_config(second, "127.0.0.3", [echo_port])
        exit_config["log"]["access"] = str(state / "exit.access")
        exit_config["inbounds"][0]["streamSettings"] = {
            "network": "raw", "security": "tls",
            "tlsSettings": {"certificates": [{
                "certificateFile": str(certificate), "keyFile": str(key),
            }]},
        }
        first_config = server_config(first, "127.0.0.2", [second, echo_port])
        first_process = start_xray(stack, state, "first", first_config, first)
        exit_process = start_xray(stack, state, "exit", exit_config, second)
        config = client_config((proxy, first, second), certificate)
        start_xray(stack, state, "client", config, proxy)
        try:
            check_routes(proxy, echo_port)
        except AssertionError:
            for label in ("first", "exit", "client"):
                print(f"--- {label} ---")
                print((state / f"{label}.log").read_text(errors="replace"))
            raise
        assert "127.0.0.2" in (state / "exit.access").read_text(), "Exit did not observe the first hop"
        stop(first_process)
        assert request(TARGET, proxy, echo_port).returncode != 0, "Client dialled EXIT2 after first-hop failure"
        assert request(IP_CHECK, proxy, echo_port).returncode != 0, "IP check bypassed the first hop"
        start_xray(stack, state, "first-restored", first_config, first)
        assert request(TARGET, proxy, echo_port).stdout == "127.0.0.3"
        stop(exit_process)
        assert request(TARGET, proxy, echo_port).returncode != 0, "Target unexpectedly survived an exit failure"
        assert request(IP_CHECK, proxy, echo_port).returncode != 0, "IP check unexpectedly survived an exit failure"
        assert request("ordinary.example", proxy, echo_port).stdout == "127.0.0.2"
        assert request("example.ru", proxy, echo_port).stdout == "127.0.0.1"
        print("Xray passed cascade, first-hop identity, RU direct and fail-closed checks.")


if __name__ == "__main__":
    main()
