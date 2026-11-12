# Zero Margin

A free cyberpunk tabletop game for Windows and Linux, set in the flooded free port of Port Sable. It plays solo against the computer, with friends on one PC, or online with a join code, in English or Polish.

The game has three modes:

- **Squad skirmish:** turn-based tactical battles on a generated city map.
- **Story campaign:** a crew goes from job to job through a story with choices and endings, or keeps going on an endless job board.
- **Card duel:** a hacker tries to crack a corporation's network while the corporation hunts them down.

> **Status: early release.** All three modes are playable, but balance is still rough and some parts have had little real-world testing. See [Known limitations](#known-limitations).

## Download

Builds are on the [Releases page](https://github.com/Dravilias/Zero-Margin/releases).

| System | File | How to start it |
| --- | --- | --- |
| **Windows** | `ZeroMargin-<version>-win-x64-setup.exe` | Run the installer. It adds the game to the Start menu and desktop, needs no administrator rights, and starts the game when it's done. The installer isn't code-signed, so SmartScreen may warn about it the first time (More info → Run anyway). |
| **Linux** | `ZeroMargin-<version>-linux-x86_64.AppImage` | Mark the file as executable, then open it. AppImages need FUSE, which most desktop systems already have. |

On Windows, installing a newer version over an older one keeps saves and settings. So does uninstalling, from Installed apps in Windows Settings.

The tutorial in the main menu has three lessons: a 5-minute walk through the basics of skirmish, a practice fight under Standard Contract rules with hints for overwatch, burst fire, grenades, charging, hacking and patching up, and a card duel with a hint for every decision. A first-time player goes straight into the basics. The campaign explains itself with short tips the first time each screen comes up, and its Guide button shows them all again.

## Install from source

**Linux**

```bash
git clone https://github.com/Dravilias/Zero-Margin.git
cd Zero-Margin
./install.sh
```

The script builds the game if needed, then adds it to the app menu and as a `zero-margin` command, without needing root. Building requires a recent version of Node.js.

| Command | What it does |
| --- | --- |
| `./install.sh --rebuild` | Builds a fresh package and installs it |
| `./install.sh --uninstall` | Removes the game and keeps saves and settings |

**Windows**

`npm ci` followed by `npm run dist:win` builds the installer in the `release` folder.

**Without installing**

`npm ci` followed by `npm start` runs the desktop app directly. `npm run dev` serves the game to a browser at <http://localhost:5199>, but the language-model game master only works in the desktop app.

## Updates

The main menu shows an update entry when a newer version is out. How it updates depends on where the copy came from:

| Copy | What the update entry does |
| --- | --- |
| **Windows installer** | Downloads the installer from the newest release, checks its size and SHA-256 checksum against GitHub's, installs it and restarts the game. Saves and settings are kept. |
| **Linux, installed with `install.sh`** | Runs `git pull` and the install script, then restarts the game. It follows `main`, so it can be newer than the latest release. |
| **Anything else** | Opens the releases page. |

Windows copies from v0.6.12 or earlier have no automatic update, so they need the new installer run by hand once.

To check, the game asks GitHub each time the menu opens. The check can be turned off in Settings.

## Game modes

### Squad skirmish

- Three scenarios: Flatline, Terminal Control and Data Heist
- Four factions and eleven recruitable roles
- A points-based squad builder with weapons, chrome and grenades
- Computer players on easy, normal and hard, able to fill any seat
- Up to 4 players, with autosave and resume

### Story campaign

Money, gear, chrome, levels and injuries carry over from job to job. A campaign can be played alone, on one PC, or online with up to 4 players, each running their own characters. Up to 8 campaigns can be saved at once.

There are three sources of story:

| Source | Description |
| --- | --- |
| **New contract** | A four-chapter story assembled from written pieces, different every time |
| **The Note** | A hand-written five-chapter story with three endings |
| **Written by a language model** | A new story from a connected model |

Between jobs, about every other return to the base brings a street event with two answers: a debt, a tip for sale, a dice game, a kid who wants in. Some only come up for a crew with a good or bad reputation, or for someone wounded or losing humanity to chrome.

When a story ends, the same crew can take on another one or move to the endless job board. Another player can also take the game master's seat to run the enemy, call in reinforcements, narrate and trigger events between jobs.

### Card duel

Two asymmetric decks fight over three lanes. The hacker wins by cracking two nodes. The corporation wins by filling the trace meter or holding out until the deadline. A duel can be played against the computer, on one PC with hands hidden between turns, or online.

### Rule depth

Every mode has three settings, chosen when a game starts:

| Depth | What it adds |
| --- | --- |
| **Quick Job** | Light rules, with little to track |
| **Standard Contract** | Exploding dice, ammo, overwatch, wounds, Luck and deeper hacking |
| **Full Contract** | Hit locations, armor wear, morale, and permanent death in campaigns |

In the card duel, depth sets the card pool, node strength and game length instead.

## Optional language-model game master

The whole game works without a language model. It can also connect to any server with an OpenAI-compatible chat API, using an endpoint and optional API key entered in Settings. Only the host needs this set up. Some example endpoints:

| Server | Endpoint |
| --- | --- |
| OpenAI | `https://api.openai.com/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Ollama (local) | `http://localhost:11434/v1` |
| LM Studio (local) | `http://localhost:1234/v1` |

Two models are set by the name the server uses:

- The **writer** model writes new stories and is called once per story, so a stronger model pays off here.
- The **game master** model narrates scenes and judges actions that players type in themselves. It's called often, so a cheaper or faster model makes sense.

Settings also accept 1 or 3 **fallback servers**, each with its own endpoint, key and models. If a server fails, the game tries the next one in order.

Rules, dice, money and combat always stay in the game engine. Model output is checked before use, and the game falls back to its written text if every server fails.

The desktop app stores the key encrypted, never hands it back to the game's page once it's saved, and forgets it if that server's endpoint changes. On a system without secure key storage, the key is kept only until the game closes. Plain `http://` addresses are only accepted on the same PC or local network, including private IPv6 addresses.

Scene text and crew names are sent to the chosen servers, so each provider's terms and prices apply. A model running on the same PC keeps them there.

## Online play

The host's PC runs the rules, and other players send it their moves. A small relay server connects players by join code. It passes messages between them and doesn't store them on disk or log their contents.

The game uses a default relay address, which can be changed in Settings. Everyone at a table needs the same address and the same game version.

### Direct connections

With **Direct connection to other players** turned on in Settings, the host and a guest connect straight to each other once the relay has introduced them. The link is a WebRTC data channel, encrypted end to end, and the game's messages stop passing through the relay. It's off by default, because a direct link shows the two players each other's IP address, and it's only made when both of them have turned it on. A label next to the join code says whether the game is running over a direct link or through the relay.

What keeps it safe:

- **Addresses:** the desktop app only ever offers the address the internet already sees, so a VPN's address is offered in place of the real one, and home-network addresses are neither sent nor accepted. A link can't be pointed at devices inside someone's network.
- **Untrusted input:** everything arriving over a link is checked for format, order, size and rate before the game sees it, and then goes through the same checks as a message from the relay. One bad frame closes that player's link for the rest of the session.
- **No lost moves:** every message is numbered and kept until the other side confirms it. If a link dies, the unconfirmed ones go through the relay, and nothing arrives twice or out of order.
- **Fallback:** if a link can't be made, which happens behind some routers and on mobile networks, the game stays on the relay as before.

To find its own public address the game asks a STUN server, by default Cloudflare's. That server sees the player's IP address and nothing about the game. The address can be changed or left empty in Settings.

The relay is still needed for join codes and introductions, and it is trusted for those, as it always was: a dishonest relay could put itself between two players. A table also still closes when the relay restarts.

### Running a relay

A self-hosted relay runs with:

```bash
cd relay
docker compose up -d --build
```

It listens on `127.0.0.1:7700`, so reaching it from outside takes a reverse proxy or tunnel, with `wss://` for secure connections. `npm run relay` starts the same server without Docker, also on `127.0.0.1` unless `HOST` is set.

The relay limits rooms and connections per address. Behind a proxy it only sees the proxy's address, so `PROXY_HEADER` names the header the proxy sets to the player's address. The compose file sets it to `cf-connecting-ip` for a Cloudflare tunnel. The proxy must overwrite that header, not pass along what the client sent.

## Development

```bash
npm run dev          # run in a browser at http://localhost:5199
npm test             # run the test suite
npm run typecheck    # check types
npm start            # build and run the desktop app
npm run dist:linux   # build an AppImage in release/
npm run dist:win     # build a Windows installer in release/
npm run dist         # build both
```

The Windows installer can be built on Linux, which requires Wine. `install.sh` only builds the Linux package, so it doesn't need Wine.

This command plays computer-only games and prints win rates and game length, to check balance:

```bash
npx esbuild scripts/sim.ts --bundle --platform=node --outfile=/tmp/zm-sim.cjs && node /tmp/zm-sim.cjs 48
```

### Publishing an update

The update check only compares version numbers, so a new version needs its `version` in `package.json` raised before it's pushed.

Windows copies only update from a published GitHub release. Its installer must be attached under the name electron-builder gives it, `ZeroMargin-<version>-win-x64-setup.exe`, and its tag must be `v<version>`. GitHub records each file's checksum, which the game checks before installing.

Setting `ZM_UPDATE_FEED` to a URL of a file shaped like GitHub's latest-release response makes a copy check that instead, so a full Windows update can be tested without publishing anything.

### Project layout

| Path | Purpose |
| --- | --- |
| `src/engine/` | Rules for all three modes, as pure functions with no interface code |
| `src/net/` | Relay client, direct links between players, local and online sessions, saves and the game master prompts |
| `src/ui/` | Screens, board and dice rendering, synthesized sound and translations |
| `electron/` | The desktop app, including model server calls, key storage and updates |
| `relay/` | The join-code relay, a small Node server packaged for Docker |
| `tests/` | Rules, computer players, online play, translations and the lessons |
| `scripts/` | Balance simulator, tutorial seed finder, icon generator and a test client |

Game state is plain JSON, with its random number generator stored inside it, so saves and online play use the same state. All player-facing text lives in the translation files, and a test checks that English and Polish have matching keys and placeholders.

`tests/tutorial.test.ts` checks every number the basics lesson quotes. If a rules change breaks it, `scripts/find-tutorial-seed.ts` finds a new seed. The other two lessons work out their hints from the state of the game, so they need no seed; `tests/lessons.test.ts` covers them.

### Testing a packaged build

Setting `ZM_SMOKE_TEST=1` makes the desktop app run a check using a throwaway profile, then report the result and exit. These settings select a different check:

- `ZM_SMOKE_CAMPAIGN=1` plays through a campaign against a pretend model server, with no key or network needed.
- `ZM_SMOKE_ONLINE=1` hosts an online table, which `scripts/remote-guest.ts` can join from another machine.

## Known limitations

- **Balance:** on Standard and Full Contract, factions win between about 35% and 63% of computer-played games. On Quick Job, Harbor Union and the Kilnrats still win far more often than Meridian and the Choir. Campaign prices and difficulty are estimates.
- **Language models:** one real server has been tried, on the first chapter of a story in English. Later chapters, endings, Polish output and narration in online games have only been tested against simulated responses.
- **Windows:** the build has only been tested in a virtual machine, not on physical hardware.
- **Online play:** the game hasn't been tested with players on separate home networks. Direct connections have only been tried between two copies on one PC, never across the internet, and the VPN behavior comes from Chromium's documented setting, not from a test.
- **Card duel:** online players receive the full game state, so a modified client could see the opponent's hand.
- **Tutorial:** the lessons cover Quick Job and Standard Contract skirmish and a Quick Job card duel as the hacker. Full Contract rules, scenario objectives and the corporation's side of the duel have no lesson, and the campaign has tips and a guide instead of a played one.

## License

Zero Margin is free and stays free. It's released under the [PolyForm Noncommercial License 1.0.0](LICENSE), which allows using, copying, changing and sharing it for any noncommercial purpose but not making money from it. Any shared copy must keep the [license](LICENSE) and [notice](NOTICE). Third-party packages keep their own licenses.

## Credits

Zero Margin takes inspiration from the mechanics of classic cyberpunk tabletop RPGs. Its setting, names, numbers, text and art are original. It isn't affiliated with or endorsed by the publishers of any tabletop game.
