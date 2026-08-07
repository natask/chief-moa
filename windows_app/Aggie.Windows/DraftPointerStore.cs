using System.Text;

namespace Aggie.Windows;

/// <summary>
/// Stores only the bounded gateway draft pointer. Raw audio, transcript text,
/// gateway credentials, and provider data never enter this file.
/// </summary>
public sealed class DraftPointerStore
{
    private readonly string filePath;

    public DraftPointerStore(string? root = null)
    {
        var basePath = root ?? Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData);
        filePath = Path.Combine(basePath, "Ag", "windows-voice-draft.json");
    }

    public bool Exists => File.Exists(filePath);

    public VoiceDraftPointer? Load()
    {
        try
        {
            if (!File.Exists(filePath)) return null;
            var info = new FileInfo(filePath);
            if (info.Length <= 0 || info.Length > DictationProtocol.MaximumEventBytes) return null;
            return DictationProtocol.ParsePointer(File.ReadAllText(filePath));
        }
        catch (IOException) { return null; }
        catch (UnauthorizedAccessException) { return null; }
        catch (InvalidDataException) { return null; }
        catch (ArgumentException) { return null; }
    }

    public void Save(VoiceDraftPointer pointer)
    {
        var json = DictationProtocol.SerializePointer(pointer);
        var directory = Path.GetDirectoryName(filePath) ?? throw new InvalidOperationException("Draft pointer path was invalid.");
        Directory.CreateDirectory(directory);
        var temporary = filePath + ".next";
        using (var stream = new FileStream(temporary, FileMode.Create, FileAccess.Write, FileShare.None, 4096, FileOptions.WriteThrough))
        using (var writer = new StreamWriter(stream, new UTF8Encoding(false)))
        {
            writer.Write(json);
            writer.Flush();
            stream.Flush(true);
        }
        File.Move(temporary, filePath, true);
    }

    public void Clear()
    {
        try { File.Delete(filePath); }
        catch (DirectoryNotFoundException) { }
    }
}
