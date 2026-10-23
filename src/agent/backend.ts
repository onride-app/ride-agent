#!/usr/bin/env node
import "dotenv/config";
import express from "express";
import { VERSION } from "../version.js";
import { z } from "zod";
import { PgRepository, Cursor } from "./repository.js";
import { BridgeAdapter } from "./adapter.js";
import { AgentService } from "./service.js";
import { AgentRunner } from "./runner.js";
import {
  AgentError,
  failure,
  inputs,
  publicResult,
  TOOL_NAMES,
  mutationTools,
  stateTools,
  type ToolName,
  id,
  positiveMoney,
  output,
} from "./contracts.js";
import {
  createRideHttpApp,
  requestBodyErrorHandler,
} from "../http_security.js";

export async function validateCoreIdentity(
  token: string,
  graphqlUrl: string,
): Promise<string> {
  const response = await fetch(graphqlUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      query:
        "query AgentIdentity { copyTradeSummary { totalConfigs } me { id } }",
    }),
    signal: AbortSignal.timeout(12000),
    redirect: "error",
  });
  const payload = (await response.json()) as {
    data?: { me?: { id?: string }; copyTradeSummary?: unknown };
    errors?: unknown[];
  };
  const user = payload.data?.me?.id;
  if (
    !response.ok ||
    payload.errors?.length ||
    !payload.data?.copyTradeSummary ||
    !user
  )
    throw new AgentError(
      "AUTH_REQUIRED",
      "A valid Ride session is required.",
      false,
      401,
    );
  return user;
}
export function backendApp(
  service: AgentService,
  identity: (token: string) => Promise<string>,
  host = "127.0.0.1",
  readOnly = false,
) {
  const app = createRideHttpApp(host);
  app.get("/health", (_req, res) =>
    res.json({
      service: "ride-agent",
      version: "3",
      release: VERSION,
      status: "ready",
      read_only: readOnly,
    }),
  );
  app.use(async (req, res, next) => {
    try {
      const header = req.headers.authorization;
      if (!header?.startsWith("Bearer "))
        throw new AgentError(
          "AUTH_REQUIRED",
          "Rider authentication required.",
          false,
          401,
        );
      res.locals.user = await identity(header.slice(7));
      next();
    } catch (e) {
      res.status(e instanceof AgentError ? e.httpStatus : 503).json(failure(e));
    }
  });
  app.post("/agent/v1/:operation", async (req, res) => {
    try {
      const name = req.params.operation;
      if (
        readOnly &&
        (mutationTools.has(name as ToolName) ||
          (stateTools.has(name as ToolName) && name !== "recommend_traders") ||
          name === "proposal")
      )
        throw new AgentError(
          "READ_ONLY",
          "Trading is not enabled on this deployment.",
          false,
          403,
        );
      if (name === "proposal") {
        const arg = z.object({ proposal_id: id }).strict().parse(req.body);
        res.json(
          publicResult(
            await service.proposal(res.locals.user, arg.proposal_id),
          ),
        );
        return;
      }
      if (!TOOL_NAMES.includes(name as any))
        throw new AgentError("NOT_FOUND", "Unknown operation.", false, 404);
      res.json(
        publicResult(
          await service.tool(
            res.locals.user,
            name as keyof typeof inputs,
            req.body,
          ),
        ),
      );
    } catch (e) {
      res.status(e instanceof AgentError ? e.httpStatus : 400).json(failure(e));
    }
  });
  // Separate native Ride surface: MCP exposes none of these endpoints and its
  // opaque access tokens do not pass Core JWT/session validation.
  app.post("/agent/human/:operation", async (req, res) => {
    try {
      const user = res.locals.user;
      if (
        readOnly &&
        !["updates", "update", "portfolio"].includes(req.params.operation)
      )
        throw new AgentError(
          "READ_ONLY",
          "Trading is not enabled on this deployment.",
          false,
          403,
        );
      let value;
      switch (req.params.operation) {
        case "funding_prepare": {
          const a = z
            .object({ deposit_id: id, amount_usdc: positiveMoney })
            .strict()
            .parse(req.body);
          await service.funding.prepare(
            user,
            a.deposit_id,
            String(a.amount_usdc),
          );
          // The human surface needs the refreshed signing challenge. The MCP
          // prepare_deposit tool still returns only the public funding view.
          value = await service.funding.read(user, a.deposit_id);
          break;
        }
        case "funding":
        case "funding_activation_quote":
        case "funding_status": {
          const a = z.object({ deposit_id: id }).strict().parse(req.body);
          value =
            req.params.operation === "funding"
              ? await service.funding.read(user, a.deposit_id)
              : req.params.operation === "funding_activation_quote"
                ? await service.funding.activationQuote(user, a.deposit_id)
                : await service.tool(user, "check_deposit_status", a);
          break;
        }
        case "funding_confirm":
        case "funding_activate": {
          const a = z
            .object({
              deposit_id: id,
              preview_hash: z.string().regex(/^[a-f0-9]{64}$/),
              signature: z
                .string()
                .regex(/^0x[a-fA-F0-9]{130}$/)
                .optional(),
            })
            .strict()
            .parse(req.body);
          value =
            req.params.operation === "funding_confirm"
              ? await service.funding.confirm(
                  user,
                  a.deposit_id,
                  a.preview_hash,
                  a.signature,
                )
              : await service.funding.activate(
                  user,
                  a.deposit_id,
                  a.preview_hash,
                  a.signature,
                );
          break;
        }
        case "proposal": {
          const a = z.object({ proposal_id: id }).strict().parse(req.body);
          value = await service.proposal(user, a.proposal_id);
          break;
        }
        case "confirm": {
          const a = z
            .object({
              proposal_id: id,
              preview_hash: z.string().regex(/^[a-f0-9]{64}$/),
            })
            .strict()
            .parse(req.body);
          value = await service.confirm(user, a.proposal_id, a.preview_hash);
          break;
        }
        case "reject": {
          const a = z.object({ proposal_id: id }).strict().parse(req.body);
          value = await service.reject(user, a.proposal_id);
          break;
        }
        case "authorize": {
          const a = z
            .object({
              portfolio_id: id,
              total_usdc: positiveMoney,
              per_action_usdc: positiveMoney,
              daily_usdc: positiveMoney,
              expires_at: z.number().int().positive(),
              markets: z
                .array(z.enum(["perps", "prediction"]))
                .min(1)
                .max(2),
              assets: z
                .array(z.string().regex(/^[A-Z][A-Z0-9]{0,15}$/))
                .min(1)
                .max(20),
              leverage_cap: z.number().int().min(1).max(40),
            })
            .strict()
            .parse(req.body);
          value = await service.authorize(user, {
            ...a,
            total_usdc: String(a.total_usdc),
            per_action_usdc: String(a.per_action_usdc),
            daily_usdc: String(a.daily_usdc),
          });
          break;
        }
        case "revoke":
          value = await service.revoke(user);
          break;
        case "updates":
          value = await service.tool(user, "get_updates", req.body);
          break;
        case "update": {
          const a = z.object({ event_id: id }).strict().parse(req.body);
          value = await service.update(user, a.event_id);
          break;
        }
        case "portfolio":
          value = await service.tool(user, "get_portfolio", req.body);
          break;
        default:
          throw new AgentError(
            "NOT_FOUND",
            "Unknown human operation.",
            false,
            404,
          );
      }
      res
        .set("Cache-Control", "no-store")
        .json(
          req.params.operation.startsWith("funding")
            ? output.parse(value)
            : publicResult(value),
        );
    } catch (e) {
      res.status(e instanceof AgentError ? e.httpStatus : 400).json(failure(e));
    }
  });
  app.use(requestBodyErrorHandler);
  return app;
}
export async function startBackend(): Promise<void> {
  if (process.env.RIDE_AGENT_ENABLED !== "true")
    throw new Error("Explicit Agent service activation is required");
  const required = (key: string) => {
    const v = process.env[key];
    if (!v) throw new Error(`${key} is required`);
    return v;
  };
  const repository = new PgRepository(required("RIDE_AGENT_DATABASE_URL"));
  await repository.migrate();
  const service = new AgentService(
    repository,
    new BridgeAdapter(
      required("RIDE_AGENT_EXECUTOR_URL"),
      required("RIDE_AGENT_EXECUTOR_TOKEN"),
      process.env.RIDE_AGENT_PRIVATE_HTTP_HOST,
    ),
    required("PUBLIC_BASE_URL"),
    new Cursor(required("RIDE_AGENT_CURSOR_KEY")),
  );
  const app = backendApp(
    service,
    (token) => validateCoreIdentity(token, required("RIDE_GRAPHQL_URL")),
    process.env.HOST ?? "127.0.0.1",
    process.env.RIDE_AGENT_READ_ONLY === "true",
  );
  const controller = new AbortController(),
    runner = new AgentRunner(service);
  const listener = app.listen(
    Number(process.env.PORT ?? 3344),
    process.env.HOST ?? "127.0.0.1",
  );
  process.once("SIGTERM", () => {
    controller.abort();
    listener.close();
  });
  process.once("SIGINT", () => {
    controller.abort();
    listener.close();
  });
  if (process.env.RIDE_AGENT_READ_ONLY === "true") {
    await new Promise<void>((resolve) => {
      controller.signal.addEventListener("abort", () => resolve(), {
        once: true,
      });
    });
  } else {
    await runner.run(controller.signal);
  }
  await repository.close();
}
