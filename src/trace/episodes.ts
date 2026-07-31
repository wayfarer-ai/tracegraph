/** Episode splitting: turn one interactive session into task-shaped
 * traces at user-message boundaries. Loaders record `episodeBreaks` in
 * trace.meta; this module slices on them. */

import type { Trace } from "./types.js";

/** Split a session trace into task-shaped episodes at user-message
 * boundaries (recorded by the loader). Sessions where a spec makes no
 * sense often contain dozens of episodes where it does. */
export function splitEpisodes(trace: Trace): Trace[] {
  const breaks = (trace.meta["episodeBreaks"] as number[] | undefined) ?? [];
  if (breaks.length === 0) return [trace];
  const bounds = [0, ...breaks, trace.events.length];
  const out: Trace[] = [];
  for (let i = 0; i + 1 < bounds.length; i++) {
    const events = trace.events.slice(bounds[i], bounds[i + 1]);
    if (events.length === 0) continue;
    out.push({
      ...trace,
      id: `${trace.id}#e${i + 1}`,
      events,
      meta: { ...trace.meta, episodeOf: trace.id, episodeBreaks: [] },
    });
  }
  return out;
}
