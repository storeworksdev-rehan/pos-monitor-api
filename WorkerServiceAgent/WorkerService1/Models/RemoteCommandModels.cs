namespace PosMonitoringAgent.Models;

/// <summary>A request from the central API, e.g. "files.browse".</summary>
public sealed record RemoteCommand(string Id, string Op, RemoteCommandArgs? Args);

public sealed record RemoteCommandArgs(
    string? Path,
    bool Recursive = false,
    long? Offset = null,
    bool Tail = true);

public sealed record RemoteCommandBatch(IReadOnlyList<RemoteCommand>? Commands);

/// <summary>Posted back to the server for one command.</summary>
public sealed record RemoteCommandResult(bool Ok, object? Result, RemoteCommandError? Error)
{
    public static RemoteCommandResult Success(object result) => new(true, result, null);

    public static RemoteCommandResult Failure(string code, string message) => new(false, null, new RemoteCommandError(code, message));
}

/// <summary>Codes: not-found, denied, unsupported, too-large, io-error, disabled.</summary>
public sealed record RemoteCommandError(string Code, string Message);

public sealed record FileEntry(
    string Name,
    string Path,
    string Type,
    long? Size,
    DateTimeOffset Modified,
    bool Readable);

public sealed record DirectoryListing(
    string Kind,
    string Path,
    string Root,
    string? Parent,
    bool Recursive,
    bool Truncated,
    int Count,
    IReadOnlyList<FileEntry> Entries);

public sealed record FileContent(
    string Kind,
    string Path,
    string Name,
    string? Parent,
    long Size,
    DateTimeOffset Modified,
    long Offset,
    int Length,
    bool Truncated,
    bool HasMoreBefore,
    bool HasMoreAfter,
    string Encoding,
    bool Redacted,
    string Content);
