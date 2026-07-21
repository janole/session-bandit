/**
 * Coerce an unknown value to a non-negative number, defaulting to 0.
 *
 * Token counts arrive from four different on-disk formats, none of which we control;
 * a missing, null, negative or non-numeric field must degrade to 0 rather than
 * poison an arithmetic total with NaN.
 */
export function num(v: unknown): number
{
    return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : 0;
}
