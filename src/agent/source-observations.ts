import type { VenueAdapter, SourceSnapshot } from "./adapter.js";
import type { Candidate } from "./domain.js";

export type SourceObservation =
  { ok: true; value: SourceSnapshot } | { ok: false; error: unknown };

// Collect public source evidence independently of follower account eligibility.
// Collection never changes target quantities, initialization, or source cursors.
// A bounded worker pool lets account reads enter the shared venue queue too.
export function observeSources(
  adapter: VenueAdapter,
  traders: Candidate[],
  onObservation?: (id: string, value: SourceObservation) => void,
) {
  const unique = [...new Map(traders.map((t) => [t.id, t])).values()];
  const observations = new Map<string, Promise<SourceObservation>>();
  const complete = new Map<string, (value: SourceObservation) => void>();
  for (const trader of unique)
    observations.set(
      trader.id,
      new Promise((resolve) => complete.set(trader.id, resolve)),
    );
  let index = 0;
  const workers = Array.from(
    { length: Math.min(2, unique.length) },
    async () => {
      while (index < unique.length) {
        const trader = unique[index++];
        let result: SourceObservation;
        try {
          result = { ok: true, value: await adapter.source(trader) };
        } catch (error) {
          result = { ok: false, error };
        }
        onObservation?.(trader.id, result);
        complete.get(trader.id)!(result);
      }
    },
  );
  return {
    get: (id: string) => observations.get(id)!,
    finish: async () => {
      await Promise.all(workers);
      return new Map(
        await Promise.all(
          [...observations].map(
            async ([id, value]) => [id, await value] as const,
          ),
        ),
      );
    },
  };
}
