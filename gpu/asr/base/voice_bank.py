from collections import OrderedDict
import threading
from typing import Any, Optional

from base.server_log import log, format_log


class VoiceBank:
    """In-memory voice cache (LRU)."""

    def __init__(self, max_items: int = 1000):
        try:
            max_items = int(max_items)
        except Exception:
            max_items = 1000
        self.max_items = max(0, max_items)
        self._lock = threading.Lock()
        self._items: "OrderedDict[str, Any]" = OrderedDict()
        self._hits = 0
        self._misses = 0

    def get(self, key: str) -> Optional[Any]:
        if not key:
            log(format_log("voicebank", "get failed: empty key"))
            return None
        with self._lock:
            if key not in self._items:
                self._misses += 1
                _, _, rate = self._stats_locked()
                log(
                    format_log(
                        "voicebank",
                        f"get miss key={key} hit_rate={rate * 100:.2f}%",
                    )
                )
                return None
            value = self._items.pop(key)
            self._items[key] = value
            self._hits += 1
            _, _, rate = self._stats_locked()
            log(
                format_log(
                    "voicebank",
                    f"get hit key={key} hit_rate={rate * 100:.2f}%",
                )
            )
            return value

    def set(self, key: str, value: Any) -> None:
        if not key or self.max_items <= 0:
            if not key:
                log(format_log("voicebank", "set failed: empty key"))
            return
        with self._lock:
            if key in self._items:
                self._items.pop(key)
            self._items[key] = value
            while len(self._items) > self.max_items:
                self._items.popitem(last=False)
            _, _, rate = self._stats_locked()
            log(
                format_log(
                    "voicebank",
                    f"set ok key={key} size={len(self._items)} hit_rate={rate * 100:.2f}%",
                )
            )

    def __len__(self) -> int:
        with self._lock:
            return len(self._items)

    def _stats_locked(self) -> tuple[int, int, float]:
        total = self._hits + self._misses
        rate = (self._hits / total) if total > 0 else 0.0
        return self._hits, self._misses, rate

    def stats(self) -> tuple[int, int, float]:
        with self._lock:
            return self._stats_locked()
