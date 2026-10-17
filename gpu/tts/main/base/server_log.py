import os
import sys
import time
import threading
import queue
from datetime import datetime

class Logger:
    def __init__(self, log_dir="logs"):
        # 创建日志目录
        self.log_dir = log_dir
        os.makedirs(log_dir, exist_ok=True)

        # 日志队列和线程
        self.log_queue = queue.Queue()
        self.log_thread = None
        self.running = True
        self.log_file = None
        self.last_file_open_time = 0
        self.file_open_interval = 300  # 5分钟 = 300秒

        # 启动日志线程
        self.start_log_thread()

    def start_log_thread(self):
        """启动日志处理线程"""
        if self.log_thread is None or not self.log_thread.is_alive():
            self.log_thread = threading.Thread(target=self._log_worker)
            self.log_thread.daemon = True
            self.log_thread.start()

    def _log_worker(self):
        """日志处理线程的工作函数"""
        while self.running:
            try:
                # 尝试从队列获取日志，最多等待1秒
                log_entry = self.log_queue.get(timeout=1)

                # 写入日志到文件
                self._write_to_file(log_entry)

                # 标记任务完成
                self.log_queue.task_done()
            except queue.Empty:
                # 队列为空，继续等待
                continue
            except Exception as e:
                # 捕获其他异常，防止日志线程崩溃
                print(f"日志线程异常: {str(e)}", file=sys.stderr)

    def _write_to_file(self, log_entry):
        """将日志写入文件"""
        current_time = time.time()

        # 检查是否需要打开或重新打开日志文件
        if self.log_file is None or (current_time - self.last_file_open_time) > self.file_open_interval:
            # 关闭旧文件
            if self.log_file is not None:
                self.log_file.close()

            # 生成新的日志文件名
            date_str = datetime.now().strftime("%Y-%m-%d")
            log_filename = os.path.join(self.log_dir, f"server_log-{date_str}.log")

            # 打开新文件
            self.log_file = open(log_filename, "a", encoding="utf-8")
            self.last_file_open_time = current_time

        # 写入日志
        self.log_file.write(log_entry + "\n")
        self.log_file.flush()

    def log(self, message, stderr=False):
        """记录日志"""
        # 输出到控制台
        if stderr:
            print(message, file=sys.stderr)
        else:
            print(message)

        # 添加到日志队列
        self.log_queue.put(message)

    def format_log(self, prefix, message):
        """格式化日志输出"""
        timestamp = time.strftime('[%Y-%m-%d %H:%M:%S]')
        return f'{timestamp} [{prefix}] {message}'

    def shutdown(self):
        """关闭日志系统"""
        self.running = False

        # 等待日志队列处理完成
        if not self.log_queue.empty():
            self.log_queue.join()

        # 关闭日志文件
        if self.log_file is not None:
            self.log_file.close()
            self.log_file = None

        # 等待日志线程结束
        if self.log_thread is not None:
            self.log_thread.join(timeout=2)

# 创建全局日志实例
logger = Logger()

# 导出便捷函数
def log(message, stderr=False):
    logger.log(message, stderr)

def format_log(prefix, message):
    return logger.format_log(prefix, message)

def shutdown_logger():
    logger.shutdown()
