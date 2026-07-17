# Context IDE

A dependency-free terminal workspace for switching between local AI coding agents without losing shared context.

It invokes locally installed agent CLIs. Authentication and usage come from each CLI's existing subscription or local model session—there are no API keys or direct API calls in this project.

## Requirements

- Node.js 18+
- At least one supported provider CLI (see below)

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
| `/providers` | Show providers, availability, and setup hints |
| `/agent <provider>` | Switch the active task's agent |
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
| `/git status` | Show repository status |
| `/git diff` | Show unstaged changes |
| `/git add` | Stage all workspace changes |
| `/git commit <message>` | Commit staged changes |
| `/git push` | Push to the tracked GitHub remote |
| `/exit` | Save and quit |

Any line that does not begin with `/` is sent to the active CLI agent. Conversation history, universal context, and attached task context are included with each turn.

## Providers

| Provider | Authentication route | Command |
| --- | --- | --- |
| Codex | ChatGPT/Codex subscription via `codex login` | `codex` |
| Claude | Claude subscription via `claude auth login` | `claude` |
| Kimi | Kimi membership/OAuth via `kimi login` | `kimi` |
| Gemini | Google account sign-in | `gemini` |
| Copilot | GitHub Copilot subscription | `copilot` |
DeepSeek is intentionally not included: it does not currently offer an official subscription-authenticated coding CLI, and Context IDE does not use local models or direct model API integrations.

## Permissions

The child CLIs retain their own configured permissions and safety settings. Context IDE does not pass permission-bypass flags.
