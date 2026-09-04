import os
import sys
import time
import json
import random
import datetime
from typing import Dict, Any, Tuple
from ctyun_keeper import GLOBAL_LOGS
from ocr_solver import get_captcha_code

PRESET_MESSAGES = [
    "今天北京天气怎么样？（简短回答）",
    "给我讲一个冷笑话。（简短回答）",
    "来一首古诗。（简短回答）",
    "空腹可以吃饭吗？（简短回答）",
    "推荐一部人生必看电影。（简短回答）",
    "人工智能的发展趋势是什么？（简短回答）"
]


def run_ai_chat_for_account(account: Dict[str, Any], data_dir: str) -> Tuple[bool, str]:
    acc_name = account.get("name") or account.get("user")
    user = account.get("user")
    pwd = account.get("password")

    GLOBAL_LOGS.append("AIChat", f"[{acc_name}] 准备执行天翼 AI 对话积分任务...", "info")

    if not user or not pwd:
        GLOBAL_LOGS.append("AIChat", f"[{acc_name}] 缺少账号或密码，跳过", "error")
        return False, "缺少账号或密码"

    # 检查是否有 DrissionPage
    try:
        from DrissionPage import ChromiumOptions, ChromiumPage
    except ImportError:
        msg = "未安装 DrissionPage，无法使用浏览器执行 AI 对话（在 Docker 容器中将自动具备完整浏览器环境）"
        GLOBAL_LOGS.append("AIChat", f"[{acc_name}] {msg}", "warning")
        return False, msg

    cookie_file = os.path.join(data_dir, f"ctyun_cookies_{user}_.json")
    chat_url = "https://eaichat.ctyun.cn/chat/#/aichat"
    login_url = (
        "https://desk.ctyun.cn/cloudB/dy/iam/api/auth/iam/cas/login?"
        "service=https%3A%2F%2Feaichat.ctyun.cn%3A443%2Fchat%2F%23%2Faichat&consent=false"
    )

    options = ChromiumOptions()
    options.set_argument("--no-sandbox")
    options.set_argument("--disable-gpu")
    options.set_argument("--disable-dev-shm-usage")
    options.headless()

    page = None
    try:
        page = ChromiumPage(addr_or_opts=options)
        
        # 1. 尝试使用已保存的 Cookie
        is_logged_in = False
        if os.path.exists(cookie_file):
            try:
                page.get(chat_url)
                with open(cookie_file, "r", encoding="utf-8") as f:
                    cookies = json.load(f)
                page.set.cookies(cookies)
                page.get(chat_url)
                if page.wait.ele_displayed("css:div.input-box.input-wrap", timeout=5):
                    GLOBAL_LOGS.append("AIChat", f"[{acc_name}] 使用缓存凭证免密登录成功", "success")
                    is_logged_in = True
            except Exception as e:
                GLOBAL_LOGS.append("AIChat", f"[{acc_name}] 缓存凭证失效: {e}，将重新登录", "info")

        # 2. 账密登录
        if not is_logged_in:
            GLOBAL_LOGS.append("AIChat", f"[{acc_name}] 开始账密登录: {login_url}", "info")
            page.get(login_url)
            page.wait.load_start()

            # 输入账号密码
            acc_input = page.ele('css:input[type="text"]')
            if not acc_input:
                raise RuntimeError("未找到账号输入框")
            acc_input.clear()
            acc_input.input(user)

            pwd_input = page.ele('css:input[type="password"]')
            pwd_input.clear()
            pwd_input.input(pwd)

            # 验证码识别
            captcha_container = page.ele("css:.fgt-capt-ct", timeout=2)
            if captcha_container:
                pic_ele = captcha_container.ele("css:img")
                if pic_ele:
                    img_bytes = pic_ele.get_screenshot(as_bytes=True)
                    ocr_code = get_captcha_code(img_bytes)
                    GLOBAL_LOGS.append("AIChat", f"[{acc_name}] 识别图形验证码: {ocr_code}", "info")
                    cap_input = captcha_container.ele('css:input[placeholder="输入图形验证码"]')
                    cap_input.clear()
                    cap_input.input(ocr_code)

            if not page.wait.ele_displayed("css:button.lgm-submit-ct", timeout=5):
                raise RuntimeError("未找到登录提交按钮")

            login_btn = page.ele("css:button.lgm-submit-ct")
            page.listen.start("api/auth/iam/login")
            login_btn.click()

            packet = page.listen.wait(timeout=5)
            page.listen.stop()
            time.sleep(3)

            # 保存 Cookie
            try:
                cookies = page.cookies()
                has_yl = any(c.get("name") == "YL-Token" for c in cookies) if isinstance(cookies, list) else ("YL-Token" in cookies)
                if has_yl:
                    with open(cookie_file, "w", encoding="utf-8") as f:
                        json.dump(cookies, f, ensure_ascii=False, indent=2)
                    GLOBAL_LOGS.append("AIChat", f"[{acc_name}] 新凭证已保存", "info")
            except Exception:
                pass

        # 3. 发送消息
        if page.url != chat_url:
            page.get(chat_url)

        input_box = page.ele("css:div.input-box.input-wrap", timeout=10)
        if not input_box:
            raise RuntimeError("未找到 AI 对话输入框")

        question = random.choice(PRESET_MESSAGES)
        GLOBAL_LOGS.append("AIChat", f"[{acc_name}] 发送对话: {question}", "info")
        input_box.input(question)
        time.sleep(3)

        send_btn = page.ele("css:div.send-button", timeout=5)
        if not send_btn:
            raise RuntimeError("未找到发送按钮")
        send_btn.click()

        GLOBAL_LOGS.append("AIChat", f"[{acc_name}] 消息已发送，等待 AI 响应...", "info")
        time.sleep(5)

        reply_eles = page.eles("css:div.markdown-content")
        if reply_eles:
            latest = reply_eles[-1]
            ans = latest.text or ""
            GLOBAL_LOGS.append("AIChat", f"[{acc_name}] 收到 AI 回复: {ans[:60]}...", "success")
            return True, f"AI 对话成功: {ans[:30]}"
        else:
            return True, "消息已成功发送（任务完成）"

    except Exception as e:
        GLOBAL_LOGS.append("AIChat", f"[{acc_name}] AI 对话任务失败: {e}", "error")
        return False, f"异常: {e}"
    finally:
        if page:
            try:
                page.quit()
            except Exception:
                pass
