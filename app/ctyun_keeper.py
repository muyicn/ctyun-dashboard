import os
import sys
import time
import signal
import subprocess
import threading
from typing import Optional, Callable, List
from collections import deque

class LogBuffer:
    def __init__(self, max_lines: int = 2000):
        self.buffer = deque(maxlen=max_lines)
        self.lock = threading.Lock()
        self.subscribers: List[Callable[[dict], None]] = []

    def append(self, source: str, message: str, level: str = "info") -> dict:
        entry = {
            "timestamp": time.strftime("%Y-%m-%d %H:%M:%S"),
            "source": source,
            "message": message.rstrip(),
            "level": level
        }
        with self.lock:
            self.buffer.append(entry)
            subs = list(self.subscribers)
        
        for callback in subs:
            try:
                callback(entry)
            except Exception:
                pass
        return entry

    def get_recent(self, count: int = 200) -> List[dict]:
        with self.lock:
            items = list(self.buffer)
            return items[-count:] if len(items) > count else items

    def subscribe(self, callback: Callable[[dict], None]) -> None:
        with self.lock:
            self.subscribers.append(callback)

    def unsubscribe(self, callback: Callable[[dict], None]) -> None:
        with self.lock:
            if callback in self.subscribers:
                self.subscribers.remove(callback)


# 全局日志缓冲区
GLOBAL_LOGS = LogBuffer(max_lines=3000)


class CtYunKeeper:
    def __init__(self, data_dir: str, on_status_update: Optional[Callable[[str, str], None]] = None):
        self.data_dir = data_dir
        self.process: Optional[subprocess.Popen] = None
        self.running = False
        self.thread: Optional[threading.Thread] = None
        self.on_status_update = on_status_update
        self.lock = threading.Lock()

    def find_executable(self) -> Optional[List[str]]:
        """寻找 CtYun 可执行文件或 dll"""
        # 1. Docker / Linux 容器内标准路径
        if os.path.exists("/app/CtYun.dll"):
            return ["dotnet", "/app/CtYun.dll"]
        if os.path.exists("./CtYun.dll"):
            return ["dotnet", "./CtYun.dll"]
        if os.path.exists("/app/CtYun"):
            return ["/app/CtYun"]
        # 2. 本地开发路径（例如 Windows 下查找 CtYun.exe 或 CtYun.dll）
        dev_dll = os.path.join(os.path.dirname(os.path.dirname(self.data_dir)), "CtYun", "CtYun", "bin", "Debug", "net8.0", "CtYun.dll")
        if os.path.exists(dev_dll):
            return ["dotnet", dev_dll]
        return None

    def start(self) -> bool:
        with self.lock:
            if self.running:
                return True
            self.running = True
            self.thread = threading.Thread(target=self._run_loop, daemon=True)
            self.thread.start()
            return True

    def stop(self) -> None:
        with self.lock:
            self.running = False
            if self.process and self.process.poll() is None:
                try:
                    self.process.terminate()
                    self.process.wait(timeout=3)
                except Exception:
                    try:
                        self.process.kill()
                    except Exception:
                        pass

    def restart(self, delay_seconds: int = 0) -> None:
        def _do_restart():
            if delay_seconds > 0:
                GLOBAL_LOGS.append("Keeper", f"保活程序将在 {delay_seconds} 秒后重启...", "warning")
                time.sleep(delay_seconds)
            GLOBAL_LOGS.append("Keeper", "正在重启 CtYun 保活守护...", "info")
            if self.process and self.process.poll() is None:
                try:
                    self.process.terminate()
                    self.process.wait(timeout=3)
                except Exception:
                    try:
                        self.process.kill()
                    except Exception:
                        pass
        
        threading.Thread(target=_do_restart, daemon=True).start()

    def _run_loop(self) -> None:
        cmd = self.find_executable()
        if not cmd:
            GLOBAL_LOGS.append("Keeper", "提示：未找到 CtYun.dll / 可执行文件，保活进程处于休眠监控模式（Docker容器启动后将自动挂载启动）", "warning")

        while self.running:
            if not cmd:
                time.sleep(5)
                cmd = self.find_executable()
                continue

            # 启动子进程
            GLOBAL_LOGS.append("Keeper", f"启动保活核心: {' '.join(cmd)}", "info")
            try:
                env = os.environ.copy()
                env["CTYUN_DATA_DIR"] = self.data_dir
                env["DOTNET_SYSTEM_GLOBALIZATION_INVARIANT"] = "1"

                self.process = subprocess.Popen(
                    cmd,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.STDOUT,
                    text=True,
                    bufsize=1,
                    env=env
                )

                # 读取子进程输出
                if self.process.stdout:
                    for raw_line in iter(self.process.stdout.readline, ""):
                        if not raw_line:
                            break
                        line = raw_line.strip()
                        if not line:
                            continue

                        level = "info"
                        if "Error" in line or "失败" in line or "错误" in line:
                            level = "error"
                        elif "保活校验" in line or "保活响应成功" in line or "连接已就绪" in line:
                            level = "success"
                        elif "未开机" in line or "警告" in line or "重试" in line:
                            level = "warning"

                        GLOBAL_LOGS.append("CtYun", line, level)

                        # 解析账号保活状态
                        # 示例：[account-a][desktop-code] -> 发送保活响应成功
                        if self.on_status_update and "[" in line and "]" in line:
                            try:
                                acc_part = line.split("[")[1].split("]")[0]
                                if "保活响应成功" in line or "连接已就绪" in line:
                                    self.on_status_update(acc_part, "online")
                                elif "未获取到云电脑" in line or "失败" in line or "Error" in line:
                                    self.on_status_update(acc_part, "error")
                            except Exception:
                                pass

                self.process.wait()
                exit_code = self.process.returncode
                GLOBAL_LOGS.append("Keeper", f"保活子进程已退出，代码: {exit_code}", "warning")

            except Exception as e:
                GLOBAL_LOGS.append("Keeper", f"保活子进程异常: {e}", "error")

            if self.running:
                # 异常或正常退出后，等待一段时间再拉起
                time.sleep(10)
