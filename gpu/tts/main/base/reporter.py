import time
import logging
import requests
import concurrent.futures
from typing import Dict, Any, List, Optional
from base.config_manager import ConfigManager
from base.utils import get_http_proxy

logger = logging.getLogger(__name__)

class Reporter:
    """进度上报器，用于向服务器报告任务进度和结果，单例模式"""

    _instance = None

    def __new__(cls):
        """实现单例模式"""
        if cls._instance is None:
            cls._instance = super(Reporter, cls).__new__(cls)
            config_manager = ConfigManager()
            cls._instance.report_servers = config_manager.get_report_server_config()
            cls._instance.executors = []

            # 为每个服务器创建一个单线程的线程池
            for _ in range(len(cls._instance.report_servers)):
                executor = concurrent.futures.ThreadPoolExecutor(max_workers=1)
                cls._instance.executors.append(executor)

            logger.info(f"初始化进度上报器，服务器数量: {len(cls._instance.report_servers)}")
        return cls._instance

    def __init__(self):
        """初始化进度上报器"""
        # 由于使用了__new__方法实现单例，这里不需要重复初始化
        pass

    def reportProgress(self, task_id: str, progress: int):
        """
        报告任务进度

        Args:
            task_id: 任务ID
            progress: 进度值(0-100)
        """
        if not task_id or not self.report_servers:
            return

        # 为每个服务器提交上报任务
        for i, server in enumerate(self.report_servers):
            self.executors[i].submit(self._report_progress_thread, task_id, progress, server)

    def _report_progress_thread(self, task_id: str, progress: int, server: Dict[str, Any]):
        """
        在线程中执行进度上报

        Args:
            task_id: 任务ID
            progress: 进度值
            server: 服务器配置
        """
        try:
            report_start = time.time()
            if not task_id:
                return

            url = f"{server['url']}/generate/setTaskProgress/{task_id}"
            headers = {
                'Content-Type': 'application/json',
                'x-token': server.get('token', '')
            }

            response = requests.post(
                url,
                headers=headers,
                proxies=get_http_proxy(),
                json={"progress": progress},
                timeout=10
            )

            if response.status_code == 200:
                logger.info(f"汇报进度: {progress}% @{round(time.time() - report_start, 1)}s - {task_id}")
            else:
                logger.warning(f"汇报进度失败: {response.status_code} - {task_id}")

        except Exception as ex:
            logger.error(f"向服务器报告进度失败: {ex} - {task_id}")

    def reportResult(self, task_id: str, output: Dict[str, Any]):
        """
        报告任务结果

        Args:
            task_id: 任务ID
            output: 输出结果
        """
        if not task_id or not self.report_servers:
            return

        # 为每个服务器提交上报任务
        for i, server in enumerate(self.report_servers):
            self.executors[i].submit(self._report_result_thread, task_id, output, server)

    def _report_result_thread(self, task_id: str, output: Dict[str, Any], server: Dict[str, Any]):
        """
        在线程中执行结果上报

        Args:
            task_id: 任务ID
            output: 输出结果
            server: 服务器配置
        """
        try_count = 3
        while try_count > 0:
            try_count -= 1
            try:
                if not task_id:
                    return

                url = f"{server['url']}/generate/setTaskResult/{task_id}"
                headers = {
                    'Content-Type': 'application/json',
                    'x-token': server.get('token', '')
                }

                response = requests.post(
                    url,
                    headers=headers,
                    proxies=get_http_proxy(),
                    json=output,
                    timeout=10
                )

                if response.status_code == 200:
                    logger.info(f"向服务器报告结果成功: {task_id}")
                    break
                else:
                    logger.warning(f"向服务器报告结果失败(尝试{3-try_count}/3): {task_id} - {response.status_code}")

            except Exception as ex:
                logger.error(f"向服务器报告结果失败(尝试{3-try_count}/3): {task_id} - {ex}")

            # 如果还有重试次数，等待一秒后重试
            if try_count > 0:
                time.sleep(1)

    def shutdown(self):
        """关闭所有线程池"""
        for executor in self.executors:
            executor.shutdown(wait=False)
