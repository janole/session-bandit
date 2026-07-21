import type { Session } from "@session-bandit/core";

/**
 * Resolve a session by id or unique id prefix, optionally restricted to one agent.
 *
 * Reports the failure on stderr and sets a non-zero exit code, returning null so the
 * caller can simply `return`. Every session-taking command shares this behaviour, so
 * the "not found" and "ambiguous prefix" wording stays identical across them.
 */
export function resolveSession(sessions: Session[], sessionId: string, agent?: string): Session | null
{
    const candidates = sessions.filter(s =>
    {
        if (agent && s.agent !== agent) { return false; }
        return s.sessionId.startsWith(sessionId);
    });

    if (candidates.length === 0)
    {
        console.error(`No session found matching "${sessionId}".`);
        process.exitCode = 1;
        return null;
    }

    if (candidates.length > 1)
    {
        console.error(`Ambiguous session prefix "${sessionId}" — matches ${candidates.length} sessions:`);
        for (const c of candidates.slice(0, 10))
        {
            console.error(`  ${c.agent}  ${c.sessionId}  ${c.startedAt}`);
        }
        process.exitCode = 1;
        return null;
    }

    return candidates[0]!;
}
