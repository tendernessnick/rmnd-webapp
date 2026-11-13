#!/usr/bin/env python3
"""开发服务器：在 http.server 基础上禁用缓存（禁启发式缓存，保证改完刷新即见）。
用法：python serve.py [port] [host]
  默认 8000 + 127.0.0.1（仅本机；手机经 adb reverse 转发时用这个）
  传 host=0.0.0.0 时监听所有网卡（手机同局域网直接访问 http://<PC IP>:<port>，
  注意 http://IP 非安全上下文，Web Bluetooth/NFC 不可用，仅 UI 与模拟工牌调试）"""
import http.server
import sys


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-cache, no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):  # 静音访问日志（通宵跑，输出太吵）
        pass


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    host = sys.argv[2] if len(sys.argv) > 2 else "127.0.0.1"
    srv = http.server.ThreadingHTTPServer((host, port), NoCacheHandler)
    print(f"serving http://{host}:{port} (no-cache)")
    srv.serve_forever()
