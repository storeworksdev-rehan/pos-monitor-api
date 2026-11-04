using System.Text.RegularExpressions;

namespace PosMonitoringAgent.Services;

/// <summary>
/// Removes card numbers, credentials and personal data from free text before it is queued.
/// This is a safety net; collectors should still avoid reading sensitive sources at all.
/// </summary>
public static partial class SensitiveDataRedactor
{
    private const int TimeoutMs = 250;

    // 13-19 digits, optionally separated by spaces or dashes. Luhn-checked before redaction.
    [GeneratedRegex(@"(?<!\d)(?:\d[ -]?){12,18}\d(?!\d)", RegexOptions.None, TimeoutMs)]
    private static partial Regex CardCandidate();

    // Magnetic stripe track 1/2 data.
    [GeneratedRegex(@"%?B\d{13,19}\^[^\^]{2,26}\^\d{4,}|;?\d{13,19}=\d{4,}\??", RegexOptions.None, TimeoutMs)]
    private static partial Regex TrackData();

    [GeneratedRegex(@"\b(cvv2?|cvc2?|cid|pin)\b\s*[:=]?\s*\d{3,6}", RegexOptions.IgnoreCase, TimeoutMs)]
    private static partial Regex CardSecurity();

    [GeneratedRegex(@"\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)\b(\s*[:=]\s*)(""[^""]*""|'[^']*'|[^\s;,]+)", RegexOptions.IgnoreCase, TimeoutMs)]
    private static partial Regex Credential();

    [GeneratedRegex(@"\b(Bearer|Basic)\s+[A-Za-z0-9\-._~+/]+=*", RegexOptions.IgnoreCase, TimeoutMs)]
    private static partial Regex AuthHeader();

    [GeneratedRegex(@"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}", RegexOptions.None, TimeoutMs)]
    private static partial Regex Email();

    [GeneratedRegex(@"\b\d{3}-\d{2}-\d{4}\b", RegexOptions.None, TimeoutMs)]
    private static partial Regex Ssn();

    public static string? Redact(string? text, int maxLength = 2000)
    {
        if (string.IsNullOrEmpty(text))
        {
            return text;
        }

        try
        {
            var result = TrackData().Replace(text, "[REDACTED-TRACK]");
            result = CardCandidate().Replace(result, m => IsLuhnValid(m.Value) ? "[REDACTED-PAN]" : m.Value);
            result = CardSecurity().Replace(result, "$1=[REDACTED]");
            result = Credential().Replace(result, "$1$2[REDACTED]");
            result = AuthHeader().Replace(result, "$1 [REDACTED]");
            result = Email().Replace(result, "[REDACTED-EMAIL]");
            result = Ssn().Replace(result, "[REDACTED-SSN]");
            return Truncate(result, maxLength);
        }
        catch (RegexMatchTimeoutException)
        {
            // Never ship text we could not scan.
            return "[REDACTED: message could not be scanned]";
        }
    }

    private static string Truncate(string value, int maxLength) =>
        value.Length <= maxLength ? value : string.Concat(value.AsSpan(0, maxLength), "...[truncated]");

    private static bool IsLuhnValid(string candidate)
    {
        var sum = 0;
        var digits = 0;
        var doubleIt = false;
        for (var i = candidate.Length - 1; i >= 0; i--)
        {
            var c = candidate[i];
            if (c is < '0' or > '9')
            {
                continue;
            }

            var d = c - '0';
            if (doubleIt)
            {
                d *= 2;
                if (d > 9)
                {
                    d -= 9;
                }
            }

            sum += d;
            digits++;
            doubleIt = !doubleIt;
        }

        return digits is >= 13 and <= 19 && sum % 10 == 0;
    }
}
