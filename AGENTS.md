# Notes for AI assistants

You are helping a person install and run Perplexity On Steroids on their own computer. Read this before you run anything. The README has the same facts in shorter form.

## What it is

A local MCP server that Perplexity reaches through the person's own Cloudflare relay. It gives Perplexity file and shell tools with no folder limit and no approval step. A local panel shows every call.

## Ground rules

- Do not edit anything in `app/`. The license forbids changes, and the person needs the code as published.
- Never paste the connector URL, the panel URL with its `#k=` key, or anything from `state.json` into a chat, an issue or a log. They work like passwords. If one leaks, the person presses "Rotate address" in the panel.
- Do not sign in to Cloudflare or Perplexity for the person, and do not type passwords. Tell them what to click.
- Do not delete `~/.perplexity-on-steroids`. It holds the permanent address, and deleting it means setting up the relay again.

## Install and run

Use the folder for the person's system, in this order.

| System | First time | Start | Stop |
| --- | --- | --- | --- |
| Windows | `For-Windows\setup.bat` | `For-Windows\start.bat` | `For-Windows\stop.bat` |
| macOS | `For-macOS/setup.command` | `For-macOS/start.command` | `For-macOS/stop.command` |
| Linux | `bash For-Linux/setup.sh` | `bash For-Linux/start.sh` | `bash For-Linux/stop.sh` |

On macOS, run `chmod +x For-macOS/*.command` once first. Setup installs Node.js, or updates it to the newest patched release from nodejs.org. Run it again after a Node.js security release. Start runs the server in the background and opens the panel.

## Connect Perplexity

1. In the panel, the person presses "Get a permanent address", signs in to Cloudflare in the browser and presses Allow.
2. They press "Copy URL" when the badge says Permanent.
3. In Perplexity they open Customize > Connectors > Add custom > Connector > Add MCP connector and paste the URL.
4. Under Advanced, Authentication must be None. Perplexity picks OAuth by default, and then Add fails with "Server does not support automatic registration".
5. They tick the risk box and press Add. The panel then shows "Perplexity connected".

The "How to connect" button in the panel shows the same steps.

## Where things are

| What | Where |
| --- | --- |
| MCP server | `127.0.0.1:8857` |
| Panel | `127.0.0.1:8859`, the full URL is in `pos-panel.url` in the temp folder |
| Server log | `pos-mcp.log` in the temp folder (`%TEMP%` on Windows, `$TMPDIR` on macOS, `/tmp` on Linux) |
| Settings | `app/bridge/config.json`, also changed from the panel |
| Secret, relay address, last call | `~/.perplexity-on-steroids/state.json` |
| Call history | `~/.perplexity-on-steroids/calls.jsonl` |

## Common problems

- Port 8857 is already in use. Another program or an older copy of the server holds it. Run the stop file, then start again.
- The panel says it needs a key. Open the URL from `pos-panel.url`, not the bare address.
- Perplexity cannot validate the connector. The server is not running or the relay is offline. Start the server and check the panel.
- Perplexity says a tool is unknown. Remove the connector in Perplexity and add it again, because Perplexity caches the tool list.
- Perplexity asks "Reply yes to proceed" before changes. That is Perplexity's own rule and cannot be turned off from here.
