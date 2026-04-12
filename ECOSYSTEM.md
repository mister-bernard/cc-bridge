# Ecosystem

This repo is part of the [Bernard Bootstrap](https://github.com/mister-bernard/bernard-bootstrap) ecosystem.

## Role
Persistent Claude Code sessions exposed as an OpenAI-compatible `/v1/chat/completions` endpoint. Multi-session bridge for Telegram, Signal, HTTP APIs, and cron jobs. Features message batching, idle timeout management, per-session prompts, and defense-in-depth security for public-facing sessions.

## Related repos
| Repo | Role |
|------|------|
| [bernard-bootstrap](https://github.com/mister-bernard/bernard-bootstrap) | Master entry point — templates, playbooks, provisioning |
| [openclaw-claude-bridge](https://github.com/mister-bernard/openclaw-claude-bridge) | `cc` command, CLAUDE.md synth, tmux launcher |
| [bernard-skills](https://github.com/mister-bernard/bernard-skills) | Skill packages (voice, stego, Twitter, SMS) |
| **openclaw-1** (private) | Modified OpenClaw fork |

## Setup
To clone all ecosystem repos at once:
```
git clone https://github.com/mister-bernard/bernard-bootstrap.git
cd bernard-bootstrap
bash setup-ecosystem.sh
```
