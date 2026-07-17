# Context IDE

A dependency-free terminal workspace for switching between Codex and Claude Code without losing shared context.

It invokes the locally installed `codex` and `claude` CLIs. Authentication and usage therefore come from your existing Codex and Claude Code subscription sessions—there are no API keys or direct API calls in this project.

## Requirements

- Node.js 18+
- Codex CLI, signed in (`codex login`)
- Claude Code, signed in (`claude auth login`)

## Run

```bash
git clone https://github.com/v1hns/context-ide.git
cd context-ide
npm start
```

Or make the `context-ide` command available globally:

```bash
npm link
context-ide
```

Workspace state is stored at `~/.context-ide/workspace.json` and is never committed.

## Commands

| Command | Action |
| --- | --- |
| `/help` | Show commands |
| `/agent codex` | Use the local Codex subscription |
| `/agent claude` | Use the local Claude Code subscription |
| `/new <title>` | Create and switch to a task |
| `/tabs` | List task tabs |
| `/switch <number>` | Switch tasks |
| `/rename <title>` | Rename the active task |
| `/attach <number>` | Add another task's recent conversation as context |
| `/detach <number>` | Remove attached context |
| `/context` | Show universal context |
| `/context set <text>` | Replace universal context |
| `/context add <text>` | Append universal context |
| `/clear` | Clear the active conversation |
| `/status` | Show the active task, agent, and attachments |
| `/exit` | Save and quit |

Any line that does not begin with `/` is sent to the active CLI agent. Conversation history, universal context, and attached task context are included with each turn.

## Permissions

The child CLIs retain their own configured permissions and safety settings. Context IDE does not pass permission-bypass flags.
