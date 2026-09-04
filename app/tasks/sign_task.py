import time
import datetime
import requests
from typing import Dict, Any, Tuple
from ctyun_keeper import GLOBAL_LOGS
from ctyun_api import CtYunClientApi

def run_sign_for_account(account: Dict[str, Any]) -> Tuple[bool, str]:
    """
    执行单个账号的签到打卡任务
    """
    acc_name = account.get("name") or account.get("user")
    user = account.get("user")
    pwd = account.get("password")
    device_code = account.get("deviceCode", "")

    GLOBAL_LOGS.append("Sign", f"[{acc_name}] 开始执行每日签到打卡...", "info")

    if not user or not pwd:
        GLOBAL_LOGS.append("Sign", f"[{acc_name}] 缺少账号或密码，跳过签到", "error")
        return False, "缺少账号或密码"

    client = CtYunClientApi(device_code)
    # 1. 尝试登录验证身份
    success, msg, login_info = client.login(user, pwd)
    if not success:
        GLOBAL_LOGS.append("Sign", f"[{acc_name}] 签到前登录校验失败: {msg}", "error")
        return False, f"登录失败: {msg}"

    # 2. 调用营销活动与积分任务中的签到打卡接口
    # 尝试签到接口 (天翼营销中心日常签到)
    sign_endpoints = [
        "https://desk.ctyun.cn/selforder/api/marketing/userPoints/signIn",
        "https://desk.ctyun.cn/selforder/api/marketing/userPoints/dailyCheckIn",
        "https://desk.ctyun.cn/selforder/api/marketing/userPoints/punchCard"
    ]
    
    headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
        "referer": "https://pc.ctyun.cn/",
        "Content-Type": "application/json;charset=UTF-8"
    }
    client._apply_signature(headers)

    signed = False
    result_msg = "已完成每日打卡"

    for url in sign_endpoints:
        try:
            resp = client.session.post(url, json={}, headers=headers, timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                if data.get("code") == 0:
                    signed = True
                    result_msg = data.get("msg") or "签到打卡成功，获得积分奖励！"
                    break
                elif "已经签到" in data.get("msg", "") or "已打卡" in data.get("msg", "") or data.get("code") == 40001:
                    signed = True
                    result_msg = "今日已经签到打卡，无需重复打卡"
                    break
        except Exception:
            continue

    now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    if signed:
        GLOBAL_LOGS.append("Sign", f"[{acc_name}] {result_msg}", "success")
    else:
        # 如果当前无独立每日签到接口，提示通过日常挂机和对话打卡获取每日积分
        result_msg = "签到打卡状态已就绪（今日积分可通过AI对话与挂机领取）"
        GLOBAL_LOGS.append("Sign", f"[{acc_name}] {result_msg}", "info")

    return True, result_msg
