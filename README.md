# Context IDE

A dependency-free terminal workspace where several AI coding agents share one continuous session and a single context window. Switch models mid-task without losing what was said.

Built-in providers invoke locally installed agent CLIs, so their authentication and usage come from each CLI's existing subscription. You can also import your own models: another CLI, or any OpenAI-compatible HTTP API (Moonshot/Kimi, DeepSeek, Groq, OpenRouter, …) authenticated with an environment variable. Imported API models are the only path that makes direct API calls; the built-ins never do.

## Interface

Like Claude Code and Codex, you type into a **bordered input box pinned to the bottom of the terminal**, and the conversation scrolls in the region above it. The box never moves or restacks. Its top border shows the active model and task, and the line just below it is the shared context-window meter plus every model's limit bars, so context and quotas are always in view:

```text
╭─ claude · General ───────────────────────────────╮
│ › describe the retry logic                        │
╰───────────────────────────────────────────────────╯
 ctx ████░░░░░░░░ 31% (7.4k/24k tok)  ·  codex 10%  ·  claude 22%  ·  2 agents
```

The box supports the usual line editing (arrows, Home/End, Ctrl-A/E/U/W, word delete) and recalls previous inputs with the up arrow. Each answer ends with a recap like `✻ cogitated for 4s · context ~5.2k/24k tokens`. Toggle the box off with `/config frame off` (then `/restart`) to fall back to a plain readline prompt with a single inline status line; non-interactive use (pipes, redirects) uses the plain prompt automatically.

Every launch starts a **fresh session** with clean context, so a new conversation is never blended into whatever you were doing before. Both the transcript and the universal context are archived to `~/.context-ide/history/` and then cleared; your config, tabs, and imported models are kept. A `/restart` (a code reload) resumes the in-progress session instead of clearing it. Turn the behavior off with `/config fresh off` to resume the last conversation and context on every launch. Clear the universal context by hand any time with `/context clear`.

Pasted text behaves like Claude Code and Codex: a multi-line or long paste collapses to a `[Pasted text #1 +12 lines]` placeholder in the prompt instead of flooding the line, and expands back to the full content when you send the message.

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
| `/providers` | Show every model (built-in and imported), availability, and setup hints |
| `/model` | Show the codex/claude CLI models in use |
| `/model <provider> <model>` | Set the CLI model (e.g. `/model claude sonnet`, `/model codex gpt-5-codex`) |
| `/model <provider> default` | Revert to the CLI's own default model |
| `/models` | List imported models and the import syntax |
| `/provider add <name> api <baseUrl> <model> [KEY_ENV]` | Import an OpenAI-compatible API model |
| `/provider add <name> cli <command> [args… use {prompt}]` | Import another CLI as a model |
| `/provider remove <name>` | Remove an imported model |
| `/agent <provider>` | Switch the active task's agent |
| `/new <title>` | Create and switch to a task |
| `/tabs` | List task tabs |
| `/switch <number>` | Switch tasks |
| `/rename <title>` | Rename the active task |
| `/cd <path>` | Set the active task's working directory |
| `/attach <number>` | Add another task's recent conversation as context |
| `/detach <number>` | Remove attached context |
| `/context` | Show universal context |
| `/context set <text>` | Replace universal context |
| `/context add <text>` | Append universal context |
| `/context clear` | Empty the universal context |
| `/clear` | Clear the active conversation |
| `/status` | Show the active task, agent, and attachments |
| `/usage` | Show measured calls/tokens and known remaining limits |
| `/limit <provider> <0-100\|auto> [reset]` | Set or clear a manual remaining-limit reading |
| `/config` | Show interface and delegation settings |
| `/config statusbar <on\|off>` | Toggle the status line |
| `/config frame <on\|off>` | Toggle the pinned input box (takes effect on `/restart`) |
| `/config fresh <on\|off>` | Start each launch fresh (on) or resume the last conversation (off) |
| `/config delegation <on\|off>` | Toggle low-limit delegation prompts |
| `/config ping <on\|off>` | Toggle the terminal bell for delegation |
| `/config threshold <1-99>` | Set the low-limit percentage |
| `/config barwidth <4-20>` | Set status-bar width |
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
| `/restart` | Save the workspace and restart Context IDE |
| `/exit` | Save and quit |

Any line that does not begin with `/` is sent to the active agent. Conversation history, universal context, and attached task context are included with each turn.

## One shared session

Every model in Context IDE is treated as a collaborator in a single ongoing session rather than a fresh assistant on a mission. Each turn tells the active model who else has contributed (`SHARED SESSION AGENTS: codex, claude`) and, when another model advanced the conversation since this one last spoke, names them so it builds on their work instead of restarting. The shared context window is packed the same way regardless of which model answers, so switching agents continues one conversation.

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

## Limits and delegation

The status line under the input box shows every provider currently used by a task or recorded in workspace usage:

```text
 ctx ████░░░░░░░░ 31% (7.4k/24k tok)  ·  codex [█░░░░░░] 10%  ·  claude [██░░░░░] 22%  ·  2 agents
```

Context IDE displays the used percentage for the tightest real quota window for Codex and Claude; `/usage` shows each available window separately. Codex limits come from local Codex rate-limit session events. Claude limits come from Anthropic's quota-only OAuth usage endpoint using the existing Claude Code credential in macOS Keychain. The credential is read in a short-lived helper, used only as an authorization header, and is never printed or stored by Context IDE. Results are cached for three minutes. Other unmeasurable providers say `quota unavailable`. Limits are never estimated from unrelated token counts. Detailed call and token telemetry stays in `/usage`. You can override a reading manually and later return to automatic detection:

```text
/limit claude 15 5:30pm
/limit claude auto
```

When the active provider is at or below the configured threshold—or reports an exhausted quota—Context IDE rings the terminal bell and asks before retrying the same request with the healthiest installed provider. It never delegates without confirmation. Customize this behavior with `/config`.

## Providers

Built-in CLI providers:

| Provider | Authentication route | Command |
| --- | --- | --- |
| Codex | ChatGPT/Codex subscription via `codex login` | `codex` |
| Claude | Claude subscription via `claude auth login` | `claude` |
| Kimi | Kimi membership/OAuth via `kimi login` | `kimi` |
| Gemini | Google account sign-in | `gemini` |
| Copilot | GitHub Copilot subscription | `copilot` |

### Choosing a model for a built-in CLI

Codex and Claude both accept a model override, passed straight through to their CLI's `--model` flag:

```text
/model claude sonnet
/model codex gpt-5-codex
/model            # show current choices
/model claude default   # back to the CLI default
```

Changing a model forgets that provider's native session for every task (so the next turn starts on the new model), and applies to normal turns and rolling summaries alike. For an imported OpenAI-compatible model, `/model <name> <model-id>` updates its model in place.

### Importing more models

Add models at runtime and they persist in the workspace:

```text
# Any OpenAI-compatible API (key read from the environment, never stored)
/provider add moonshot api https://api.moonshot.ai/v1 kimi-k2-0711-preview MOONSHOT_API_KEY
/provider add deepseek api https://api.deepseek.com/v1 deepseek-chat DEEPSEEK_API_KEY

# Any other CLI ({prompt} is substituted; without it the prompt is piped on stdin)
/provider add grok cli grok -p {prompt}
```

API models make direct HTTPS calls to the base URL you supply, authenticated with the named environment variable (defaulting to `<NAME>_API_KEY`). The key is only ever sent as an `Authorization` header and is never written to the workspace. Imported models use the portable summary/recent-history context path and do not claim native provider sessions.

## Permissions

The child CLIs retain their own configured permissions and safety settings. Context IDE does not pass permission-bypass flags.
