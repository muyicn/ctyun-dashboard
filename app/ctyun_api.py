import hashlib
import json
import time
import requests
from typing import Optional, Dict, Any, List, Tuple
from ocr_solver import get_captcha_code

DEVICE_TYPE = "60"
CLIENT_VERSION = "103020001"
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
BASE_URL = "https://desk.ctyun.cn:8810"


def md5(text: str) -> str:
    return hashlib.md5(text.encode("utf-8")).hexdigest().lower()


def sha256(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest().lower()


class CtYunClientApi:
    def __init__(self, device_code: str):
        self.device_code = device_code
        self.session = requests.Session()
        self.session.headers.update({
            "User-Agent": USER_AGENT,
            "ctg-devicetype": DEVICE_TYPE,
            "ctg-version": CLIENT_VERSION,
            "ctg-devicecode": self.device_code,
            "referer": "https://pc.ctyun.cn/"
        })
        self.login_info: Optional[Dict[str, Any]] = None

    def _apply_signature(self, headers: Dict[str, str]) -> Dict[str, str]:
        if self.login_info:
            now_ts = str(int(time.time() * 1000))
            user_id = str(self.login_info.get("userId", ""))
            tenant_id = str(self.login_info.get("tenantId", ""))
            secret_key = str(self.login_info.get("secretKey", ""))

            headers["ctg-userid"] = user_id
            headers["ctg-tenantid"] = tenant_id
            headers["ctg-timestamp"] = now_ts
            headers["ctg-requestid"] = now_ts

            raw_str = f"{DEVICE_TYPE}{now_ts}{tenant_id}{now_ts}{user_id}{CLIENT_VERSION}{secret_key}"
            headers["ctg-signaturestr"] = md5(raw_str)
        return headers

    def _add_common_payload(self, data: Dict[str, Any]) -> Dict[str, Any]:
        data.update({
            "deviceCode": self.device_code,
            "deviceName": "Chrome浏览器",
            "deviceType": DEVICE_TYPE,
            "deviceModel": "Windows NT 10.0; Win64; x64",
            "appVersion": "3.2.0",
            "sysVersion": "Windows NT 10.0; Win64; x64",
            "clientVersion": CLIENT_VERSION
        })
        return data

    def get_challenge_data(self) -> Optional[Dict[str, Any]]:
        try:
            url = f"{BASE_URL}/api/auth/client/genChallengeData"
            resp = self.session.post(url, json={}, timeout=10)
            data = resp.json()
            if data.get("code") == 0 and "data" in data:
                return data["data"]
            return None
        except Exception as e:
            print(f"[!] get_challenge_data error: {e}")
            return None

    def get_login_captcha(self, userphone: str) -> Optional[bytes]:
        try:
            ts = int(time.time() * 1000)
            url = f"{BASE_URL}/api/auth/client/captcha?height=36&width=85&userInfo={userphone}&mode=auto&_t={ts}"
            resp = self.session.get(url, timeout=10)
            if resp.status_code == 200:
                return resp.content
            return None
        except Exception as e:
            print(f"[!] get_login_captcha error: {e}")
            return None

    def login(self, username: str, password: str) -> Tuple[bool, str, Optional[Dict[str, Any]]]:
        for attempt in range(1, 4):
            challenge = self.get_challenge_data()
            if not challenge:
                time.sleep(1)
                continue

            challenge_code = challenge.get("challengeCode", "")
            challenge_id = challenge.get("challengeId", "")

            img_bytes = self.get_login_captcha(username)
            if not img_bytes:
                time.sleep(1)
                continue

            captcha_code = get_captcha_code(img_bytes)
            if not captcha_code:
                time.sleep(1)
                continue

            payload = {
                "userAccount": username,
                "password": sha256(password + challenge_code),
                "sha256Password": sha256(sha256(password) + challenge_code),
                "challengeId": challenge_id,
                "captchaCode": captcha_code
            }
            self._add_common_payload(payload)

            try:
                url = f"{BASE_URL}/api/auth/client/login"
                resp = self.session.post(url, data=payload, timeout=15)
                res = resp.json()

                if res.get("code") == 0 and "data" in res:
                    self.login_info = res["data"]
                    bond = bool(res["data"].get("bondedDevice", False))
                    return True, "登录成功" if bond else "需要短信验证码绑定设备", res["data"]

                msg = res.get("msg", "未知错误")
                if "用户名或密码错误" in msg:
                    return False, "用户名或密码错误", None

                print(f"[-] 登录重试 {attempt}/3: {msg}")
            except Exception as e:
                print(f"[!] 登录异常: {e}")

            time.sleep(1)

        return False, "登录重试多次均失败，请检查账号密码或图形验证码", None

    def get_sms_code(self, username: str) -> Tuple[bool, str]:
        """请求发送短信验证码"""
        for _ in range(3):
            try:
                ts = int(time.time() * 1000)
                cap_url = f"{BASE_URL}/api/auth/client/validateCode/captcha?width=120&height=40&_t={ts}"
                headers = self._apply_signature({})
                resp = self.session.get(cap_url, headers=headers, timeout=10)
                if resp.status_code != 200:
                    continue

                captcha = get_captcha_code(resp.content)
                if not captcha:
                    continue

                sms_url = f"{BASE_URL}/api/cdserv/client/device/getSmsCode?mobilePhone={username}&captchaCode={captcha}"
                headers = self._apply_signature({})
                res = self.session.get(sms_url, headers=headers, timeout=10).json()

                if res.get("code") == 0:
                    return True, "短信验证码发送成功"
                msg = res.get("msg", "未知异常")
                print(f"[-] 发送验证码失败: {msg}")
            except Exception as e:
                print(f"[!] get_sms_code error: {e}")

        return False, "短信验证码发送失败，请稍后重试"

    def bind_device(self, verification_code: str) -> Tuple[bool, str]:
        """提交短信验证码绑定新设备"""
        try:
            url = (
                f"{BASE_URL}/api/cdserv/client/device/binding"
                f"?verificationCode={verification_code.strip()}"
                f"&deviceName=Chrome%E6%B5%8F%E8%A7%88%E5%99%A8"
                f"&deviceCode={self.device_code}"
                f"&deviceModel=Windows+NT+10.0%3B+Win64%3B+x64"
                f"&sysVersion=Windows+NT+10.0%3B+Win64%3B+x64"
                f"&appVersion=3.2.0&hostName=pc.ctyun.cn&deviceInfo=Win32"
            )
            headers = self._apply_signature({})
            resp = self.session.post(url, headers=headers, timeout=15)
            res = resp.json()
            if res.get("code") == 0:
                if self.login_info:
                    self.login_info["bondedDevice"] = True
                return True, "设备绑定成功！"
            return False, f"绑定失败: {res.get('msg', '未知原因')}"
        except Exception as e:
            return False, f"绑定请求异常: {e}"

    def get_desktop_list(self) -> List[Dict[str, Any]]:
        """获取名下所有云电脑列表"""
        try:
            url = f"{BASE_URL}/api/desktop/client/pageDesktop"
            headers = self._apply_signature({"Content-Type": "application/json; charset=UTF-8"})
            payload = {
                "getCnt": 20,
                "desktopTypes": ["1", "2001", "2002", "2003"],
                "sortType": "createTimeV1"
            }
            resp = self.session.post(url, json=payload, headers=headers, timeout=15)
            res = resp.json()
            if res.get("code") == 0 and "data" in res:
                return res["data"].get("desktopList", [])
            return []
        except Exception as e:
            print(f"[!] get_desktop_list error: {e}")
            return []
