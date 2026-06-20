import { describe, it, expect } from 'vitest';
import { parseUnifiedDiff } from '../src/diff/parseUnifiedDiff';

describe('parseUnifiedDiff', () => {
  it('parses an added file with all new lines', () => {
    const diff = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..3333333
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,3 @@
+line1
+line2
+line3`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('new.ts');
    expect(files[0].status).toBe('added');
    expect([...files[0].addedLines].sort((a, b) => a - b)).toEqual([1, 2, 3]);
  });

  it('parses a modified file (unified=0) with correct new-file line numbers', () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index 1111111..2222222 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,0 +11,2 @@ ctx
+const a = 1;
+const b = 2;
@@ -20 +22 @@ ctx
-old
+new`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/foo.ts');
    expect(files[0].status).toBe('modified');
    expect([...files[0].addedLines].sort((a, b) => a - b)).toEqual([11, 12, 22]);
  });

  it('marks a deleted file with no added lines', () => {
    const diff = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index 3333333..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
-line1
-line2`;
    const files = parseUnifiedDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('gone.ts');
    expect(files[0].status).toBe('deleted');
    expect(files[0].addedLines.size).toBe(0);
  });

  it('handles multiple files in one diff', () => {
    const diff = `diff --git a/a.ts b/a.ts
index 1..2 100644
--- a/a.ts
+++ b/a.ts
@@ -1 +1 @@
-x
+y
diff --git a/b.ts b/b.ts
new file mode 100644
--- /dev/null
+++ b/b.ts
@@ -0,0 +1,1 @@
+z`;
    const files = parseUnifiedDiff(diff);
    expect(files.map((f) => f.path)).toEqual(['a.ts', 'b.ts']);
  });
});
