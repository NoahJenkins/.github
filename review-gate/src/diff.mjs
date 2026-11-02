// Maps each file in a unified diff to the new-side line numbers GitHub accepts
// for inline review comments (added and context lines inside hunks).
export function rightSideLines(diff) {
  const map = new Map();
  let file = null;
  let line = 0;
  let prev = "";
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++ ") && prev.startsWith("--- ")) {
      const p = l.slice(4).trim();
      file = p === "/dev/null" ? null : p.replace(/^b\//, "");
      if (file && !map.has(file)) map.set(file, new Set());
    } else if (l.startsWith("diff --git ")) {
      file = null;
    } else {
      const h = l.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (h) {
        line = Number(h[1]);
      } else if (file && !l.startsWith("--- ")) {
        if (l.startsWith("+") || l.startsWith(" ")) map.get(file).add(line++);
      }
    }
    prev = l;
  }
  return map;
}
