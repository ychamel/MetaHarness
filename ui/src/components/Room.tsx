import { useEffect, useMemo, useRef, useState } from 'react';
import type { ConfigView, Goal, GoalSummary, MhEvent, Participant, Snapshot } from '../types.ts';
import { ago, duration, money } from '../format.ts';
import { Dialog, Field, Toggle, useConfirm } from './common.tsx';
import { MessageDialog } from './Dialogs.tsx';
import { AccountChips, harnessOf } from './Accounts.tsx';
import { EFFORTS, type RoomView } from '../roomData.ts';

/** Roles a room can seat: the team's, without the built-in side sessions. */
export function seatRoles(config?: ConfigView): string[] {
  const s = config?.settings.effective;
  const side = new Set([s?.gatekeeper, s?.assistant, s?.coordinator].filter(Boolean));
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

/** A seat that's just a model needs a responsibility: it's all it's told. */
export const seatProblem = (p: Participant) => (!p.role && !p.on ? 'Pick a model for this seat.' : !p.role && !p.responsibility?.trim() ? 'A seat that’s just a model needs a responsibility.' : '');

/**
 * One seat: a role (or just a model), the harness, model and effort it runs on, what it's
 * responsible for in this room, and optionally a stance and a name.
 */
export function SeatEditor({ seat, config, onChange, onRemove }: { seat: Participant; config?: ConfigView; onChange: (p: Participant) => void; onRemove?: () => void }) {
  const roles = seatRoles(config);
  const def = config?.roles.find(r => r.name === seat.role);
  const models = useMemo(() => modelsByHarness(config), [config]);
  const presets = config?.responsibilities ?? [];
  const own = splitOn(seat.on);
  // A role seat shows its role's route until another is picked.
  const harness = own.harness || (seat.role ? '' : [...models.keys()][0] ?? '');
  const shownHarness = harness || def?.harness || '';
  const choices = [...new Set([...(models.get(shownHarness) ?? []), ...(own.model ? [own.model] : []), ...(def?.model && shownHarness === def.harness ? [def.model] : [])])];
  const fallbackDefault = presets.find(r => r.roles.some(x => seat.role?.toLowerCase().includes(x)));
  const [stanceOpen, setStanceOpen] = useState(!!seat.stance);
  const setRoute = (h: string, m: string, e: string) => {
    // Nothing picked on a role seat: it runs as its role says.
    if (seat.role && !h && !m && !e) return onChange({ ...seat, on: undefined });
    const hh = h || def?.harness || '';
    const mm = m || (hh === def?.harness ? def?.model : '') || models.get(hh)?.[0] || '';
    onChange({ ...seat, on: joinOn(hh, mm, e) });
  };
  const preset = presets.find(r => r.text === seat.responsibility);
  return (
    <div className="seat-card">
      <div className="seat-row">
        <select value={seat.role ?? ''} onChange={e => onChange({ ...seat, role: e.target.value || undefined, ...(e.target.value ? {} : { on: seat.on ?? joinOn(shownHarness, choices[0] ?? '', '') }) })} aria-label="Role">
          <option value="">Just a model</option>
          {roles.map(r => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
        <select value={harness} onChange={e => setRoute(e.target.value, '', own.effort)} aria-label="Harness">
          {seat.role && <option value="">{def ? `${def.harness} (role’s)` : 'role’s harness'}</option>}
          {[...models.keys()].map(h => (
            <option key={h} value={h}>
              {h}
            </option>
          ))}
        </select>
        <select value={own.model} onChange={e => setRoute(shownHarness, e.target.value, own.effort)} aria-label="Model">
          {seat.role && <option value="">{def?.model ? `${def.model} (role’s)` : 'role’s model'}</option>}
          {choices.map(m => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <select value={own.effort} onChange={e => setRoute(own.harness, own.model, e.target.value)} aria-label="Effort">
          <option value="">{seat.role && def?.effort ? `${def.effort} (role’s)` : 'default effort'}</option>
          {EFFORTS.map(x => (
            <option key={x} value={x}>
              {x}
            </option>
          ))}
        </select>
        <input type="text" className="seat-name" value={seat.name ?? ''} onChange={e => onChange({ ...seat, name: e.target.value.trim() || undefined })} placeholder="name" aria-label="Name" />
        {onRemove && (
          <button className="btn ghost small" onClick={onRemove} aria-label="Remove this seat" title="Remove">
            ×
          </button>
        )}
      </div>
      <div className="seat-row second">
        <select
          value={preset?.name ?? (seat.responsibility ? 'custom' : '')}
          onChange={e => {
            const p = presets.find(r => r.name === e.target.value);
            onChange({ ...seat, responsibility: p ? p.text : e.target.value === 'custom' ? (seat.responsibility ?? '') : undefined });
          }}
          aria-label="Responsibility"
        >
          <option value="">{seat.role ? `Usual${fallbackDefault ? `: ${fallbackDefault.name}` : ''}` : 'Responsibility…'}</option>
          {presets.map(r => (
            <option key={r.name} value={r.name}>
              {r.name}
            </option>
          ))}
          <option value="custom">Your own…</option>
        </select>
        <input
          type="text"
          value={seat.responsibility ?? ''}
          onChange={e => onChange({ ...seat, responsibility: e.target.value || undefined })}
          placeholder={seat.role ? (fallbackDefault?.text ?? 'What this seat is for here (the coordinator routes by it)') : 'Required: what this seat is for here'}
          aria-label="What it's responsible for"
          className={!seat.role && !seat.responsibility?.trim() ? 'needed' : undefined}
        />
        {stanceOpen ? (
          <input type="text" value={seat.stance ?? ''} onChange={e => onChange({ ...seat, stance: e.target.value || undefined })} placeholder="Stance, e.g. argue for the simplest fix" aria-label="Stance" autoFocus={!seat.stance} />
        ) : (
          <button className="btn ghost small" onClick={() => setStanceOpen(true)} title="How it should look at things, besides what it's for">
            + stance
          </button>
        )}
        {config?.roles.some(r => r.name === 'scout') && (
          <label className="check small" title="It may hand lookups to MetaHarness's scout (a quick helper), keeping its own turn for the thinking">
            <input type="checkbox" checked={!!seat.scout} onChange={e => onChange({ ...seat, scout: e.target.checked || undefined })} /> scout
          </label>
        )}
      </div>
    </div>
  );
}

/** Starts a room: the topic, who's in it (from a saved cast or by hand), and whether they may talk to each other. */
export function NewRoomDialog({ config, from, initial, onClose, onStart, onCommand }: {
  config?: ConfigView;
  /** A room or goal the new room carries on from. */
  from?: { id: string; label: string; kind: 'room' | 'goal' };
  initial?: { topic?: string; cast?: Participant[] };
  onClose: () => void;
  onStart: (b: Record<string, unknown>) => Promise<boolean>;
  onCommand: (b: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
}) {
  const roles = seatRoles(config);
  const casts = config?.casts ?? [];
  const firstRole = (want: string[]) => want.find(r => roles.includes(r)) ?? roles[0];
  const [topic, setTopic] = useState(initial?.topic ?? '');
  const [cast, setCast] = useState<Participant[]>(() => initial?.cast?.map(({ role, on, responsibility, stance, scout }) => ({ role, on, responsibility, stance, scout })) ?? [firstRole(['scout', 'explorer']), firstRole(['designer', 'architect'])].filter((r, i, a): r is string => !!r && a.indexOf(r) === i).map(role => ({ role })));
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState<string>();
  const start = async () => {
    if (!topic.trim() || busy) return;
    setBusy(true);
    const ok = await onStart({ cmd: 'room.start', topic: topic.trim(), cast: cast.filter(p => p.role), open, from: from?.id });
    setBusy(false);
    if (ok) onClose();
  };
  return (
    <Dialog title={from ? `New room from this ${from.kind}` : 'New room'} onClose={onClose} wide>
      <div className="dialog-body muted small">
        You lead: ask the participants, compare their views, settle what to do. They read the code; a patch job lets one change it on the room's own branch, which you merge at the end.
        {from && (
          <>
            {' '}
            It starts with what <b>{from.label}</b> found on its board.
          </>
        )}
      </div>
      <Field label="What to discuss">
        <textarea autoFocus rows={3} value={topic} onChange={e => setTopic(e.target.value)} onKeyDown={e => e.key === 'Enter' && (e.ctrlKey || e.metaKey) && void start()} placeholder="e.g. Creatures die at the map edge: why, and what's the cleanest fix?" />
      </Field>
      <Field
        label="Participants"
        hint="Each seat starts when you first address it. Run a role on another model to hear a second view from the same role."
      >
        <div className="seats">
          {casts.length > 0 && (
            <div className="row start">
              <span className="muted small">Cast:</span>
              {casts.map(c => (
                <button key={c.name} className="btn small" title={c.goodAt || c.participants.map(p => p.role ?? p.on).join(', ')} onClick={() => setCast(c.participants.map(p => ({ ...p })))}>
                  {c.name}
                </button>
              ))}
            </div>
          )}
          {cast.map((p, i) => (
            <SeatEditor key={i} seat={p} config={config} onChange={n => setCast(cs => cs.map((x, j) => (j === i ? n : x)))} onRemove={() => setCast(cs => cs.filter((_, j) => j !== i))} />
          ))}
          <div className="row start">
            <button className="btn small" onClick={() => setCast(cs => [...cs, { role: firstRole(['reviewer']) ?? '' }])} disabled={!roles.length}>
              + Seat
            </button>
            {cast.length > 0 &&
              (saving === undefined ? (
                <button className="btn ghost small" onClick={() => setSaving('')} title="Save these seats as a cast to pick next time">
                  Save as a cast…
                </button>
              ) : (
                <>
                  <input type="text" className="cast-name" autoFocus value={saving} onChange={e => setSaving(e.target.value)} placeholder="cast name, e.g. bug-hunt" />
                  <button
                    className="btn small"
                    disabled={!saving.trim()}
                    onClick={async () => {
                      if (await onCommand({ cmd: 'cast.save', name: saving.trim(), participants: cast })) setSaving(undefined);
                    }}
                  >
                    Save
                  </button>
                </>
              ))}
          </div>
        </div>
      </Field>
      <Toggle checked={open} onChange={setOpen} label="Open discussion" hint="Participants message each other directly and the coordinator only watches. Off (the default): the coordinator decides who goes next, and routes what you don't address to anyone." />
      <div className="row end">
        <span className="muted kbd-hint">Ctrl+Enter to start</span>
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        {cast.some(seatProblem) && <span className="warn-text small">{cast.map(seatProblem).find(Boolean)}</span>}
        <button className="btn primary" disabled={!topic.trim() || busy || cast.some(seatProblem)} onClick={() => void start()}>
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
  onAllRooms: () => void;
  onCommand: (body: Record<string, unknown>) => Promise<Record<string, unknown> | undefined>;
}

/** The room's header: which room, how it's going, its branch, and merging or ending it. */
export function RoomHeader({ rooms, goal, room, events, snapshot, connected, onGoal, onNewRoom, onAllRooms, onCommand }: HeaderProps) {
  const confirm = useConfirm();
  const [messaging, setMessaging] = useState(false);
  const [ending, setEnding] = useState(false);
  const live = goal.live && goal.status !== 'ended';
  const agents = goal.agents;
  const paused = agents.filter(a => a.state === 'paused' || a.pausing).length;
  const active = agents.filter(a => !['ended', 'crashed', 'done', 'idle'].includes(a.state)).length;
  const allPaused = live && paused > 0 && paused >= active;
  const end = events.find(e => e.type === 'goal.ended');
  const took = live ? `open ${duration(goal.createdAt)}` : end ? `took ${duration(goal.createdAt, new Date(end.ts).getTime())}` : `started ${ago(goal.createdAt)}`;
  return (
    <header className="goal-header compact">
      <div className="goal-title-row">
        <button className="btn primary new-btn" onClick={onNewRoom} title="Open another room">
          + New room
        </button>
        <RoomSwitcher rooms={rooms} goal={goal} onGoal={onGoal} onNewRoom={onNewRoom} onAllRooms={onAllRooms} />
        <div className="goal-meta">
          <span className={`pill ${live ? 'running' : 'ended'}`}>{live ? 'open' : 'ended'}</span>
          {live && <span title={room.open ? 'Participants talk to each other; the coordinator watches' : 'The coordinator decides who goes next'}>{room.open ? 'open discussion' : 'moderated'}</span>}
          <span>{took}</span>
          {goal.cost != null && <span title="Cost reported by the harnesses, the coordinator's included">{money(goal.cost)}</span>}
          <span>
            {room.cast.length} seat{room.cast.length === 1 ? '' : 's'}
          </span>
          {goal.roomBranch && (
            <span className="mono" title={room.ahead ? `${room.ahead} commit${room.ahead > 1 ? 's' : ''} on the room's branch that ${goal.branch ?? 'your branch'} doesn't have yet` : "The room's branch: patch jobs commit here"}>
              {goal.roomBranch}
              {room.ahead > 0 && <span className="badge warn">{room.ahead}</span>}
            </span>
          )}
          {live && snapshot && <AccountChips accounts={snapshot.accounts.filter(a => agents.some(x => x.harness === harnessOf(a.id)))} />}
          {!connected && goal.live && <span className="warn-text">reconnecting…</span>}
          {goal.notice && (
            <span className="help-dot" title={goal.notice}>
              i
            </span>
          )}
        </div>
        <div className="goal-actions">
          {live && (
            <>
              {room.ahead > 0 && (
                <button
                  className="btn"
                  title={`Merge the room's branch into ${goal.branch ?? 'your branch'}; the cartographer then maps what changed`}
                  onClick={async () => {
                    if (await confirm({ title: `Merge into ${goal.branch ?? 'your branch'}?`, body: `${room.ahead} commit${room.ahead > 1 ? 's' : ''} from ${goal.roomBranch} land in your checkout. The room stays open, so the cartographer can map the result and you can carry on.`, confirm: 'Merge' }))
                      void onCommand({ cmd: 'room.merge', goal: goal.id });
                  }}
                >
                  ⤵ Merge
                </button>
              )}
              <button className="btn" onClick={() => setMessaging(true)} title="Message one participant directly, outside the thread">
                ✉ Message
              </button>
              {agents.length > 0 && (
                <button className="btn" onClick={() => void onCommand({ cmd: allPaused ? 'goal.resume' : 'goal.pause', goal: goal.id })} title={allPaused ? '' : 'Every participant stops after its current step'}>
                  {allPaused ? '▶ Resume all' : '⏸ Pause all'}
                </button>
              )}
              <button className="btn ghost danger" onClick={() => setEnding(true)}>
                End room
              </button>
            </>
          )}
        </div>
      </div>
      {messaging && <MessageDialog goal={goal} onClose={() => setMessaging(false)} onSend={async b => !!(await onCommand(b))} />}
      {ending && <EndRoomDialog goal={goal} room={room} onClose={() => setEnding(false)} onCommand={onCommand} />}
    </header>
  );
}

/** Ending a room: with unmerged patches, keep the branch (to merge later) or throw it away. */
function EndRoomDialog({ goal, room, onClose, onCommand }: { goal: Goal; room: RoomView; onClose: () => void; onCommand: HeaderProps['onCommand'] }) {
  const end = async (discard: boolean) => {
    onClose();
    await onCommand({ cmd: 'room.end', goal: goal.id, discard });
  };
  return (
    <Dialog title="End this room?" onClose={onClose}>
      <div className="dialog-body">
        <p>Every participant stops. The thread, the board and the shared folder stay, and a new room can start from this one.</p>
        {room.ahead > 0 && (
          <p>
            <b>
              {room.ahead} patch commit{room.ahead > 1 ? 's are' : ' is'} not merged
            </b>{' '}
            into {goal.branch ?? 'your branch'}. Merge first to keep {room.ahead > 1 ? 'them' : 'it'} in your checkout, keep the branch {goal.roomBranch} to merge later, or discard {room.ahead > 1 ? 'them' : 'it'}.
          </p>
        )}
      </div>
      <div className="row">
        <button className="btn" onClick={onClose}>
          Cancel
        </button>
        {room.ahead > 0 && (
          <button className="btn danger-solid" onClick={() => void end(true)}>
            End and discard the patches
          </button>
        )}
        <button className="btn primary" autoFocus onClick={() => void end(false)}>
          {room.ahead > 0 ? 'End, keep the branch' : 'End the room'}
        </button>
      </div>
    </Dialog>
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
