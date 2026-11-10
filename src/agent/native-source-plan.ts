import { createHash } from "node:crypto";
import { types } from "node:util";
import { costPlanUnavailable } from "./account-observation-plans.js";

declare const nativeSourceBrand: unique symbol;
export type NativeSourcePlan = Readonly<{ [nativeSourceBrand]: true }>;
export interface NativeSourcePlanBinding {
  issuer: object;
  reader: object;
  budget: object;
  costOwner: string;
  frameOwner: string;
  firstDeadline: number;
  operationalBinding: string;
  purpose: "audit_source";
  network: "mainnet";
}
export interface NativeSourcePlanSource {
  readonly id: string;
  readonly address: string;
  readonly requires_rwa: false;
}
export interface NativeSourcePlanFacts {
  sources: readonly NativeSourcePlanSource[];
  nonClosedSleeves: number;
  fixedSourceIds: readonly string[];
}
export interface NativeSourcePlanTerms {
  readonly contractKey: string;
  readonly sourceWeight: number;
  readonly sourceIds: readonly string[];
  readonly historySources: readonly string[];
}
export type NativeSourcePlanValidator = (
  source: NativeSourcePlanSource,
) => Promise<void>;
type Record = {
  binding: NativeSourcePlanBinding;
  terms: NativeSourcePlanTerms;
  sources: readonly NativeSourcePlanSource[];
  validate: NativeSourcePlanValidator;
};
const records = new WeakMap<NativeSourcePlan, Record>();
const keys = [
  "issuer",
  "reader",
  "budget",
  "costOwner",
  "frameOwner",
  "firstDeadline",
  "operationalBinding",
  "purpose",
  "network",
] as const;
const idPattern = /^trader_[0-9a-f]{32}$/;
const addressPattern = /^0x[0-9a-f]{40}$/;

function own(value: unknown, key: string): unknown {
  if (!value || typeof value !== "object") throw costPlanUnavailable();
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, key);
  } catch {
    throw costPlanUnavailable();
  }
  if (!descriptor || !("value" in descriptor)) throw costPlanUnavailable();
  return descriptor.value;
}
function bindingCopy(value: NativeSourcePlanBinding): NativeSourcePlanBinding {
  const result = Object.fromEntries(
    keys.map((key) => [key, own(value, key)]),
  ) as unknown as NativeSourcePlanBinding;
  if (
    [result.issuer, result.reader, result.budget].some(
      (ref) => !ref || typeof ref !== "object",
    ) ||
    typeof result.costOwner !== "string" ||
    !/^[0-9a-f]{64}$/.test(result.costOwner) ||
    typeof result.frameOwner !== "string" ||
    !/^[0-9a-f]{64}$/.test(result.frameOwner) ||
    !Number.isSafeInteger(result.firstDeadline) ||
    result.firstDeadline <= 0 ||
    typeof result.operationalBinding !== "string" ||
    !result.operationalBinding.length ||
    result.operationalBinding.length > 256 ||
    result.purpose !== "audit_source" ||
    result.network !== "mainnet"
  )
    throw costPlanUnavailable();
  return Object.freeze(result);
}
function matching(record: Record, binding: NativeSourcePlanBinding): void {
  const current = bindingCopy(binding);
  if (keys.some((key) => current[key] !== record.binding[key]))
    throw costPlanUnavailable();
}
function lookup(plan: NativeSourcePlan): Record {
  const record = records.get(plan);
  if (!record) throw costPlanUnavailable();
  return record;
}

/** Internal capability only. The issuer must supply its freshly verified PG
 * identities and revalidate them before every new provider request. JSON,
 * client labels and previous source responses never create this capability. */
export function issueNativeSourcePlan(
  binding: NativeSourcePlanBinding,
  facts: NativeSourcePlanFacts,
  validate: NativeSourcePlanValidator,
): NativeSourcePlan {
  const savedBinding = bindingCopy(binding);
  const raw = own(facts, "sources"),
    sleeves = own(facts, "nonClosedSleeves"),
    fixed = own(facts, "fixedSourceIds");
  if (
    !Array.isArray(raw) ||
    raw.length < 1 ||
    raw.length > 8 ||
    !Array.isArray(fixed) ||
    !Number.isSafeInteger(sleeves) ||
    (sleeves as number) < raw.length ||
    (sleeves as number) > 8 ||
    typeof validate !== "function"
  )
    throw costPlanUnavailable();
  const sources = Array.from(
    { length: raw.length },
    (_, index): NativeSourcePlanSource => {
      const item = own(raw, String(index));
      const id = own(item, "id"),
        address = own(item, "address"),
        native = own(item, "requires_rwa");
      if (
        typeof id !== "string" ||
        !idPattern.test(id) ||
        typeof address !== "string" ||
        !addressPattern.test(address) ||
        native !== false
      )
        throw costPlanUnavailable();
      return Object.freeze({ id, address, requires_rwa: false });
    },
  ).sort((a, b) => a.id.localeCompare(b.id));
  const sourceIds = sources.map((source) => source.id);
  if (fixed.length > sources.length) throw costPlanUnavailable();
  const fixedIds = Array.from({ length: fixed.length }, (_, index) =>
    own(fixed, String(index)),
  );
  if (
    new Set(sourceIds).size !== sources.length ||
    new Set(sources.map((source) => source.address)).size !== sources.length ||
    fixedIds.some((id) => typeof id !== "string" || !sourceIds.includes(id)) ||
    new Set(fixedIds).size !== fixedIds.length
  )
    throw costPlanUnavailable();
  const historySources = [...fixedIds].sort() as string[];
  // At most N registered background retries, plus two paid reads for each
  // initial N / aged-sleeve M / Fixed-history F call. A retry's first failure
  // is strictly verified UNSENT; its background winner and delayed waiter
  // can each need a fresh paid read. No clock-based pass-count assumption.
  const sourceWeight =
    2 *
    (sources.length +
      2 * (sources.length + (sleeves as number) + fixed.length));
  if (sourceWeight > 112) throw costPlanUnavailable();
  const contractKey = createHash("sha256")
    .update(
      JSON.stringify([
        "native-readonly-runner-source-v1",
        savedBinding.costOwner,
        savedBinding.frameOwner,
        savedBinding.operationalBinding,
        savedBinding.purpose,
        savedBinding.network,
        sources,
        sleeves,
        historySources,
      ]),
    )
    .digest("hex");
  const terms = Object.freeze({
    contractKey,
    sourceWeight,
    sourceIds: Object.freeze(sourceIds),
    historySources: Object.freeze(historySources),
  });
  const token = Object.freeze({}) as NativeSourcePlan;
  records.set(token, {
    binding: savedBinding,
    terms,
    sources: Object.freeze(sources),
    validate,
  });
  return token;
}

export function nativeSourcePlanTerms(
  plan: NativeSourcePlan,
  binding: NativeSourcePlanBinding,
): NativeSourcePlanTerms {
  const record = lookup(plan);
  matching(record, binding);
  return record.terms;
}

export function nativeSourceBudgetTerms(
  plan: NativeSourcePlan,
  budget: object,
  frameOwner: string,
  historySources: readonly string[],
): NativeSourcePlanTerms {
  const record = lookup(plan);
  if (
    record.binding.budget !== budget ||
    record.binding.frameOwner !== frameOwner ||
    !Array.isArray(historySources) ||
    new Set(historySources).size !== historySources.length ||
    JSON.stringify([...historySources].sort()) !==
      JSON.stringify(record.terms.historySources)
  )
    throw costPlanUnavailable();
  return record.terms;
}

function sourceFor(record: Record, payload: unknown): NativeSourcePlanSource {
  if (
    !payload ||
    typeof payload !== "object" ||
    types.isProxy(payload) ||
    Array.isArray(payload) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(payload)) ||
    "toJSON" in payload ||
    Reflect.ownKeys(payload).length !== 2 ||
    !Object.getOwnPropertyDescriptor(payload, "type")?.enumerable ||
    !Object.getOwnPropertyDescriptor(payload, "user")?.enumerable ||
    own(payload, "type") !== "clearinghouseState"
  )
    throw costPlanUnavailable();
  const user = own(payload, "user");
  const source = record.sources.find((item) => item.address === user);
  if (!source) throw costPlanUnavailable();
  return source;
}
export async function assertNativeSourcePayload(
  plan: NativeSourcePlan,
  binding: NativeSourcePlanBinding,
  payload: unknown,
): Promise<void> {
  const record = lookup(plan);
  matching(record, binding);
  const source = sourceFor(record, payload);
  try {
    await record.validate(source);
  } catch {
    throw costPlanUnavailable();
  }
  matching(record, binding);
  if (sourceFor(record, payload) !== source) throw costPlanUnavailable();
}
