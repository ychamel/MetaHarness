import { useMemo, useState } from 'react';
import type { ConfigView, HarnessReport, HarnessView, ModelSettings, Scope } from '../types.ts';
import { useConfirm } from '../components/common.tsx';
import { EditorFooter, ListItem, ScopePicker, Section, SetupLayout, useDraft, useLeaveGuard, type SetupProps } from './setup.tsx';

/** One model's settings as the form edits them: numbers as text, blank for unset. */
interface Row {
  input: string;
  output: string;
  cacheRead: string;
  cacheWrite: string;
  cacheMinutes: string;
}
const COLS: [keyof Row, string, string][] = [
  ['input', 'Input', '$ per million input tokens'],
  ['output', 'Output', '$ per million output tokens'],
  ['cacheRead', 'Cache read', '$ per million tokens read from the prompt cache (blank: the input price)'],
  ['cacheWrite', 'Cache write', '$ per million tokens written to the cache (blank: the input price)'],
  ['cacheMinutes', 'Cache life', 'Minutes an idle prompt cache lasts (blank: what the harness reports, else the default)'],
];
const EMPTY: Row = { input: '', output: '', cacheRead: '', cacheWrite: '', cacheMinutes: '' };
const txt = (n?: number) => (n === undefined ? '' : String(n));
const toRow = (m?: ModelSettings): Row => ({ input: txt(m?.prices?.input), output: txt(m?.prices?.output), cacheRead: txt(m?.prices?.cacheRead), cacheWrite: txt(m?.prices?.cacheWrite), cacheMinutes: txt(m?.cacheMinutes) });
const num = (t: string) => (t.trim() === '' || !Number.isFinite(Number(t)) || Number(t) < 0 ? undefined : Number(t));

/** What a row saves as; null when it's empty (the model's settings are removed). */
function toSettings(r: Row): ModelSettings | null {
  const input = num(r.input);
  const output = num(r.output);
  const out: ModelSettings = {};
  if (input !== undefined && output !== undefined) {
    out.prices = { input, output };
    if (num(r.cacheRead) !== undefined) out.prices.cacheRead = num(r.cacheRead);
    if (num(r.cacheWrite) !== undefined) out.prices.cacheWrite = num(r.cacheWrite);
  }
  if (num(r.cacheMinutes) !== undefined) out.cacheMinutes = num(r.cacheMinutes);
  return Object.keys(out).length ? out : null;
}

const CAPS: [keyof NonNullable<HarnessView['manifest']>, string, string][] = [
  ['injectMidTurn', 'Messages mid-turn', 'A message reaches a running turn'],
  ['resume', 'Resume', 'A finished session can take another turn'],
  ['interrupt', 'Interrupt', 'A turn can be stopped between steps'],
  ['reportsCost', 'Reports cost', 'The harness says what each turn cost; otherwise prices below estimate it'],
  ['reportsContext', 'Reports context', 'How full the context window is'],
  ['reportsRateLimits', 'Reports limits', 'How close the account is to its rate limit'],
];

/** The harnesses on this machine: whether they run, what they can do, and each model's prices and cache life. */
export function Harnesses({ config, selected, onSelect, onSave, onCommand }: SetupProps) {
  const harnesses = useMemo(() => (config?.harnesses ?? []).slice().sort((a, b) => Number(b.runnable) - Number(a.runnable) || a.title.localeCompare(b.title)), [config]);
  const h = harnesses.find(x => x.id === selected) ?? harnesses[0];
  const [models, setModels] = useState<Record<string, string[]>>({});
  const [report, setReport] = useState<Record<string, HarnessReport | 'checking'>>({});
  const [probe, setProbe] = useState<Record<string, { checks: { name: string; ok: boolean | null; detail: string }[]; seconds: number; cost: number | null } | 'running'>>({});
  const [extra, setExtra] = useState('');
  const [picked, setScope] = useState<Scope>('personal');
  // Prices are usually yours on every project; a setup with only the repository's folder saves there.
  const scope: Scope = config?.scopes.some(x => x.scope === picked) ? picked : (config?.scopes[0]?.scope ?? picked);
  const confirm = useConfirm();

  // Models: the profile's, any the harness listed, and any a role uses or has settings for.
  const list = useMemo(() => {
    if (!h) return [];
    const fromSettings = Object.keys(config?.settings.effective.models ?? {})
      .filter(k => k.startsWith(`${h.id}/`))
      .map(k => k.slice(h.id.length + 1));
    const fromRoles = (config?.roles ?? []).flatMap(r => [r.harness === h.id ? r.model : '', ...r.fallback.filter(f => f.startsWith(`${h.id}/`)).map(f => f.slice(h.id.length + 1))]);
    return [...new Set([...fromSettings, ...fromRoles, ...h.models, ...(models[h.id] ?? [])].filter(Boolean))];
  }, [h, config, models]);
  const saved = useMemo(() => Object.fromEntries(list.map(m => [m, toRow(config?.settings.effective.models[`${h?.id}/${m}`] ?? config?.settings.effective.models[m])])), [list, config, h]);
  const { draft, setDraft, dirty, revert } = useDraft<Record<string, Row>>(saved);
  const leave = useLeaveGuard(dirty);
  const [saving, setSaving] = useState(false);
  if (!h) return <div className="page">Loading…</div>;
  const usedBy = (config?.roles ?? []).filter(r => r.harness === h.id || r.fallback.some(f => f.startsWith(`${h.id}/`)));
  const rep = report[h.id];
  const pr = probe[h.id];

  const save = async () => {
    setSaving(true);
    const patch: Record<string, ModelSettings | null> = {};
    for (const m of Object.keys(draft)) if (JSON.stringify(draft[m]) !== JSON.stringify(saved[m] ?? EMPTY)) patch[`${h.id}/${m}`] = toSettings(draft[m]);
    await onSave({ cmd: 'settings.save', scope, patch: { models: patch } });
    setSaving(false);
  };
  const check = async () => {
    setReport(r => ({ ...r, [h.id]: 'checking' }));
    const r = (await onCommand({ cmd: 'harness.check', harness: h.id })) as { report?: HarnessReport } | undefined;
    setReport(x => ({ ...x, [h.id]: r?.report ?? { id: h.id, title: h.title, models: [] } }));
    if (r?.report?.models.length) setModels(x => ({ ...x, [h.id]: r.report!.models }));
  };
  const test = async () => {
    const ok = await confirm({ title: `Test ${h.title}?`, body: 'This runs a few short turns on its cheapest model to check what works on this machine: our tools, mid-turn messages, resume, usage. It costs a few cents and takes a minute or two.', confirm: 'Run the test' });
    if (!ok) return;
    setProbe(p => ({ ...p, [h.id]: 'running' }));
    const r = (await onCommand({ cmd: 'harness.test', harness: h.id })) as any;
    setProbe(p => ({ ...p, [h.id]: r?.checks ? r : { checks: [{ name: 'test', ok: false, detail: 'did not finish' }], seconds: 0, cost: null } }));
  };

  return (
    <SetupLayout
      title="Harnesses"
      intro={<>The agent CLIs on this machine. MetaHarness never handles your logins: each harness uses its own. Prices turn token counts into dollars where a harness doesn’t report cost, and the cache life is how long an idle agent’s prompt cache lasts.</>}
      list={harnesses.map(x => (
        <ListItem
          key={x.id}
          on={x.id === h.id}
          title={x.title}
          onClick={() => void leave().then(ok => ok && onSelect(x.id))}
          extra={<span className={`pill ${x.runnable ? 'running' : ''}`}>{x.runnable ? 'runs here' : 'not here'}</span>}
          sub={<span className="mono">{x.id}</span>}
        />
      ))}
      editor={
        <div className="editor">
          <div className="editor-scroll">
            <div className="editor-title">
              <h2>{h.title}</h2>
              <span className="muted small mono">
                {h.id}
                {h.transport ? ` · ${h.transport}` : ''}
              </span>
            </div>

            <Section title="On this machine" hint={!h.runnable && h.install ? <>Install: <code>{h.install}</code></> : undefined}>
              <div className="row actions">
                <button className="btn small" onClick={() => void check()} disabled={rep === 'checking'}>
                  {rep === 'checking' ? 'Checking…' : 'Check version and login'}
                </button>
                {h.runnable && (
                  <button className="btn small" onClick={() => void test()} disabled={pr === 'running'}>
                    {pr === 'running' ? 'Testing… (a minute or two)' : 'Run the live test'}
                  </button>
                )}
              </div>
              {rep && rep !== 'checking' && (
                <dl className="kv">
                  <dt>Installed</dt>
                  <dd>{rep.path ? <span className="mono">{rep.path}</span> : 'no'}</dd>
                  {rep.version && (
                    <>
                      <dt>Version</dt>
                      <dd>{rep.version}</dd>
                    </>
                  )}
                  {rep.path && (
                    <>
                      <dt>Signed in</dt>
                      <dd>
                        {rep.login?.signedIn === true ? 'yes' : rep.login?.signedIn === false ? 'no' : 'unknown'}
                        {rep.login?.detail ? <span className="muted"> · {rep.login.detail}</span> : null}
                        {rep.login?.signedIn === false && (rep.loginCommand ?? h.login) ? <code>{rep.loginCommand ?? h.login}</code> : null}
                      </dd>
                    </>
                  )}
                  {rep.modelsError && (
                    <>
                      <dt>Models</dt>
                      <dd className="warn-text">{rep.modelsError}</dd>
                    </>
                  )}
                </dl>
              )}
              {pr && pr !== 'running' && (
                <div className="probe">
                  {pr.checks.map(c => (
                    <div key={c.name} className="probe-row">
                      <span className={c.ok === true ? 'ok-text' : c.ok === false ? 'warn-text' : 'muted'}>{c.ok === true ? '✓' : c.ok === false ? '✗' : '?'}</span>
                      <b>{c.name}</b>
                      <span className="muted">{c.detail}</span>
                    </div>
                  ))}
                  <div className="muted small">
                    {pr.seconds}s{pr.cost != null ? `, $${pr.cost.toFixed(4)}` : ''}
                  </div>
                </div>
              )}
              {h.manifest && (
                <div className="caps">
                  {CAPS.map(([k, label, hint]) => (
                    <span key={k} className={`cap${h.manifest![k] ? '' : ' off'}`} title={hint}>
                      {h.manifest![k] ? '✓' : '–'} {label}
                    </span>
                  ))}
                </div>
              )}
              <div className="muted small">
                {usedBy.length ? <>Roles on it: {usedBy.map(r => (r.harness === h.id ? r.name : `${r.name} (backup)`)).join(', ')}</> : 'No role uses it yet.'}
              </div>
            </Section>

            <Section title="Models" hint={<>Saved in <ScopePicker config={config} value={scope} onChange={setScope} /></>}>
              <table className="model-table">
                <thead>
                  <tr>
                    <th>Model</th>
                    {COLS.map(([k, label, hint]) => (
                      <th key={k} title={hint}>
                        {label}
                        <span className="muted">{k === 'cacheMinutes' ? ' min' : ' $/M'}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(draft).map(m => (
                    <tr key={m}>
                      <td className="mono">{m}</td>
                      {COLS.map(([k, label]) => (
                        <td key={k}>
                          <input
                            type="text"
                            inputMode="decimal"
                            aria-label={`${m} ${label}`}
                            value={draft[m][k]}
                            placeholder={k === 'cacheMinutes' ? String(config?.settings.effective.defaultCacheMinutes ?? 5) : '—'}
                            onChange={e => setDraft(d => ({ ...d, [m]: { ...d[m], [k]: e.target.value } }))}
                            className={draft[m][k] && num(draft[m][k]) === undefined ? 'invalid' : ''}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="row add-model">
                <input type="text" value={extra} onChange={e => setExtra(e.target.value.trim())} placeholder="another model ID" />
                <button
                  className="btn small"
                  disabled={!extra || extra in draft}
                  onClick={() => {
                    setDraft(d => ({ ...d, [extra]: { ...EMPTY } }));
                    setExtra('');
                  }}
                >
                  Add
                </button>
                {h.runnable && (
                  <button className="link" onClick={() => void onCommand({ cmd: 'harness.models', harness: h.id, refresh: true }).then(r => r && setModels(x => ({ ...x, [h.id]: (r.models as string[]) ?? [] })))}>
                    List {h.title}’s models
                  </button>
                )}
              </div>
              <div className="hint">An input and an output price are needed for an estimate. Claude Code reports its own cost, so its prices only matter if you want to override the split.</div>
            </Section>
          </div>
          <EditorFooter dirty={dirty} isNew={false} saving={saving} onSave={() => void save()} onRevert={revert} />
        </div>
      }
    />
  );
}
