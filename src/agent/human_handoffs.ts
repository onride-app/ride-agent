import { randomBytes } from "node:crypto";
import { createClient } from "redis";

export type HumanHandoff = {
  session: string;
  challenge: string;
  proposal_id?: string;
  deposit_id?: string;
  expires_at: number;
};
export interface HumanHandoffs {
  issue(value: HumanHandoff): Promise<string>;
  consume(ticket: string): Promise<HumanHandoff | undefined>;
}
export class MemoryHumanHandoffs implements HumanHandoffs {
  private values = new Map<string, HumanHandoff>();
  async issue(value: HumanHandoff) {
    for (const [key, entry] of this.values)
      if (entry.expires_at <= Date.now()) this.values.delete(key);
    const ticket = randomBytes(32).toString("base64url");
    this.values.set(ticket, value);
    return ticket;
  }
  async consume(ticket: string) {
    const value = this.values.get(ticket);
    this.values.delete(ticket);
    return value && value.expires_at > Date.now() ? value : undefined;
  }
}
export async function redisHumanHandoffs(url: string): Promise<HumanHandoffs> {
  const client = createClient({ url });
  client.on("error", () => {});
  await client.connect();
  const prefix = "ride:agent:human-handoff:";
  return {
    async issue(value) {
      const ticket = randomBytes(32).toString("base64url");
      await client.set(prefix + ticket, JSON.stringify(value), { PX: 60_000 });
      return ticket;
    },
    async consume(ticket) {
      // GETDEL makes a browser handoff single-use across gateway replicas.
      const raw = await client.getDel(prefix + ticket);
      if (!raw) return undefined;
      const value = JSON.parse(raw) as HumanHandoff;
      return value.expires_at > Date.now() ? value : undefined;
    },
  };
}
