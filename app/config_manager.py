import os
import json
import uuid
import random
import string
import datetime
from pathlib import Path
from typing import Dict, List, Any, Optional

DATA_DIR = os.getenv("CTYUN_DATA_DIR", "/app/data" if os.path.exists("/app/data") or os.getenv("RUNNING_IN_DOCKER") == "true" else os.path.join(os.path.dirname(os.path.dirname(__file__)), "data"))
CONFIG_FILE = os.path.join(DATA_DIR, "app_config.json")
ACCOUNTS_JSON = os.path.join(DATA_DIR, "accounts.json")
DEVICES_DIR = os.path.join(DATA_DIR, "devices")


def generate_device_code() -> str:
    chars = string.ascii_letters + string.digits
    rand_str = "".join(random.choice(chars) for _ in range(32))
    return f"web_{rand_str}"


def get_default_config() -> Dict[str, Any]:
    return {
        "version": "1.0.0",
        "settings": {
            "webPort": 8080,
            "webPassword": "",
            "keepAliveSeconds": 60,
            "cron": {
                "signCron": "0 2 * * *",
                "aiChatCron": "0 3,20 * * *",
                "cloudHangCron": "0 4,6 * * *",
                "redeemCron": "0 7 * * *"
            },
            "notify": {
                "enabled": False,
                "channel": "webhook",
                "barkUrl": "",
                "serverChanKey": "",
                "pushPlusToken": "",
                "tgBotToken": "",
                "tgChatId": "",
                "webhookUrl": ""
            }
        },
        "accounts": []
    }


class ConfigManager:
    def __init__(self, data_dir: str = DATA_DIR):
        self.data_dir = data_dir
        self.config_file = os.path.join(data_dir, "app_config.json")
        self.accounts_json = os.path.join(data_dir, "accounts.json")
        self.devices_dir = os.path.join(data_dir, "devices")
        
        Path(self.data_dir).mkdir(parents=True, exist_ok=True)
        Path(self.devices_dir).mkdir(parents=True, exist_ok=True)
        
        self.config = self.load_config()
        self.sync_ctyun_accounts()

    def load_config(self) -> Dict[str, Any]:
        if os.path.exists(self.config_file):
            try:
                with open(self.config_file, "r", encoding="utf-8") as f:
                    data = json.load(f)
                    default_cfg = get_default_config()
                    # 补齐默认字段
                    if "settings" not in data:
                        data["settings"] = default_cfg["settings"]
                    else:
                        for k, v in default_cfg["settings"].items():
                            if k not in data["settings"]:
                                data["settings"][k] = v
                    if "accounts" not in data:
                        data["accounts"] = []
                    return data
            except Exception as e:
                print(f"[!] 读取主配置失败: {e}，将使用默认配置")

        # 检查是否已有旧的 accounts.json 或环境变量并导入
        initial_config = get_default_config()
        env_user = os.getenv("APP_USER")
        env_pwd = os.getenv("APP_PASSWORD")
        if env_user and env_pwd:
            account = self._create_account_object(
                name=os.getenv("APP_NAME", env_user),
                user=env_user,
                password=env_pwd,
                device_code=os.getenv("DEVICECODE")
            )
            initial_config["accounts"].append(account)
        elif os.path.exists(self.accounts_json):
            try:
                with open(self.accounts_json, "r", encoding="utf-8") as f:
                    old_accs = json.load(f)
                    for acc in old_accs.get("accounts", []):
                        new_acc = self._create_account_object(
                            name=acc.get("name", acc.get("user", "")),
                            user=acc.get("user", ""),
                            password=acc.get("password", ""),
                            device_code=acc.get("deviceCode")
                        )
                        initial_config["accounts"].append(new_acc)
            except Exception as e:
                print(f"[-] 导入旧 accounts.json 失败: {e}")

        self.save_config(initial_config)
        return initial_config

    def _create_account_object(
        self,
        name: str,
        user: str,
        password: str,
        device_code: Optional[str] = None
    ) -> Dict[str, Any]:
        acc_id = str(uuid.uuid4())[:8]
        user_clean = user.strip()
        name_clean = (name or user_clean).strip()
        
        # 寻找或生成设备码
        final_device_code = (device_code or "").strip()
        if not final_device_code:
            dev_file = os.path.join(self.devices_dir, f"{name_clean}.txt")
            if os.path.exists(dev_file):
                with open(dev_file, "r", encoding="utf-8") as df:
                    final_device_code = df.read().strip()
            if not final_device_code:
                final_device_code = generate_device_code()
                with open(dev_file, "w", encoding="utf-8") as df:
                    df.write(final_device_code)

        return {
            "id": acc_id,
            "name": name_clean,
            "user": user_clean,
            "password": password,
            "deviceCode": final_device_code,
            "enabled": True,
            "bound": True,  # 默认视为已绑定或由系统自动检测
            "features": {
                "keepAlive": True,
                "autoSign": True,
                "aiChat": True,
                "cloudHang": True,
                "autoRedeem": False
            },
            "redeemConfig": {
                "enabled": False,
                "targetType": "redeem",
                "desktopId": "",
                "desktopName": "",
                "prodId": 0,
                "prodName": "升级 8C16G 电脑 (300积分)",
                "prodType": "POINTS_REDEEM",
                "costPoints": 300,
                "maxRedeemTimes": 0,
                "scheduleType": "monthly_days",
                "intervalDays": 1,
                "monthlyDays": [-1],
                "lastRedeemDate": ""
            },
            "stats": {
                "lastSignTime": "",
                "lastAiChatTime": "",
                "lastHangTime": "",
                "hangMinutesToday": 0,
                "points": 0,
                "keepAliveStatus": "offline",
                "lastError": ""
            }
        }

    def save_config(self, config: Optional[Dict[str, Any]] = None) -> bool:
        if config is not None:
            self.config = config
        try:
            with open(self.config_file, "w", encoding="utf-8") as f:
                json.dump(self.config, f, ensure_ascii=False, indent=2)
            self.sync_ctyun_accounts()
            return True
        except Exception as e:
            print(f"[!] 保存配置失败: {e}")
            return False

    def sync_ctyun_accounts(self) -> None:
        """同步生成 CtYun.dll 专用的 accounts.json"""
        try:
            active_accounts = []
            for acc in self.config.get("accounts", []):
                if acc.get("enabled", True) and acc.get("features", {}).get("keepAlive", True):
                    active_accounts.append({
                        "name": acc.get("name") or acc.get("user"),
                        "user": acc.get("user"),
                        "password": acc.get("password"),
                        "deviceCode": acc.get("deviceCode")
                    })
            
            ctyun_data = {
                "keepAliveSeconds": self.config.get("settings", {}).get("keepAliveSeconds", 60),
                "accounts": active_accounts
            }
            with open(self.accounts_json, "w", encoding="utf-8") as f:
                json.dump(ctyun_data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"[!] 同步 accounts.json 失败: {e}")

    def get_accounts(self) -> List[Dict[str, Any]]:
        return self.config.get("accounts", [])

    def get_account(self, account_id: str) -> Optional[Dict[str, Any]]:
        for acc in self.config.get("accounts", []):
            if acc.get("id") == account_id:
                return acc
        return None

    def add_account(self, data: Dict[str, Any]) -> Dict[str, Any]:
        user = data.get("user", "").strip()
        password = data.get("password", "").strip()
        name = (data.get("name") or user).strip()
        device_code = (data.get("deviceCode") or "").strip() or generate_device_code()

        account = self._create_account_object(
            name=name,
            user=user,
            password=password,
            device_code=device_code
        )
        
        # 允许外部传入初始自定义 features 与 redeemConfig
        if "features" in data and isinstance(data["features"], dict):
            account["features"].update(data["features"])
        if "redeemConfig" in data and isinstance(data["redeemConfig"], dict):
            account["redeemConfig"].update(data["redeemConfig"])
        if "enabled" in data:
            account["enabled"] = bool(data["enabled"])

        self.config["accounts"].append(account)
        self.save_config()
        return account

    def update_account(self, account_id: str, data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
        account = self.get_account(account_id)
        if not account:
            return None

        for field in ["name", "user", "password", "deviceCode", "enabled", "bound"]:
            if field in data:
                account[field] = data[field]

        if "features" in data and isinstance(data["features"], dict):
            account["features"].update(data["features"])

        if "redeemConfig" in data and isinstance(data["redeemConfig"], dict):
            account["redeemConfig"].update(data["redeemConfig"])

        if "stats" in data and isinstance(data["stats"], dict):
            account["stats"].update(data["stats"])

        # 若 deviceCode 更改，同步更新本地 devices 文件
        if "deviceCode" in data and account.get("name"):
            dev_file = os.path.join(self.devices_dir, f"{account['name']}.txt")
            try:
                with open(dev_file, "w", encoding="utf-8") as df:
                    df.write(account["deviceCode"])
            except Exception:
                pass

        self.save_config()
        return account

    def delete_account(self, account_id: str) -> bool:
        original_len = len(self.config["accounts"])
        self.config["accounts"] = [
            a for a in self.config["accounts"] if a.get("id") != account_id
        ]
        if len(self.config["accounts"]) < original_len:
            self.save_config()
            return True
        return False

    def update_settings(self, settings_data: Dict[str, Any]) -> Dict[str, Any]:
        if "settings" not in self.config:
            self.config["settings"] = get_default_config()["settings"]
        self.config["settings"].update(settings_data)
        self.save_config()
        return self.config["settings"]
