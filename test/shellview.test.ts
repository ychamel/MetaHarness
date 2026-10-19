import { test } from 'node:test';
import assert from 'node:assert/strict';
import { elideHeredocs, unwrapShell } from '../src/shellview.ts';

test("Codex's bash -lc wrapper comes off when it's the whole command", () => {
  // As Codex quotes it: double quotes, switching to single quotes around backticks.
  assert.equal(unwrapShell(`/bin/bash -lc "cat > a.md <<'EOF'\n# Map ("'\`src/\`)'"\nEOF"`), "cat > a.md <<'EOF'\n# Map (`src/`)\nEOF");
  assert.equal(unwrapShell(`bash -c 'npm test'`), 'npm test');
  assert.equal(unwrapShell(`sh -ec "make \\"all\\""`), 'make "all"');
  // Anything the outer shell would expand or run itself stays as it came.
  for (const cmd of [`bash -lc "echo $HOME"`, 'bash -lc "echo `id`"', `bash -lc 'a' && rm x`, `bash -lc 'a' extra`, `bash script.sh`, `FOO=1 bash -c 'a'`, `bash -lc 'unclosed`, `npm test`]) {
    assert.equal(unwrapShell(cmd), cmd, cmd);
  }
});

test('quoted here-document bodies are left out, unquoted ones kept', () => {
  assert.equal(
    elideHeredocs("cat > a.md <<'EOF'\n# A `b` $(c)\nline two\nEOF\nwc -l a.md"),
    "cat > a.md <<'EOF'\n[2 lines of text, written as is: nothing in them runs]\nEOF\nwc -l a.md",
  );
  assert.equal(elideHeredocs('cat <<"X" > a\none\nX'), 'cat <<"X" > a\n[1 line of text, written as is: nothing in it runs]\nX');
  assert.equal(elideHeredocs('cat <<-\\END\n\tbody\n\tEND\n'), 'cat <<-\\END\n[1 line of text, written as is: nothing in it runs]\n\tEND\n');
  // Two on one line are read in order; an unquoted one runs its $( … ), so it stays.
  assert.equal(
    elideHeredocs("paste <<'A' <<B\nx\nA\n$(rm -rf ~)\nB"),
    "paste <<'A' <<B\n[1 line of text, written as is: nothing in it runs]\nA\n$(rm -rf ~)\nB",
  );
  // Inside quotes or a comment, << isn't a here-document; nor is a here-string.
  for (const cmd of [`echo "<<'X'"\nrm -rf ~\nX`, `# don't <<'X'\nrm -rf ~\nX`, `grep x <<< 'EOF'\nrm -rf ~\nEOF`]) assert.equal(elideHeredocs(cmd), cmd, cmd);
  // No end line: nothing is left out.
  assert.equal(elideHeredocs("cat <<'EOF'\nrm -rf ~"), "cat <<'EOF'\nrm -rf ~");
});
