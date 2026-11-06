using System.Globalization;

namespace GestureMouse.Shared;

internal sealed class NativeSessionGenerationStore : INativeSessionGenerationStore
{
    private const string FormatPrefix = "v1:";
    private readonly string _generationFile;

    public NativeSessionGenerationStore()
        : this(Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "Glimouse",
            "native-session-generation.txt"))
    {
    }

    internal NativeSessionGenerationStore(string generationFile)
    {
        _generationFile = generationFile;
    }

    public long Load()
    {
        string raw;
        try
        {
            raw = File.ReadAllText(_generationFile);
        }
        catch (FileNotFoundException)
        {
            return 0;
        }
        catch (DirectoryNotFoundException)
        {
            return 0;
        }

        var valueText = raw.StartsWith(FormatPrefix, StringComparison.Ordinal)
            ? raw[FormatPrefix.Length..]
            : raw;
        if (!long.TryParse(valueText, NumberStyles.None, CultureInfo.InvariantCulture, out var value)
            || value < 0)
        {
            throw new InvalidDataException("The saved native mouse session generation is invalid or unsupported.");
        }

        return value;
    }

    public void Save(long generation)
    {
        if (generation < 0)
        {
            throw new ArgumentOutOfRangeException(nameof(generation));
        }

        var directory = Path.GetDirectoryName(_generationFile)!;
        Directory.CreateDirectory(directory);
        var temporaryFile = $"{_generationFile}.{Guid.NewGuid():N}.tmp";
        try
        {
            File.WriteAllText(temporaryFile, $"{FormatPrefix}{generation.ToString(CultureInfo.InvariantCulture)}");
            File.Move(temporaryFile, _generationFile, overwrite: true);
        }
        finally
        {
            if (File.Exists(temporaryFile))
            {
                File.Delete(temporaryFile);
            }
        }
    }

    public void ResetCorruptData()
    {
        if (File.Exists(_generationFile))
        {
            var backup = $"{_generationFile}.corrupt-{Guid.NewGuid():N}";
            File.Move(_generationFile, backup);
        }

        Save(0);
    }
}

internal interface INativeSessionGenerationStore
{
    long Load();
    void Save(long generation);
    void ResetCorruptData();
}
