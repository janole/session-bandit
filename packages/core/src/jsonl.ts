import { readFileSync } from "node:fs";

/**
 * Read a JSONL file and return parsed objects, skipping blank/malformed lines.
 * Never throws on bad lines — returns whatever parsed cleanly.
 */
export function readJsonl(filePath: string): unknown[]
{
    let text: string;
    try
    {
        text = readFileSync(filePath, "utf8");
    }
    catch
    {
        return [];
    }
    const out: unknown[] = [];
    for (const line of text.split("\n"))
    {
        const trimmed = line.trim();
        if (!trimmed) {continue;}
        try
        {
            out.push(JSON.parse(trimmed));
        }
        catch
        {
            // skip malformed line
        }
    }
    return out;
}
