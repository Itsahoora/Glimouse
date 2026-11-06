namespace GestureMouse.Shared;

internal sealed record NativeCommandHttpError(int StatusCode, string Code, string Error)
{
    public static NativeCommandHttpError From(NativeCommandResult result, string? failure = null) =>
        result switch
        {
            NativeCommandResult.NativeOperationFailed => new(
                500,
                "native_operation_failed",
                failure ?? "A native mouse operation failed; the bridge is unavailable."),
            NativeCommandResult.StorageUnavailable => new(
                503,
                "storage_unavailable",
                failure ?? "Native session storage is unavailable."),
            _ => new(
                409,
                "command_rejected",
                failure ?? "The mouse command is stale or belongs to an expired session."),
        };
}
