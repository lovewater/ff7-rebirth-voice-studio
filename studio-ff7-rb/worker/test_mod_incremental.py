"""Offline release lifecycle: real IoStore writers/readers, fake encoder and share."""
import copy
import contextlib
from concurrent.futures import Future
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time
import unittest
from unittest.mock import patch

import build_mod as b
import mod_incremental as inc
from bootstrap_mod_state import initialize
from test_build_mod import asset

REAL_LOAD_SNAPSHOT = b.load_build_snapshot


class InlinePool:
    def __init__(self, **kwargs): pass
    def __enter__(self): return self
    def __exit__(self, *args): pass
    def submit(self, fn, *args):
        future = Future()
        try: future.set_result(fn(*args))
        except BaseException as error: future.set_exception(error)
        return future


class Lifecycle(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name)
        self.cn = self.root / 'cn'
        self.cn.mkdir()
        self.data = self.root / 'data'
        self.data.mkdir()
        self.game = self.root / 'game'
        self.game.mkdir()
        self.work = self.root / 'work'
        self.share = self.root / 'share'
        self.txt = self.root / 'txt'
        self.txt.mkdir()
        (self.root / 'work').mkdir()
        self.rows = []
        self.calls = []
        self.during_encode = None
        self.fail_upload = False
        self.bad_hash = False
        self.alias = False
        self.index = self.work / 'jp-voice-index.jsonl'
        self.index.write_text('')
        self.patchers = []
        values = dict(ROOT=self.root, CN_MODS=self.cn, DATA=self.data, GAME_PAKS=self.game,
                      BUILD_ROOT=self.root / 'build', SMB_ROOT=self.share, TXTRES_RAW=self.txt,
                      TXTRES_INDEX=self.root/'txt-index', AUDIOMOG=self.root/'AudioMog.dll')
        for key, value in values.items(): self.mock(key, value)
        b.AUDIOMOG.write_bytes(b'fake encoder')
        self.mock('oodle_compress', lambda data:None)
        self.mock('ProcessPoolExecutor', InlinePool)
        self.mock('build_policy', lambda:'fixture-policy')
        self.mock('chapter_map', lambda:({1:['C1']}, []))
        self.mock('load_build_snapshot', lambda regions,limit:(copy.deepcopy(self.rows[:limit] if limit else self.rows), [], []))
        self.mock('rebuild_locked', self.encode)
        self.mock('material_entries', lambda data:[{'digest':hashlib.sha256(data).hexdigest()}])
        self.mock('validate_replacements', lambda *args:None)
        self.mock('next_version', lambda day:len(list((self.share/day).glob('*'))))
        self.mock('index_txtres', lambda:({'a':'captions'}, {'captions':{'path':'End/CN/captions.uasset','chunk_id':self.cid(9).hex()}}))
        self.mock('parse_txtres', self.parse_text)
        self.mock('patch_txtres', lambda raw,repl:self.caption(repl['a']))
        self.mock('clean_text', lambda text:text)
        self.patchers.append(patch.object(b.subprocess, 'run', side_effect=self.command))
        self.patchers[-1].start()
        (self.cn/'zzz_cn_voice_g_P.pak').write_bytes(b'pak')
        for number, stem in enumerate(('a','b'), 1):
            cid = self.cid(number)
            original = asset([64 + 16*number])[0]
            self.write_pack(self.cn/f'zzz_cn_voice_{stem}_P.utoc', [(cid, original, self.rel(stem))], number+20)
            (self.data/f'{stem}.wav').write_bytes(stem.encode())
            self.rows.append(dict(stem=stem, region='C1', pack=f'zzz_cn_voice_{stem}_P',
                                  asset_path=self.rel(stem), id=number, audio_path=f'{stem}.wav',
                                  voice_gpu_key='generated', text_zh='原文', subtitle_text=None))
        # write_container needs g pak, but it should not be counted as a source container.
        (self.txt/'captions.uasset').write_bytes(self.caption('原文'))
        self.addCleanup(self.stop_patches)

    def mock(self, key, value):
        p = patch.object(b, key, value)
        p.start()
        self.patchers.append(p)

    def stop_patches(self):
        for p in reversed(self.patchers): p.stop()

    @staticmethod
    def cid(n): return n.to_bytes(8,'little') + bytes.fromhex('00000002')
    @staticmethod
    def rel(stem, directory='EV'): return f'End/Content/Sound/Voice/JP/{directory}/{stem}.uasset'
    @staticmethod
    def caption(text):
        return b'TEXT' + asset([64])[0] + text.encode()

    def parse_text(self, data):
        if not data.startswith(b'TEXT'): raise AssertionError('not subtitle')
        return {'entries':[{'stem':'a','text':data[4+len(asset([64])[0]):].decode()}]}

    def write_pack(self, path, assets, n):
        header = n.to_bytes(8,'little')
        b.write_container([(header+bytes.fromhex('0000000a'), b.container_header(header), None)] + assets, path)

    def encode(self, task):
        stem, selected, audio, original_hex = task
        original = bytes.fromhex(original_hex)
        self.calls.append((stem, selected, len(original)))
        b.audit_encode("fixture", dict(stem=stem, tts_id=selected))
        audio_bytes = (b.DATA/audio).read_bytes()
        if self.during_encode:
            action, self.during_encode = self.during_encode, None
            action()
        payload = b.repair_audio_exports(original, original + hashlib.sha256(audio_bytes).digest())
        path = b.BUILD_ROOT/'tmp'/f'{stem}-{selected}-{len(original)}.uasset'
        path.write_bytes(payload)
        return str(path)

    def command(self, args, **kwargs):
        if args[0] == 'rsync':
            if self.fail_upload: return subprocess.CompletedProcess(args, 1)
            source, dest = Path(args[-2]), Path(args[-1])
            shutil.copytree(source, dest, dirs_exist_ok=True)
            if self.bad_hash:
                next(dest.rglob('*.ucas')).write_bytes(b'corrupt')
        return subprocess.CompletedProcess(args, 0)

    def run_build(self, *args):
        if not any(a in args for a in ('--full', '--incremental')):
            args = (('--incremental' if (b.BUILD_ROOT/'state/latest.json').exists() else '--full'), *args)
        with patch('sys.argv', ['build_mod.py',*args]), contextlib.redirect_stdout(io.StringIO()):
            self.assertEqual(b.main(), 0)
        state = b.BUILD_ROOT/'state/latest.json'
        return json.loads(state.read_text()) if state.exists() else None

    def manifest(self, state): return json.loads((Path(state['output'])/'manifest.json').read_text())
    def payload(self, state, stem='a'):
        return b.extract_chunk_ids(Path(state['output'])/'End/Content/Paks/~mods'/f'zzz_cn_voice_{stem}_P.utoc', {self.cid(1 if stem=='a' else 2):stem}, strict=True)[stem]

    def test_initial_nochange_one_audio_old_selection_cancel(self):
        first = self.run_build()
        self.assertEqual(len(self.calls),2)
        before = (b.BUILD_ROOT/'state/latest.json').read_bytes()
        same = self.run_build()
        self.assertEqual(before,(b.BUILD_ROOT/'state/latest.json').read_bytes())
        self.assertEqual(first['id'],same['id'])
        self.assertEqual(len(self.calls),2)
        (self.data/'a.wav').write_bytes(b'new')
        changed = self.run_build()
        report = self.manifest(changed)['incremental']
        self.assertEqual(len(self.calls),3)
        self.assertEqual(report['changed_containers'],['zzz_cn_voice_a_P'])
        self.assertEqual(report['reused_containers'],['zzz_cn_voice_b_P'])
        self.assertFalse(Path(first['output']).exists())
        # Selecting a version created before the baseline is still a new selection.
        self.rows[0]['id'] = 500
        self.rows[0]['audio_path'] = 'old.wav'
        (self.data/'old.wav').write_bytes(b'old audio')
        switched = self.run_build()
        self.assertEqual(len(self.calls),4)
        self.rows[0]['id'] = None
        self.rows[0]['audio_path'] = None
        cancelled = self.run_build()
        self.assertEqual(len(self.calls),4)
        source = b.extract_chunk_ids(self.cn/'zzz_cn_voice_a_P.utoc',{self.cid(1):'a'},strict=True)['a']
        self.assertEqual(self.payload(cancelled),source)

    def test_cancel_every_lock_returns_independent_source_set(self):
        first = self.run_build()
        for row in self.rows:
            row['id'] = None
            row['audio_path'] = None
        second = self.run_build()
        self.assertEqual(len(self.calls),2)
        self.assertEqual(self.manifest(second)['incremental']['audio_encodes'],0)
        for stem in ('a','b'):
            source = b.extract_chunk_ids(self.cn/f'zzz_cn_voice_{stem}_P.utoc',
                        {self.cid(1 if stem=='a' else 2):stem},strict=True)[stem]
            self.assertEqual(self.payload(second,stem),source)
        self.assertFalse(Path(first['output']).exists())

    def test_missing_cache_reuses_chunks_and_same_file_edits(self):
        first = self.run_build()
        shutil.rmtree(b.BUILD_ROOT/'tmp')
        (self.data/'a.wav').write_bytes(b'changed same ID')
        second = self.run_build()
        self.assertEqual(len(self.calls),3)
        self.assertEqual(self.manifest(second)['incremental']['reused_chunks'],['cn:'+self.cid(2).hex()])
        self.assertIn('a',self.manifest(second)['incremental']['changed_stems'])

    def test_mid_build_change_stays_dirty(self):
        self.during_encode = lambda:(self.data/'a.wav').write_bytes(b'changed during build')
        first = self.run_build()
        old = self.payload(first)
        second = self.run_build()
        self.assertEqual(len(self.calls),3)
        self.assertNotEqual(old,self.payload(second))

    def test_linked_voice_subtitle_policy_clears_mistaken_overlay_without_touching_audio(self):
        original_validate=b.validate_zen_exports
        def validate(data):
            if data.startswith(b'TEXT'):return
            original_validate(data)
        with patch.object(b,'validate_zen_exports',side_effect=validate):
            self.rows[0]['subtitle_text']='误存的伴随轨字幕'
            first=self.run_build()
            self.assertEqual(self.manifest(first)['subtitle_mod'],b.MOD_STEM)
            encoded=len(self.calls)
            self.rows[0]['subtitle_parent_stem']='main'
            second=self.run_build()
            result=self.manifest(second)
            self.assertIsNone(result['subtitle_mod'])
            self.assertEqual(result['incremental']['audio_encodes'],0)
            self.assertEqual(len(self.calls),encoded)
            self.assertEqual(len(result['incremental']['deleted_files']),3)
            self.assertEqual(result['companion_subtitles_suppressed'][0]['stem'],self.rows[0]['stem'])
            self.assertTrue(result['companion_subtitles_suppressed'][0]['had_override'])
            self.assertEqual(self.rows[0]['subtitle_text'],'误存的伴随轨字幕')

    def test_subtitle_only_and_last_subtitle_delete(self):
        # A real Zen fixture text parser/writer is not needed to test orchestration.
        original_validate = b.validate_zen_exports
        def validate(data):
            if data.startswith(b'TEXT'): return
            original_validate(data)
        with patch.object(b,'validate_zen_exports',side_effect=validate):
            first = self.run_build()
            self.rows[0]['subtitle_text'] = '新字幕'
            second = self.run_build()
            report = self.manifest(second)['incremental']
            self.assertEqual(len(self.calls),2)
            self.assertEqual(report['changed_containers'],[b.MOD_STEM])
            self.assertEqual(report['audio_encodes'],0)
            self.rows[0]['subtitle_text'] = None
            third = self.run_build()
            report = self.manifest(third)['incremental']
            self.assertEqual(len(self.calls),2)
            self.assertEqual(len(report['deleted_files']),3)
            self.assertTrue(all(b.MOD_STEM in p for p in report['deleted_files']))

    def add_alias(self):
        mv = asset([96,32])[0]
        self.write_pack(self.game/'game.utoc',[(self.cid(3),mv,self.rel('a','MV'))],50)
        entries = [dict(stem='a',chunk_id=self.cid(1).hex(),container='game',path='../../../'+self.rel('a'),size=len(asset([80])[0])),
                   dict(stem='a',chunk_id=self.cid(3).hex(),container='game',path='../../../'+self.rel('a','MV'),size=len(mv))]
        self.index.write_text(''.join(json.dumps(e)+'\n' for e in entries))

    def test_multisource_ev_mv_reuse_and_cancel_last_alias(self):
        self.add_alias()
        first = self.run_build()
        self.assertEqual(sorted(c[2] for c in self.calls if c[0]=='a'),[len(asset([80])[0]),len(asset([96,32])[0])])
        self.rows[1]['subtitle_text'] = 'force metadata reconciliation'
        # no matching subtitle fixture for b; instead change selection ID only.
        self.rows[1]['subtitle_text'] = None
        self.rows[1]['id'] = 30
        second = self.run_build()
        report = self.manifest(second)['incremental']
        self.assertIn(b.ADD_PACK,report['reused_containers'])
        self.assertEqual(len(self.calls),4)
        self.rows[0]['id'] = None
        self.rows[0]['audio_path'] = None
        third = self.run_build()
        self.assertEqual(len(self.manifest(third)['incremental']['deleted_files']),3)

    def test_shared_added_bank_layout_japanese_and_last_removal(self):
        original = asset([96])[0]
        self.write_pack(self.game/'movie.utoc',[(self.cid(4),original,self.rel('bank','MV'))],55)
        (self.data/'movie.wav').write_bytes(b'movie')
        added = [dict(stem=f'movie{i}',id=10+i,audio_path='movie.wav',voice_gpu_key='generated',
                      text_zh='',subtitle_text=None,tts_text='',jp_chunk_id=self.cid(4).hex(),
                      jp_container='movie',asset_path='../../../'+self.rel('bank','MV'),
                      extra=dict(slice_start_s=i,slice_end_s=i+1,voice_channel=0)) for i in range(2)]
        additions = []
        def encode_added(task):
            bank,path,slices,cache = task
            raw = Path(path).read_bytes()
            additions.append(copy.deepcopy(slices))
            if all(piece['keep_japanese'] for piece in slices):
                result = raw
            else:
                b.audit_encode('added-fixture',dict(bank=bank))
                result = b.repair_audio_exports(raw,raw+bytes.fromhex(inc.digest(slices)))
            target = b.BUILD_ROOT/'tmp'/'added.uasset';target.write_bytes(result)
            return str(target)
        with patch.object(b,'load_build_snapshot',side_effect=lambda *args:(copy.deepcopy(self.rows),copy.deepcopy(added),[])), patch.object(b,'rebuild_added_bank',side_effect=encode_added):
            first = self.run_build()
            self.rows[1]['id'] = 100
            second = self.run_build()
            self.assertEqual(len(additions),1)
            self.assertIn(b.ADD_PACK,self.manifest(second)['incremental']['reused_containers'])
            added[0]['extra']['voice_channel'] = 1
            third = self.run_build()
            self.assertEqual(len(additions),2)
            self.assertEqual(len(self.calls),3)
            added.pop(0)
            fourth = self.run_build()
            self.assertEqual(len(additions[-1]),1)  # only current desired slice; never old overlays
            added[0]['voice_gpu_key'] = 'jp-lock'
            fifth = self.run_build()
            self.assertEqual(self.manifest(fifth)['incremental']['audio_encodes'],0)
            payload = b.extract_chunk_ids(Path(fifth['output'])/'End/Content/Paks/~mods'/f'{b.ADD_PACK}.utoc', {self.cid(4):'bank'},strict=True)['bank']
            self.assertEqual(payload,original)
            added.clear()
            last = self.run_build()
            self.assertEqual(len(self.manifest(last)['incremental']['deleted_files']),3)

    def test_battle_bank_metadata_reuse_and_cancel(self):
        self.rows[0]['id'] = None
        self.rows[0]['audio_path'] = None
        (self.data/'material.wav').write_bytes(b'material')
        battle = [dict(stem='material',id=20,audio_path='material.wav',voice_gpu_key='generated',
                       pack=self.rows[0]['pack'],extra=dict(bank_stem='a',bank_material_index=0))]
        calls = []
        def encode_bank(bank,original,rows):
            calls.append(copy.deepcopy(rows))
            b.audit_encode('battle-fixture',dict(bank=bank))
            return b.repair_audio_exports(original,original+bytes.fromhex(inc.digest(rows)))
        with patch.object(b,'load_build_snapshot',side_effect=lambda *args:(copy.deepcopy(self.rows),[],copy.deepcopy(battle))), patch.object(b,'rebuild_battle_bank',side_effect=encode_bank):
            first = self.run_build()
            self.rows[1]['id'] = 100
            second = self.run_build()
            self.assertEqual(len(calls),1)
            battle[0]['extra']['bank_material_index'] = 1
            third = self.run_build()
            self.assertEqual(len(calls),2)
            battle.clear()
            last = self.run_build()
            source = b.extract_chunk_ids(self.cn/'zzz_cn_voice_a_P.utoc',{self.cid(1):'a'},strict=True)['a']
            self.assertEqual(self.payload(last),source)

    def test_corrupt_baseline_refuses_incremental(self):
        first = self.run_build()
        next(Path(first['output']).rglob('*.ucas')).write_bytes(b'corrupt')
        with self.assertRaisesRegex(RuntimeError, '拒绝增量'): self.run_build()
        self.assertEqual(len(self.calls),2)
        self.assertTrue(Path(first['output']).exists())

    def test_upload_and_hash_failure_preserve_state_same_day_output(self):
        first = self.run_build()
        old = (b.BUILD_ROOT/'state/latest.json').read_bytes()
        (self.data/'a.wav').write_bytes(b'new')
        self.fail_upload = True
        with self.assertRaises(SystemExit): self.run_build()
        self.assertEqual(old,(b.BUILD_ROOT/'state/latest.json').read_bytes())
        self.assertTrue(Path(first['output']).exists())
        self.fail_upload = False
        self.bad_hash = True
        with self.assertRaises(RuntimeError): self.run_build()
        self.assertEqual(old,(b.BUILD_ROOT/'state/latest.json').read_bytes())
        self.assertTrue(Path(first['output']).exists())
        self.assertEqual(len(list((b.BUILD_ROOT/b.sh_date()).glob('in-progress-*'))),2)

    def test_no_rsync_and_limit_never_promote(self):
        first = self.run_build()
        old = (b.BUILD_ROOT/'state/latest.json').read_bytes()
        (self.data/'a.wav').write_bytes(b'new')
        self.run_build('--no-rsync')
        self.run_build('--limit','1')
        self.assertEqual(old,(b.BUILD_ROOT/'state/latest.json').read_bytes())
        self.assertTrue(Path(first['output']).exists())

    def test_full_policy_scope_and_source_changes(self):
        first = self.run_build()
        second = self.run_build('--full')
        self.assertEqual(len(self.calls),4)
        self.assertNotEqual(first['id'],second['id'])
        with patch.object(b,'build_policy',return_value='new-policy'):
            with self.assertRaisesRegex(RuntimeError, '拒绝增量'): self.run_build()
            third = self.run_build('--full')
        self.assertEqual(len(self.calls),6)
        with self.assertRaisesRegex(RuntimeError, '拒绝增量'): self.run_build('--chapters','1')
        fourth = self.run_build('--full','--chapters','1')
        self.assertEqual(len(self.calls),8)
        # A change in the source asset bytes changes the per-chunk audio fingerprint.
        original = bytearray(asset([80])[0]); original[-1] = 1
        self.write_pack(self.cn/'zzz_cn_voice_a_P.utoc',[(self.cid(1),bytes(original),self.rel('a'))],21)
        fifth = self.run_build('--chapters','1')
        self.assertEqual(len(self.calls),9)

    def test_encoder_and_strict_validation_failure_preserve_previous(self):
        first = self.run_build()
        old = (b.BUILD_ROOT/'state/latest.json').read_bytes()
        (self.data/'a.wav').write_bytes(b'changed')
        with patch.object(b,'rebuild_locked',side_effect=RuntimeError('encoder failed')):
            with self.assertRaisesRegex(RuntimeError,'encoder failed'): self.run_build()
        with patch.object(b,'verify_container',side_effect=RuntimeError('strict failed')):
            with self.assertRaisesRegex(RuntimeError,'strict failed'): self.run_build()
        self.assertEqual(old,(b.BUILD_ROOT/'state/latest.json').read_bytes())
        self.assertTrue(Path(first['output']).exists())

    def test_same_size_restored_mtime_and_unselected_candidates(self):
        first = self.run_build()
        (self.data/'unselected-candidate.wav').write_bytes(b'not selected')
        same = self.run_build()
        self.assertEqual(first['id'],same['id'])
        path = self.data/'a.wav'
        stamp = path.stat()
        path.write_bytes(b'z')
        os.utime(path,ns=(stamp.st_atime_ns,stamp.st_mtime_ns))
        second = self.run_build()
        self.assertEqual(len(self.calls),3)
        self.assertIn('a',self.manifest(second)['incremental']['changed_stems'])
        source = self.cn/'zzz_cn_voice_a_P.pak'
        stamp = source.stat()
        source.write_bytes(b'new')  # same length, preserved mtime; ctime must invalidate SHA cache
        os.utime(source,ns=(stamp.st_atime_ns,stamp.st_mtime_ns))
        third = self.run_build()
        self.assertEqual(len(self.calls),3)
        self.assertIn('zzz_cn_voice_a_P',self.manifest(third)['incremental']['changed_containers'])

    def test_build_lock_and_missing_baseline(self):
        with inc.build_lock(b.BUILD_ROOT):
            with self.assertRaisesRegex(RuntimeError,'构建锁'):
                with inc.build_lock(b.BUILD_ROOT): pass
        first = self.run_build()
        next(Path(first['output']).rglob('*.utoc')).unlink()
        with self.assertRaisesRegex(RuntimeError, '拒绝增量'): self.run_build()
        self.assertTrue(Path(first['output']).exists())

    def test_source_changed_during_build_does_not_publish(self):
        first = self.run_build()
        old = (b.BUILD_ROOT/'state/latest.json').read_bytes()
        (self.data/'a.wav').write_bytes(b'changed')
        self.during_encode = lambda:(self.cn/'zzz_cn_voice_a_P.pak').write_bytes(b'new source')
        with self.assertRaisesRegex(RuntimeError,'源资源改变'): self.run_build()
        self.assertEqual(old,(b.BUILD_ROOT/'state/latest.json').read_bytes())
        self.assertTrue(Path(first['output']).exists())

    def test_selection_snapshot_uses_one_readonly_transaction(self):
        with patch.object(b.psycopg,'connect') as connect:
            conn = connect.return_value.__enter__.return_value
            def read_rows(regions):
                self.assertIs(b._READ_CONN,conn)
                return []
            with patch.object(b,'load_lines',side_effect=read_rows), patch.object(b,'load_added_lines',side_effect=read_rows), patch.object(b,'load_battle_bank_lines',side_effect=read_rows):
                self.assertEqual(REAL_LOAD_SNAPSHOT(None,0),([],[],[]))
            connect.assert_called_once()
            self.assertEqual(conn.execute.call_args_list[0].args, ('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY',))
            self.assertIn('pg_current_snapshot()', conn.execute.call_args_list[1].args[0])
            self.assertIsNone(b._READ_CONN)

    def test_pre_freeze_edit_aborts_exact_reviewer_case(self):
        first = self.run_build()
        old_state = (b.BUILD_ROOT/'state/latest.json').read_bytes()
        old_payload = self.payload(first)
        freezer = inc.Session.freeze_audio
        def late(session, rows, data):
            (self.data/'a.wav').write_bytes(b'POST_START_EDIT')
            self.assertGreater((self.data/'a.wav').stat().st_ctime, session.start)
            return freezer(session, rows, data)
        with patch.object(inc.Session, 'freeze_audio', late):
            with self.assertRaisesRegex(RuntimeError, '冻结之前改变'): self.run_build()
        self.assertEqual(len(self.calls), 2)
        self.assertEqual(len(list((self.share/b.sh_date()).iterdir())), 1)
        self.assertEqual(old_state, (b.BUILD_ROOT/'state/latest.json').read_bytes())
        self.assertEqual(old_payload, self.payload(first))
        second = self.run_build()
        self.assertEqual(len(self.calls), 3)
        self.assertNotEqual(old_payload, self.payload(second))

    def test_later_filename_changed_during_sequential_freeze_aborts(self):
        first = self.run_build()
        copier = inc.shutil.copy2
        def late(source, target, *args, **kwargs):
            result = copier(source, target, *args, **kwargs)
            if Path(source) == self.data/'a.wav':
                (self.data/'b.wav').write_bytes(b'LATER_FILENAME_POST_START')
            return result
        with patch.object(inc.shutil, 'copy2', late):
            with self.assertRaisesRegex(RuntimeError, 'b.wav'): self.run_build()
        self.assertEqual(len(self.calls), 2)
        self.assertTrue(Path(first['output']).exists())
        self.run_build()
        self.assertEqual(len(self.calls), 3)

    def test_db_selection_during_baseline_verification_stays_next_build(self):
        first = self.run_build()
        verify = inc.verify_files
        def change_selection(*args):
            self.rows[0]['id'] = 999
            return verify(*args)
        with patch.object(inc, 'verify_files', change_selection):
            same = self.run_build()
        self.assertEqual(first['id'], same['id'])
        self.assertEqual(len(self.calls), 2)
        second = self.run_build()
        self.assertEqual(second['selection'][0][0]['id'], 999)
        self.assertEqual(len(self.calls), 3)

    def test_db_snapshot_clock_precedes_reads_and_survives_late_selection(self):
        captured = copy.deepcopy(self.rows)
        events = []
        with patch.object(b.psycopg, 'connect') as connect:
            conn = connect.return_value.__enter__.return_value
            def execute(sql):
                events.append(sql)
                cursor = unittest.mock.Mock()
                cursor.fetchone.return_value = (time.time(), 'snapshot')
                return cursor
            conn.execute.side_effect = execute
            def read(regions):
                self.assertIn('pg_current_snapshot()', events[-1])
                self.rows[0]['id'] = 999  # committed after the acquired MVCC boundary
                return copy.deepcopy(captured)
            with patch.object(b, 'load_lines', read), patch.object(b, 'load_added_lines', return_value=[]), patch.object(b, 'load_battle_bank_lines', return_value=[]):
                snapshot = REAL_LOAD_SNAPSHOT(None, 0)
        self.assertEqual(snapshot[0][0]['id'], 1)
        self.assertLessEqual(snapshot.started, time.time())

    def test_unlocked_metadata_does_not_change_effective_identity(self):
        self.rows[0]['id'] = None
        self.rows[0]['audio_path'] = None
        first = self.run_build()
        self.rows[0]['text_zh'] = 'unlocked changed'
        self.rows[0]['subtitle_text'] = 'unlocked candidate'
        self.rows[0]['voice_gpu_key'] = 'new candidate'
        self.assertEqual(first['id'], self.run_build()['id'])
        self.rows[0].update(id=99, audio_path='a.wav', subtitle_text=None)
        second = self.run_build()
        self.assertIn('a', self.manifest(second)['incremental']['changed_stems'])

    def test_real_cli_modes_and_convenience_entry(self):
        # Run actual executable argument parsing in fresh processes; all game,
        # encoder and share effects remain the offline fixture's temp files.
        driver = r"""
import contextlib, io, json, os, runpy, sys
from pathlib import Path
from test_mod_incremental import Lifecycle
import build_mod as b
case = Lifecycle('test_initial_nochange_one_audio_old_selection_cancel')
case.setUp()
os.environ['FF7_PROJECT_ROOT'] = str(case.root)
try:
    entry, baseline, *args = sys.argv[1:]
    if baseline == 'yes':
        case.run_build('--full')
    before = len(case.calls)
    sys.argv = [entry, *args]
    error = None
    with contextlib.redirect_stdout(io.StringIO()):
        try:
            if entry == 'build_mod.py':
                b.main()  # actual main/parser, with offline fixture dependencies
            else:
                runpy.run_path(entry, run_name='__main__')
        except SystemExit as exc:
            if exc.code not in (0, None): error = str(exc.code)
        except RuntimeError as exc:
            error = str(exc)
    path = b.BUILD_ROOT/'state/latest.json'
    state = json.loads(path.read_text()) if path.exists() else None
    print(json.dumps(dict(error=error, calls=len(case.calls)-before,
        mode=case.manifest(state)['incremental']['mode'] if state else None)))
finally:
    case.doCleanups()
"""
        cases = [
            ('build_mod.py', 'yes', [], 'full', 2, False),
            ('build_mod.py', 'yes', ['--full'], 'full', 2, False),
            ('build_mod.py', 'yes', ['--incremental'], 'full', 0, False),
            ('build_mod.py', 'yes', ['--full','--incremental'], 'full', 0, True),
            ('build_mod.py', 'no', ['--incremental'], None, 0, True),
            ('build_mod_incremental.py', 'no', [], None, 0, True),
            ('build_mod_incremental.py', 'yes', [], 'full', 0, False),
            ('build_mod_incremental.py', 'yes', ['--full'], 'full', 0, True),
        ]
        for entry, baseline, args, mode, calls, error in cases:
            with self.subTest(entry=entry, args=args, baseline=baseline):
                # b.subprocess.run is mocked by the release fixture; use Popen.
                process = subprocess.Popen([sys.executable, '-c', driver, entry, baseline, *args],
                    cwd=Path(__file__).parent, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
                stdout, stderr = process.communicate(timeout=30)
                self.assertEqual(process.returncode, 0, stderr)
                got = json.loads(stdout)
                self.assertEqual((got['mode'],got['calls'],bool(got['error'])), (mode,calls,error), got)

    def test_cache_policy_isolates_algorithm_changes(self):
        original = asset([64])[0]
        with patch.object(b,'_CACHE_POLICY','old-algorithm'):
            old = b.source_audio_key(original,[1,'a.wav'],[self.data/'a.wav'])
        with patch.object(b,'_CACHE_POLICY','new-algorithm'):
            new = b.source_audio_key(original,[1,'a.wav'],[self.data/'a.wav'])
        self.assertNotEqual(old,new)

    def test_bootstrap_evidence_rejects_wrong_ids_sha_stat_and_late_metadata(self):
        from bootstrap_mod_state import validate_evidence
        from datetime import datetime, timezone
        selected = copy.deepcopy(self.rows)
        started = time.time()
        stamp = datetime.fromtimestamp(started-1, timezone.utc).isoformat()
        metadata = [dict(r,line_updated_at=stamp,meta_updated_at=stamp) for r in selected]
        audio = []
        for row in selected:
            path = self.data/row['audio_path']; stat = path.stat()
            audio.append(dict(stem=row['stem'],id=row['id'],audio_path=row['audio_path'],
                sha256=inc.sha(path),size=stat.st_size,mtime_ns=stat.st_mtime_ns,
                ctime_ns=stat.st_ctime_ns,sample_stable=True,post_build_start_change=False))
        ae, me = self.root/'ae.json', self.root/'me.json'
        for kind in ('ids','sha','stat','unstable','late-audio','late-metadata','missing-meta-time','start','selection'):
            aa, mm = copy.deepcopy(audio), copy.deepcopy(metadata)
            boundary = started
            if kind == 'ids': aa[0]['id'] = 999
            if kind == 'sha': aa[0]['sha256'] = '0'*64
            if kind == 'stat': aa[0]['size'] += 1
            if kind == 'unstable': aa[0]['sample_stable'] = False
            if kind == 'late-audio': aa[0]['ctime_ns'] = int((started+1)*1e9)
            if kind == 'late-metadata': mm[0]['line_updated_at'] = datetime.fromtimestamp(started+1,timezone.utc).isoformat()
            if kind == 'missing-meta-time': mm[0].update(extra={'slice_start_s':1},meta_updated_at=None)
            if kind == 'start': boundary += 1
            if kind == 'selection': mm[0]['voice_gpu_key'] = 'changed'
            ae.write_text(json.dumps(dict(actual_build_started=boundary,rows=aa)))
            me.write_text(json.dumps(dict(actual_build_started=started,rows=mm)))
            with self.subTest(kind=kind), self.assertRaises(RuntimeError):
                validate_evidence(ae,me,started,selected,self.data)
        with self.assertRaisesRegex(RuntimeError, '同时提供'):
            validate_evidence(ae,None,started,selected,self.data)

    def test_bootstrap_complete_evidence_reuses_generated_slices_and_battle_without_cache(self):
        from datetime import datetime, timezone
        self.rows[0].update(id=None, audio_path=None)
        (self.data/'material.wav').write_bytes(b'material')
        (self.data/'movie.wav').write_bytes(b'movie')
        original_movie = asset([96])[0]
        self.write_pack(self.game/'movie.utoc', [(self.cid(4),original_movie,self.rel('bank','MV'))], 55)
        added = [dict(stem=f'movie{i}', region='MV', pack='jp-only', id=10+i,
                      audio_path='movie.wav', voice_gpu_key='generated', text_zh='',
                      subtitle_text=None, tts_text='', jp_chunk_id=self.cid(4).hex(),
                      jp_container='movie', asset_path='../../../'+self.rel('bank','MV'),
                      extra=dict(slice_start_s=i,slice_end_s=i+1,voice_channel=0)) for i in range(2)]
        battle = [dict(stem='material', pack=self.rows[0]['pack'], id=20,
                       audio_path='material.wav', voice_gpu_key='generated',
                       extra=dict(bank_stem='a',bank_material_index=0))]
        selected = [copy.deepcopy(self.rows[1]), *copy.deepcopy(added), *copy.deepcopy(battle)]
        started = time.time()
        stamp = datetime.fromtimestamp(started-5, timezone.utc).isoformat()
        metadata = [dict(r, line_updated_at=stamp, meta_updated_at=stamp,
                         metadata_potentially_post_start=False, subtitle_parent_stem=None) for r in selected]
        audio = []
        for r in selected:
            path = self.data/r['audio_path']; stat = path.stat()
            audio.append(dict(stem=r['stem'], id=r['id'], audio_path=r['audio_path'],
                              sha256=inc.sha(path), size=stat.st_size, mtime_ns=stat.st_mtime_ns,
                              ctime_ns=stat.st_ctime_ns, sample_stable=True, post_build_start_change=False))
        before = self.root/'before.py'; before.write_text('immutable start source')
        receipt = self.root/'receipt.json'
        receipt.write_text(json.dumps(dict(started=started,source_sha256=inc.sha(before),locked_count=len(selected))))
        snapshot = self.root/'locked.json'; snapshot.write_text(json.dumps(selected))
        ae = self.root/'audio.json'; me = self.root/'metadata.json'
        ae.write_text(json.dumps(dict(actual_build_started=started,rows=audio)))
        me.write_text(json.dumps(dict(actual_build_started=started,rows=metadata)))
        def save_cache(original, payload, selection, paths, name):
            h = hashlib.sha256(original)
            h.update(json.dumps(selection,sort_keys=True,ensure_ascii=False).encode())
            for path in paths: h.update(path.read_bytes())
            dest = b.BUILD_ROOT/'cache'/name(h.hexdigest())
            dest.parent.mkdir(exist_ok=True)
            dest.write_bytes(payload)
            return str(dest)
        def ordinary_cache(task):
            path = Path(self.encode(task))
            stem, selected_id, audio_path, raw = task
            return save_cache(bytes.fromhex(raw),path.read_bytes(),[selected_id,audio_path],
                              [b.DATA/audio_path],lambda h:f'{stem}-{selected_id}-{h[:32]}.uasset')
        def added_cache(task):
            bank,path,slices,cache = task
            raw = Path(path).read_bytes()
            payload = b.repair_audio_exports(raw,raw+b'ADDED-CACHE')
            b.audit_encode('added-fixture',dict(bank=bank))
            base = Path(cache)
            return save_cache(raw,payload,slices,[b.DATA/p['audio'] for p in slices],
                              lambda h:base.stem+'-'+h[:32]+'.uasset')
        def battle_cache(bank,raw,group):
            payload = b.repair_audio_exports(raw,raw+b'BATTLE-CACHE')
            h = hashlib.sha256(raw)
            for row in group:
                h.update(json.dumps([0,row['id'],row['audio_path']]).encode())
                h.update((b.DATA/row['audio_path']).read_bytes())
            dest = b.BUILD_ROOT/'cache'/f'{bank}-materials-{h.hexdigest()[:24]}.uasset'
            dest.parent.mkdir(exist_ok=True); dest.write_bytes(payload)
            b.audit_encode('battle-fixture',dict(bank=bank))
            return payload
        with patch.object(b,'load_build_snapshot',side_effect=lambda *args:(copy.deepcopy(self.rows),copy.deepcopy(added),copy.deepcopy(battle))), patch.object(b,'rebuild_locked',side_effect=ordinary_cache), patch.object(b,'rebuild_added_bank',side_effect=added_cache), patch.object(b,'rebuild_battle_bank',side_effect=battle_cache):
            first = self.run_build('--full')
        (b.BUILD_ROOT/'state/latest.json').unlink()
        # Missing legacy proof remains dirty; never invent a reusable fingerprint.
        for pattern, expected_dirty in (('add-*.uasset',2), ('a-materials-*.uasset',1)):
            cache = next((b.BUILD_ROOT/'cache').glob(pattern))
            saved = cache.read_bytes(); cache.unlink()
            result = initialize(b,first['output'],self.share/b.sh_date()/'0',receipt,snapshot,before,
                                audio_evidence=ae,metadata_evidence=me)
            self.assertEqual(result['dirty_stems'],expected_dirty)
            self.assertEqual(result['reusable_chunks'],2)
            cache.write_bytes(saved)
        with patch.object(b,'load_build_snapshot',side_effect=AssertionError('no current DB')):
            result = initialize(b,first['output'],self.share/b.sh_date()/'0',receipt,snapshot,before,
                                apply=True,audio_evidence=ae,metadata_evidence=me)
        self.assertEqual(result['reusable_chunks'],3)
        self.assertEqual(result['dirty_stems'],0)
        shutil.rmtree(b.BUILD_ROOT/'cache')
        with patch.object(b,'load_build_snapshot',side_effect=lambda *args:(copy.deepcopy(self.rows),copy.deepcopy(added),copy.deepcopy(battle))), patch.object(b,'rebuild_locked',side_effect=AssertionError('ordinary encoded')), patch.object(b,'rebuild_added_bank',side_effect=AssertionError('JP slice encoded')), patch.object(b,'rebuild_battle_bank',side_effect=AssertionError('battle encoded')):
            second = self.run_build('--incremental')
        report = self.manifest(second)['incremental']
        self.assertEqual(report['audio_encodes'],0)
        self.assertEqual(report['changed_stems'],[])
        self.assertEqual(set(report['reused_chunks']),{'cn:'+self.cid(1).hex(),'cn:'+self.cid(2).hex(),'add:'+self.cid(4).hex()})
        self.assertNotIn('详细构建证据', json.dumps(self.manifest(second)))
        install = (Path(second['output'])/'安装说明.txt').read_text()
        self.assertIn('manifest.json',install)
        self.assertNotIn('"same_stem_aliases"',install)

    def test_bootstrap_uses_receipt_snapshot_without_db_and_dry_run(self):
        # Create immutable content-keyed cache evidence like the real running build.
        def real_cache(task):
            path = Path(self.encode(task))
            stem, selected, audio, original = task
            key = b.source_audio_key(bytes.fromhex(original),[selected,audio],[b.DATA/audio])
            dest = b.BUILD_ROOT/'cache'/f'{stem}-{selected}-{key}.uasset'
            dest.parent.mkdir(exist_ok=True)
            shutil.copyfile(path,dest)
            return str(dest)
        before = self.root/'before.py'; before.write_text('immutable source')
        receipt = self.root/'receipt.json'
        snapshot = self.root/'locked.json'
        selected = copy.deepcopy(self.rows)
        snapshot.write_text(json.dumps(selected))
        receipt.write_text(json.dumps(dict(started=time.time()+.01, source_sha256=inc.sha(before),locked_count=2)))
        with patch.object(b,'rebuild_locked',side_effect=real_cache):
            first = self.run_build()
        # Bootstrap applies only to a pre-incremental output, never replace existing baseline.
        (b.BUILD_ROOT/'state/latest.json').unlink()
        self.rows[0]['id'] = 999  # current DB state must not affect initialization
        with patch.object(b,'load_build_snapshot',side_effect=AssertionError('must not query database')):
            result = initialize(b, first['output'],self.share/b.sh_date()/'0',receipt,snapshot,before)
            self.assertEqual(result['reusable_chunks'],2)
            self.assertFalse((b.BUILD_ROOT/'state/latest.json').exists())
            # An audio file edited after the real start must never be blessed by bootstrap.
            edited = self.data/'a.wav'
            edited.write_bytes(b'post-start edit')
            started = json.loads(receipt.read_text())['started']
            os.utime(edited,(started+1,started+1))
            initialize(b, first['output'],self.share/b.sh_date()/'0',receipt,snapshot,before,apply=True)
        baseline = json.loads((b.BUILD_ROOT/'state/latest.json').read_text())
        self.assertEqual(baseline['started'],json.loads(receipt.read_text())['started'])
        self.assertEqual(baseline['selection'],inc.effective_selection([selected,[],[]]))
        self.assertIsNone(baseline['input_id'])
        self.assertTrue(baseline['late_inputs'])
        self.assertIn('a',baseline['bootstrap']['dirty_stems'])
        self.assertNotIn('cn:'+self.cid(1).hex(),baseline['chunks'])
        # Stop using the deliberately future mtime after testing bootstrap refusal.
        os.utime(edited, None)
        shutil.rmtree(b.BUILD_ROOT/'cache')
        count = len(self.calls)
        next_state = self.run_build()
        self.assertEqual(len(self.calls),count+1)  # dirty a only; proven b survives cache deletion
        self.assertIn('cn:'+self.cid(2).hex(),self.manifest(next_state)['incremental']['reused_chunks'])


if __name__ == '__main__': unittest.main()
