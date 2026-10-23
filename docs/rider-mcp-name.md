# Rider MCP display name

Starting with `@onride/agent@0.5.3`, the public MCP title, CLI help, OAuth authorization pages, authorization-client name, confirmation cards and current Skill display **Rider**. The company package remains `@onride/agent`, repository `onride-app/ride-agent`, CLI command and MCP registration key `ride`, and credential directory `~/.ride`. OAuth scopes, endpoints, tools and trading confirmation rules are unchanged.

## New installation

```sh
npx -y @onride/agent
```

For ChatGPT, open Plugins, select Add custom MCP server, and use:

| Field | Value |
| --- | --- |
| Name | **Rider** |
| Server URL | `https://mcp.onride.me/mcp` |
| Authentication | OAuth |

Complete the host-generated authorization flow. The package installer does not authorize ChatGPT. ChatGPT asks the creator to enter a name; its saved plugin name is separate from the server title. A server deployment cannot overwrite another user's chosen custom name. See the [official OpenAI setup guide](https://developers.openai.com/api/docs/guides/custom-mcp-server).

Clients that use the MCP `serverInfo.title` show **Rider** after connecting to the new release. Clients that label connections by configuration key can continue to show `ride`; that stable key is retained to preserve login and prevent duplicate registrations. We do not add unsupported client-config fields to force a label.

## Existing installation

```sh
npx -y --prefer-online @onride/agent@latest setup --skip-login
```

Reconnect MCP or start a new chat. Managed npm stdio installations resolve latest at startup; global binaries and explicit GitHub tags stay pinned. For a fixed release use `npx -y @onride/agent@0.5.3` or `npx -y github:onride-app/ride-agent#v0.5.3`.

For an existing ChatGPT custom plugin, edit its application name to **Rider** in plugin settings. Keep the same application, account connection and server URL. Refresh tools if needed; changing the display name alone does not require new OAuth scopes.

Unmodified 0.5.2 Skills and managed 0.5.2 launchers remain eligible for migration. Customized configurations remain user-managed; setup retains custom server URLs, other MCP entries and existing credentials. No proposal, preference or execution state is changed by this display update.
