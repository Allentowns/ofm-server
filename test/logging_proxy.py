"""A throwaway local HTTP CONNECT proxy that logs every tunnel it opens.

Used to prove that ofm-server's traffic really leaves through the configured
proxy. Prints one line per CONNECT to stdout.
"""
import socket, threading, sys

LOG = []


def pipe(src, dst):
    try:
        while True:
            data = src.recv(65536)
            if not data:
                break
            dst.sendall(data)
    except OSError:
        pass
    finally:
        try:
            dst.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def handle(client):
    head = b''
    while b'\r\n\r\n' not in head:
        chunk = client.recv(65536)
        if not chunk:
            client.close()
            return
        head += chunk
    lines = head.split(b'\r\n')
    method, target, _ = lines[0].decode('latin1').split(' ', 2)
    if method.upper() != 'CONNECT':
        client.sendall(b'HTTP/1.1 405 Method Not Allowed\r\n\r\n')
        client.close()
        return
    host, _, port = target.partition(':')
    print(f'CONNECT {host}:{port or 443}', flush=True)
    try:
        upstream = socket.create_connection((host, int(port or 443)), timeout=20)
    except OSError as exc:
        client.sendall(b'HTTP/1.1 502 Bad Gateway\r\n\r\n')
        client.close()
        print(f'  -> dial failed: {exc}', flush=True)
        return
    client.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
    rest = head.split(b'\r\n\r\n', 1)[1]
    if rest:
        upstream.sendall(rest)
    threading.Thread(target=pipe, args=(client, upstream), daemon=True).start()
    threading.Thread(target=pipe, args=(upstream, client), daemon=True).start()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 17890
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind(('127.0.0.1', port))
    server.listen(64)
    print(f'proxy listening on 127.0.0.1:{port}', flush=True)
    while True:
        client, _ = server.accept()
        threading.Thread(target=handle, args=(client,), daemon=True).start()


main()
