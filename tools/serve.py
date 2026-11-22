#!/usr/bin/env python3
"""Tiny static server for Tiltbox. No caching, so every reload gets the latest code.

Usage: python3 tools/serve.py [port] [--https]     (default port 8797)

--https serves over TLS with a self-signed certificate, made on first use and kept outside the
repo in ~/.local/share/tiltbox-certs/. Phones only give motion sensors to HTTPS pages; the
browser warns about the certificate once, and you accept it ("visit this website").
Set TILTBOX_CERT_HOSTS (comma-separated names and IPs) to choose what the certificate covers;
by default it covers this machine's hostname, localhost and its current IP addresses.
"""
import http.server
import ipaddress
import json
import os
import socket
import ssl
import subprocess
import sys

args = [a for a in sys.argv[1:] if not a.startswith("--")]
HTTPS = "--https" in sys.argv
PORT = int(args[0]) if args else 8797
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CERT_DIR = os.path.expanduser("~/.local/share/tiltbox-certs")


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        super().end_headers()

    def log_message(self, *a):
        pass


Handler.extensions_map.update({".js": "text/javascript", ".mjs": "text/javascript"})


def cert_hosts():
    env = os.environ.get("TILTBOX_CERT_HOSTS")
    if env:
        return [h.strip() for h in env.split(",") if h.strip()]
    hosts = {"localhost", "127.0.0.1", socket.gethostname(), f"{socket.gethostname()}.local"}
    try:
        out = subprocess.run(["hostname", "-I"], capture_output=True, text=True, timeout=5).stdout
        hosts.update(out.split())
    except OSError:
        pass
    try:  # the machine's tailnet name, if it has one (read-only query)
        st = json.loads(subprocess.run(["tailscale", "status", "--json"], capture_output=True, text=True, timeout=5).stdout)
        name = st.get("Self", {}).get("DNSName", "").rstrip(".")
        if name:
            hosts.add(name)
    except (OSError, ValueError):
        pass
    return sorted(hosts)


def ensure_cert():
    cert = os.path.join(CERT_DIR, "cert.pem")
    key = os.path.join(CERT_DIR, "key.pem")
    if os.path.exists(cert) and os.path.exists(key):
        return cert, key
    os.makedirs(CERT_DIR, exist_ok=True)
    san = []
    for h in cert_hosts():
        try:
            ipaddress.ip_address(h)
            san.append(f"IP:{h}")
        except ValueError:
            san.append(f"DNS:{h}")
    # 825 days: the longest validity iOS accepts for a server certificate.
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-sha256", "-days", "825",
        "-keyout", key, "-out", cert, "-subj", "/CN=Tiltbox dev server",
        "-addext", "subjectAltName=" + ",".join(san),
        "-addext", "extendedKeyUsage=serverAuth",
        "-addext", "basicConstraints=critical,CA:FALSE",
    ], check=True, capture_output=True)
    os.chmod(key, 0o600)
    return cert, key


if __name__ == "__main__":
    with http.server.ThreadingHTTPServer(("0.0.0.0", PORT), Handler) as srv:
        if HTTPS:
            cert, key = ensure_cert()
            tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            tls.load_cert_chain(cert, key)
            # Handshake on first read, in the request's thread, so one slow client cannot stall the rest.
            srv.socket = tls.wrap_socket(srv.socket, server_side=True, do_handshake_on_connect=False)
        print(f"Serving {ROOT} on {'https' if HTTPS else 'http'}://0.0.0.0:{PORT}")
        srv.serve_forever()
