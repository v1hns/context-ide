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
| `/budget [tokens]` | Show or set the token-aware context budget |
| `/summary` | Show the rolling task summary |
| `/summary now` | Summarize older context immediately |
| `/privacy [provider]` | Show provider-specific sharing controls |
| `/privacy <provider> <field> <on\|off>` | Control universal, attached, history, or native context |
| `/sessions` | Show native provider sessions for this task |
| `/sessions reset [provider]` | Forget native session state |
| `/git status` | Show repository status |
| `/git diff` | Show unstaged changes |
| `/git add` | Stage all workspace changes |
| `/git commit <message>` | Commit staged changes |
| `/git push` | Push to the tracked GitHub remote |
| `/exit` | Save and quit |

Any line that does not begin with `/` is sent to the active CLI agent. Conversation history, universal context, and attached task context are included with each turn.

## Context handling

- Prompt context is packed to an estimated token budget (24,000 by default), instead of fixed message counts.
- Older history is automatically compressed into a rolling summary when unsummarized history reaches roughly 65% of the budget.
- Full local transcripts remain in `~/.context-ide/workspace.json`; summarization does not delete them.
- Attached tasks contribute their rolling summary plus the most recent messages that fit their share of the budget.
- Codex and Claude use isolated native session IDs per task. When switching providers, messages that the returning provider missed are supplied as a cross-provider update.
- Kimi, Gemini, and Copilot use the portable summary/recent-history path because this integration does not have a safely isolated native task-session ID for them.
- If a native session disappears or cannot resume, Context IDE rebuilds it from portable context automatically.

Privacy is configured independently for every provider. The four fields are `universal`, `attached`, `history`, and `native`. Changing a policy forgets that provider's native session for the active task so previously shared context is not silently reused. For example:

```text
/privacy kimi
/privacy kimi attached off
/privacy claude universal off
/privacy codex native off
```

The token count is an offline estimate rather than a provider tokenizer result, so it intentionally leaves headroom for provider instructions and output. Budgets range from 4,000 to 48,000 tokens; the upper bound also keeps prompts safe for CLIs that accept them as command arguments.

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
