import { diffUnits, parseFile, type ParsedFile, type SymbolUnit } from "./symbols";

/**
 * Symbol-level three-way merge ("semantic weave").
 *
 *   base  = baseline commit the fork was taken from
 *   head  = current baseline tip (may have advanced since the fork)
 *   contribs = winning fork versions of the file, at most one owner per unit
 *
 * Each changed unit in a contribution is spliced into `head` only if `head` still holds the same
 * text for that unit as `base` did. Otherwise the baseline moved underneath the agent and that
 * unit is reported as stale instead of being silently overwritten.
 */
export interface Contribution {
  id: string; // fork repo name
  source: string;
}

export interface WeaveOp {
  contrib: string;
  unit: string;
  op: "modify" | "add" | "remove" | "imports";
}

export interface WeaveConflict {
  contrib: string;
  unit: string;
  reason: "stale_baseline" | "contested" | "class_shell_overlap" | "syntax_regression";
}

export interface WeaveResult {
  path: string;
  merged: string;
  applied: WeaveOp[];
  conflicts: WeaveConflict[];
}

const norm = (s: string) => s.replace(/\s+/g, " ").trim();

interface Edit {
  start: number;
  end: number;
  text: string;
}

export function weaveFile(path: string, baseSrc: string, headSrc: string, contribs: Contribution[]): WeaveResult {
  const base = parseFile(path, baseSrc);
  const head = parseFile(path, headSrc);
  const applied: WeaveOp[] = [];
  const conflicts: WeaveConflict[] = [];
  const edits: Edit[] = [];
  const owner = new Map<string, string>();
  const newImports: string[] = [];

  const parsed: Array<{ c: Contribution; p: ParsedFile }> = contribs.map((c) => ({ c, p: parseFile(path, c.source) }));

  // Pass 1: ownership. A unit touched by two contributions is contested (the tournament should
  // have prevented this; we refuse rather than guess).
  const touched = new Map<string, string[]>();
  for (const { c, p } of parsed) {
    const d = diffUnits(base, p);
    for (const k of [...d.added, ...d.modified, ...d.removed]) {
      touched.set(k, [...(touched.get(k) ?? []), c.id]);
    }
  }
  for (const [k, ids] of touched) {
    if (ids.length > 1) ids.forEach((id) => conflicts.push({ contrib: id, unit: k, reason: "contested" }));
    else owner.set(k, ids[0]);
  }

  const headClassEnd = (cls: string): number | null => {
    const u = head.units.get(cls);
    if (!u) return null;
    const close = headSrc.lastIndexOf("}", u.end);
    return close >= u.start ? close : null;
  };

  for (const { c, p } of parsed) {
    const d = diffUnits(base, p);

    // Imports merge as a set union.
    if (d.importsChanged) {
      const have = new Set([...head.imports, ...newImports].map(norm));
      for (const imp of p.imports) {
        if (!have.has(norm(imp))) {
          newImports.push(imp);
          have.add(norm(imp));
        }
      }
      applied.push({ contrib: c.id, unit: "<imports>", op: "imports" });
    }

    for (const k of d.modified) {
      if (owner.get(k) !== c.id) continue;
      const b = base.units.get(k)!;
      const h = head.units.get(k);
      const next = p.units.get(k)!;
      if (!h || norm(h.text) !== norm(b.text)) {
        conflicts.push({ contrib: c.id, unit: k, reason: "stale_baseline" });
        continue;
      }
      if (next.kind === "ClassShell") {
        // Header-level class change: only safe if nobody else edits this class's members.
        const others = [...owner.entries()].some(([uk, id]) => id !== c.id && uk.startsWith(k + "."));
        if (others) {
          conflicts.push({ contrib: c.id, unit: k, reason: "class_shell_overlap" });
          continue;
        }
        // Replace the whole class with the contributor's version.
        const full = c.source.slice(next.start, next.end);
        edits.push({ start: h.start, end: h.end, text: full });
      } else {
        edits.push({ start: h.start, end: h.end, text: next.text });
      }
      applied.push({ contrib: c.id, unit: k, op: "modify" });
    }

    for (const k of d.removed) {
      if (owner.get(k) !== c.id) continue;
      const b = base.units.get(k)!;
      const h = head.units.get(k);
      if (!h) continue; // already gone upstream
      if (norm(h.text) !== norm(b.text)) {
        conflicts.push({ contrib: c.id, unit: k, reason: "stale_baseline" });
        continue;
      }
      edits.push({ start: h.start, end: h.end, text: "" });
      applied.push({ contrib: c.id, unit: k, op: "remove" });
    }

    for (const k of d.added) {
      if (owner.get(k) !== c.id) continue;
      const next = p.units.get(k)!;
      if (head.units.has(k)) {
        conflicts.push({ contrib: c.id, unit: k, reason: "stale_baseline" });
        continue;
      }
      if (next.parent) {
        const at = headClassEnd(next.parent);
        if (at === null) {
          conflicts.push({ contrib: c.id, unit: k, reason: "stale_baseline" });
          continue;
        }
        edits.push({ start: at, end: at, text: next.text.replace(/^\s*/, "\n  ") + "\n" });
      } else {
        const text = next.kind === "ClassShell" ? c.source.slice(next.start, next.end) : next.text;
        edits.push({ start: headSrc.length, end: headSrc.length, text: "\n" + text.replace(/^\s+/, "") + "\n" });
      }
      applied.push({ contrib: c.id, unit: k, op: "add" });
    }
  }

  if (newImports.length) {
    const lastImport = [...head.imports].pop();
    const at = lastImport ? headSrc.indexOf(lastImport) + lastImport.length : 0;
    edits.push({ start: at, end: at, text: (at ? "\n" : "") + newImports.join("\n") + (at ? "" : "\n") });
  }

  // Apply back-to-front so earlier offsets stay valid. Edits never overlap: units are disjoint spans.
  edits.sort((a, b) => b.start - a.start || b.end - a.end);
  let merged = headSrc;
  for (const e of edits) merged = merged.slice(0, e.start) + e.text + merged.slice(e.end);

  if (parseFile(path, merged).syntaxErrors > head.syntaxErrors) {
    return {
      path,
      merged: headSrc,
      applied: [],
      conflicts: [...conflicts, ...applied.map((a) => ({ contrib: a.contrib, unit: a.unit, reason: "syntax_regression" as const }))],
    };
  }
  return { path, merged, applied, conflicts };
}

export type { SymbolUnit };
