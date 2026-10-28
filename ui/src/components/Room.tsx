import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConfigView, Goal, GoalSummary, Lens, MhEvent, Snapshot } from '../types.ts';
import { ago, duration, money } from '../format.ts';
import { Dialog, Field, Toggle, useConfirm } from './common.tsx';
import { AccountChips, harnessOf } from './Accounts.tsx';
import { EFFORTS, type RoomView } from '../roomData.ts';

/** Roles a maker can be: the team's, without the built-in side sessions and the room lead. */
export function lensRoles(config?: ConfigView): string[] {
  const s = config?.settings.effective;
  const side = new Set([s?.gatekeeper, s?.assistant, s?.roomLead].filter(Boolean));
  return [...new Set((config?.roles ?? []).map(r => r.name))].filter(n => !side.has(n));
}

/** Each runnable harness's models: its own list and the ones roles use on it. */
function modelsByHarness(config?: ConfigView): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const h of config?.harnesses ?? []) {
    if (!h.runnable) continue;
    const models = new Set(h.models);
    for (const r of config?.roles ?? []) if (r.harness === h.id && r.model) models.add(r.model);
    out.set(h.id, [...models].sort());
  }
  return out;
}

/** "harness/model@effort" into its parts, and back. */
export function splitOn(on?: string): { harness: string; model: string; effort: string } {
  const at = on?.lastIndexOf('@') ?? -1;
  const route = on ? (at > 0 ? on.slice(0, at) : on) : '';
  const slash = route.indexOf('/');
  return { harness: slash > 0 ? route.slice(0, slash) : '', model: slash > 0 ? route.slice(slash + 1) : '', effort: at > 0 ? on!.slice(at + 1) : '' };
}
const joinOn = (harness: string, model: string, effort: string) => (harness && model ? `${harness}/${model}${effort ? `@${effort}` : ''}` : undefined);

/** A maker that's just a model needs a responsibility: it's all it's told. */
export const lensProblem = (p: Lens) => (!p.role && !p.on ? 'Pick a model for this maker.' : !p.role && !p.responsibility?.trim() ? 'A maker that’s just a model needs a responsibility.' : '');

/**
 * One maker: a role (or just a model), the harness, model and effort it runs on, what it makes
 * and is responsible for in this room (a preset says both), and optionally a stance and a name.
 */
export function LensEditor({ lens, config, onChange, onRemove }: { lens: Lens; config?: ConfigView; onChange: (p: Lens) => void; onRemove?: () => void }) {
  const roles = lensRoles(config);
  const def = config?.roles.find(r => r.name === lens.role);
  const models = useMemo(() => modelsByHarness(config), [config]);
  const presets = config?.responsibilities ?? [];
  const own = splitOn(lens.on);
  // A role lens shows its role's route until another is picked.
  const harness = own.harness || (lens.role ? '' : [...models.keys()][0] ?? '');
  const shownHarness = harness || def?.harness || '';
  const choices = [...new Set([...(models.get(shownHarness) ?? []), ...(own.model ? [own.model] : []), ...(def?.model && shownHarness === def.harness ? [def.model] : [])])];
  const fallbackDefault = presets.find(r => r.roles.some(x => lens.role?.toLowerCase().includes(x)));
  const [stanceOpen, setStanceOpen] = useState(!!lens.stance);
  const setRoute = (h: string, m: string, e: string) => {
    // Nothing picked on a role lens: it runs as its role says.
    if (lens.role && !h && !m && !e) return onChange({ ...lens, on: undefined });
    const hh = h || def?.harness || '';
    const mm = m || (hh === def?.harness ? def?.model : '') || models.get(hh)?.[0] || '';
    onChange({ ...lens, on: joinOn(hh, mm, e) });
  };
  const preset = presets.find(r => r.text === lens.responsibility);
  return (
    <div className="lens-card">
      <div className="lens-row">
        <select value={lens.role ?? ''} onChange={e => onChange({ ...lens, role: e.target.value || undefined, ...(e.target.value ? {} : { on: lens.on ?? joinOn(shownHarness, choices[0] ?? '', '') }) })} aria-label="Role">
          <option value="">Just a model</option>
          {roles.map(r => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select value={harness} onChange={e => setRoute(e.target.value, '', own.effort)} aria-label="Harness">
          {lens.role && <option value="">{def ? `${def.harness} (role’s)` : 'role’s harness'}</option>}
          {[...models.keys()].map(h => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        <select value={own.model} onChange={e => setRoute(shownHarness, e.target.value, own.effort)} aria-label="Model">
          {lens.role && <option value="">{def?.model ? `${def.model} (role’s)` : 'role’s model'}</option>}
          {choices.map(m => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select value={own.effort} onChange={e => setRoute(own.harness, own.model, e.target.value)} aria-label="Effort">
          <option value="">{lens.role && def?.effort ? `${def.effort} (role’s)` : 'default effort'}</option>
          {EFFORTS.map(x => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
        <input type="text" className="lens-name" value={lens.name ?? ''} onChange={e => onChange({ ...lens, name: e.target.value.trim() || undefined })} placeholder="name" aria-label="Name" />
        {onRemove && (
          <button className="btn ghost small" onClick={onRemove} aria-label="Remove this maker" title="Remove">
            ×
          </button>
        )}
      </div>
      <div className="lens-row second">
        <select
          value={preset?.name ?? (lens.responsibility ? 'custom' : '')}
          onChange={e => {
            const p = presets.find(r => r.name === e.target.value);
            onChange({ ...lens, responsibility: p ? p.text : e.target.value === 'custom' ? (lens.responsibility ?? '') : undefined });
          }}
          aria-label="Responsibility"
        >
          <option value="">{lens.role ? `Usual${fallbackDefault ? `: ${fallbackDefault.name}` : ''}` : 'Responsibility…'}</option>
          {presets.map(r => (
            <option key={r.name} value={r.name}>
              {r.name} ({r.makes === 'text' ? 'write-ups' : `${r.makes}s`})
            </option>
          ))}
          <option value="custom">Your own… (write-ups)</option>
        </select>
        <input
          type="text"
          value={lens.responsibility ?? ''}
          onChange={e => onChange({ ...lens, responsibility: e.target.value || undefined })}
          placeholder={lens.role ? (fallbackDefault?.text ?? 'What this maker is for here (the lead picks makers by it)') : 'Required: what this maker is for here'}
          aria-label="What it's responsible for"
          className={!lens.role && !lens.responsibility?.trim() ? 'needed' : undefined}
        />
        {stanceOpen ? (
          <input type="text" value={lens.stance ?? ''} onChange={e => onChange({ ...lens, stance: e.target.value || undefined })} placeholder="Stance, e.g. argue for the simplest fix" aria-label="Stance" autoFocus={!lens.stance} />
        ) : (
          <button className="btn ghost small" onClick={() => setStanceOpen(true)} title="How it should look at things, besides what it's for">
            + stance
          </button>
        )}
      </div>
    </div>
  );
}

/** Where a new room starts from: a past room (or some of its cards), or a goal. */
export interface RoomFrom {
  id: string;
  label: string;
  kind: 'room' | 'goal';
  topic?: string;
  lenses?: Lens[];
  /** Cards branched off a room's board. */
  cards?: { id: string; title: string }[];
}

/** Starts a room: the topic, and the makers its lead may send and you may ask (the built-in four, a saved cast, or by hand). */
export function NewRoomDialog({ config, from, onClose, onStart, onCommand }: {
  config?: ConfigView;
  from?: RoomFrom;
  onClose: () => void;
  onStart: (b: Record<string, unknown>) => Promise<boolean>;
  onCommand: (b: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
}) {
  const roles = lensRoles(config);
  const casts = config?.casts ?? [];
  const firstRole = (want: string[]) => want.find(r => roles.includes(r));
  const branching = !!from?.cards?.length;
  const [topic, setTopic] = useState(
    () => (branching ? from!.cards!.map(c => c.title).join('; ') : from?.kind === 'room' ? `Follow-up: ${from.topic?.split('\n')[0] ?? ''}` : (from?.topic ?? '')),
  );
  const [lenses, setLenses] = useState<Lens[]>(
    () =>
      from?.lenses?.map(({ role, name, on, responsibility, stance }) => ({ role, name, on, responsibility, stance })) ??
      ['researcher', 'illustrator', 'prototyper', 'writer'].filter(r => roles.includes(r)).map(role => ({ role })),
  );
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<string>();
  const lead = config?.roles.find(r => r.name === config.settings.effective.roomLead);
  const start = async () => {
    if (!topic.trim() || busy) return;
    setBusy(true);
    const ok = await onStart({ cmd: 'room.start', topic: topic.trim(), lenses, from: from?.id, ...(branching ? { cards: from!.cards!.map(c => c.id) } : {}) });
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog title={branching ? 'Branch into a new room' : from ? `New room from this ${from.kind}` : 'New room'} onClose={onClose} wide>
      <div className="dialog-body muted small">
        A room is for getting clear and deciding. You talk with the lead{lead ? ` (${lead.harness} · ${lead.model})` : ''}, which helps you narrow things down, keeps the board and sends makers to find references and make images, playable demos and write-ups; you can ask makers yourself and mix cards into new ones. Nobody changes your project here: building is for a goal.
        {branching ? (
          <>
            {' '}
            The new room starts with {from!.cards!.length > 1 ? 'these cards' : 'this card'} from <b>{from!.label}</b>, and the cards linked to {from!.cards!.length > 1 ? 'them' : 'it'}.
          </>
        ) : (
          from && (
            <>
              {' '}
              It starts with what <b>{from.label}</b> {from.kind === 'room' ? 'has on its board' : 'came to'}.
            </>
          )
        )}
      </div>
      <Field label="What to talk about">
        <textarea autoFocus rows={3} value={topic} onChange={e => setTopic(e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && void start()} placeholder="e.g. What should the jump feel like? Or: a game about tides, what's the hook?" />
      </Field>
      <Field label="Makers" hint="Each starts the first time it's asked, and keeps what it learnt. Change a maker's model, or run one role on two models for a second take. You can add more in the room.">
        <div className="seats">
          {casts.length > 0 && (
            <div className="row start">
              <span className="muted small">Cast:</span>
              {casts.map(c => (
                <button key={c.name} className="btn small" title={c.goodAt || c.participants.map(p => p.role ?? p.on).join(', ')} onClick={() => setLenses(c.participants.map(p => ({ ...p })))}>
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {lenses.map((p, i) => (
            <LensEditor key={i} lens={p} config={config} onChange={n => setLenses(cs => cs.map((x, j) => (j === i ? n : x)))} onRemove={() => setLenses(cs => cs.filter((_, j) => j !== i))} />
          ))}
          <div className="row start">
            <button className="btn small" onClick={() => setLenses(cs => [...cs, { role: firstRole(['writer', 'researcher']) ?? roles[0] }])} disabled={!roles.length}>
              + Maker
            </button>
            {lenses.length > 0 &&
              (saving === undefined ? (
                <button className="btn ghost small" onClick={() => setSaving('')} title="Save these makers as a cast to pick next time">
                  Save as a cast…
                </button>
              ) : (
                <>
                  <input type="text" className="cast-name" autoFocus value={saving} onChange={e => setSaving(e.target.value)} placeholder="cast name, e.g. game-feel" />
                  <button
                    className="btn small"
                    disabled={!saving.trim()}
                    onClick={async () => {
                      if (await onCommand({ cmd: 'cast.save', name: saving.trim(), participants: lenses })) setSaving(undefined);
                    }}
                  >
                    Save
                  </button>
                </>
              ))}
          </div>
        </div>
      </Field>
      <div className="row end">
        <span className="muted kbd-hint">Ctrl+Enter to start</span>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        {lenses.some(lensProblem) && <span className="warn-text small">{lenses.map(lensProblem).find(Boolean)}</span>}
        <button className="btn primary" disabled={!topic.trim() || busy || lenses.some(lensProblem)} onClick={() => void start()}>
          {busy ? 'Opening…' : 'Open the room'}
        </button>
      </div>
    </Dialog>
  );
}

interface HeaderProps {
  rooms: GoalSummary[];
  goal: Goal;
  room: RoomView;
  events: MhEvent[];
  snapshot?: Snapshot;
  connected: boolean;
  onGoal: (id: string) => void;
  onNewRoom: () => void;
  /** A new room that starts with this one's board. */
  onRoomFromThis: () => void;
  /** A goal that carries out what the room settled. */
  onStartGoal: () => void;
  /** Opens the design the room wrote. */
  onDesign: () => void;
  onAllRooms: () => void;
  onCommand: (body: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
}

/** The room's header: which room, and where it goes from here: a design, a goal, another room, or just ending, clearer. */
export function RoomHeader({ rooms, goal, room, events, snapshot, connected, onGoal, onNewRoom, onRoomFromThis, onStartGoal, onDesign, onAllRooms, onCommand }: HeaderProps) {
  const confirm = useConfirm();
  const live = goal.live && goal.status !== 'ended';
  const agents = goal.agents;
  const paused = agents.filter(a => a.state === 'paused' || a.pausing).length;
  const active = agents.filter(a => !['ended', 'crashed', 'done', 'idle'].includes(a.state)).length;
  const allPaused = live && paused > 0 && paused >= active;
  const end = events.find(e => e.type === 'goal.ended');
  const took = live ? `open ${duration(goal.createdAt)}` : end ? `took ${duration(goal.createdAt, new Date(end.ts).getTime())}` : `started ${ago(goal.createdAt)}`;
  const hasDesign = events.some(e => e.type === 'shared.write' && e.data.path === 'room/design.md');
  const shared = goal.sharedDir.endsWith('/') ? goal.sharedDir : `${goal.sharedDir}/`;
  return (
    <header className="goal-header compact">
      <div className="goal-title-row">
        <button className="btn primary new-btn" onClick={onNewRoom} title="Open another room">
          + New room
        </button>
        <RoomSwitcher rooms={rooms} goal={goal} onGoal={onGoal} onNewRoom={onNewRoom} onAllRooms={onAllRooms} />
        <div className="goal-meta">
          <span className={`pill ${live ? 'running' : 'ended'}`}>{live ? 'open' : 'ended'}</span>
          <span>{took}</span>
          {goal.cost != null && <span title="Cost reported by the harnesses: the lead and its makers">{money(goal.cost)}</span>}
          <span>
            {room.lenses.length} maker{room.lenses.length === 1 ? '' : 's'} · {room.cards.length} card{room.cards.length === 1 ? '' : 's'}
          </span>
          {live && snapshot && <AccountChips accounts={snapshot.accounts.filter(a => agents.some(x => x.harness === harnessOf(a.id)))} />}
          {!connected && goal.live && <span className="warn-text">reconnecting…</span>}
          {goal.notice && (
            <span className="help-dot" title={goal.notice}>
              i
            </span>
          )}
        </div>
        <div className="goal-actions">
          {hasDesign && (
            <button className="btn ghost" onClick={onDesign} title="Read the design the room wrote">
              design.md
            </button>
          )}
          {live && room.cards.length > 0 && (
            <button
              className="btn ghost"
              onClick={() => void onCommand({ cmd: 'room.post', goal: goal.id, text: `Write the design for a goal to carry out, as ${shared}room/design.md: what we're making and why, what we decided (citing the cards by id, with any kept values), the references to match (images, demos, sources), the plan in steps, what to test, and what's still open. Work from the board and the chat.` })}
              title="Ask the lead to write room/design.md from the board, citing its cards"
            >
              Write the design
            </button>
          )}
          <button className="btn ghost" onClick={onStartGoal} title="A goal that builds what the room settled; its lead reads the board (the concept, the decisions and their values, the demos) and the design">
            → Goal
          </button>
          <button className="btn ghost" onClick={onRoomFromThis} title="A new room that starts with this board (to branch off a few cards, pick them on the board)">
            New room from this
          </button>
          {live && (
            <>
              {agents.length > 0 && (
                <button className="btn" onClick={() => void onCommand({ cmd: allPaused ? 'goal.resume' : 'goal.pause', goal: goal.id })} title={allPaused ? '' : 'The lead and every maker stop after their current step'}>
                  {allPaused ? '▶ Resume all' : '⏸ Pause all'}
                </button>
              )}
              <button
                className="btn ghost danger"
                onClick={async () => {
                  if (await confirm({ title: 'End this room?', body: 'The lead and its makers stop. The chat, the board, its images and demos stay, and a new room or a goal can start from it.', confirm: 'End the room' }))
                    void onCommand({ cmd: 'room.end', goal: goal.id });
                }}
                title="Done here: clarity is a fine outcome on its own"
              >
                End room
              </button>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

function RoomSwitcher({ rooms, goal, onGoal, onNewRoom, onAllRooms }: { rooms: GoalSummary[]; goal: Goal; onGoal: (id: string) => void; onNewRoom: () => void; onAllRooms: () => void }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [open]);
  const pick = (f: () => void) => () => {
    setOpen(false);
    f();
  };
  return (
    <div className="goal-switcher" ref={ref}>
      <button className="goal-title" onClick={() => setOpen(o => !o)} aria-haspopup="listbox" aria-expanded={open} title={goal.request}>
        <span className="title-text">{goal.request.split('\n')[0]}</span>
        <span className="muted">▾</span>
      </button>
      {open && (
        <div className="menu" role="listbox">
          <button className="menu-item" onClick={pick(onNewRoom)}>
            <b>+ New room</b>
          </button>
          {rooms.slice(0, 12).map(g => (
            <button key={g.id} className={`menu-item${g.id === goal.id ? ' on' : ''}`} onClick={pick(() => onGoal(g.id))}>
              <span className={`pill ${g.status === 'running' ? 'running' : 'ended'}`}>{g.status === 'running' ? 'open' : 'ended'}</span>
              <span className="ellipsis">{g.request}</span>
              <span className="sub">
                {money(g.cost)} · {ago(g.createdAt)}
              </span>
            </button>
          ))}
          <button className="menu-item" onClick={pick(onAllRooms)}>
            All rooms…
          </button>
        </div>
      )}
    </div>
  );
}
