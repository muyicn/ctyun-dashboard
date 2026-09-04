import os
import sys
import time
import json
import datetime
import threading
from typing import Dict, Any, Tuple, Optional, Callable
import requests
from ctyun_keeper import GLOBAL_LOGS
from ocr_solver import get_captcha_code

# 记录当前挂机任务状态
ACTIVE_HANG_TASKS: Dict[str, Dict[str, Any]] = {}


def fetch_task_progress(headers: Dict[str, str]) -> Tuple[int, int]:
    """获取使用1小时任务的当前进度与总目标"""
    try:
        url = "https://desk.ctyun.cn/selforder/api/marketing/userPoints/getTaskList"
        clean = {str(k): str(v) for k, v in headers.items() if not str(k).startswith(":")}
        resp = requests.get(url, headers=clean, timeout=10)
        if resp.status_code == 200:
            data = resp.json()
            for task in data.get("data", []):
                if "使用" in task.get("taskDefName", ""):
                    prog = task.get("currentProgress", 0)
                    total = task.get("targetProgress", 3600)
                    return prog, total
    except Exception:
        pass
    return 0, 3600


def run_hang_task_async(account: Dict[str, Any], data_dir: str, on_progress: Optional[Callable[[str, int, int], None]] = None) -> None:
    acc_id = account.get("id")
    if acc_id in ACTIVE_HANG_TASKS and ACTIVE_HANG_TASKS[acc_id].get("running"):
        GLOBAL_LOGS.append("Hang", f"[{account.get('name')}] 当前已有挂机任务在运行中", "warning")
        return

    thread = threading.Thread(target=_hang_worker, args=(account, data_dir, on_progress), daemon=True)
    thread.start()


def _hang_worker(account: Dict[str, Any], data_dir: str, on_progress: Optional[Callable[[str, int, int], None]]) -> None:
    acc_id = account.get("id")
    acc_name = account.get("name") or account.get("user")
    user = account.get("user")
    pwd = account.get("password")
    device_code = account.get("deviceCode", "")

    ACTIVE_HANG_TASKS[acc_id] = {
        "running": True,
        "startTime": time.strftime("%Y-%m-%d %H:%M:%S"),
        "progressSeconds": 0,
        "status": "starting"
    }

    GLOBAL_LOGS.append("Hang", f"[{acc_name}] 启动云电脑挂机任务...", "info")

    try:
        from DrissionPage import ChromiumOptions, ChromiumPage
    except ImportError:
        GLOBAL_LOGS.append("Hang", f"[{acc_name}] 未安装 DrissionPage，挂机任务需要浏览器环境（容器中可用）", "warning")
        ACTIVE_HANG_TASKS[acc_id]["running"] = False
        ACTIVE_HANG_TASKS[acc_id]["status"] = "failed"
        return

    options = ChromiumOptions()
    options.set_argument("--no-sandbox")
    options.set_argument("--disable-gpu")
    options.set_argument("--disable-dev-shm-usage")
    options.set_argument("--window-size=1920,1080")
    options.headless()

    auth_file = os.path.join(data_dir, f"ctyun_authData_{user}_.json")
    page = None

    try:
        page = ChromiumPage(addr_or_opts=options)
        login_url = "https://pc.ctyun.cn/#/login"
        desktop_url = "https://pc.ctyun.cn/#/desktop-list"

        page.get(login_url)
        # 写入 device_code 与本地 authData
        if device_code:
            page.run_js(f"localStorage.setItem('web_device_code', {json.dumps(device_code)});")
        if os.path.exists(auth_file):
            try:
                with open(auth_file, "r", encoding="utf-8") as f:
                    auth_data = json.load(f)
                expired_at = str(int((time.time() + 72 * 3600) * 1000))
                page.run_js(f"localStorage.setItem('authExpiredAt', {json.dumps(expired_at)});")
                page.run_js(f"localStorage.setItem('authData', {json.dumps(json.dumps(auth_data))});")
            except Exception:
                pass

        page.get(desktop_url)
        time.sleep(3)

        # 检查是否需要重新登录
        if "/login" in (page.url or ""):
            GLOBAL_LOGS.append("Hang", f"[{acc_name}] 凭证过期，进行账号密码登录...", "info")
            page.get(login_url)
            acc_input = page.ele('css:input[placeholder*="手机号"]', timeout=10) or page.ele('css:input[type="text"]')
            pwd_input = page.ele('css:input[placeholder*="密码"]') or page.ele('css:input[type="password"]')
            if acc_input and pwd_input:
                acc_input.clear()
                acc_input.input(user)
                pwd_input.clear()
                pwd_input.input(pwd)

                # 识别验证码
                cap_img = page.ele("css:img.code-img", timeout=2)
                cap_input = page.ele('css:input[placeholder*="请输入验证码"]')
                if cap_img and cap_input:
                    img_bytes = cap_img.get_screenshot(as_bytes=True)
                    code = get_captcha_code(img_bytes)
                    cap_input.clear()
                    cap_input.input(code)

                submit_btn = page.ele("css:button.btn-submit-pc", timeout=5)
                if submit_btn:
                    submit_btn.click()
                    time.sleep(3)
                    # 保存 authData
                    raw_auth = page.run_js("return localStorage.getItem('authData');")
                    if raw_auth:
                        try:
                            val = json.loads(raw_auth) if isinstance(raw_auth, str) else raw_auth
                            with open(auth_file, "w", encoding="utf-8") as f:
                                json.dump(val, f, ensure_ascii=False, indent=2)
                        except Exception:
                            pass

        # 进入云电脑页面
        page.get(desktop_url)
        time.sleep(3)
        enter_buttons = page.eles("css:div.desktopcom-enter")
        clicked_enter = False
        for btn in enter_buttons:
            if "进入AI云电脑" in (btn.text or ""):
                btn.click()
                clicked_enter = True
                break

        if clicked_enter or "/desktop?id=" in (page.url or ""):
            GLOBAL_LOGS.append("Hang", f"[{acc_name}] 成功进入云电脑，开始挂机监听...", "success")
            ACTIVE_HANG_TASKS[acc_id]["status"] = "hanging"
        else:
            GLOBAL_LOGS.append("Hang", f"[{acc_name}] 未检测到云电脑进入按钮或账号名下无可用电脑", "warning")
            ACTIVE_HANG_TASKS[acc_id]["running"] = False
            ACTIVE_HANG_TASKS[acc_id]["status"] = "no_desktop"
            return

        # 挂机进度监听
        task_url = "https://desk.ctyun.cn/selforder/api/marketing/userPoints/getTaskList"
        page.listen.start(task_url)

        # 轮询挂机时长（默认最长挂 70 分钟）
        hang_seconds = 0
        max_hang = 70 * 60

        while hang_seconds < max_hang and ACTIVE_HANG_TASKS[acc_id].get("running"):
            packet = page.listen.wait(timeout=15)
            headers = packet.request.headers if packet else {}

            prog, total = fetch_task_progress(headers) if headers else (hang_seconds, 3600)
            if prog > 0:
                hang_seconds = prog

            ACTIVE_HANG_TASKS[acc_id]["progressSeconds"] = hang_seconds
            ACTIVE_HANG_TASKS[acc_id]["status"] = f"挂机中（已挂机 {hang_seconds // 60} 分钟 / 60 分钟）"

            if on_progress:
                on_progress(acc_id, hang_seconds, total)

            if hang_seconds >= 3600:
                GLOBAL_LOGS.append("Hang", f"[{acc_name}] 恭喜！今日云电脑1小时挂机任务圆满完成！", "success")
                ACTIVE_HANG_TASKS[acc_id]["status"] = "completed"
                break

            time.sleep(30)
            hang_seconds += 30

    except Exception as e:
        GLOBAL_LOGS.append("Hang", f"[{acc_name}] 挂机异常: {e}", "error")
        ACTIVE_HANG_TASKS[acc_id]["status"] = f"异常: {e}"
    finally:
        ACTIVE_HANG_TASKS[acc_id]["running"] = False
        if page:
            try:
                page.quit()
            except Exception:
                pass
