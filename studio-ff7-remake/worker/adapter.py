#!/usr/bin/env python3
"""Remake resource boundary: validated read-only extraction, packaging disabled."""
import argparse,json,subprocess,sys
from pathlib import Path
PROJECT=Path(__file__).resolve().parents[1]
def main(argv=None):
 p=argparse.ArgumentParser(description='Remake 游戏资源适配器');p.add_argument('command',choices=['status','extract','pack']);p.add_argument('--workers',type=int,default=4);a=p.parse_args(argv)
 if a.command=='pack':p.exit(2,'Remake 写回/封包尚未完成原样往返及 Win11 验证，禁止调用 Rebirth 打包器替代。\n')
 if a.command=='extract':
  data=PROJECT/'website/data';marker=json.loads((data/'.ff7-game.json').read_text())
  if data.is_symlink() or marker!={'game_id':'remake','database':'studio_ff7_remake'}:p.exit(2,'Remake 音频目录身份不匹配。\n')
  if not (PROJECT/'work/indexes/voice-assets.jsonl').exists() or not (PROJECT/'work/raw-voice').is_dir():p.exit(2,'先按 AUDIO-EXTRACTION.md 完成本作只读PAK索引/原始资源导出。\n')
  return subprocess.call([sys.executable,str(PROJECT/'worker/extract_voice.py'),'--workers',str(min(max(a.workers,1),4))])
 progress_path=PROJECT/'work/extraction-progress.json';progress=json.loads(progress_path.read_text()) if progress_path.exists() else None
 print(json.dumps({'game_id':'remake','resource_adapter':'legacy-pak-v4-read-only','extract_enabled':True,'pack_enabled':False,'validated':['encrypted-v4-index-sha1','custom-oodle-source-blocks','native-independent-pak-reader-match','multi-material-real-index-coverage','multichannel-lossless-pcm'],'full_expected_source_assets':55351,'full_extraction_complete':bool(progress and progress['total_assets']==55351 and progress['complete'] and progress['error_assets']==0),'progress':progress,'remaining_validation':['asset-unchanged-writeback-roundtrip','minimal-game-install-test']},ensure_ascii=False))
 return 0
if __name__=='__main__':raise SystemExit(main())
