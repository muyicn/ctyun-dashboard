import time
import calendar
import datetime
import requests
from typing import Dict, Any, List, Tuple, Optional
from ctyun_keeper import GLOBAL_LOGS

REWARD_LIST_URL = "https://desk.ctyun.cn/selforder/api/selforder/prod/get?prodId=17000000&prodCode=POINTS"
PLACE_ORDER_URL = "https://desk.ctyun.cn/selforder/api/selforder/paas/placeOrder"


def fetch_available_rewards(headers: Optional[Dict[str, str]] = None) -> List[Dict[str, Any]]:
    """从天翼云商城获取当前所有可兑换商品与抽奖奖品列表"""
    req_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36",
        "referer": "https://pc.ctyun.cn/"
    }
    if headers:
        for k, v in headers.items():
            if not str(k).startswith(":"):
                req_headers[str(k)] = str(v)

    rewards = []
    try:
        resp = requests.get(REWARD_LIST_URL, headers=req_headers, timeout=10)
        if resp.status_code == 200:
            result = resp.json()
            for mall in result.get("data", []):
                for series in mall.get("series", []):
                    if series.get("expireDate") is not None:
                        continue
                    for sku in series.get("sku", []):
                        if sku.get("expireDate") is not None:
                            continue
                        rewards.append({
                            "prodId": int(sku.get("prodId", 0)),
                            "prodName": str(sku.get("prodName", "")).strip(),
                            "costPoints": int(sku.get("costPoints", 0)),
                            "description": str(sku.get("description", "")).strip(),
                            "prodType": str(sku.get("prodType", "")).strip()
                        })
    except Exception as e:
        print(f"[-] fetch_available_rewards error: {e}")

    # 若网络不可达时提供默认推荐选项（保证UI有数据可选）
    if not rewards:
        rewards = [
            {
                "prodId": 17000000,
                "prodName": "升级 8C16G 配置 (长期有效)",
                "costPoints": 300,
                "description": "每天300积分即可兑换升级8c16g配置",
                "prodType": "POINTS_REDEEM"
            },
            {
                "prodId": 17000001,
                "prodName": "升级 4C8G 配置",
                "costPoints": 150,
                "description": "4核8G轻量云电脑升级包",
                "prodType": "POINTS_REDEEM"
            },
            {
                "prodId": 17000002,
                "prodName": "云电脑时长增加包",
                "costPoints": 100,
                "description": "延长云电脑运行可用时长",
                "prodType": "POINTS_REDEEM"
            },
            {
                "prodId": 17000003,
                "prodName": "积分幸运大转盘抽奖",
                "costPoints": 50,
                "description": "使用50积分参与幸运抽奖，赢取话费和云电脑周边",
                "prodType": "LOTTERY"
            }
        ]
    return rewards


def should_redeem_today(redeem_config: Dict[str, Any], today: datetime.date) -> Tuple[bool, str]:
    if not redeem_config.get("enabled"):
        return False, "自动兑换未启用"

    schedule_type = str(redeem_config.get("scheduleType") or "monthly_days").strip()
    last_date = str(redeem_config.get("lastRedeemDate") or "").strip()
    today_str = today.isoformat()

    if last_date == today_str:
        return False, f"今日 ({today_str}) 已执行过兑换，跳过"

    if schedule_type == "daily":
        return True, "命中每日兑换策略"

    if schedule_type == "interval_days":
        interval = int(redeem_config.get("intervalDays", 1) or 1)
        if not last_date:
            return True, "间隔天数兑换策略首次触发"
        try:
            last_d = datetime.date.fromisoformat(last_date)
            passed = (today - last_d).days
            if passed >= interval:
                return True, f"已间隔 {passed} 天，达到设定的每隔 {interval} 天要求"
            return False, f"距上次仅 {passed} 天，未达到设定间隔 {interval} 天"
        except Exception:
            return True, "日期解析异常，允许执行"

    if schedule_type == "monthly_days":
        month_days = redeem_config.get("monthlyDays", [-1])
        allow_last_day = -1 in month_days
        last_day_of_month = calendar.monthrange(today.year, today.month)[1]

        if allow_last_day and today.day == last_day_of_month:
            return True, f"今天是本月最后一天 ({today.day}号)，命中每月兑换日（维持长期8C16G）"
        if today.day in month_days:
            return True, f"今天是 {today.day} 号，命中设定的每月兑换日"
        return False, f"今天是 {today.day} 号，不在设定日期 {month_days} 中"

    return True, "默认策略执行"


def execute_redeem_order(
    headers: Dict[str, str],
    desktop_id: int,
    prod_id: int,
    prod_type: str,
    cost_points: int,
    times: int = 1
) -> Tuple[bool, str]:
    """向天翼云发送下单兑换/抽奖请求"""
    clean_headers = {str(k): str(v) for k, v in headers.items() if not str(k).startswith(":")}
    clean_headers["Content-Type"] = "application/json;charset=UTF-8"

    payload = {
        "busiChannel": "010",
        "orderType": 1,
        "pointType": 1,
        "points": int(cost_points) * int(times),
        "sku": [
            {
                "execSort": idx + 1,
                "prodId": int(prod_id),
                "prodType": prod_type,
                "attrs": [{"attrKey": "bindDesktopId", "attrVal": int(desktop_id)}]
            }
            for idx in range(times)
        ]
    }

    try:
        resp = requests.post(PLACE_ORDER_URL, json=payload, headers=clean_headers, timeout=15)
        res = resp.json()
        code = res.get("code")
        if code == 0:
            return True, f"兑换成功！消耗 {cost_points * times} 积分"
        return False, f"兑换失败({code}): {res.get('msg', '未知错误')}"
    except Exception as e:
        return False, f"兑换请求异常: {e}"
