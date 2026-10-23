# Ride Agent distribution migration

Ride Agent is the **AI Copy-Trading Agent**. It helps you discover traders, build a personalized copy-trading portfolio, and start copying after your confirmation.

## Release state

This migration introduces **@onride/agent 0.5.2** in the company npm organization and the company GitHub repository **onride-app/ride-agent**. Registry publication, GitHub release integrity and hosted deployment each have separate acceptance checks below.

Company ownership and transfer verified on 2026-10-17:

| Item | Verified state |
| --- | --- |
| Company name | `onride`; independent GitHub organization registered under Corporate terms, Free plan |
| Old public npm latest | `@glenyang/ride-cli@0.5.0` |
| New package/release | `@onride/agent@0.5.2`, `onride-app/ride-agent#v0.5.2`; use registry/install checks below to verify availability |
| npm CLI | Authenticated as `glenyang`; account 2FA enabled for authorization and publishing |
| npm organization | `onride` exists; Free plan, unlimited public packages, $0 monthly; sole current Owner `glenyang`, account 2FA and organization 2FA enforcement enabled |
| GitHub source | Original `Glen-yang/ride-mcp` transferred in place; leave the old location unused to retain redirects |
| GitHub destination | `onride-app/ride-agent`, public, same repository ID; all 50 pre-transfer Git refs, 14 releases and 13 issue/PR records retained |
| Company ownership | Founder Glen confirmed as final responsible owner: GitHub `Glen-yang` is organization Owner, npm `glenyang` is organization Owner; `admin@onride.me` verified on npm and set as GitHub organization billing email |
| Developer access | Only the founder is currently a member; add independent developer accounts through repository/team permissions when their usernames are supplied |
| Production MCP | Retain `https://mcp.onride.me/mcp` and its OAuth issuer |
| Website/directories | `onride.me` is the Ride App website; update actual Agent entries after package acceptance and record each existing directory listing separately |

Release maintainers must pass the registry installation checks below before announcing a new version or deprecating the old package. Namespace ownership alone does not establish that a package version is downloadable.

## New installation and existing-user upgrade

New users run:

```sh
npx -y @onride/agent
```

Existing users run once on their original computer:

```sh
npx -y --prefer-online @onride/agent@latest setup --skip-login
```

Add `--client codex`, `--client claude-code` or `--client cursor` to choose a client explicitly. Run once per client if several are installed. Omit `--server` to preserve the installed URL; an environment override `RIDE_MCP_URL` is an explicit server selection and must match the existing registration. Reconnect MCP or open a new chat afterwards.

The CLI command, MCP registration key and Skill directory remain `ride`. MCP implementations advertise the independent display title `Rider`. Tool names, `ride:read`/`ride:trade` scopes and the `~/.ride` session path remain unchanged. Codex keeps its native OAuth store and HTTP entry; Claude Code/Cursor retain their stdio session. Migration does not request login or broader scopes when `--skip-login` is used.

The installer recognizes released fixed-version npm/GitHub launchers and the old npm `latest` launcher, including the actual published 0.5.0 Skill tree. It replaces only managed registrations and known unmodified Skills. Custom servers and unrelated client settings survive. Custom arguments, environment entries, wrappers, unrecognized versions or edited Skills require manual review; conflicts leave the original files untouched and report their paths.

An old namespace cannot redirect its `latest` dist-tag to another package. The explicit command above performs the namespace migration. A globally installed old `ride` binary also stays on its installed package. Prefer the npx command for migration. To switch the optional global binary after the new package is verified:

```sh
npm uninstall -g @glenyang/ride-cli
npm install -g @onride/agent@latest
```

If global installation fails, restore the previous binary with `npm install -g @glenyang/ride-cli@0.5.0` or keep using the new npx command. Neither global operation deletes `~/.ride`.

For a fixed source/version:

```sh
npx -y @onride/agent@0.5.2 setup --client cursor --skip-login
npx -y github:onride-app/ride-agent#v0.5.2 setup --client cursor --skip-login --distribution github
```

The first command pins the installer; generated npm MCP launches deliberately follow `@onride/agent@latest`. Explicit GitHub distribution pins subsequent launches to the release tag. The GitHub tag must point to the exact reviewed release commit.

## Conflicts and failure recovery

Back up a custom client's configuration and `skills/ride` before reviewing it. In a custom stdio registration, update only the package argument after checking its flags and server; keep `ride`, unrelated MCP entries and user options. Merge the packaged Skill with the user's notes manually. Setup will continue refusing to overwrite a customized Skill; the merged instructions can be used as a deliberately user-managed installation.

Setup stages its configuration and Skill, checks that both originals still match, and commits using rename. If the configuration commit fails after a Skill replacement, it restores the old Skill and leaves the original configuration and session untouched. Resolve the reported file/access error and rerun the same upgrade command. Login failure after a successful installation retains the valid installation; retry login separately. Never delete the user's session or original configuration to force a migration.

## Company ownership and repository transfer

1. Create/confirm npm `onride` using the **Unlimited public packages** free plan. Verify availability during creation, not from a public 404. Confirm the company/founder Owner and developer account names. Enforce 2FA and give developers package publishing access through an appropriate team; do not distribute passwords or tokens.
2. Finish the GitHub **onride-app** Free organization as a business-owned organization, using business name `onride` and the owner-confirmed contact email. Accept its agreement only with the authorized person's approval. Confirm company/founder Owner access, developer repository access and 2FA.
3. Transfer the existing repository to that organization and rename it **ride-agent**. Do not create a replacement empty repository, rewrite history or recreate releases. Before/after evidence must compare commit and tag refs, releases, issues/PRs and project access. Check installed GitHub Apps, Actions/environment protection, webhooks, Railway source integration and deployment configuration.
4. Update `origin` only after transfer is confirmed. Preserve the old GitHub redirect by leaving the previous repository location unused. Confirm clone/fetch and fixed release-tag installs at the new URL. Package repository metadata, homepage and issues links must all resolve to the company repository.

Official references: [npm organization creation](https://docs.npmjs.com/creating-an-organization/), [GitHub repository transfer](https://docs.github.com/en/repositories/creating-and-managing-repositories/transferring-a-repository).

## Publish and distribution sequence

Run the source checks, isolated database tests, package verification and online release checks from the reviewed/tagged company repository:

```sh
npm ci
npm run check
RIDE_AGENT_TEST_DATABASE_URL=postgresql://LOCAL_DISPOSABLE_DATABASE npm test
RIDE_AGENT_FUNCTIONAL_DATABASE_URL=postgresql://LOCAL_DISPOSABLE_DATABASE npm run test:functional
npm run verify:package
npm run verify:release -- --online
```

`verify:package` rebuilds, packs and installs a local tarball, checks its file list/common credential formats, exercises fresh and repeat setup for all three clients, and initializes the built stdio MCP. `verify:release -- --online` requires an accessible company-owned repository, an exact release tag and an unused npm version. Passing the local metadata check alone does not establish ownership or publication.

For the initial authenticated publish, use `npm publish --access public` only after owner/team/2FA checks. For CI, bind npm trusted publishing to **onride-app / ride-agent / publish.yml / npm-production**, allowing direct publish. Configure the GitHub `npm-production` environment with company release reviewers and tag restrictions before using it. The manual workflow runs only from a version tag, checks the repository/ref against package metadata and uses GitHub OIDC without storing a publishing token. Node 24 supplies the supported npm client. See [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).

After publishing, verify public registry metadata/integrity; run both `npx -y @onride/agent --help` and `npx -y --prefer-online @onride/agent@latest --help`; install the fixed version and GitHub tag into isolated client homes; initialize each supported transport and perform read-only queries. Exercise proposal confirmation and execution only with the isolated simulated venue. Local/CI tests do not establish a live client login or real exchange execution.

Deploy the reviewed display changes to the existing hosted gateway using the normal deployment sequence; check OAuth display, MCP title, live guide and read paths separately. Do not change endpoints, scopes, tool identifiers, trading flags or service role identifiers as part of the branding rollout.

Update actual Agent website/install entries and existing plugin/MCP listings only after registry and hosted acceptance. The public `onride.me` homepage currently presents the Ride App; its App branding is a separate surface. Obtain its editing access and identify the actual Agent entry/listings before changing it. Do not claim an unverified directory submission or replace the native App brand globally.

Finally publish the old-package migration notice/deprecation. Example **only after new-package acceptance**:

```sh
npm deprecate '@glenyang/ride-cli@*' 'Renamed to @onride/agent. Upgrade once: npx -y --prefer-online @onride/agent@latest setup --skip-login. Details: https://github.com/onride-app/ride-agent/blob/main/docs/ride-agent-migration.md'
```

Keep the old package downloadable. Do not unpublish it or move its latest tag as a substitute for migration.

## Acceptance evidence

| Check | Local result |
| --- | --- |
| TypeScript check / Skill validation | Passed |
| Regression tests with isolated PostgreSQL | 211 passed, 0 failed, 0 skipped, including current main's confirmation-card compatibility fixes |
| Functional OAuth/MCP/CLI/Pg and simulated execution | 45 passed, 0 failed; no real funds moved |
| Packed files / installed CLI / all-client fresh and repeat setup | Passed; see the verification JSON for the final file count and tarball size |
| Built MCP identity | `name=ride`, `title=Rider`, release 0.5.3 |
| Published 0.5.0 upgrades | Fixed npm, old npm latest and GitHub launchers on all 3 clients passed |
| Custom server, unrelated settings and session preservation | Passed |
| Custom configuration refusal / failed commit rollback and retry | Passed |
| GitHub transfer integrity | Same repository ID and all pre-transfer refs, releases, issue/PR records and environments preserved |
| Online release gate | Must verify the company repository, exact release tag and unused npm version immediately before publishing |
| Registry, hosted service and external entries | Verify and record separately using the release checks above; local tests alone do not establish publication or deployment |

Compatibility strings remain intentionally in `src/cli/setup.ts`, migration tests/fixtures and upgrade/rollback documentation. Historical service names such as Railway `ride-mcp`, internal health identifiers, App names, existing OAuth scopes and storage keys retain their meanings.
