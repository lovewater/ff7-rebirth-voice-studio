"""逐段ASR会提高缓存并发，过期清理不能因其他请求增删字典而报音频格式错误。"""
import importlib.util
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor
import tempfile
import time
import unittest

spec = importlib.util.spec_from_file_location('asr_file_utils', Path(__file__).parents[1] / 'base/fileUtils.py')
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

class CacheConcurrencyTest(unittest.TestCase):
    def test_cleanup_while_other_requests_register_audio(self):
        with tempfile.TemporaryDirectory() as directory:
            cache = module.FileUtils({'file_utils': {'cache_path': directory, 'file_expire_time': .001}})
            cache.audio_cache = {str(i): {'path': directory + '/' + str(i), 'create_time': 0} for i in range(300)}
            def request(worker):
                for n in range(500):
                    cache.register_audio_file(directory + f'/{worker}-{n}')
                    cache.delete_old_files()
                    if n % 10 == 0:
                        time.sleep(.0001)
            with ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(request, range(8)))
            cache.delete_old_files()

if __name__ == '__main__':
    unittest.main()
