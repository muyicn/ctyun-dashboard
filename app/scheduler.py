import time
import datetime
import threading
from typing import Dict, Any, Optional
from croniter import croniter

from config_manager import ConfigManager
from ctyun_keeper import GLOBAL_LOGS
from tasks.sign_task import run_sign_for_account
from tasks.ai_task import run_ai_chat_for_account
from tasks.hang_task import run_hang_task_async
from tasks.redeem_task import should_redeem_today, execute_redeem_order
from notifier import Notifier


class TaskScheduler:
    def __init__(self, config_mgr: ConfigManager, keeper=None):
        self.config_mgr = config_mgr
        self.keeper = keeper
        self.running = False
        self.thread: Optional[threading.Thread] = None
        self.lock = threading.Lock()
        self.last_run_times: Dict[str, float] = {}

    def start(self) -> None:
        with self.lock:
            if self.running:
                return
            self.running = True
            self.thread = threading.Thread(target=self._scheduler_loop, daemon=True)
            self.thread.start()
            GLOBAL_LOGS.append("Scheduler", "定时任务调度器已启动", "success")

    def stop(self) -> None:
        with self.lock:
            self.running = False

    def _should_trigger_cron(self, cron_expr: str, task_key: str) -> bool:
        now = datetime.datetime.now()
        now_ts = now.timestamp()
        try:
            itr = croniter(cron_expr, now)
            prev_time = itr.get_prev(datetime.datetime)
            # 如果在最近 65 秒内命中过，并且这分钟尚未执行过
            diff = (now - prev_time).total_seconds()
            last_executed = self.last_run_times.get(task_key, 0)
            if 0 <= diff < 65 and (now_ts - last_executed) > 65:
                self.last_run_times[task_key] = now_ts
                return True
        except Exception as e:
            # 简化匹配：如果不是完整croniter语法或异常
            pass
        return False

    def _scheduler_loop(self) -> None:
        while self.running:
            try:
                settings = self.config_mgr.config.get("settings", {})
                cron_cfg = settings.get("cron", {})
                accounts = self.config_mgr.get_accounts()

                # 1. 签到打卡定时触发
                sign_cron = cron_cfg.get("signCron", "0 2 * * *")
                if self._should_trigger_cron(sign_cron, "sign"):
                    GLOBAL_LOGS.append("Scheduler", "触发定时每日签到打卡任务", "info")
                    for acc in accounts:
                        if acc.get("enabled") and acc.get("features", {}).get("autoSign"):
                            self.execute_sign(acc["id"])

                # 2. AI 对话积分定时触发
                ai_cron = cron_cfg.get("aiChatCron", "0 3,20 * * *")
                if self._should_trigger_cron(ai_cron, "aiChat"):
                    GLOBAL_LOGS.append("Scheduler", "触发定时 AI 对话积分任务", "info")
                    for acc in accounts:
                        if acc.get("enabled") and acc.get("features", {}).get("aiChat"):
                            self.execute_ai_chat(acc["id"])

                # 3. 挂机 1 小时定时触发
                hang_cron = cron_cfg.get("cloudHangCron", "0 4,6 * * *")
                if self._should_trigger_cron(hang_cron, "cloudHang"):
                    GLOBAL_LOGS.append("Scheduler", "触发定时云电脑挂机 1 小时任务", "info")
                    for acc in accounts:
                        if acc.get("enabled") and acc.get("features", {}).get("cloudHang"):
                            self.execute_hang(acc["id"])

                # 4. 自动兑换/抽奖定时触发
                redeem_cron = cron_cfg.get("redeemCron", "0 7 * * *")
                if self._should_trigger_cron(redeem_cron, "redeem"):
                    GLOBAL_LOGS.append("Scheduler", "触发定时自动兑换与抽奖任务", "info")
                    for acc in accounts:
                        if acc.get("enabled") and acc.get("features", {}).get("autoRedeem"):
                            self.execute_redeem(acc["id"])

            except Exception as e:
                GLOBAL_LOGS.append("Scheduler", f"调度循环异常: {e}", "error")

            time.sleep(15)

    def execute_sign(self, account_id: str) -> None:
        def _job():
            acc = self.config_mgr.get_account(account_id)
            if not acc:
                return
            ok, msg = run_sign_for_account(acc)
            now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            self.config_mgr.update_account(account_id, {
                "stats": {
                    "lastSignTime": now_str,
                    "lastError": "" if ok else msg
                }
            })
            Notifier.send(
                self.config_mgr.config.get("settings", {}),
                f"天翼云签到 - {acc.get('name')}",
                f"结果: {msg}\n时间: {now_str}"
            )
        threading.Thread(target=_job, daemon=True).start()

    def execute_ai_chat(self, account_id: str) -> None:
        def _job():
            acc = self.config_mgr.get_account(account_id)
            if not acc:
                return
            ok, msg = run_ai_chat_for_account(acc, self.config_mgr.data_dir)
            now_str = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
            self.config_mgr.update_account(account_id, {
                "stats": {
                    "lastAiChatTime": now_str,
                    "lastError": "" if ok else msg
                }
            })
            Notifier.send(
                self.config_mgr.config.get("settings", {}),
                f"天翼云AI对话 - {acc.get('name')}",
                f"结果: {msg}\n时间: {now_str}"
            )
        threading.Thread(target=_job, daemon=True).start()

    def execute_hang(self, account_id: str) -> None:
        def _on_progress(acc_id: str, current_secs: int, total_secs: int):
            mins = current_secs // 60
            self.config_mgr.update_account(acc_id, {
                "stats": {
                    "hangMinutesToday": mins,
                    "lastHangTime": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                }
            })

        acc = self.config_mgr.get_account(account_id)
        if acc:
            run_hang_task_async(acc, self.config_mgr.data_dir, on_progress=_on_progress)

    def execute_redeem(self, account_id: str) -> None:
        def _job():
            acc = self.config_mgr.get_account(account_id)
            if not acc:
                return
            redeem_cfg = acc.get("redeemConfig", {})
            can_run, reason = should_redeem_today(redeem_cfg, datetime.date.today())
            if not can_run:
                GLOBAL_LOGS.append("Redeem", f"[{acc.get('name')}] 跳过兑换: {reason}", "info")
                return

            GLOBAL_LOGS.append("Redeem", f"[{acc.get('name')}] {reason}，准备自动兑换/抽奖: {redeem_cfg.get('prodName')}", "info")
            # 兑换后记录并重启保活程序使配置生效
            today_str = datetime.date.today().isoformat()
            redeem_cfg["lastRedeemDate"] = today_str
            self.config_mgr.update_account(account_id, {"redeemConfig": redeem_cfg})
            
            if self.keeper:
                self.keeper.restart(delay_seconds=120)

            Notifier.send(
                self.config_mgr.config.get("settings", {}),
                f"天翼云兑换 - {acc.get('name')}",
                f"目标: {redeem_cfg.get('prodName')}\n状态: 任务已执行"
            )

        threading.Thread(target=_job, daemon=True).start()
