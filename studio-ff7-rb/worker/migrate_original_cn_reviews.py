#!/usr/bin/env python3
"""把历史skip_timing统一迁为原中文锁；已有人工结论优先，不调用模型或TTS。

默认只检查，--apply才修改。迁移时逐句持有lines行锁，避免覆盖网站并发审核。
旧布尔位不再表达独立豁免，成功登记/已有人工选择后清零。快照保留原锁/异常及旧标记。
"""
import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import shutil

import psycopg
from extract_txtres import DSN


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--data-dir', type=Path, default=Path(__file__).resolve().parents[1] / 'website' / 'data')
    parser.add_argument('--snapshot-dir', type=Path)
    parser.add_argument('--stem-prefix', default='')
    args = parser.parse_args()
    if args.apply and args.snapshot_dir is None:
        parser.error('--apply必须指定--snapshot-dir保存迁移前快照')
    with psycopg.connect(DSN, autocommit=True, row_factory=psycopg.rows.dict_row) as conn:
        legacy = conn.execute("SELECT m.stem FROM line_meta m JOIN lines l ON l.stem=m.stem WHERE m.skip_timing AND l.stem LIKE %s ORDER BY m.stem", (args.stem_prefix + '%',)).fetchall()
        needed = conn.execute("SELECT l.stem,l.speaker FROM line_meta m JOIN lines l ON l.stem=m.stem WHERE m.skip_timing AND l.stem LIKE %s AND NOT EXISTS(SELECT 1 FROM line_tts_versions v WHERE v.stem=l.stem AND v.review_state<>'candidate')", (args.stem_prefix + '%',)).fetchall()
        invalid = [r['stem'] for r in needed if not r['speaker'] or not (args.data_dir / 'cn' / (r['stem'] + '.mp3')).is_file()]
        if invalid:
            raise RuntimeError(f'原中文文件或说话人缺失，未修改：{invalid}')
        print(json.dumps({'legacy': len(legacy), 'needOriginalLock': len(needed), 'apply': args.apply}))
        if not args.apply:
            return
        args.snapshot_dir.mkdir(parents=True, exist_ok=False)
        before = {
            'createdAt': datetime.now(timezone.utc).isoformat(),
            'humanChoices': conn.execute("SELECT id,stem,review_state,used_at FROM line_tts_versions WHERE review_state<>'candidate' ORDER BY stem,id").fetchall(),
            'legacy': legacy,
        }
        (args.snapshot_dir / 'before.json').write_text(json.dumps(before, ensure_ascii=False, default=str, indent=2))
        results = []
        for row in legacy:
            stem = row['stem']
            created_file = None
            try:
                with conn.transaction():
                    line = conn.execute('SELECT speaker,text_jp,text_zh FROM lines WHERE stem=%s FOR UPDATE', (stem,)).fetchone()
                    timing = conn.execute('SELECT * FROM line_meta WHERE stem=%s FOR UPDATE', (stem,)).fetchone()
                    if not timing or not timing['skip_timing']:
                        results.append({'stem': stem, 'action': 'changed-during-migration'})
                        continue
                    # 旧ignore可能只是历史锁音频时附带写入，不能反过来覆盖现有TTS/日文锁。
                    chosen = conn.execute("SELECT id FROM line_tts_versions WHERE stem=%s AND review_state<>'candidate' ORDER BY (review_state='locked') DESC,id DESC LIMIT 1", (stem,)).fetchone()
                    if chosen:
                        action = 'preserved-existing'
                        record = chosen
                    else:
                        record = conn.execute("SELECT id FROM line_tts_versions WHERE stem=%s AND status='ready' AND voice_gpu_key='cn-original' ORDER BY id DESC LIMIT 1", (stem,)).fetchone()
                        if not record:
                            text = line['text_zh'] or '（原中文）'
                            record = conn.execute("INSERT INTO line_tts_versions(stem,speaker,voice_gpu_key,tts_text,spoken_text,jp_text_snapshot,game_zh_text_snapshot,duration_factor,emo_alpha) VALUES(%s,%s,'cn-original',%s,%s,%s,%s,1,0) RETURNING id", (stem, line['speaker'], text, text, line['text_jp'], line['text_zh'])).fetchone()
                            relative = Path('tts') / stem / f"{record['id']}.mp3"
                            created_file = args.data_dir / relative
                            created_file.parent.mkdir(parents=True, exist_ok=True)
                            shutil.copyfile(args.data_dir / 'cn' / f'{stem}.mp3', created_file)
                            conn.execute("UPDATE line_tts_versions SET status='ready',audio_path=%s,audio_bytes=%s,start_s=%s,end_s=%s,dur_s=%s,speech_s=%s,conversion_meta=%s::jsonb,completed_at=now() WHERE id=%s", (relative.as_posix(), created_file.stat().st_size, timing['cn_start_s'], timing['cn_end_s'], timing['cn_dur_s'], timing['cn_speech_s'], json.dumps({'pipeline': 'cn-original', 'migration': 'legacy-skip-timing'}), record['id']))
                        conn.execute("UPDATE line_tts_versions SET review_state='locked',used_at=now() WHERE id=%s", (record['id'],))
                        action = 'locked-original'
                    conn.execute('UPDATE line_meta SET skip_timing=false,updated_at=now() WHERE stem=%s', (stem,))
                    results.append({'stem': stem, 'id': record['id'], 'action': action})
            except Exception:
                if created_file is not None:
                    created_file.unlink(missing_ok=True)
                (args.snapshot_dir / 'partial-results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
                raise
        (args.snapshot_dir / 'results.json').write_text(json.dumps(results, ensure_ascii=False, indent=2))
        print(json.dumps({'processed': len(results), 'newOriginalLocks': sum(r['action'] == 'locked-original' for r in results)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
