using System;using System.IO;using System.Linq;using System.Text.Json;using System.Collections.Generic;
using AudioMog.Core;using AudioMog.Application;using AudioMog.Core.Audio;using AudioMog.Core.Sound;
class Logger:IApplicationLogger {public void Log(string m){}public void Warn(string m){}public void Error(string m){}}
class Program {
 static object[] FullCommands(SoundAudioBinaryFile sab,SequenceEntry sequence,byte[] bytes){
  var end=sab.SoundEntries.SelectMany(e=>e.Sequences).Select(s=>s.Offset).Where(o=>o>sequence.Offset).DefaultIfEmpty(sab.TrackSectionOffset).Min();
  long p=sequence.Offset+BitConverter.ToUInt16(bytes,(int)sequence.Offset+(sequence.Version<=2?0x16:6));var commands=new List<object>();
  while(p+4<=end){var size=bytes[(int)p+1];var type=bytes[(int)p+2];var bodySize=bytes[(int)p+3];if(size<4||p+size+bodySize>end)break;
   uint? track=type==2&&bodySize>=4?BitConverter.ToUInt32(bytes,(int)p+size):null;
   commands.Add(new{type=type,track_index=track,body=Convert.ToHexString(bytes.AsSpan((int)p+size,bodySize))});p+=size+bodySize;if(type==0||type==1||type>=9)break;
  }return commands.ToArray();
 }
 static int Main(string[] args){if(args.Length==2&&args[0]=="--files-list")args=File.ReadAllLines(args[1]);foreach(var file in args){try{
 var bytes=File.ReadAllBytes(file);var parser=new FileParser {Settings=new FileParserSettings {SoundFileFileVersion=new AudioBinaryFileVersion {Main=2,Sub=1},MusicFileFileVersion=new AudioBinaryFileVersion {Main=2,Sub=1}},Logger=new Logger()};
 var parsed=parser.Parse(bytes);var sab=parsed as SoundAudioBinaryFile;if(sab==null)throw new Exception("not SAB");
 Console.WriteLine(JsonSerializer.Serialize(new {path=file,status="ok",sounds=sab.SoundEntries.Select(e=>new{name=e.Name.TrimEnd('\0'),type=e.Type,sequences=e.Sequences.Select(s=>new {index=s.DeclarationIndex,commands=FullCommands(sab,s,bytes)})}),tracks=sab.Tracks.Select((t,i)=>new{index=i,type=t.Type,id=t.Id,child_id=t.ChildId,material_index=t.HasMaterial?(int?)t.MaterialIndex:null,header=Convert.ToHexString(bytes.AsSpan((int)t.Offset,Math.Min(t.Size,(ushort)64)))})}));
 }catch(Exception e){Console.WriteLine(JsonSerializer.Serialize(new {path=file,status="error",error=e.Message}));}}return 0;}}
