import subprocess
from typing import Optional


def force_kill_process(process) -> bool:
    """使用系统 kill -9 强杀进程。"""
    try:
        pid: Optional[int] = process.pid
    except Exception:
        return False
    if not pid:
        return False
    subprocess.run(["kill", "-9", str(pid)], check=False)
    return True
