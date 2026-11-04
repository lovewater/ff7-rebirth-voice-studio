#!/usr/bin/env python3
"""Build isolated FF7R read-only tool fixes; never replace shared binaries."""
from pathlib import Path
import argparse,shutil,subprocess,os
ROOT=Path(__file__).resolve().parents[2];PROJECT=ROOT/'studio-ff7-remake';TOOLS=PROJECT/'work/tools'
def main():
 p=argparse.ArgumentParser(description=__doc__);p.add_argument('--offline',action='store_true');a=p.parse_args()
 src=ROOT/'programs/vendor/repak';dst=TOOLS/'repak-ff7r';shutil.copytree(src,dst,ignore=shutil.ignore_patterns('.git','target'),dirs_exist_ok=True)
 f=dst/'repak/src/pak.rs';s=f.read_text();needle='Some(Compression::Gzip),\n                    Some(Compression::Oodle),';assert needle in s;s=s.replace(needle,'Some(Compression::Gzip),\n                    None, // Legacy compression flag4 is custom/Oodle.\n                    Some(Compression::Oodle),');f.write_text(s)
 f=dst/'repak/src/footer.rs';s=f.read_text();needle='compression.push(Some(Compression::Oodle));';assert s.count(needle)==1;s=s.replace(needle,'compression.push(None);\n                compression.push(Some(Compression::Oodle));');f.write_text(s)
 cargo=Path.home()/'.cargo/bin/cargo';cmd=[str(cargo),'build','--release','--manifest-path',str(dst/'Cargo.toml')];cmd+=['--offline'] if a.offline else [];subprocess.run(cmd,check=True)
 shutil.copy2(ROOT/'programs/bin/liboo2corelinux64.so.9',dst/'target/release/liboo2corelinux64.so.9')
 for project_name,folder in [('AudioBatch','audio-batch'),('SoundProbe','sound-probe')]:
  out=TOOLS/folder;subprocess.run([str(Path.home()/'.dotnet/dotnet'),'build',str(PROJECT/'worker'/project_name),'-c','Release','-o',str(out)],check=True)
  for f in (ROOT/'programs/bin/audiomog').glob('*.dll'):shutil.copy2(f,out/f.name)
  print('Isolated .NET host:',out/(project_name+'.dll'))
 print('Isolated repak:',dst/'target/release/repak')
if __name__=='__main__':main()
