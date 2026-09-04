import os
import sys
import json
import time
import urllib.parse
from http import HTTPStatus
from http.server import HTTPServer, BaseHTTPRequestHandler
from socketserver import ThreadingMixIn
from typing import Dict, Any, List

from config_manager import ConfigManager, generate_device_code
from ctyun_keeper import CtYunKeeper, GLOBAL_LOGS
from scheduler import TaskScheduler
from ctyun_api import CtYunClientApi
from tasks.redeem_task import fetch_available_rewards

# 基础目录定位
BASE_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DATA_DIR = os.getenv("CTYUN_DATA_DIR", "/app/data" if os.path.exists("/app/data") or os.getenv("RUNNING_IN_DOCKER") == "true" else os.path.join(os.path.dirname(BASE_DIR), "data"))

config_manager = ConfigManager(DATA_DIR)


def on_account_status_change(account_name: str, status: str):
    for acc in config_manager.get_accounts():
        if acc.get("name") == account_name or acc.get("user") == account_name:
            config_manager.update_account(acc["id"], {
                "stats": {"keepAliveStatus": status}
            })
            break


keeper = CtYunKeeper(DATA_DIR, on_status_update=on_account_status_change)
scheduler = TaskScheduler(config_manager, keeper)


class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True


class AppRequestHandler(BaseHTTPRequestHandler):
    def log_message(self, format, *args):
        # 静默常规静态资源请求，错误记录到日志
        if args and str(args[1]) not in ["200", "304"]:
            pass

    def send_json(self, data: Any, status: int = 200):
        content = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(content)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.end_headers()
        self.wfile.write(content)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS")
        self.end_headers()

    def get_post_data(self) -> Dict[str, Any]:
        try:
            content_length = int(self.headers.get("Content-Length", 0))
            if content_length > 0:
                body = self.rfile.read(content_length).decode("utf-8")
                return json.loads(body)
        except Exception:
            pass
        return {}

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        # 1. 静态资源
        if path == "/" or path == "/index.html":
            self.serve_file(os.path.join(STATIC_DIR, "index.html"), "text/html; charset=utf-8")
            return
        elif path.startswith("/static/"):
            rel_path = path[8:]
            file_path = os.path.join(STATIC_DIR, rel_path)
            content_type = "text/plain"
            if rel_path.endswith(".css"):
                content_type = "text/css; charset=utf-8"
            elif rel_path.endswith(".js"):
                content_type = "application/javascript; charset=utf-8"
            elif rel_path.endswith(".html"):
                content_type = "text/html; charset=utf-8"
            self.serve_file(file_path, content_type)
            return

        # 2. SSE 实时日志流
        if path == "/api/logs/stream":
            self.handle_log_stream()
            return

        # 3. REST API
        if path == "/api/status":
            accounts = config_manager.get_accounts()
            active_cnt = sum(1 for a in accounts if a.get("enabled"))
            online_cnt = sum(1 for a in accounts if a.get("stats", {}).get("keepAliveStatus") == "online")
            signed_cnt = sum(1 for a in accounts if a.get("stats", {}).get("lastSignTime", "").startswith(time.strftime("%Y-%m-%d")))
            self.send_json({
                "accountsTotal": len(accounts),
                "accountsActive": active_cnt,
                "onlineKeepAlive": online_cnt,
                "signedToday": signed_cnt,
                "keeperRunning": keeper.running,
                "currentTime": time.strftime("%Y-%m-%d %H:%M:%S")
            })
            return

        if path == "/api/accounts":
            self.send_json(config_manager.get_accounts())
            return

        if path.startswith("/api/accounts/") and path.endswith("/desktops"):
            parts = path.split("/")
            acc_id = parts[3]
            acc = config_manager.get_account(acc_id)
            if not acc:
                self.send_json({"error": "账号不存在"}, 404)
                return
            client = CtYunClientApi(acc.get("deviceCode", ""))
            ok, msg, _ = client.login(acc.get("user", ""), acc.get("password", ""))
            if not ok:
                self.send_json({"error": msg}, 400)
                return
            desktops = client.get_desktop_list()
            self.send_json(desktops)
            return

        if path == "/api/rewards":
            rewards = fetch_available_rewards()
            self.send_json(rewards)
            return

        if path == "/api/settings":
            self.send_json(config_manager.config.get("settings", {}))
            return

        if path == "/api/logs":
            self.send_json(GLOBAL_LOGS.get_recent(200))
            return

        self.send_json({"error": "Not Found"}, 404)

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body = self.get_post_data()

        if path == "/api/accounts":
            new_acc = config_manager.add_account(body)
            GLOBAL_LOGS.append("System", f"已添加账号: {new_acc.get('name')}", "info")
            keeper.restart(1)
            self.send_json(new_acc, 201)
            return

        if path == "/api/device/generate":
            self.send_json({"deviceCode": generate_device_code()})
            return

        # 发送短信验证码
        if path.startswith("/api/accounts/") and path.endswith("/send-sms"):
            parts = path.split("/")
            acc_id = parts[3]
            acc = config_manager.get_account(acc_id)
            if not acc:
                self.send_json({"error": "账号不存在"}, 404)
                return
            client = CtYunClientApi(acc.get("deviceCode", ""))
            ok, msg = client.get_sms_code(acc.get("user", ""))
            if ok:
                GLOBAL_LOGS.append("Auth", f"[{acc.get('name')}] 短信验证码已发送至手机: {acc.get('user')}", "success")
                self.send_json({"success": True, "message": msg})
            else:
                GLOBAL_LOGS.append("Auth", f"[{acc.get('name')}] 发送验证码失败: {msg}", "error")
                self.send_json({"success": False, "message": msg}, 400)
            return

        # 提交短信验证码绑定
        if path.startswith("/api/accounts/") and path.endswith("/bind-sms"):
            parts = path.split("/")
            acc_id = parts[3]
            acc = config_manager.get_account(acc_id)
            if not acc:
                self.send_json({"error": "账号不存在"}, 404)
                return
            code = body.get("verificationCode", "").strip()
            if not code:
                self.send_json({"error": "验证码不能为空"}, 400)
                return
            client = CtYunClientApi(acc.get("deviceCode", ""))
            ok, msg = client.bind_device(code)
            if ok:
                config_manager.update_account(acc_id, {"bound": True})
                GLOBAL_LOGS.append("Auth", f"[{acc.get('name')}] 设备绑定成功！", "success")
                keeper.restart(1)
                self.send_json({"success": True, "message": msg})
            else:
                GLOBAL_LOGS.append("Auth", f"[{acc.get('name')}] 设备绑定失败: {msg}", "error")
                self.send_json({"success": False, "message": msg}, 400)
            return

        # 手动执行任务
        if path.startswith("/api/accounts/") and "/run/" in path:
            parts = path.split("/")
            acc_id = parts[3]
            task_type = parts[5]

            acc = config_manager.get_account(acc_id)
            if not acc:
                self.send_json({"error": "账号不存在"}, 404)
                return

            if task_type == "sign":
                scheduler.execute_sign(acc_id)
                self.send_json({"message": "已触发每日签到任务"})
            elif task_type == "aiChat":
                scheduler.execute_ai_chat(acc_id)
                self.send_json({"message": "已触发 AI 对话任务"})
            elif task_type == "hang":
                scheduler.execute_hang(acc_id)
                self.send_json({"message": "已启动挂机任务"})
            elif task_type == "redeem":
                scheduler.execute_redeem(acc_id)
                self.send_json({"message": "已触发自动兑换检查"})
            else:
                self.send_json({"error": f"未知任务: {task_type}"}, 400)
            return

        if path == "/api/keeper/restart":
            keeper.restart()
            self.send_json({"message": "已请求重启保活守护"})
            return

        self.send_json({"error": "Not Found"}, 404)

    def do_PUT(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path
        body = self.get_post_data()

        if path.startswith("/api/accounts/"):
            acc_id = path.split("/")[3]
            updated = config_manager.update_account(acc_id, body)
            if updated:
                GLOBAL_LOGS.append("System", f"已更新账号配置: {updated.get('name')}", "info")
                keeper.restart(1)
                self.send_json(updated)
            else:
                self.send_json({"error": "账号不存在"}, 404)
            return

        if path == "/api/settings":
            new_settings = config_manager.update_settings(body)
            GLOBAL_LOGS.append("System", "已更新系统全局设置", "info")
            keeper.restart(1)
            self.send_json(new_settings)
            return

        self.send_json({"error": "Not Found"}, 404)

    def do_DELETE(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path

        if path.startswith("/api/accounts/"):
            acc_id = path.split("/")[3]
            acc = config_manager.get_account(acc_id)
            name = acc.get("name") if acc else acc_id
            if config_manager.delete_account(acc_id):
                GLOBAL_LOGS.append("System", f"已删除账号: {name}", "warning")
                keeper.restart(1)
                self.send_json({"success": True})
            else:
                self.send_json({"error": "账号不存在"}, 404)
            return

        self.send_json({"error": "Not Found"}, 404)

    def serve_file(self, filepath: str, content_type: str):
        if not os.path.exists(filepath):
            self.send_json({"error": "File not found"}, 404)
            return
        try:
            with open(filepath, "rb") as f:
                content = f.read()
            self.send_response(200)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(content)))
            self.end_headers()
            self.wfile.write(content)
        except Exception as e:
            self.send_json({"error": str(e)}, 500)

    def handle_log_stream(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()

        import queue
        q = queue.Queue(maxsize=100)

        def log_listener(entry):
            try:
                q.put_nowait(entry)
            except Exception:
                pass

        GLOBAL_LOGS.subscribe(log_listener)

        try:
            # 先下发最近日志
            recent = GLOBAL_LOGS.get_recent(50)
            for item in recent:
                data_str = f"data: {json.dumps(item, ensure_ascii=False)}\n\n"
                self.wfile.write(data_str.encode("utf-8"))
            self.wfile.flush()

            while True:
                try:
                    entry = q.get(timeout=15)
                    data_str = f"data: {json.dumps(entry, ensure_ascii=False)}\n\n"
                    self.wfile.write(data_str.encode("utf-8"))
                    self.wfile.flush()
                except queue.Empty:
                    # 心跳 keep-alive
                    self.wfile.write(b": ping\n\n")
                    self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass
        finally:
            GLOBAL_LOGS.unsubscribe(log_listener)


def run_server(port: int = 8080):
    server_address = ("", port)
    httpd = ThreadingHTTPServer(server_address, AppRequestHandler)
    print(f"[*] 天翼云自动化控制面板启动成功: http://0.0.0.0:{port}")
    GLOBAL_LOGS.append("System", f"Web 控制台已就绪，端口: {port}", "success")
    
    # 启动保活守护与调度器
    keeper.start()
    scheduler.start()

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[*] 正在关闭服务...")
    finally:
        keeper.stop()
        scheduler.stop()
        httpd.server_close()


if __name__ == "__main__":
    port = int(os.getenv("PORT", 8080))
    run_server(port)
