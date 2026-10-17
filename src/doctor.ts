import { relative } from 'node:path';
import type { HarnessReport } from './harnesses.ts';
import type { Role } from './types.ts';

/**
 * `mh doctor` (design §16): which harnesses are here, signed in, and offering which models, and
 * whether each role can run as configured. Pure formatting; the CLI gathers the reports.
 */

export interface RouteCheck {
  harness: string;
  model: string;
  ok: boolean | undefined;
  why: string;
}

/** Whether a harness/model pair can run here, and if not, why. undefined: can't tell. */
export function checkRoute(harness: string, model: string, reports: Map<string, HarnessReport>): RouteCheck {
  const r = reports.get(harness);
  const res = (ok: boolean | undefined, why: string): RouteCheck => ({ harness, model, ok, why });
  if (!r) return res(false, `no harness called ${harness} (add .metaharness/harnesses/${harness}.md to define one)`);
  if (!r.path) return res(false, `${r.title} isn't installed${r.install ? ` (${r.install})` : ''}`);
  if (!r.transport) return res(false, `MetaHarness can't drive ${r.title} yet`);
  if (r.login?.signedIn === false) return res(false, `${r.title} isn't signed in${r.loginCommand ? `: run ${r.loginCommand}` : ''}`);
  if (!model) return res(true, `${r.title}'s default model`);
  if (r.models.length && !r.models.includes(model)) {
    const some = r.models.slice(0, 6).join(', ') + (r.models.length > 6 ? ', …' : '');
    return res(false, `${r.title} doesn't offer ${model} (it offers ${some})`);
  }
  if (!r.models.length) return res(undefined, `couldn't list ${r.title}'s models${r.modelsError ? `: ${r.modelsError}` : ''}`);
  return res(r.login?.signedIn === undefined ? undefined : true, r.login?.signedIn === undefined ? `couldn't tell whether ${r.title} is signed in` : 'ready');
}

const mark = (ok: boolean | undefined) => (ok === true ? '✓' : ok === false ? '✗' : '?');

export function doctorLines(reports: HarnessReport[], roles: Role[]): string[] {
  const byId = new Map(reports.map(r => [r.id, r]));
  const lines = ['Harnesses on this machine', ''];
  const found = reports.filter(r => r.path);
  for (const r of found) {
    const login = r.login ? `${r.login.signedIn === true ? 'signed in' : r.login.signedIn === false ? 'NOT signed in' : 'sign-in unknown'}${r.login.detail ? ` (${r.login.detail})` : ''}` : '';
    const models = r.models.length ? `${r.models.length} models` : r.modelsError ? `models: ${r.modelsError}` : '';
    const ok = r.transport ? r.login?.signedIn !== false : false;
    lines.push(`  ${mark(ok)} ${r.title.padEnd(20)} ${r.id.padEnd(13)} ${(r.version ?? '?').padEnd(10)} ${login}${models ? ` · ${models}` : ''}`);
    if (!r.transport) lines.push(`      MetaHarness can't drive ${r.title} yet.`);
    else if (r.login?.signedIn === false && r.loginCommand) lines.push(`      Sign in with: ${r.loginCommand}`);
  }
  if (!found.length) lines.push('  None found.');
  const missing = reports.filter(r => !r.path);
  if (missing.length) lines.push('', `  Not found: ${missing.map(r => r.title).join(', ')}`);

  if (roles.length) {
    lines.push('', 'Roles', '');
    for (const role of roles) {
      const routes = [{ harness: role.harness, model: role.model }, ...role.fallback.map(f => {
        const i = f.indexOf('/');
        return i > 0 ? { harness: f.slice(0, i), model: f.slice(i + 1) } : { harness: role.harness, model: f };
      })];
      const checks = routes.map(r => checkRoute(r.harness, r.model, byId));
      const best = checks.find(c => c.ok) ?? checks.find(c => c.ok === undefined);
      const head = `  ${mark(best?.ok ?? false)} ${role.name.padEnd(14)}`;
      checks.forEach((c, i) => {
        const label = `${i === 0 ? '' : 'backup '}${c.harness} · ${c.model || '(default)'}`;
        lines.push(`${i === 0 ? head : ' '.repeat(head.length)} ${mark(c.ok)} ${label.padEnd(44)} ${c.ok === true ? '' : c.why}`.trimEnd());
      });
      if (!best) lines.push(`${' '.repeat(head.length)}   ${role.name} can't run here. Add a backup to ${relative(process.cwd(), role.file) || role.file}: fallback: <harness>/<model>`);
    }
  }
  return lines;
}
