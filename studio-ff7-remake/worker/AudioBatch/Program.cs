using System;
using System.IO;
using System.Linq;
using System.Text.Json;
using AudioMog.Application;
using AudioMog.Application.AudioExtractor;
using AudioMog.Core;
using AudioMog.Core.Audio;
class Logger : IApplicationLogger { public void Log(string m){} public void Warn(string m){} public void Error(string m){Console.Error.WriteLine(m);} }
class Program {
 static int Main(string[] args) {
  int errors=0;
  foreach(var file in args) {
   try {
    var settings=new ApplicationSettings { Parser=new FileParserSettings {SoundFileFileVersion=new AudioBinaryFileVersion {Main=2,Sub=1},MusicFileFileVersion=new AudioBinaryFileVersion {Main=2,Sub=1}}, AudioExtractor=new AudioExtractorSettings {ExtractAsWav=true,ExtractAsRaw=false}};
    // Upstream terminal caches an extractor whose per-material dictionaries persist across files.
    // A fresh service per asset prevents duplicate material index collisions in batch decoding.
    var parser=new FileParser {Settings=settings.Parser,Logger=new Logger()};
    var parsed=parser.Parse(File.ReadAllBytes(file));
    File.WriteAllText(file+".materials.json",JsonSerializer.Serialize(parsed.MaterialSection.Entries.Select(x=>new {index=x.EntryIndex,codec=x.Codec.ToString(),stream_size=x.StreamSize,channels=x.ChannelCount,sample_rate=x.SampleRate}).ToArray()));
    var extractor=new AudioExtractorService {Settings=settings,Logger=new Logger(),FilePathToExtract=file};
    extractor.Run();Console.WriteLine("OK\t"+file);
   } catch(Exception e) {errors++;Console.Error.WriteLine("ERROR\t"+file+"\t"+e.Message);}
  }
  return errors==0?0:1;
 }
}
