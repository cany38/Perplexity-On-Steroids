# Perplexity On Steroids ✳️

> [!NOTE]
> This project uses Perplexity’s official connector feature. It follows Perplexity’s rules and should not get your account banned.
>
> Everything runs on your computer and on your own Cloudflare account. We have no server and we don't collect data. Perplexity sees a file only when the agent reads it in your chat.
> Please read this document carefully to set correctly.

A custom MCP connector that lets Perplexity work on your own computer. It can read and search files, write and edit them, and run shell commands.

Before Perplexity creates, edits or deletes anything or runs a command, it shows you the exact call in the chat and waits for your "yes". 
The local panel is a second check. Depending on your selected permission level, the change waits there for "Allow". 
The tools can only reach the folders you approved.

<p align="center"><img src="screenshots/perplexity-chat.png" alt="Perplexity shows the call and waits for yes before creating a folder and a file" width="560"></p>

Perplexity reaches the server over a small relay on your own free Cloudflare account, so the connector URL never changes. There is no browser extension and no chat scraping.

![The local panel](screenshots/panel.png)

Custom connectors need Perplexity Pro or Max.

## Getting started

Open the folder for your system and use its three files.

| Folder | First time | Start | Stop |
| --- | --- | --- | --- |
| `For-Windows` | `setup.bat` | `start.bat` | `stop.bat` |
| `For-macOS` | `setup.command` | `start.command` | `stop.command` |
| `For-Linux` | `bash setup.sh` | `bash start.sh` | `bash stop.sh` |

Setup installs Node.js 18 or newer if you don't have it, then the packages the project needs. Start opens the panel in your browser. Its "How to connect" guide walks you through the permanent address and adding the connector in Perplexity.

On a Mac, run `chmod +x For-macOS/*.command` once in Terminal first, because the files on GitHub do not carry their run permission. If macOS blocks a file, right click it and choose Open. Mac and Linux support is new and not tested yet.

## Permissions

There are two checks before anything changes.

1. Perplexity asks "Reply yes to proceed" in the chat before each change and shows the call it is about to make. That is Perplexity's own rule, and the connector cannot turn it off.
2. The local panel can hold the same change for your approval. The permission level decides what waits there.

| Level | Reads | Writes | Commands | Deletes, destructive commands |
| --- | --- | --- | --- | --- |
| Read only | yes | no | no | no |
| Files only | yes | ask | no | ask |
| Ask every time | yes | ask | ask | ask |
| Approve writes automatically | yes | auto | ask | ask |
| Auto run unflagged commands | yes | auto | auto | ask |
| No restrictions | yes | auto | auto | auto |

A request nobody answers within 90 seconds is denied. The Access card in the panel sets which folders the tools can reach.

## Tools

| Tool | What it does |
| --- | --- |
| `pos_ping`, `pos_list_dir`, `pos_read_file`, `pos_search` | read and search |
| `pos_write_file`, `pos_edit_file`, `pos_copy_file`, `pos_move_file`, `pos_make_dir` | change files |
| `pos_delete_file` | delete a file or folder |
| `pos_exec_command` | run a shell command |
| `pos_batch` | run up to 20 calls in one request |
| `pos_list_sessions`, `pos_session_log` | read the call history |

## Security

- The connector URL contains a secret, so treat it like a password. If it leaks, press "Rotate address" and paste the new URL into Perplexity.
- File tools only reach the approved folders, and paths are resolved with `realpath`, so a link pointing outside is refused. This is not an OS sandbox.
- Shell commands run with your user's permissions. The approved folders only set where a command starts, so keep commands on "ask" unless you need them.
- The check for destructive commands is a heuristic. A command it does not flag is not guaranteed safe.
- The panel listens on `127.0.0.1` only and needs the key in its URL. It can widen access, so treat that URL like a password too.
- The relay runs in your own Cloudflare account and stores only a hash of the secret. Set `POS_TOKEN` to also require `Authorization: Bearer <token>`.

## License

PolyForm Strict 1.0.0. See [LICENSE.md](LICENSE.md). You may download and use the software for personal and other noncommercial purposes. You may not change it, build on it, share copies of it, sell it or use it commercially.

## About

Some parts of this project were made with help from AI tools. I guided and checked all of the work and made every final decision.
