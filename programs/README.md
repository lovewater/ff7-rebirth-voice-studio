# FF7 sound pipeline tools

Linux 上拆/封 FF7 Remake、Rebirth 音频容器。TTS 不在这里。

**进展：** 抽 JP（retoc）和 CN（自研 IoStore）已经能用。`retoc to-zen` / UnrealReZen 在 Linux 上打出来的 overlay 不能进游戏，封包改 Win11。

## Layout

- `vendor/` — cloned upstream sources
- `bin/` — built or downloaded binaries
- `src/ff7sound/` — thin CLI that wraps those binaries
- `ff7sound` — launcher

## Commands

```bash
cd /srv/ff7-rebirth-voice-studio/programs
./ff7sound status

# audio container (SQEXSEAD inside uasset/uexp/sab/mab)
./ff7sound unpack-audio path/to/Voice.uasset
# edit wavs inside Voice_Project/
./ff7sound pack-audio path/to/Voice_Project/RebuildSettings.json

# wav <-> hca
./ff7sound hca clip.wav -o clip.hca

# official subtitles
./ff7sound unpack-text path/to/4000-MIDGR_TxtRes.uasset -o out/text
./ff7sound pack-text out/text/4000-MIDGR_TxtRes.csv path/to/4000-MIDGR_TxtRes.uasset -o out/text-imported

# game pak folder (Rebirth IoStore). Game body not required until you have it.
./ff7sound unpack-paks "/path/to/End/Content/Paks" -o out/legacy --filter Sound --version UE4_26
./ff7sound pack-mod out/mod-content -o "/path/to/End/Content/Paks/~mods/ChineseVO_P.utoc" --version UE4_26
```

Drop the generated `_P.utoc` / `_P.ucas` / `_P.pak` into `End/Content/Paks/~mods`.

## Upstream

| Tool | Role |
|---|---|
| AudioMog | SQEXSEAD unpack/repack |
| VGAudio | HCA encode/decode |
| vgmstream | listen / extra decode |
| ff7r-text-tool | TxtRes export/import |
| retoc | IoStore pak/utoc/ucas |
| repak | legacy .pak |
