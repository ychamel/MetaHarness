import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readOnlyCommand } from '../src/readonly.ts';

test('read-only commands, including the ones that needed approval in the last real run', () => {
  for (const c of [
    "sed -n '1,120p' src/color-button.js",
    "sed -n '40,80p' a.js && sed -n '1,20p' b.js",
    'cat README.md | head -40',
    'for f in src/*.js; do echo "== $f"; cat "$f"; done',
    'while IFS= read -r line; do echo "$line"; done < notes.txt',
    'ls -la src test 2>/dev/null; wc -l src/*.js',
    'grep -rn "palette" src test | head -20',
    'git diff mh/e6cb3a94/main..HEAD --stat',
    'git log --oneline -10 && git status --short',
    'git -C ../other --no-pager show HEAD:src/a.js',
    'git branch -a',
    "find . -name '*.js' -not -path './node_modules/*' | xargs wc -l",
    "/bin/bash -lc 'cat package.json && ls test'",
    'if [ -f package.json ]; then cat package.json; fi',
    "awk '{print $1}' file.txt | sort | uniq -c",
    "rg -n 'TODO' --glob '!node_modules' . 2>&1 | head",
    'echo done # just a comment > not a redirect',
    "for f in $(git ls-files | grep -v -i roles | grep -E '\\.(js|css)$'); do echo \"== $f\"; cat \"$f\"; done",
    "cat ../../shared/notes/review-view.md | sed -n '/ocus/,+15p' | head -30",
    'echo "branch: $(git rev-parse --abbrev-ref HEAD)" && echo $((1 + 2))',
  ]) {
    const v = readOnlyCommand(c);
    assert.ok(v.readOnly, `${c} → ${v.reason}`);
  }
});

test('anything that could write, run other programs or change state still asks', () => {
  for (const [c, why] of [
    ['cat > shared/notes.md <<EOF\nhi\nEOF', /redirection|here-document/],
    ["python3 -c 'open(\"README.md\",\"w\").write(\"x\")'", /python3/],
    ["sed -i 's/a/b/' file", /sed -i/],
    ["sed -n 's/a/b/w out' file", /sed script/],
    ['echo hi > file.txt', /redirection/],
    ['cat a | tee b', /tee/],
    ['ls $(rm -rf /)', /substitution that isn't read-only/],
    ['echo "`touch x`"', /substitution that isn't read-only/],
    ['find . -name x -delete', /find/],
    ["find . -exec rm {} ';'", /find/],
    ['git checkout main', /git checkout/],
    ['git branch -D old', /git branch/],
    ['git branch newname', /git branch/],
    ['git -c core.pager=evil log', /git -c/],
    ['git diff --output=x', /output/],
    ['npm test', /npm/],
    ['./run.sh', /running/],
    ['PATH=/tmp ls', /PATH/],
    ['sleep 100 &', /background/],
    ["awk 'BEGIN{system(\"rm x\")}'", /awk/],
    ['sort -o out in', /sort -o/],
    ["bash -c 'rm -rf build'", /rm/],
    ['cat <(ls)', /process substitution/],
    ['(cd x && ls)', /subshell/],
    ["echo 'unclosed", /quote/],
  ] as const) {
    const v = readOnlyCommand(c);
    assert.equal(v.readOnly, false, c);
    assert.match(v.reason ?? '', why, c);
  }
});

test('the daemon approves read-only commands itself, unless the role says to always ask', async () => {
  const { FakeAdapter } = await import('../src/adapters/fake.ts');
  const { makeTeam } = await import('./helpers.ts');
  const idle = async () => {};
  const role = (extra = '') => `---\nharness: fake\nmodel: m\n${extra}good_at: x\n---\nx\n`;
  const d = makeTeam({ roles: { architect: role(), careful: role('auto_approve: none\n') }, adapters: { fake: new FakeAdapter({ '*': idle }) } });
  const goal = d.startGoal({ request: 'r' });
  const lead = d.agent(goal, 'architect')!;
  assert.deepEqual(await d.requestApproval(lead, 'Bash', 'git log --oneline | head -5'), { allow: true });
  assert.equal(d.humanInbox.length, 0);
  assert.ok(d.store.since(goal).some(e => e.type === 'approval.auto'));

  const pending = d.requestApproval(lead, 'Bash', 'git push --force');
  assert.equal(d.humanInbox.filter(i => i.kind === 'approval').length, 1, 'a write still asks');
  d.resolveInbox(d.humanInbox.find(i => i.kind === 'approval')!.id, 'deny');
  assert.equal((await pending).allow, false);

  const r = d.spawnAgent(goal, { role: 'careful', brief: 'b', parent: 'architect' });
  assert.ok(r.ok);
  void d.requestApproval(r.rec, 'Bash', 'git status');
  assert.equal(d.humanInbox.filter(i => i.kind === 'approval').length, 1, 'auto_approve: none always asks');
  await d.close();
});
