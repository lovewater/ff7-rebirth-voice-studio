"""Shared game packaging rule; generated scripts never create new subtitle slots."""
import re
from pathlib import Path

POLICY = 'original-chinese-subtitles-only-v1'
POLICY_SOURCE = Path(__file__).resolve()


def has_original_chinese_subtitle(row: dict) -> bool:
    """text_zh is the original CN catalog field, never subtitle_text or a TTS/translation draft."""
    text = row.get('text_zh')
    if not isinstance(text, str):
        return False
    text = re.sub(r'</?i>|<br\s*/?>', '', text, flags=re.I)
    return bool(text.replace('\\r\\n', '').replace('\\n', '').strip())
