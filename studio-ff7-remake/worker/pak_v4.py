"""Read-only FF7 Remake legacy pak V4 reader; no game/package writes."""
from pathlib import Path
import os,struct,hashlib,zlib,gzip,ctypes,threading
from cryptography.hazmat.primitives.ciphers import Cipher,algorithms,modes
ROOT=Path(__file__).resolve().parents[2]
KEY_SOURCE='https://github.com/jordanbtucker/ff7r-data-editor/wiki/Getting-Started'
KEY_FILE=ROOT/'studio-ff7-remake/.private/pak-aes.txt'
class Cursor:
 def __init__(self,data):self.data=data;self.i=0
 def read(self,n):
  r=self.data[self.i:self.i+n];self.i+=n
  if len(r)!=n:raise ValueError('Truncated pak index')
  return r
 def unpack(self,f):return struct.unpack(f,self.read(struct.calcsize(f)))
 def string(self):
  n=self.unpack('<i')[0]
  if not -1000000<n<1000000:raise ValueError('Bad FString')
  if n==0:return ''
  return self.read(n).rstrip(b'\0').decode('utf8') if n>0 else self.read(-n*2)[:-2].decode('utf-16le')
class PakV4:
 def __init__(self,path,key=None):
  key=key or os.environ.get('FF7_REMAKE_AES_KEY') or KEY_FILE.read_text().strip()
  self.path=Path(path);self.key=bytes.fromhex(key.removeprefix('0x'));self.entries={}
  with self.path.open('rb') as f:
   f.seek(-45,2);encrypted,magic,version,offset,size,digest=struct.unpack('<?IIQQ20s',f.read(45))
   if magic!=0x5a6f12e1 or version!=4:raise ValueError('Expected actual FF7R pak V4')
   f.seek(offset);blob=f.read((size+15)//16*16 if encrypted else size)
  if encrypted:blob=self.decrypt(blob)
  blob=blob[:size]
  if hashlib.sha1(blob).digest()!=digest:raise ValueError('Pak index SHA1 mismatch')
  self.index_offset=offset;self.file_size=self.path.stat().st_size
  c=Cursor(blob);self.mount=c.string();count=c.unpack('<I')[0]
  for _ in range(count):
   name=c.string();pos,compressed,uncompressed,method=c.unpack('<QQQI');sha=c.read(20)
   blocks=[c.unpack('<QQ') for __ in range(c.unpack('<I')[0])] if method else []
   flags,blocksize=c.unpack('<BI')
   self.entries[(self.mount+name).removeprefix('../../../')]={'offset':pos,'compressed':compressed,'size':uncompressed,'method':method,'sha1':sha.hex(),'blocks':blocks,'encrypted':bool(flags&1),'header_size':c.i,'blocksize':blocksize}
  if len(self.entries)!=count:raise ValueError('Duplicate paths within pak')
 def decrypt(self,data):
  d=Cipher(algorithms.AES(self.key),modes.ECB()).decryptor();return d.update(data)+d.finalize()
 def read(self,name):
  name=name.removeprefix('../../../');e=self.entries[name]
  with self.path.open('rb') as f:
   if e['method']==0:
    # V4 entry header: offset/sizes/method/hash/flags/blocksize.
    f.seek(e['offset']+53);data=f.read((e['size']+15)//16*16 if e['encrypted'] else e['size'])
    result=(self.decrypt(data) if e['encrypted'] else data)[:e['size']]
    if len(result)!=e['size'] or hashlib.sha1(result).hexdigest()!=e['sha1']:raise ValueError('Raw pak entry size/SHA1 mismatch')
    return result
   out=[];digest=hashlib.sha1();previous=e['offset']+57+16*len(e['blocks'])
   for start,end in e['blocks']:
    if not previous<=start<=end<=self.index_offset:raise ValueError('Pak compression block outside payload boundary')
    previous=end
    f.seek(start);n=end-start;data=f.read((n+15)//16*16 if e['encrypted'] else n)
    if e['encrypted']:data=self.decrypt(data)
    data=data[:n];digest.update(data);expected=min(e['blocksize'],e['size']-sum(map(len,out)))
    if e['method']==1:decoded=zlib.decompress(data)
    elif e['method']==2:decoded=gzip.decompress(data)
    elif e['method']==4:decoded=oodle(data,expected)
    else:raise ValueError(f'Unsupported legacy compression flag {e["method"]}')
    if len(decoded)!=expected:raise ValueError('Pak block length mismatch')
    out.append(decoded)
  if digest.hexdigest()!=e['sha1']:raise ValueError('Compressed pak entry SHA1 mismatch')
  result=b''.join(out)
  if len(result)!=e['size']:raise ValueError('Pak asset length mismatch')
  return result
_oodle=None
_lock=threading.Lock()
def oodle(data,size):
 global _oodle
 with _lock:
  if _oodle is None:
   lib=ctypes.CDLL(str(ROOT/'programs/bin/liboo2corelinux64.so.9'));fn=lib.OodleLZ_Decompress;fn.restype=ctypes.c_ssize_t;fn.argtypes=[ctypes.c_void_p,ctypes.c_ssize_t,ctypes.c_void_p,ctypes.c_ssize_t,ctypes.c_int,ctypes.c_int,ctypes.c_int,ctypes.c_void_p,ctypes.c_ssize_t,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_void_p,ctypes.c_ssize_t,ctypes.c_int];_oodle=(lib,fn)
 fn=_oodle[1];buf=ctypes.create_string_buffer(size);n=fn(data,len(data),buf,size,1,1,0,None,0,None,None,None,0,3)
 if n!=size:raise ValueError(f'Oodle decoded {n}, expected {size}')
 return buf.raw
