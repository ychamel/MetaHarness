import type { Goal } from './types.ts';

/**
 * Each agent's colour in the Design and Git views: the categorical slots in the order agents
 * joined the goal, so an agent keeps its colour whatever is filtered. The palette has eight
 * validated slots; agents after them share a neutral grey and are told apart by name (names
 * always sit next to the colour).
 */
export const AGENT_SLOTS = 8;

export function agentColors(goal: Goal): (name?: string) => string {
  const order = new Map(goal.agents.filter(a => !a.quick).map((a, i) => [a.name, i]));
  return name => {
    const i = name === undefined ? undefined : order.get(name);
    return i !== undefined && i < AGENT_SLOTS ? `var(--series-${i + 1})` : 'var(--series-other)';
  };
}
