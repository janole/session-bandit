import { indexSessions, type AdapterConfig } from "@session-bandit/core";

export { indexSessions, type AdapterConfig };

export function cli(argv: string[]): void {
  // Placeholder — real commands land in build-order step 5.
  console.log("session-bandit", argv.join(" "));
}