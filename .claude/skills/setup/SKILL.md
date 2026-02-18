---
name: setup
description: Run initial NanoClaw setup. Use when user wants to install dependencies, authenticate Slack, register their main channel, or start the background services. Triggers on "setup", "install", "configure nanoclaw", or first-time setup requests.
---

# NanoClaw Setup

Run setup scripts automatically. Only pause when user action is required (Slack token configuration, configuration choices). Scripts live in `.claude/skills/setup/scripts/` and emit structured status blocks to stdout. Verbose logs go to `logs/setup.log`.

**Principle:** When something is broken or missing, fix it. Don't tell the user to go fix it themselves unless it genuinely requires their manual action (e.g. creating a Slack app, pasting a secret token). If a dependency is missing, install it. If a service won't start, diagnose and repair. Ask the user for permission when needed, then do the work.

**UX Note:** Use `AskUserQuestion` for all user-facing questions.

## 1. Check Environment

Run `./.claude/skills/setup/scripts/01-check-environment.sh` and parse the status block.

- If HAS_AUTH=true → note that Slack tokens exist, offer to skip step 5
- If HAS_REGISTERED_GROUPS=true → note existing config, offer to skip or reconfigure
- Record PLATFORM, APPLE_CONTAINER, and DOCKER values for step 3

**If NODE_OK=false:**

Node.js is missing or too old. Ask the user if they'd like you to install it. Offer options based on platform:

- macOS: `brew install node@22` (if brew available) or install nvm then `nvm install 22`
- Linux: `curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs`, or nvm

If brew/nvm aren't installed, install them first (`/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"` for brew, `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash` for nvm). After installing Node, re-run the environment check to confirm NODE_OK=true.

## 2. Install Dependencies

Run `./.claude/skills/setup/scripts/02-install-deps.sh` and parse the status block.

**If failed:** Read the tail of `logs/setup.log` to diagnose. Common fixes to try automatically:
1. Delete `node_modules` and `package-lock.json`, then re-run the script
2. If permission errors: suggest running with corrected permissions
3. If specific package fails to build (native modules like better-sqlite3): install build tools (`xcode-select --install` on macOS, `build-essential` on Linux), then retry

Only ask the user for help if multiple retries fail with the same error.

## 3. Container Runtime

### 3a. Choose runtime

Use the environment check results from step 1 to decide which runtime to use:

- PLATFORM=linux → Docker
- PLATFORM=macos + APPLE_CONTAINER=installed → apple-container
- PLATFORM=macos + DOCKER=running + APPLE_CONTAINER=not_found → Docker
- PLATFORM=macos + DOCKER=installed_not_running → start Docker: `open -a Docker`. Wait 15s, re-check with `docker info`. If still not running, tell the user Docker is starting up and poll a few more times.
- Neither available → AskUserQuestion: Apple Container (recommended for macOS) vs Docker?
  - Apple Container: tell user to download from https://github.com/apple/container/releases and install the .pkg. Wait for confirmation, then verify with `container --version`.
  - Docker on macOS: install via `brew install --cask docker`, then `open -a Docker` and wait for it to start. If brew not available, direct to Docker Desktop download.
  - Docker on Linux: install with `curl -fsSL https://get.docker.com | sh && sudo usermod -aG docker $USER`. Note: user may need to log out/in for group membership.

### 3b. Docker conversion gate (REQUIRED before building)

**If the chosen runtime is Docker**, you MUST check whether the source code has already been converted from Apple Container to Docker. Do NOT skip this step. Run:

```bash
grep -q 'container system status' src/index.ts && echo "NEEDS_CONVERSION" || echo "ALREADY_CONVERTED"
```

Check these three files for Apple Container references:
- `src/index.ts` — look for `container system status` or `ensureContainerSystemRunning`
- `src/container-runner.ts` — look for `spawn('container'`
- `container/build.sh` — look for `container build`

**If ANY of those Apple Container references exist**, the source code has NOT been converted. You MUST run the `/convert-to-docker` skill NOW, before proceeding to the build step. Do not attempt to build the container image until the conversion is complete.

**If none of those references exist** (i.e. the code already uses `docker info`, `spawn('docker'`, `docker build`), the conversion has already been done. Continue to 3c.

### 3c. Build and test

Run `./.claude/skills/setup/scripts/03-setup-container.sh --runtime <chosen>` and parse the status block.

**If BUILD_OK=false:** Read `logs/setup.log` tail for the build error.
- If it's a cache issue (stale layers): run `container builder stop && container builder rm && container builder start` (Apple Container) or `docker builder prune -f` (Docker), then retry.
- If Dockerfile syntax or missing files: diagnose from the log and fix.
- Retry the build script after fixing.

**If TEST_OK=false but BUILD_OK=true:** The image built but won't run. Check logs — common cause is runtime not fully started. Wait a moment and retry the test.

## 4. Claude Authentication (No Script)

If HAS_ENV=true from step 1, read `.env` and check if it already has `CLAUDE_CODE_OAUTH_TOKEN` or `ANTHROPIC_API_KEY`. If so, confirm with user: "You already have Claude credentials configured. Want to keep them or reconfigure?" If keeping, skip to step 5.

AskUserQuestion: Claude subscription (Pro/Max) vs Anthropic API key?

**Subscription:** Tell the user:
1. Open another terminal and run: `claude setup-token`
2. Copy the token it outputs
3. Add it to the `.env` file in the project root: `CLAUDE_CODE_OAUTH_TOKEN=<token>`
4. Let me know when done

Do NOT ask the user to paste the token into the chat. Do NOT use AskUserQuestion to collect the token. Just tell them what to do, then wait for confirmation that they've added it to `.env`. Once confirmed, verify the `.env` file has the key.

**API key:** Tell the user to add `ANTHROPIC_API_KEY=<key>` to the `.env` file in the project root, then let you know when done. Once confirmed, verify the `.env` file has the key.

## 5. Slack Authentication

If HAS_AUTH=true from step 1, confirm with user: "Slack tokens already exist. Want to keep them or reconfigure?" If keeping, skip to step 6.

Tell the user to create a Slack App at https://api.slack.com/apps:

1. Click "Create New App" → "From scratch"
2. Name the app (e.g. "NanoClaw") and select the workspace
3. Go to **OAuth & Permissions** → Add these Bot Token Scopes:
   - `app_mentions:read`, `chat:write`, `channels:read`, `channels:history`
   - `groups:read`, `groups:history`, `im:read`, `im:history`, `im:write`, `users:read`
4. Go to **Event Subscriptions** → Enable Events → Subscribe to bot events:
   - `app_mention`, `message.im`
5. Go to **Socket Mode** → Enable Socket Mode → Generate an App-Level Token with `connections:write` scope
   - Copy the token (starts with `xapp-`)
6. Go to **Install App** → Install to Workspace → Copy the Bot User OAuth Token (starts with `xoxb-`)
7. Add both tokens to `.env`:
   - `SLACK_BOT_TOKEN=xoxb-...`
   - `SLACK_APP_TOKEN=xapp-...`

Wait for the user to confirm they've added the tokens to `.env`.

Run `./.claude/skills/setup/scripts/04-auth-slack.sh` and parse the status block.

**If AUTH_STATUS=authenticated:** Display the bot user ID and team name. Continue.

**If AUTH_STATUS=missing_tokens:** Tokens not found in `.env`. Walk the user through adding them.

**If AUTH_STATUS=failed:** Token is invalid. Ask the user to verify they copied the correct token. Common issues:
- Wrong token type (user token vs bot token)
- Token not yet installed to workspace
- App permissions not saved before installing

## 6. Configure Trigger and Channel

AskUserQuestion: What trigger word? (default: Andy). In channels, the bot responds when @mentioned. The trigger word is used as the bot's display name in conversations.

AskUserQuestion: Main channel type?
1. Slack channel — Recommended. @mention the bot in a channel to interact.
2. DM with the bot — Message the bot directly. No @mention needed.

## 7. Sync and Select Channel

1. Run `./.claude/skills/setup/scripts/05-sync-channels.sh` (Bash timeout: 60000ms)
2. **If CHANNELS_IN_DB=0:** Check `logs/setup.log`. Common causes: bot not installed to workspace (re-run step 5), insufficient permissions.
3. Query the database for channels: `sqlite3 store/messages.db "SELECT jid, name FROM chats WHERE jid LIKE 'C%' OR jid LIKE 'G%' ORDER BY name"`. Do NOT display the raw output to the user.
4. Present the most likely candidates as AskUserQuestion options — show names only, not channel IDs. Include channels where the bot has been invited. If using DM, get the DM channel ID from the sync results.

**Important:** The bot must be invited to the channel first. Tell the user to invite the bot with `/invite @BotName` in the desired channel before selecting it.

## 8. Register Channel

Run `./.claude/skills/setup/scripts/06-register-channel.sh` with args:
- `--jid "CHANNEL_ID"` — from step 7 (e.g. `C012345ABCD`)
- `--name "main"` — always "main" for the first channel
- `--trigger "@TriggerWord"` — from step 6
- `--folder "main"` — always "main" for the first channel
- `--no-trigger-required` — if DM channel
- `--assistant-name "Name"` — if trigger word differs from "Andy"

## 9. Mount Allowlist

AskUserQuestion: Want the agent to access directories outside the NanoClaw project? (Git repos, project folders, documents, etc.)

**If no:** Run `./.claude/skills/setup/scripts/07-configure-mounts.sh --empty`

**If yes:** Collect directory paths and permissions (read-write vs read-only). Ask about non-main group read-only restriction (recommended: yes). Build the JSON and pipe it to the script:

`echo '{"allowedRoots":[...],"blockedPatterns":[],"nonMainReadOnly":true}' | ./.claude/skills/setup/scripts/07-configure-mounts.sh`

Tell user how to grant a group access: add `containerConfig.additionalMounts` to their entry in `data/registered_groups.json`.

## 10. Start Service

If the service is already running (check `systemctl --user is-active nanoclaw` on Linux or `launchctl list | grep nanoclaw` on macOS), stop it first — then proceed with a clean install.

Run `./.claude/skills/setup/scripts/08-setup-service.sh` and parse the status block.

**If SERVICE_LOADED=false:**
- Read `logs/setup.log` for the error.
- On macOS: check `launchctl list | grep nanoclaw` to see if it's loaded with an error status. If the PID column is `-` and the status column is non-zero, the service is crashing. Read `logs/nanoclaw.error.log` for the crash reason and fix it (common: wrong Node path, missing .env, missing Slack tokens).
- On Linux: check `systemctl --user status nanoclaw` for the error and fix accordingly.
- Re-run the setup-service script after fixing.

## 11. Verify

Run `./.claude/skills/setup/scripts/09-verify.sh` and parse the status block.

**If STATUS=failed, fix each failing component:**
- SERVICE=stopped → run `npm run build` first, then restart: `launchctl kickstart -k gui/$(id -u)/com.nanoclaw` (macOS) or `systemctl --user restart nanoclaw` (Linux). Re-check.
- SERVICE=not_found → re-run step 10.
- CREDENTIALS=missing → re-run step 4.
- SLACK_AUTH=not_found → re-run step 5.
- REGISTERED_GROUPS=0 → re-run steps 7-8.
- MOUNT_ALLOWLIST=missing → run `./.claude/skills/setup/scripts/07-configure-mounts.sh --empty` to create a default.

After fixing, re-run `09-verify.sh` to confirm everything passes.

Tell user to test: @mention the bot in the registered Slack channel (or send a DM if using DM mode).

Show the log tail command: `tail -f logs/nanoclaw.log`

## Troubleshooting

**Service not starting:** Check `logs/nanoclaw.error.log`. Common causes: wrong Node path in service config (re-run step 10), missing `.env` (re-run step 4), missing Slack tokens (re-run step 5).

**Container agent fails ("Claude Code process exited with code 1"):** Ensure Docker is running: `sudo systemctl start docker` (Linux) or `open -a Docker` (macOS). Check container logs in `groups/main/logs/container-*.log`.

**No response to messages:** Verify the bot is invited to the channel (`/invite @BotName`). Check that event subscriptions (`app_mention`, `message.im`) are configured. Check the registered channel ID in the database: `sqlite3 store/messages.db "SELECT * FROM registered_groups"`. Check `logs/nanoclaw.log`.

**Slack connection issues:** Verify Socket Mode is enabled in the Slack app settings. Check that `SLACK_APP_TOKEN` starts with `xapp-` and `SLACK_BOT_TOKEN` starts with `xoxb-`. Re-run `04-auth-slack.sh` to validate tokens.

**Unload service:** `systemctl --user stop nanoclaw` (Linux) or `launchctl unload ~/Library/LaunchAgents/com.nanoclaw.plist` (macOS)
