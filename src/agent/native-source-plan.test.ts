import assert from "node:assert/strict";
import { it } from "node:test";
import {
  issueNativeSourcePlan,
  nativeSourcePlanTerms,
  nativeSourceBudgetTerms,
  assertNativeSourcePayload,
  type NativeSourcePlan,
  type NativeSourcePlanBinding,
  type NativeSourcePlanFacts,
} from "./native-source-plan.js";

const id = (n: number) => "trader_" + n.toString(16).padStart(32, "0");
const address = (n: number) => "0x" + n.toString(16).padStart(40, "0");
function binding(): NativeSourcePlanBinding {
  return {
    issuer: {},
    reader: {},
    budget: {},
    costOwner: "a".repeat(64),
    frameOwner: "b".repeat(64),
    firstDeadline: 100000,
    operationalBinding: "stable-readonly-graph",
    purpose: "audit_source",
    network: "mainnet",
  };
}
function facts(n = 3, m = n, f = 1): NativeSourcePlanFacts {
  return {
    sources: Array.from({ length: n }, (_, i) => ({
      id: id(i + 1),
      address: address(i + 1),
      requires_rwa: false as const,
    })),
    nonClosedSleeves: m,
    fixedSourceIds: Array.from({ length: f }, (_, i) => id(i + 1)),
  };
}
const rejected = { code: "VENUE_COST_PLAN_UNAVAILABLE" };
function unavailable(work: () => unknown) {
  assert.throws(
    work,
    (error) =>
      (error as { code?: string }).code === "VENUE_COST_PLAN_UNAVAILABLE",
  );
}

it("native complete graph counts all 156 N/M/F shapes including G0 and delayed R1 paid reads", () => {
  let count = 0;
  for (let n = 1; n <= 8; n++)
    for (let m = n; m <= 8; m++)
      for (let f = 0; f <= n; f++) {
        const b = binding(),
          p = issueNativeSourcePlan(b, facts(n, m, f), async () => {}),
          t = nativeSourcePlanTerms(p, b);
        assert.equal(t.sourceWeight, 2 * (n + 2 * (n + m + f)));
        assert.ok(t.sourceWeight <= 112);
        count++;
      }
  assert.equal(count, 156);
  const b = binding();
  assert.equal(
    nativeSourcePlanTerms(
      issueNativeSourcePlan(b, facts(), async () => {}),
      b,
    ).sourceWeight,
    34,
  );
});

it("a deterministic contract excludes episode deadlines and object identities but not stable facts", () => {
  const b = binding(),
    f = facts(),
    p = issueNativeSourcePlan(b, f, async () => {}),
    t = nativeSourcePlanTerms(p, b);
  const b2 = { ...binding(), firstDeadline: 200000 };
  const p2 = issueNativeSourcePlan(
    b2,
    { ...facts(), sources: [...facts().sources].reverse() },
    async () => {},
  );
  assert.equal(t.contractKey, nativeSourcePlanTerms(p2, b2).contractKey);
  const changed = { ...binding(), operationalBinding: "another-graph" };
  assert.notEqual(
    t.contractKey,
    nativeSourcePlanTerms(
      issueNativeSourcePlan(changed, f, async () => {}),
      changed,
    ).contractKey,
  );
  assert.notEqual(
    t.contractKey,
    nativeSourcePlanTerms(
      issueNativeSourcePlan(b, facts(3, 4, 1), async () => {}),
      b,
    ).contractKey,
  );
});

it("copied, invented, foreign or rebound capabilities cannot obtain terms", () => {
  const b = binding(),
    p = issueNativeSourcePlan(b, facts(), async () => {});
  for (const fake of [{}, { ...p }, structuredClone(p)])
    unavailable(() => nativeSourcePlanTerms(fake as NativeSourcePlan, b));
  for (const key of [
    "issuer",
    "reader",
    "budget",
    "costOwner",
    "frameOwner",
    "firstDeadline",
    "operationalBinding",
    "purpose",
    "network",
  ] as const) {
    const value = ["issuer", "reader", "budget"].includes(key)
      ? {}
      : key === "firstDeadline"
        ? 100001
        : "changed";
    unavailable(() =>
      nativeSourcePlanTerms(p, {
        ...b,
        [key]: value,
      } as NativeSourcePlanBinding),
    );
  }
  unavailable(() => nativeSourceBudgetTerms(p, {}, b.frameOwner, [id(1)]));
  unavailable(() =>
    nativeSourceBudgetTerms(p, b.budget, "c".repeat(64), [id(1)]),
  );
  unavailable(() => nativeSourceBudgetTerms(p, b.budget, b.frameOwner, []));
  unavailable(() =>
    nativeSourceBudgetTerms(p, b.budget, b.frameOwner, [id(1), id(1)]),
  );
  assert.equal(
    nativeSourceBudgetTerms(p, b.budget, b.frameOwner, [id(1)]).sourceWeight,
    34,
  );
});

it("facts require explicit native authority and a complete supported graph", () => {
  const b = binding();
  const invalid = [
    facts(0, 0, 0),
    facts(9, 9, 0),
    facts(3, 2, 0),
    facts(3, 9, 0),
    { ...facts(), fixedSourceIds: [id(9)] },
    { ...facts(), fixedSourceIds: [id(1), id(1)] },
    { ...facts(), sources: [{ id: id(1), address: address(1) }] },
    {
      ...facts(),
      sources: [{ id: id(1), address: address(1), requires_rwa: true }],
    },
    { ...facts(), sources: [facts().sources[0], facts().sources[0]] },
    {
      ...facts(),
      sources: [
        { id: id(1), address: address(1), requires_rwa: false },
        { id: id(2), address: address(1), requires_rwa: false },
      ],
    },
  ];
  for (const f of invalid)
    unavailable(() =>
      issueNativeSourcePlan(b, f as NativeSourcePlanFacts, async () => {}),
    );
  unavailable(() =>
    issueNativeSourcePlan(
      { ...b, purpose: "audit_submit" } as unknown as NativeSourcePlanBinding,
      facts(),
      async () => {},
    ),
  );
  unavailable(() =>
    issueNativeSourcePlan(
      { ...b, network: "testnet" } as unknown as NativeSourcePlanBinding,
      facts(),
      async () => {},
    ),
  );
});

it("issuance snapshots facts without freezing or later trusting caller mutable arrays", () => {
  const b = binding(),
    f = facts(),
    p = issueNativeSourcePlan(b, f, async () => {}),
    t = nativeSourcePlanTerms(p, b);
  (f.sources as unknown as { address: string }[])[0].address = address(9);
  (f.fixedSourceIds as string[]).push(id(2));
  assert.deepEqual(t.sourceIds, [id(1), id(2), id(3)]);
  assert.deepEqual(t.historySources, [id(1)]);
  assert.throws(() => (t.sourceIds as string[]).push(id(9)));
  assert.throws(() => ((t as { sourceWeight: number }).sourceWeight = 0));
});

it("only exact selected native CHS data properties reach fresh authority validation", async () => {
  const b = binding();
  let validations = 0;
  const p = issueNativeSourcePlan(b, facts(), async (source) => {
    validations++;
    assert.equal(source.address, address(1));
  });
  for (const payload of [
    null,
    [],
    {},
    { type: "userAbstraction", user: address(1) },
    { type: "clearinghouseState", user: address(9) },
    { type: "clearinghouseState", user: address(1), dex: "" },
    { type: "clearinghouseState", user: address(1), secret: undefined },
    Object.assign(
      { type: "clearinghouseState", user: address(1) },
      { [Symbol("extra")]: true },
    ),
    Object.create({ type: "clearinghouseState", user: address(1) }),
    Object.defineProperties(
      {},
      {
        type: {
          get() {
            throw new Error("must not execute");
          },
        },
        user: { value: address(1) },
      },
    ),
  ])
    await assert.rejects(assertNativeSourcePayload(p, b, payload), rejected);
  assert.equal(validations, 0);
  await assertNativeSourcePayload(p, b, {
    type: "clearinghouseState",
    user: address(1),
  });
  assert.equal(validations, 1);
});

it("every fresh dispatch revalidates authority and refuses changed, expired or unavailable identities", async () => {
  const b = binding();
  let valid = true,
    count = 0;
  const p = issueNativeSourcePlan(b, facts(), async () => {
    count++;
    if (!valid) throw new Error("private authority detail");
  });
  await assertNativeSourcePayload(p, b, {
    type: "clearinghouseState",
    user: address(1),
  });
  valid = false;
  await assert.rejects(
    assertNativeSourcePayload(p, b, {
      type: "clearinghouseState",
      user: address(1),
    }),
    (error) => {
      assert.equal((error as { code: string }).code, rejected.code);
      assert.ok(!String(error).includes("private authority detail"));
      return true;
    },
  );
  assert.equal(count, 2);
});

it("authority awaits cannot authorize a late payload or binding mutation", async () => {
  for (const mutation of ["payload", "binding"]) {
    const b = binding();
    let done!: () => void;
    const blocked = new Promise<void>((resolve) => {
      done = resolve;
    });
    const p = issueNativeSourcePlan(b, facts(), () => blocked),
      payload = { type: "clearinghouseState", user: address(1) };
    const work = assertNativeSourcePayload(p, b, payload);
    if (mutation === "payload") payload.user = address(2);
    else b.firstDeadline++;
    done();
    await assert.rejects(work, rejected);
  }
});

it("authority inputs never execute getters or coerced identity objects", () => {
  const b = binding();
  let invoked = 0;
  const f = facts();
  Object.defineProperty(f.sources, "0", {
    get() {
      invoked++;
      throw new Error("private input");
    },
  });
  unavailable(() => issueNativeSourcePlan(b, f, async () => {}));
  unavailable(() =>
    issueNativeSourcePlan(
      {
        ...b,
        costOwner: {
          toString() {
            invoked++;
            return "a".repeat(64);
          },
        },
      } as unknown as NativeSourcePlanBinding,
      facts(),
      async () => {},
    ),
  );
  const hidden = new Proxy(b, {
    getOwnPropertyDescriptor() {
      throw new Error("private proxy detail");
    },
  });
  unavailable(() => issueNativeSourcePlan(hidden, facts(), async () => {}));
  assert.equal(invoked, 0);
});

it("serialization hooks, Proxy reads and invisible fields cannot change the validated wire request", async () => {
  const b = binding();
  let validations = 0,
    hooks = 0;
  const p = issueNativeSourcePlan(b, facts(), async () => {
    validations++;
  });
  const parent = {
    toJSON() {
      hooks++;
      return { type: "userFunding", user: address(9) };
    },
  };
  const inherited = Object.assign(Object.create(parent), {
    type: "clearinghouseState",
    user: address(1),
  });
  const proxied = new Proxy(
    { type: "clearinghouseState", user: address(1) },
    {
      get(target, key) {
        if (key === "toJSON")
          return () => {
            hooks++;
            return { type: "userFunding", user: address(9) };
          };
        return Reflect.get(target, key);
      },
    },
  );
  const invisible = Object.defineProperties(
    {},
    { type: { value: "clearinghouseState" }, user: { value: address(1) } },
  );
  for (const payload of [inherited, proxied, invisible])
    await assert.rejects(assertNativeSourcePayload(p, b, payload), rejected);
  assert.equal(validations, 0);
  assert.equal(hooks, 0);
  const canonical = Object.freeze(
    Object.assign(Object.create(null), {
      type: "clearinghouseState",
      user: address(1),
    }),
  );
  await assertNativeSourcePayload(p, b, canonical);
  assert.deepEqual(JSON.parse(JSON.stringify(canonical)), {
    type: "clearinghouseState",
    user: address(1),
  });
  assert.equal(validations, 1);
});
