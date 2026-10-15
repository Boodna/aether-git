import { describe, expect, it } from "vitest";
import { diffUnits, parseFile } from "../src/symbols";
import { weaveFile } from "../src/weave";

const BASE = `import { kv } from "./kv";

export class EdgeRateLimiter {
  private limit = 100;

  checkQuota(key: string): boolean {
    return kv.get(key) < this.limit;
  }

  flushWindow(): void {
    // noop
  }
}

export function helper(x: number) {
  return x + 1;
}
`;

describe("symbol extraction", () => {
  it("splits classes into member units", () => {
    const keys = [...parseFile("a.ts", BASE).units.keys()];
    expect(keys).toEqual(
      expect.arrayContaining(["EdgeRateLimiter", "EdgeRateLimiter.limit", "EdgeRateLimiter.checkQuota", "EdgeRateLimiter.flushWindow", "helper"])
    );
  });

  it("ignores whitespace-only changes", () => {
    const d = diffUnits(parseFile("a.ts", BASE), parseFile("a.ts", BASE.replace("return x + 1;", "return   x + 1;")));
    expect(d.modified).toEqual([]);
  });

  it("detects the exact member that changed", () => {
    const next = BASE.replace("kv.get(key) < this.limit", "kv.get(key) <= this.limit");
    expect(diffUnits(parseFile("a.ts", BASE), parseFile("a.ts", next)).modified).toEqual(["EdgeRateLimiter.checkQuota"]);
  });
});

describe("weave", () => {
  it("merges orthogonal edits to different methods of the same class", () => {
    const a = BASE.replace("kv.get(key) < this.limit", "kv.get(key) <= this.limit");
    const b = BASE.replace("// noop", "kv.flush();");
    const r = weaveFile("a.ts", BASE, BASE, [
      { id: "fork-a", source: a },
      { id: "fork-b", source: b },
    ]);
    expect(r.conflicts).toEqual([]);
    expect(r.merged).toContain("<= this.limit");
    expect(r.merged).toContain("kv.flush();");
  });

  it("adds new functions, class members and imports", () => {
    const a = BASE.replace(`import { kv } from "./kv";`, `import { kv } from "./kv";\nimport { log } from "./log";`).replace(
      "  flushWindow(): void {",
      "  emitTelemetry(): void {\n    log('x');\n  }\n\n  flushWindow(): void {"
    );
    const b = BASE + `\nexport function extra() {\n  return 2;\n}\n`;
    const r = weaveFile("a.ts", BASE, BASE, [
      { id: "fork-a", source: a },
      { id: "fork-b", source: b },
    ]);
    expect(r.conflicts).toEqual([]);
    expect(r.merged).toContain(`import { log } from "./log";`);
    expect(r.merged).toContain("emitTelemetry()");
    expect(r.merged).toContain("export function extra()");
    expect(parseFile("a.ts", r.merged).syntaxErrors).toBe(0);
  });

  it("refuses contested units", () => {
    const a = BASE.replace("x + 1", "x + 2");
    const b = BASE.replace("x + 1", "x + 3");
    const r = weaveFile("a.ts", BASE, BASE, [
      { id: "fork-a", source: a },
      { id: "fork-b", source: b },
    ]);
    expect(r.conflicts.map((c) => c.reason)).toEqual(["contested", "contested"]);
    expect(r.merged).toBe(BASE);
  });

  it("flags stale units when the baseline moved, but still applies the rest", () => {
    const head = BASE.replace("x + 1", "x + 100"); // upstream changed helper
    const a = BASE.replace("x + 1", "x + 2").replace("// noop", "kv.flush();");
    const r = weaveFile("a.ts", BASE, head, [{ id: "fork-a", source: a }]);
    expect(r.conflicts).toEqual([{ contrib: "fork-a", unit: "helper", reason: "stale_baseline" }]);
    expect(r.merged).toContain("x + 100");
    expect(r.merged).toContain("kv.flush();");
  });
});
