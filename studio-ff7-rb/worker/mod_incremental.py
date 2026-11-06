"""Content-addressed NEXT build state. No database, encoder or network operations.

Only a locally verified complete release whose share copy matches may be committed.
State references the newest complete local drop; it never references a delta chain.
"""
from __future__ import annotations

import contextlib
import fcntl
import hashlib
import json
import os
from pathlib import Path
import shutil
import time
import uuid

SCHEMA = 1
# Deliberate algorithm version; orchestration changes do not invalidate audio.
AUDIO_POLICY = 'sqex-samestem-ev-mv-place-channel-20261102-v1'


def digest(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, ensure_ascii=False,
                                     separators=(',', ':')).encode()).hexdigest()


def sha(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + '.' + uuid.uuid4().hex + '.tmp')
    with tmp.open('w', encoding='utf-8') as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2)
        stream.write('\n')
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(tmp, path)
    fd = os.open(path.parent, os.O_DIRECTORY)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


@contextlib.contextmanager
def build_lock(root):
    state = Path(root) / 'state'
    state.mkdir(parents=True, exist_ok=True)
    with (state / 'build.lock').open('a') as stream:
        try:
            fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise RuntimeError('已有打包进程持有增量构建锁') from None
        yield


def inventory(folder):
    folder = Path(folder)
    return {str(p.relative_to(folder)): sha(p) for p in sorted(folder.rglob('*')) if p.is_file()}


def verify_files(folder, files):
    for rel, expected in files.items():
        path = Path(folder) / rel
        if not path.is_file() or sha(path) != expected:
            raise RuntimeError(f'发布文件缺失或 SHA256 不符: {path}')


def compare_share(local, remote):
    files = inventory(local)
    if inventory(remote) != files:
        raise RuntimeError('共享盘整文件 SHA256/文件清单不一致；保留旧基线和所有本地包')
    return files


def inputs(paths, cache_path=None):
    # ctime + inode catches same-path edits even if mtime/size were restored.
    # Cached values are SHA256 of bytes, never timestamps as content identity.
    cached = {}
    if cache_path and Path(cache_path).exists():
        try:
            cached = json.loads(Path(cache_path).read_text())
        except (ValueError, OSError):
            pass
    updated, result = {}, {}
    for path in sorted(set(map(Path, paths))):
        if not path.is_file():
            continue
        before = path.stat()
        stamp = [before.st_dev, before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns]
        old = cached.get(str(path), {})
        value = old.get('sha256') if old.get('stat') == stamp else sha(path)
        after = path.stat()
        if stamp != [after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns]:
            raise RuntimeError(f'计算指纹时源文件变化: {path}')
        result[str(path)] = value
        updated[str(path)] = dict(stat=stamp, sha256=value)
    if cache_path:
        atomic_json(cache_path, updated)
    return result


def audio_fingerprint(original, selection, audio_hashes):
    return digest([AUDIO_POLICY, hashlib.sha256(original).hexdigest(), selection, audio_hashes])


# Match the three SELECT projections, excluding unlocked text/candidates entirely.
SELECTION_FIELDS = (
    ('stem', 'region', 'pack', 'asset_path', 'text_zh', 'id', 'audio_path', 'subtitle_text', 'voice_gpu_key', 'subtitle_parent_stem'),
    ('stem', 'region', 'pack', 'asset_path', 'text_zh', 'jp_chunk_id', 'jp_container',
     'id', 'audio_path', 'subtitle_text', 'tts_text', 'voice_gpu_key', 'extra'),
    ('stem', 'pack', 'id', 'audio_path', 'voice_gpu_key', 'extra'),
)


def effective_selection(groups):
    return [sorted(({k: r.get(k) for k in fields} for r in group if r.get('id') is not None),
                   key=lambda r: r['stem']) for fields, group in zip(SELECTION_FIELDS, groups)]


class Session:
    def __init__(self, root, day, scope, policy, full=True, publish=True, started=None):
        self.root = Path(root)
        self.start = time.time() if started is None else started
        self.id = uuid.uuid4().hex
        self.out = self.root / day / ('in-progress-' + self.id)
        self.out.mkdir(parents=True)
        self.scope, self.policy, self.publish = scope, policy, publish
        self.previous = None
        self.prior_release = None
        self.reason = '没有可信基线'
        self.chunks = {}
        self.containers = {}
        self.loaded = {}
        self.encoded = []
        self.reused_chunks = []
        self.changed_containers = []
        self.reused_containers = []
        self.late_inputs = []
        path = self.root / 'state/latest.json'
        if path.exists():
            try:
                previous = json.loads(path.read_text())
                if previous['schema'] != SCHEMA:
                    raise RuntimeError('未知基线格式')
                utocs = [rel for rel in previous['files'] if rel.startswith('End/') and rel.endswith('.utoc')]
                if not utocs or any(str(Path(rel).with_suffix(ext)) not in previous['files']
                                    for rel in utocs for ext in ('.pak', '.ucas')):
                    raise RuntimeError('基线不是完整容器三件套')
                verify_files(previous['output'], previous['files'])
                self.prior_release = previous
                if full:
                    self.reason = '--full 强制全量'
                elif previous['scope'] != scope or previous['policy'] != policy:
                    self.reason = '构建策略或章节范围不匹配'
                else:
                    self.previous = previous
                    self.reason = '可信基线增量'
            except (ValueError, KeyError, OSError, RuntimeError) as exc:
                self.reason = f'基线不可用: {exc}'
        elif full:
            self.reason = '--full 强制全量'
        if not full and self.previous is None:
            raise RuntimeError(self.reason + "; 拒绝增量，保留旧基线和旧包。全量须由用户选择 --full")
        print(self.reason, flush=True)

    def freeze_audio(self, rows, data):
        """Copy and hash selected bytes, so editing a WAV during encoding cannot leak in."""
        frozen = self.out / 'input-audio'
        frozen.mkdir()
        hashes = {}
        for rel in sorted({r['audio_path'] for r in rows if r.get('audio_path')}):
            source = Path(data) / rel
            if Path(rel).is_absolute() or '..' in Path(rel).parts:
                raise RuntimeError(f'非法音频路径 {rel}')
            before = source.stat()
            target = frozen / rel
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)
            hashes[rel] = sha(target)
            after = source.stat()
            if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (after.st_size, after.st_mtime_ns, after.st_ctime_ns):
                raise RuntimeError(f'复制时音频改变，重试构建: {rel}')
            if max(after.st_mtime, after.st_ctime) > self.start:
                raise RuntimeError(f'音频在构建起点之后、冻结之前改变，无法证明起点字节: {rel}；请重试；保留旧基线和旧包，未编码/发布')
        self.audio_hashes = hashes
        return frozen

    def snapshot(self, rows, source_files):
        self.sources = inputs(source_files, self.root / 'state/source-sha256.json')
        self.late_inputs.extend(str(p) for p in map(Path, self.sources)
                                if max(p.stat().st_mtime, p.stat().st_ctime) > self.start)
        if self.late_inputs:
            raise RuntimeError("源资源晚于构建起点，无法证明起点字节；重试，保留旧基线和旧包")
        self.selection = effective_selection(rows)
        self.input_id = digest([self.selection, self.sources, self.audio_hashes])
        atomic_json(self.out / 'build-start.json', dict(started=self.start, selection=rows,
                    sources=self.sources, audio=self.audio_hashes, policy=self.policy, scope=self.scope))

    def no_change(self):
        return (self.previous and not self.previous.get('late_inputs') and not self.late_inputs
                and self.previous.get('input_id') == self.input_id)

    def reuse_chunk(self, key, fingerprint, extract, validate):
        entry = (self.previous or {}).get('chunks', {}).get(key)
        if not entry or entry['fingerprint'] != fingerprint:
            return None
        pack = entry['pack']
        if pack not in self.loaded:
            entries = {k: v for k, v in self.previous['chunks'].items() if v['pack'] == pack}
            wanted = {bytes.fromhex(v['cid']): k for k, v in entries.items()}
            utoc = Path(self.previous['output']) / 'End/Content/Paks/~mods' / (pack + '.utoc')
            got = extract(utoc, wanted, strict=True)
            for k, value in entries.items():
                payload = got[k]
                if hashlib.sha256(payload).hexdigest() != value['sha256']:
                    raise RuntimeError(f'旧 chunk SHA 不符: {k}')
                validate(payload)
            self.loaded[pack] = got
        self.reused_chunks.append(key)
        return self.loaded[pack][key]

    def remember(self, key, fingerprint, pack, cid, rel, payload, encoded=False, stems=()):
        self.chunks[key] = dict(fingerprint=fingerprint, pack=pack, cid=cid.hex(), rel=rel,
                               sha256=hashlib.sha256(payload).hexdigest(), stems=list(stems))
        if encoded:
            self.encoded.append(key)

    def container(self, pack, signature, destination):
        """Return true after copying a verified identical previous container trio."""
        self.containers[pack] = signature
        previous = self.previous or {}
        if previous.get('containers', {}).get(pack) != signature:
            self.changed_containers.append(pack)
            return False
        source = Path(previous['output']) / 'End/Content/Paks/~mods'
        for path in source.glob(pack + '.*'):
            if path.suffix in ('.utoc', '.ucas', '.pak'):
                target = Path(destination) / path.name
                shutil.copy2(path, target)
                rel = str(path.relative_to(previous['output']))
                if sha(target) != previous['files'].get(rel):
                    raise RuntimeError(f'复用时旧容器发生变化: {path}')
        self.reused_containers.append(pack)
        return True

    def report(self):
        prior = self.prior_release or {}
        optional = ('aa_cn_voice_edit_P', 'zzz_cn_voice_add_P')
        if prior:
            old_files = {rel:value for rel,value in prior.get('files', {}).items()
                         if prior.get('scope') == self.scope or Path(rel).stem in optional}
        else:
            # A full installation without trusted history must remove stale optional overlays.
            old_files = {f'End/Content/Paks/~mods/{pack}{ext}':None
                         for pack in optional for ext in ('.utoc', '.ucas', '.pak')}
        current = inventory(self.out / 'End')
        deleted = sorted(rel for rel in old_files if rel.startswith('End/') and rel[4:] not in current)
        old_stems = {r['stem']: digest(r) for group in (self.previous or {}).get('selection', []) for r in group}
        new_stems = {r['stem']: digest(r) for group in self.selection for r in group}
        # Audio changes under an unchanged database ID must appear in changed_stems too.
        changed = {s for s in old_stems.keys() | new_stems.keys() if old_stems.get(s) != new_stems.get(s)}
        old_audio = (self.previous or {}).get('audio_hashes', {})
        changed_audio = {p for p in self.audio_hashes if old_audio.get(p) != self.audio_hashes[p]}
        changed.update(r['stem'] for group in self.selection for r in group if r.get('audio_path') in changed_audio)
        old_chunks = (self.previous or {}).get('chunks', {})
        for key in old_chunks.keys() | self.chunks.keys():
            old, new = old_chunks.get(key, {}), self.chunks.get(key, {})
            if old.get('fingerprint') != new.get('fingerprint'):
                changed.update(old.get('stems', []))
                changed.update(new.get('stems', []))
        log = self.out / 'encoding-events.jsonl'
        events = [json.loads(line) for line in log.read_text().splitlines()] if log.exists() else []
        return dict(mode='incremental' if self.previous else 'full', fallback_reason=self.reason,
                    build_id=self.id, policy=self.policy,
                    input_snapshot=dict(file='build-start.json', sha256=sha(self.out / 'build-start.json')),
                    output_files_sha256={'End/' + rel:value for rel,value in current.items()},
                    build_started=self.start, previous_baseline=(self.prior_release or {}).get('id'),
                    changed_containers=self.changed_containers, reused_containers=self.reused_containers,
                    changed_stems=sorted(changed), deleted_files=deleted,
                    encoded_chunks=events, audio_encodes=len(events), rebuild_requested_chunks=self.encoded,
                    reused_chunks=self.reused_chunks,
                    late_inputs=self.late_inputs, input_id=self.input_id)

    def commit(self, remote):
        if not self.publish:
            return False
        if inputs(map(Path, self.sources), self.root / 'state/source-sha256.json') != self.sources:
            raise RuntimeError('构建期间源资源改变；不升级基线、不删旧包')
        mods = self.out / 'End/Content/Paks/~mods'
        for pack in self.containers:
            if any(not (mods / (pack + ext)).is_file() for ext in ('.utoc', '.ucas', '.pak')):
                raise RuntimeError(f'输出三件套不完整: {pack}')
        files = compare_share(self.out, remote)
        verified = self.out.with_name('verified-' + self.id)
        self.out.rename(verified)
        self.out = verified
        state = dict(schema=SCHEMA, id=self.id, started=self.start, output=str(self.out.resolve()),
                     scope=self.scope, policy=self.policy, files=files, input_id=self.input_id,
                     chunks=self.chunks, containers=self.containers, selection=self.selection,
                     sources=self.sources, audio_hashes=self.audio_hashes, late_inputs=self.late_inputs)
        atomic_json(self.root / 'state/latest.json', state)
        return True
