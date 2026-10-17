#!/usr/bin/env python3
"""检查待提交代码；只报告位置和类别，绝不输出命中内容。

默认检查 Git 索引中所有 blob，而不只是本次 diff。--worktree 检查当前
源文件（包括尚未暂存的文件，但仍遵守 gitignore）。此脚本不能替代
Gitleaks 和人工审核，尤其是首次发布前对本地真实凭证的额外比对。
"""
from __future__ import annotations
import argparse
import ipaddress
from pathlib import Path
import re
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
FORBIDDEN_PARTS = {'.git', 'node_modules', '.next', '.venv', '__pycache__',
                   'vendor', 'bin', 'data', 'models', 'checkpoints', 'upstream',
                   'game', 'work', 'tmps', 'logs'}
FORBIDDEN_SUFFIXES = {'.wav', '.mp3', '.flac', '.ogg', '.mp4', '.uasset', '.uexp',
                      '.ucas', '.utoc', '.pak', '.hca', '.sab', '.mab', '.wem',
                      '.pt', '.pth', '.onnx', '.safetensors', '.gguf', '.bin',
                      '.so', '.dll', '.exe', '.zip', '.7z', '.dump', '.log',
                      '.jsonl', '.pem', '.key', '.p12', '.pfx'}
PATTERNS = {
    'private-key': re.compile(r'-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----'),
    'github-token': re.compile(r'\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{50,})\b'),
    'api-token': re.compile(r'\b(?:sk-[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16}|hf_[A-Za-z0-9]{30,})\b'),
    'url-credential': re.compile(r'\b(?:https?|postgres(?:ql)?)://[^\s/\x22\x27@:]+:[^\s/\x22\x27@]+@'),
    'local-hostname': re.compile(r'\bsis\.gpu\w*\b|\b[\w.-]+\.(?:lan|internal)\b', re.I),
    'personal-path': re.compile(r'/(?:home/(?:claw|chaoran)|data/sourcecode|smb-Share-models)(?:/|\b)'),
}
IPV4 = re.compile(r'(?<![\w.])(?:\d{1,3}\.){3}\d{1,3}(?![\w.])')

def run(*args: str) -> bytes:
    return subprocess.check_output(['git', *args], cwd=ROOT)

def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--worktree', action='store_true')
    args = parser.parse_args()
    names = run('ls-files', '--cached', '--others', '--exclude-standard', '-z') if args.worktree else run('ls-files', '-z')
    paths = sorted(set(x.decode() for x in names.split(b'\0') if x))
    issues = []
    for name in paths:
        path = Path(name)
        if any(part in FORBIDDEN_PARTS for part in path.parts) or path.suffix.lower() in FORBIDDEN_SUFFIXES or (path.name.startswith('.env') and path.name != '.env.example'):
            issues.append((name, 0, 'forbidden-file'))
            continue
        if args.worktree:
            if not (ROOT / name).is_file():
                continue
            if (ROOT / name).is_symlink():
                issues.append((name, 0, 'symlink'))
                continue
            content = (ROOT / name).read_bytes()
        else:
            content = run('show', ':' + name)
        if b'\0' in content:
            issues.append((name, 0, 'binary-file'))
            continue
        try:
            lines = content.decode('utf-8').splitlines()
        except UnicodeDecodeError:
            issues.append((name, 0, 'non-utf8-file'))
            continue
        for number, line in enumerate(lines, 1):
            for label, pattern in PATTERNS.items():
                if pattern.search(line):
                    issues.append((name, number, label))
            for match in IPV4.finditer(line):
                try:
                    address = ipaddress.ip_address(match.group())
                except ValueError:
                    continue
                # Loopback, wildcard and documentation ranges are safe examples.
                if address.is_loopback or address.is_unspecified or any(address in ipaddress.ip_network(net) for net in ['192.0.2.0/24', '198.51.100.0/24', '203.0.113.0/24']):
                    continue
                if address.is_private:
                    issues.append((name, number, 'private-address'))
    for name, number, label in issues:
        print(f'{name}:{number}: {label}')
    print(f'Checked {len(paths)} files; findings: {len(issues)}')
    return 1 if issues else 0

if __name__ == '__main__':
    sys.exit(main())
