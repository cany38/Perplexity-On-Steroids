# Perplexity On Steroids ✳️

> [!NOTE]
> This project uses Perplexity’s official connector feature. It follows Perplexity’s rules and should not get your account banned.
>
> Everything runs on your computer and on your own Cloudflare account. We have no server and we don't collect data. Perplexity sees a file only when the agent reads it in your chat.
> 
> **Please read this document carefully to set correctly.**

A custom MCP connector that lets Perplexity work on your own computer. It can read and search files, write and edit them, and run shell commands.

Every call runs right away with your user's rights, on any folder your account can reach.
A local panel shows each call as it happens.

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

Setup installs Node.js, or updates it to the newest patched release from nodejs.org, then the packages the project needs. Run it again any time to pick up Node.js security releases. Start opens the panel in your browser. Its "How to connect" guide walks you through the permanent address and adding the connector in Perplexity.

On a Mac, run `chmod +x For-macOS/*.command` once in Terminal first, because the files on GitHub do not carry their run permission. If macOS blocks a file, right click it and choose Open. Mac and Linux support is new and not tested yet.

## Permissions

Perplexity may ask "Reply yes to proceed" in the chat before a change. That is Perplexity's own rule, and the connector cannot turn it off. The connector itself asks nothing and has no folder limit. A path without a folder starts from your home folder.

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
- Anyone with the URL can read, change and delete your files and run commands as your user, with nothing to stop them.
- The panel listens on `127.0.0.1` only and needs the key in its URL.
- The relay runs in your own Cloudflare account and stores only a hash of the secret. Set `POS_TOKEN` to also require `Authorization: Bearer <token>`.

## License

PolyForm Strict 1.0.0. See [LICENSE.md](LICENSE.md). You may download and use the software for personal and other noncommercial purposes. You may not change it, build on it, share copies of it, sell it or use it commercially.

## About

Some parts of this project were made with help from AI tools. I guided and checked all of the work and made every final decision.
