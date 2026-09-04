import base64
import threading
from typing import Optional
import requests

class OcrSolver:
    _instance: Optional["OcrSolver"] = None
    _lock = threading.Lock()

    def __new__(cls) -> "OcrSolver":
        with cls._lock:
            if cls._instance is None:
                cls._instance = super().__new__(cls)
                cls._instance._init_engine()
        return cls._instance

    def _init_engine(self) -> None:
        self.ocr = None
        try:
            import ddddocr
            self.ocr = ddddocr.DdddOcr(show_ad=False)
            self.ocr.set_ranges(0)
            print("[*] 本地 ddddocr 引擎初始化成功")
        except Exception as e:
            print(f"[!] 本地 ddddocr 初始化失败或未安装: {e}，将使用在线 OCR 降级通道")

    def solve(self, image_bytes: bytes) -> str:
        if not image_bytes:
            return ""

        # 1. 优先本地 ddddocr
        if self.ocr is not None:
            try:
                res = self.ocr.classification(image_bytes)
                if res and isinstance(res, str) and res.strip():
                    return res.strip()
            except Exception as e:
                print(f"[-] 本地 ddddocr 识别异常: {e}，尝试在线 OCR")

        # 2. 在线备用 OCR (来自 CtYunApi 官方备用接口)
        try:
            b64 = base64.b64encode(image_bytes).decode("utf-8")
            url = "https://orc.1999111.xyz/ocr"
            resp = requests.post(url, files={"image": (None, b64)}, timeout=10)
            if resp.status_code == 200:
                data = resp.json()
                if "data" in data and data["data"]:
                    return str(data["data"]).strip()
        except Exception as e:
            print(f"[-] 在线备用 OCR 识别失败: {e}")

        return ""


def get_captcha_code(image_bytes: bytes) -> str:
    solver = OcrSolver()
    return solver.solve(image_bytes)
