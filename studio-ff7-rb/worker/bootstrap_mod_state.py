#!/usr/bin/env python3
"""Initialize ONLY after the running pre-incremental full build is finally verified.

Default is read-only dry-run. Never queries current DB. Unprovable inputs remain dirty.
Invoke with FF7_PROJECT_ROOT set before importing build_mod (or --project-root CLI).
"""
from __future__ import annotations
import argparse
from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import sys
import time

import mod_incremental as inc


def predates(path, started):
    stat = Path(path).stat()
    return max(stat.st_mtime, stat.st_ctime) <= started


def evidence_rows(path, started, selected):
    doc = json.loads(Path(path).read_text())
    if doc['actual_build_started'] != started:
        raise RuntimeError('补充证据起点与 receipt 不符')
    rows = doc['rows']
    expected = {(r['stem'], r['id']) for r in selected}
    if len(rows) != len(expected) or {(r['stem'], r['id']) for r in rows} != expected:
        raise RuntimeError('补充证据不是完整 start IDs')
    return {r['stem']: r for r in rows}


def validate_evidence(audio_path, metadata_path, started, selected, data):
    if bool(audio_path) != bool(metadata_path):
        raise RuntimeError('audio-evidence 和 metadata-evidence 必须同时提供')
    if not audio_path:
        return selected
    audio = evidence_rows(audio_path, started, selected)
    metadata = evidence_rows(metadata_path, started, selected)
    result = []
    for locked in selected:
        stem = locked['stem']
        row, proof = metadata[stem], audio[stem]
        kind = 2 if 'bank_material_index' in (row.get('extra') or {}) else (0 if row.get('pack', '').startswith('zzz_cn_voice_') else 1)
        missing = set(inc.SELECTION_FIELDS[kind]) - row.keys()
        if missing:
            raise RuntimeError(f'历史元数据字段缺失: {stem} {sorted(missing)}')
        for key, value in locked.items():
            if key in row and row[key] != value:
                raise RuntimeError(f'历史选择/元数据不一致: {stem} {key}')
        for key in ('line_updated_at', 'meta_updated_at'):
            stamp = row.get(key)
            if (not stamp and key == 'line_updated_at') or (stamp and datetime.fromisoformat(stamp).timestamp() > started):
                raise RuntimeError(f'元数据无法证明早于起点: {stem} {key}')
        if row.get('metadata_potentially_post_start') or (row.get('extra') and not row.get('meta_updated_at')):
            raise RuntimeError(f'元数据晚于起点/时间缺失: {stem}')
        rel = row['audio_path']
        if Path(rel).is_absolute() or '..' in Path(rel).parts or proof['audio_path'] != rel:
            raise RuntimeError(f'音频证据路径不符: {stem}')
        path = Path(data) / rel
        stat = path.stat()
        stamp = (stat.st_size, stat.st_mtime_ns, stat.st_ctime_ns)
        if (not proof['sample_stable'] or proof['post_build_start_change']
                or max(proof['mtime_ns'], proof['ctime_ns']) / 1e9 > started
                or stamp != (proof['size'], proof['mtime_ns'], proof['ctime_ns'])
                or inc.sha(path) != proof['sha256']
                or (path.stat().st_size, path.stat().st_mtime_ns, path.stat().st_ctime_ns,
                    path.stat().st_dev, path.stat().st_ino) != (*stamp, stat.st_dev, stat.st_ino)):
            raise RuntimeError(f'音频证据 SHA/stat/起点不符: {stem}')
        result.append(row)
    return result


def cache_proves(builder, original, payload, candidates):
    return any(path.is_file() and builder.repair_audio_exports(original, path.read_bytes()) == payload
               for path in candidates)


def initialize(builder, output, share, receipt_path, snapshot_path, before_path, apply=False, audio_evidence=None, metadata_evidence=None):
    b = builder
    output, share = Path(output).resolve(), Path(share).resolve()
    receipt = json.loads(Path(receipt_path).read_text())
    selected = json.loads(Path(snapshot_path).read_text())
    manifest = json.loads((output / 'manifest.json').read_text())
    started = float(receipt['started'])
    if apply and receipt.get('pid'):
        cmdline = Path('/proc') / str(int(receipt['pid'])) / 'cmdline'
        if cmdline.exists() and b'build_mod.py' in cmdline.read_bytes():
            raise RuntimeError('真实全量打包进程仍在运行；禁止提前初始化')
    if inc.sha(before_path) != receipt['source_sha256']:
        raise RuntimeError('开包源码 SHA 与真实 start receipt 不符')
    if len(selected) != receipt['locked_count'] or len({r['stem'] for r in selected}) != len(selected):
        raise RuntimeError('开包前选择快照数量/唯一性不符')
    if manifest['chapters'] != 'all' or manifest.get('regions') is not None:
        raise RuntimeError('迁移只接受本次全范围完整构建')
    if not manifest['validation'].get('strict_oodle_roundtrip'):
        raise RuntimeError('缺少原构建严格校验声明')
    aliases = manifest['same_stem_aliases']
    coverage = manifest['same_stem_coverage']
    if len(aliases) != manifest['same_stem_additional_assets']:
        raise RuntimeError('alias proof 数量不符')
    if len(coverage) < 2 * len(aliases):
        raise RuntimeError('同 stem EV/MV 覆盖证据不完整')
    files = inc.compare_share(output, share)
    mods = output / 'End/Content/Paks/~mods'
    expected_source_packs = {p.stem for p in b.CN_MODS.glob('zzz_cn_voice_*_P.utoc')}
    if manifest.get('trial_limit') or manifest['voice_files'] < sum(r.get('pack') in expected_source_packs for r in selected):
        raise RuntimeError('试跑/不完整选择范围不能初始化正式基线')
    expected_packs = set(manifest['mod'])
    if manifest.get('subtitle_mod'):
        expected_packs.add(manifest['subtitle_mod'])
    emitted = {p.stem for p in mods.glob('*.utoc')}
    if (not expected_source_packs or not expected_source_packs.issubset(expected_packs)
            or emitted != expected_packs
            or not emitted.issubset(expected_source_packs | {b.ADD_PACK, b.MOD_STEM})):
        raise RuntimeError('本次输出不是相同命名的完整安装集')
    for pack in expected_packs:
        if any(not (mods / (pack + ext)).is_file() for ext in ('.utoc', '.ucas', '.pak')):
            raise RuntimeError(f'本次输出容器三件套不完整: {pack}')
    payloads = {}
    catalogs = {}
    for utoc in sorted(mods.glob('*.utoc')):
        catalog = b.iter_pack_assets(utoc, full_paths=True)
        catalogs[utoc.stem] = catalog
        identities = list(catalog.values())
        seen = set()
        for offset in range(0, len(identities), 128):
            batch = identities[offset:offset + 128]
            wanted = {}
            for cid, rel in batch:
                if cid in seen or cid in payloads:
                    raise RuntimeError(f'重复 CID: {cid.hex()}')
                seen.add(cid)
                wanted[cid] = cid
            got = b.extract_chunk_ids(utoc, wanted, strict=True)
            for cid, data in got.items():
                b.validate_zen_exports(data)
                payloads[cid] = (utoc.stem, data)
    for entry in coverage:
        cid = b.chunk_id_bytes(entry['chunk_id'])
        pack, data = payloads[cid]
        if (pack != entry['pack'] or
                hashlib.sha256(data).hexdigest() != entry['sha256'] or
                catalogs[pack].get(b.rel_in_container(entry['path'])) != (cid, b.rel_in_container(entry['path']))):
            raise RuntimeError(f'同 stem 覆盖 SHA/路径不符 {entry["stem"]}')
    selected = validate_evidence(audio_evidence, metadata_evidence, started, selected, b.DATA)
    selected_by_stem = {r['stem']: r for r in selected}
    policy_id = b.build_policy()
    chunks, audio_hashes, dirty, containers = {}, {}, [], {}
    source_catalogs = {p.stem:b.iter_pack_assets(p) for p in sorted(b.CN_MODS.glob('*.utoc'))}
    ordinary = [r for r in selected if r.get("pack") in source_catalogs and "bank_material_index" not in b._extra(r)]
    added = [r for r in selected if r.get("pack") not in source_catalogs]
    battle = [r for r in selected if "bank_material_index" in b._extra(r)]
    proved_original = set()
    for pack, catalog in source_catalogs.items():
        for cid, rel in catalog.values():
            if catalogs.get(pack, {}).get(rel) != (cid, rel) or payloads.get(cid, (None,))[0] != pack:
                raise RuntimeError(f'中文源/成品 CID、路径或容器不符: {pack} {rel}')
        group = [r for r in ordinary if r.get('pack') == pack and r['stem'] in catalog]
        wanted = {catalog[r['stem']][0]:r['stem'] for r in group}
        originals = b.extract_chunk_ids(b.CN_MODS / (pack + '.utoc'), wanted, strict=True)
        source_files = list(b.CN_MODS.glob(pack + '.*'))
        if pack in catalogs and all(predates(p, started) for p in source_files):
            # Establish the same desired-payload signature as NEXT's writer. Include
            # bank-material replacements not represented in the old row snapshot.
            all_source = b.extract_chunk_ids(b.CN_MODS / (pack + '.utoc'),
                                             {cid:cid for cid,rel in catalog.values()}, strict=True)
            replacement_ids = {catalog[r['stem']][0] for r in group if r['voice_gpu_key'] != 'cn-original'}
            replacement_ids.update(cid for cid,data in all_source.items() if payloads[cid][1] != data)
            containers[pack] = inc.digest([inc.inputs(source_files),
                {cid.hex():hashlib.sha256(payloads[cid][1]).hexdigest() for cid in replacement_ids}])
        for row in group:
            stem = row['stem']
            if not all(predates(p, started) for p in source_files):
                dirty.append(stem)
                continue
            cid, rel = catalog[stem]
            if cid not in payloads:
                raise RuntimeError(f'完整包缺少开包选择 {stem}')
            original = originals[stem]
            audio = b.DATA / row['audio_path']
            if not audio.is_file() or not predates(audio, started):
                dirty.append(stem)
                continue
            audio_hash = inc.sha(audio)
            audio_hashes[row['audio_path']] = audio_hash
            fp = inc.audio_fingerprint(original, [row['id'], row['audio_path'], row['voice_gpu_key']], [audio_hash])
            payload = payloads[cid][1]
            if row['voice_gpu_key'] == 'cn-original':
                if payload != original:
                    raise RuntimeError(f'cn-original 不是源字节 {stem}')
                proved_original.add(stem)
                continue
            # The currently running builder predates cache policy namespaces.
            # Probe both byte-identical legacy evidence and the new namespace.
            candidates = []
            for policy in ('', policy_id):
                h = hashlib.sha256(original)
                h.update(policy.encode())
                h.update(json.dumps([int(row['id']), row['audio_path']], sort_keys=True, ensure_ascii=False).encode())
                h.update(audio.read_bytes())
                key = h.hexdigest()[:32]
                candidates.append(b.BUILD_ROOT / 'cache' / f'{stem}-{row["id"]}-{key}.uasset')
            if not any(cache.is_file() and b.repair_audio_exports(original, cache.read_bytes()) == payload
                       for cache in candidates):
                dirty.append(stem)
                continue
            chunks['cn:' + cid.hex()] = dict(fingerprint=fp, pack=pack, cid=cid.hex(), rel=rel,
                                             sha256=hashlib.sha256(payload).hexdigest(), stems=[stem])
    # Complete JP-only slices and battle materials are reconstructed ONLY from
    # the proved start-ID metadata, never a current selected-row query.
    if metadata_evidence:
        for row in added + battle:
            audio_hashes[row['audio_path']] = inc.sha(b.DATA / row['audio_path'])
        for (container, chunk, path), group in b.group_added(added).items():
            cid = b.chunk_id_bytes(chunk)
            rel = b.rel_in_container(path)
            utoc = b.GAME_PAKS / (container + '.utoc')
            if b.iter_pack_assets(utoc, full_paths=True).get(rel) != (cid, rel):
                raise RuntimeError(f'JP-only 源 CID/路径不符: {chunk}')
            if cid not in payloads or payloads[cid][0] != b.ADD_PACK or catalogs[b.ADD_PACK].get(rel) != (cid, rel):
                raise RuntimeError(f'JP-only 成品 CID/路径不符: {chunk}')
            original = b.extract_chunk_ids(utoc, {cid:'source'}, strict=True)['source']
            sliced = group[0]['extra'].get('slice_start_s') is not None
            slices = [dict(stem=r['stem'], audio=r['audio_path'],
                           start=r['extra'].get('slice_start_s') if sliced else None,
                           end=r['extra'].get('slice_end_s') if sliced else None,
                           channel=int(r['extra'].get('voice_channel', 4)) if sliced else 0,
                           keep_japanese=r['voice_gpu_key'] == 'jp-lock')
                      for r in sorted(group, key=lambda r:float(r['extra'].get('slice_start_s') or 0))]
            payload = payloads[cid][1]
            candidates = []
            for policy in ('', policy_id):
                h = hashlib.sha256(original)
                h.update(policy.encode())
                h.update(json.dumps(slices, sort_keys=True, ensure_ascii=False).encode())
                for piece in slices:
                    if not piece['keep_japanese']:
                        h.update((b.DATA / piece['audio']).read_bytes())
                base = b.added_cache_path(cid.hex(), slices)
                candidates.append(base.with_name(base.stem + '-' + h.hexdigest()[:32] + '.uasset'))
            if (not all(predates(p, started) for p in b.GAME_PAKS.glob(container + '.*'))
                    or not ((all(p['keep_japanese'] for p in slices) and original == payload)
                            or cache_proves(b, original, payload, candidates))):
                dirty.extend(r['stem'] for r in group)
                continue
            fp = inc.audio_fingerprint(original, slices, [audio_hashes[p['audio']] for p in slices])
            chunks['add:' + cid.hex()] = dict(fingerprint=fp, pack=b.ADD_PACK, cid=cid.hex(),
                rel=rel, sha256=hashlib.sha256(payload).hexdigest(), stems=[r['stem'] for r in group])
        banks = {}
        for row in battle:
            banks.setdefault(b._extra(row)['bank_stem'], []).append(row)
        for bank, group in banks.items():
            group = sorted(group, key=lambda r:r['stem'])
            packs = {r['pack'] for r in group}
            if len(packs) != 1:
                raise RuntimeError(f'战斗库源包冲突: {bank}')
            pack = next(iter(packs))
            cid, rel = source_catalogs[pack][bank]
            original = b.extract_chunk_ids(b.CN_MODS / (pack + '.utoc'), {cid:'source'}, strict=True)['source']
            payload = payloads[cid][1]
            projected = inc.effective_selection([[], [], group])[2]
            entries = b.material_entries(original)
            indexed = {}
            for row in projected:
                index = int(b._extra(row)['bank_material_index'])
                if index < 0 or index >= len(entries) or index in indexed:
                    raise RuntimeError(f'战斗库 material index 不符: {bank}')
                if row['voice_gpu_key'] == 'jp-lock' and b._extra(row).get('original_material_sha256') != entries[index]['digest']:
                    raise RuntimeError(f'战斗库 JP 原流证明不符: {bank}')
                indexed[index] = row
            changed = {i for i,r in indexed.items() if r['voice_gpu_key'] not in ('cn-original', 'jp-lock')}
            candidates = []
            for policy in ('', policy_id):
                h = hashlib.sha256(original)
                h.update(policy.encode())
                for index in sorted(changed):
                    row = indexed[index]
                    h.update(json.dumps([index, row['id'], row['audio_path']]).encode())
                    h.update((b.DATA / row['audio_path']).read_bytes())
                candidates.append(b.BUILD_ROOT / 'cache' / f'{bank}-materials-{h.hexdigest()[:24]}.uasset')
            if (not all(predates(p, started) for p in b.CN_MODS.glob(pack + '.*'))
                    or not ((not changed and payload == original) or cache_proves(b, original, payload, candidates))):
                dirty.extend(r['stem'] for r in group)
                continue
            b.validate_replacements(original, payload, changed)
            fp = inc.audio_fingerprint(original, projected, [audio_hashes[r['audio_path']] for r in projected])
            chunks['cn:' + cid.hex()] = dict(fingerprint=fp, pack=pack, cid=cid.hex(), rel=rel,
                sha256=hashlib.sha256(payload).hexdigest(), stems=[r['stem'] for r in group])
    # Alias proof contains the actual selected audio digest and its own MV layout.
    for alias in aliases:
        row = selected_by_stem[alias['stem']]
        if int(row['id']) != alias['tts_id']:
            raise RuntimeError('alias 选择与开包前快照不一致')
        cid = b.chunk_id_bytes(alias['chunk_id'])
        original = b.extract_chunk_ids(b.GAME_PAKS / (alias['container'] + '.utoc'), {cid:'source'}, strict=True)['source']
        payload = payloads[cid][1]
        if hashlib.sha256(original).hexdigest() != alias['source_sha256'] or hashlib.sha256(payload).hexdigest() != alias['rebuilt_sha256']:
            raise RuntimeError('alias 源或产物 SHA 不符')
        audio = b.DATA / row['audio_path']
        if (not all(predates(p, started) for p in b.GAME_PAKS.glob(alias['container'] + '.*'))
                or not audio.is_file() or not predates(audio, started)):
            dirty.append(row['stem'])
            continue
        audio_hash = inc.sha(audio)
        if row['voice_gpu_key'] != 'jp-lock' and audio_hash != alias['selected_audio_sha256']:
            dirty.append(row['stem'])
            continue
        if row['voice_gpu_key'] == 'jp-lock' and payload != original:
            raise RuntimeError('日文 alias 不等于该 MV 自己的原始字节')
        fp = inc.audio_fingerprint(original, [row['id'], row['audio_path'], row['voice_gpu_key']], [audio_hash])
        chunks['add:' + cid.hex()] = dict(fingerprint=fp, pack=b.ADD_PACK, cid=cid.hex(),
                                         rel=b.rel_in_container(alias['path']), sha256=hashlib.sha256(payload).hexdigest(), stems=[row['stem']])
    for pack in (b.ADD_PACK, b.MOD_STEM):
        if pack in catalogs:
            containers[pack] = inc.digest(sorted((cid.hex(), hashlib.sha256(payloads[cid][1]).hexdigest(), rel)
                                                 for cid,rel in catalogs[pack].values()))
    proved_stems = {stem for chunk in chunks.values() for stem in chunk['stems']}
    dirty.extend(r['stem'] for r in selected if r['stem'] not in proved_stems | proved_original)
    for pack in source_catalogs:
        if any(not predates(p, started) for p in b.CN_MODS.glob(pack + '.*')):
            dirty.extend(r['stem'] for r in selected if r.get('pack') == pack)
    state = dict(schema=inc.SCHEMA, id='bootstrap-' + inc.digest(receipt)[:20], started=started,
                 output=str(output), scope=[None, None], policy=policy_id, files=files,
                 input_id=None, chunks=chunks, containers=containers, selection=inc.effective_selection([ordinary, added, battle]),
                 sources={}, audio_hashes=audio_hashes, late_inputs=['bootstrap-reconciliation-required'],
                 bootstrap=dict(receipt=receipt, snapshot_sha256=inc.sha(snapshot_path),
                                source_sha256=inc.sha(before_path), dirty_stems=sorted(set(dirty)),
                                checked_at=time.time(), aliases=len(aliases), coverage=len(coverage)))
    result = dict(apply=apply, reusable_chunks=len(chunks), dirty_stems=len(set(dirty)),
                  aliases=len(aliases), coverage=len(coverage), next_build='reconcile; no database queried')
    if apply:
        with inc.build_lock(b.BUILD_ROOT):
            state_path = b.BUILD_ROOT / 'state/latest.json'
            if state_path.exists():
                raise RuntimeError('已有基线；拒绝覆盖')
            # Recheck hashes immediately before atomic promotion.
            inc.verify_files(output, files)
            inc.verify_files(share, files)
            inc.atomic_json(state_path, state)
    return result


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--project-root', required=True)
    for flag in ('output', 'share', 'receipt', 'locked-snapshot', 'builder-before'):
        ap.add_argument('--' + flag, required=True)
    ap.add_argument('--audio-evidence')
    ap.add_argument('--metadata-evidence')
    ap.add_argument('--apply', action='store_true', help='最终验证后才可显式执行；默认只读')
    args = ap.parse_args()
    os.environ['FF7_PROJECT_ROOT'] = args.project_root
    import build_mod
    import cn_iostore
    cn_iostore.OODLE_PATH = Path(args.project_root) / 'programs/bin/liboo2corelinux64.so.9'
    print(json.dumps(initialize(build_mod, args.output, args.share, args.receipt,
                               args.locked_snapshot, args.builder_before, args.apply,
                               args.audio_evidence, args.metadata_evidence), ensure_ascii=False, indent=2))


if __name__ == '__main__':
    main()
