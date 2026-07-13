import { describe, expect,it } from "vitest";

import { cli, createProgram } from "../src/index.js";

describe("cli entry point", () => 
{
    it("createProgram returns a Commander program with 3 commands", () => 
    {
        const program = createProgram();
        const names = program.commands.map((c) => c.name());
        expect(names).toContain("list");
        expect(names).toContain("show");
        expect(names).toContain("search");
    });

    it("createProgram has the right name and version", () => 
    {
        const program = createProgram();
        expect(program.name()).toBe("session-bandit");
        expect(program.version()).toBe("0.1.5");
    });

    it("cli() does not throw on no args (shows help)", () => 
    {
        expect(() => cli(["--help"])).not.toThrow();
    });

    it("cli() does not throw on --version", () => 
    {
        expect(() => cli(["--version"])).not.toThrow();
    });
});
