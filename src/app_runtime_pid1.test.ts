/** Actual container PID1/EOF lifecycle, fixture parts only: no PG or finance. */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const enabled = process.env.RIDE_AGENT_RUNTIME_PID1_DOCKER_TEST === "true";
test(
  "actual Docker PID1 owner reaches ready and stdin EOF drains fixture parts",
  { skip: !enabled, timeout: 20_000 },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), "app-owner-pid1-"));
    const fixture = join(dir, "fixture.mjs");
    await writeFile(
      fixture,
      `
import { runAppAgentRuntime } from '/opt/ride-agent/dist/app_runtime.js';
process.env.RIDE_AGENT_APP_OWNER_PID=String(process.ppid);
const events=[];
const part=name=>{let end;const closed=new Promise(resolve=>end=resolve);return{closed,async close(){events.push(name);end()}}};
const deps={
 async acquireLease(){events.push('lease');return{lost:new Promise(()=>{}),async release(){events.push('release')}}},
 async startBridge(){events.push('bridge');return part('close:bridge')},
 async startBackend(){events.push('backend');return part('close:backend')}
};
console.log('FIXTURE_PARENT='+process.ppid);
runAppAgentRuntime(deps).then(()=>{
 console.log('FIXTURE_DRAIN='+JSON.stringify(events));process.exit(0);
},error=>{console.log('FIXTURE_ERROR='+error.message);process.exit(1)});
`,
    );
    const image =
      process.env.RIDE_AGENT_RUNTIME_PID1_IMAGE ??
      "predictly-privateowner-repack:node-sanity";
    const child = spawn(
      "docker",
      [
        "run",
        "--rm",
        "-i",
        "--network",
        "none",
        "--platform",
        "linux/amd64",
        "--mount",
        `type=bind,src=${resolve("dist/app_runtime.js")},dst=/opt/ride-agent/dist/app_runtime.js,readonly`,
        "--mount",
        `type=bind,src=${fixture},dst=/fixture.mjs,readonly`,
        "-e",
        "RIDE_AGENT_APP_RUNTIME_ENABLED=true",
        "-e",
        "RIDE_AGENT_INTERNAL_ONLY=true",
        "-e",
        "RIDE_AGENT_ENABLED=true",
        "-e",
        "RIDE_AGENT_APP_SESSION_STORE_ENABLED=false",
        "-e",
        "RIDE_AGENT_DATABASE_URL=postgresql://fixture.invalid/never-connected",
        "-e",
        "DOTENV_CONFIG_PATH=/dev/null",
        "--entrypoint",
        "sh",
        image,
        "-c",
        'node /fixture.mjs <&0 & child=$!; wait "$child"',
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "",
      stderr = "";
    child.stdout.on("data", (data) => {
      stdout += String(data);
    });
    child.stderr.on("data", (data) => {
      stderr += String(data);
    });
    const exited = new Promise<{
      code: number | null;
      signal: NodeJS.Signals | null;
    }>((yes, no) => {
      child.once("error", no);
      child.once("exit", (code, signal) => yes({ code, signal }));
    });
    const deadline = <T>(p: Promise<T>, ms: number) =>
      new Promise<T>((yes, no) => {
        const timer = setTimeout(() => no(Error("PID1 fixture deadline")), ms);
        void p.then(
          (value) => {
            clearTimeout(timer);
            yes(value);
          },
          (error) => {
            clearTimeout(timer);
            no(error);
          },
        );
      });
    try {
      await deadline(
        new Promise<void>((yes, no) => {
          const check = () => {
            if (stdout.includes("APP_AGENT_RUNTIME_READY\n")) yes();
          };
          child.stdout.on("data", check);
          check();
          void exited.then(() => {
            if (!stdout.includes("APP_AGENT_RUNTIME_READY\n"))
              no(Error("Fixture exited before ready: " + stdout + stderr));
          });
        }),
        10_000,
      );
      assert.match(stdout, /FIXTURE_PARENT=1\n/);
      assert.doesNotMatch(stdout, /FIXTURE_ERROR=/);
      child.stdin.end();
      assert.deepEqual(await deadline(exited, 5000), { code: 0, signal: null });
      assert.match(stdout, /APP_AGENT_RUNTIME_STOPPING\n/);
      assert.match(
        stdout,
        /FIXTURE_DRAIN=\["lease","bridge","backend","close:backend","close:bridge","release"\]/,
      );
    } finally {
      child.kill("SIGKILL");
      await exited.catch(() => {});
      await rm(dir, { recursive: true, force: true });
    }
  },
);
