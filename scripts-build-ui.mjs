import { readFile, writeFile, rm } from "node:fs/promises";
await rm("dist", { recursive: true, force: true });
const css =
    (await readFile("public/agent.css", "utf8")) +
    "\n" +
    (await readFile("public/app-auth.css", "utf8")),
  host = await readFile("public/agent-host.js", "utf8"),
  view = (await readFile("public/agent-view.js", "utf8")).replaceAll(
    "export ",
    "",
  );
for (const name of ["agent", "confirm", "fund", "fund-demo"]) {
  const path = `public/${name}.html`;
  let html = await readFile(path, "utf8");
  html = html
    .replace(/\/\*INLINE_CSS\*\/[\s\S]*?(?=<\/style>)/, `/*INLINE_CSS*/${css}`)
    .replace(
      /\/\*INLINE_VIEW\*\/[\s\S]*?(?=\n(?:\/\*INLINE_HOST\*\/|\/\*INLINE_CONFIRM\*\/|const (?:root|config)=))/,
      `/*INLINE_VIEW*/${view}`,
    );
  if (name === "agent")
    html = html.replace(
      /\/\*INLINE_HOST\*\/[\s\S]*?(?=<\/script>)/,
      `/*INLINE_HOST*/${host}`,
    );
  if (name === "fund")
    html = html.replace(
      /\/\*INLINE_FUND\*\/[\s\S]*?(?=<\/script>)/,
      `/*INLINE_FUND*/${await readFile("public/fund-view.js", "utf8")}`,
    );
  if (name === "confirm")
    html = html.replace(
      /\/\*INLINE_CONFIRM\*\/[\s\S]*?(?=<\/script>)/,
      `/*INLINE_CONFIRM*/${await readFile("public/confirm-host.js", "utf8")}`,
    );
  html = html
    .replace(/\/\*CONFIG\*\/\s*\{\}/g, "/*CONFIG*/{}")
    .replace(/\/\*HOST_CONFIG\*\/\s*\{\}/g, "/*HOST_CONFIG*/{}");
  await writeFile(path, html);
}
