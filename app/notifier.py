import requests
from typing import Dict, Any

class Notifier:
    @staticmethod
    def send(settings: Dict[str, Any], title: str, content: str) -> bool:
        notify_cfg = settings.get("notify", {})
        if not notify_cfg.get("enabled"):
            return False

        channel = notify_cfg.get("channel", "webhook")

        try:
            if channel == "bark":
                url = notify_cfg.get("barkUrl", "").rstrip("/")
                if url:
                    requests.get(f"{url}/{title}/{content}", timeout=10)
                    return True

            elif channel == "serverchan":
                key = notify_cfg.get("serverChanKey", "")
                if key:
                    url = f"https://sctapi.ftqq.com/{key}.send"
                    requests.post(url, data={"title": title, "desp": content}, timeout=10)
                    return True

            elif channel == "pushplus":
                token = notify_cfg.get("pushPlusToken", "")
                if token:
                    url = "http://www.pushplus.plus/send"
                    requests.post(url, json={"token": token, "title": title, "content": content}, timeout=10)
                    return True

            elif channel == "telegram":
                bot_token = notify_cfg.get("tgBotToken", "")
                chat_id = notify_cfg.get("tgChatId", "")
                if bot_token and chat_id:
                    url = f"https://api.telegram.org/bot{bot_token}/sendMessage"
                    requests.post(url, json={"chat_id": chat_id, "text": f"*{title}*\n\n{content}", "parse_mode": "Markdown"}, timeout=10)
                    return True

            elif channel == "webhook":
                webhook_url = notify_cfg.get("webhookUrl", "")
                if webhook_url:
                    requests.post(webhook_url, json={"title": title, "content": content}, timeout=10)
                    return True

        except Exception as e:
            print(f"[!] 通知推送失败: {e}")
            return False

        return False
