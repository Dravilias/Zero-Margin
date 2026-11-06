# Zero Margin

A cyberpunk tabletop game for Windows and Linux, set in the flooded free port of Port Sable. Play against the computer, with friends on one PC, or online with a join code. Available in English and Polish.

The game has three modes:

- **Squad skirmish:** turn-based tactical battles on a generated city map.
- **Story campaign:** run a crew from job to job through a story with choices and endings, or keep going on an endless job board.
- **Card duel:** a hacker tries to crack a corporation's network while the corporation hunts them down.

> **Status: early (v0.6.0).** All three modes are playable, but balance is still rough and some parts haven't had much real-world testing. See [Known limitations](#known-limitations).

## Getting started

Download a build from the Releases page, if one is available. Or install it from source:

**Linux**

```bash
git clone https://github.com/Dravilias/Zero-Margin.git
cd Zero-Margin
./install.sh
```

This builds the game if needed, then adds it to your app menu and as a `zero-margin` command. It doesn't need root. Building needs a recent version of Node.js. Run `./install.sh --rebuild` to update after pulling changes, or `./install.sh --uninstall` to remove the game. Your saves and settings are kept.

**Windows**

Put a Windows package in the `release` folder, either downloaded or built with `npm ci` and `npm run dist:win`. Then run:

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

This adds the game to your Start menu without needing administrator rights. Add `-Uninstall` to remove it.

**Without installing**

Run `npm install`, then `npm start`. To try the game in a browser without the desktop app, run `npm run dev` and open <http://localhost:5199>. The language-model game master only works in the desktop app.

New to the game? Start with the tutorial in the main menu, which takes about 5 minutes.

## Game modes

### Squad skirmish

- Three scenarios: Flatline, Terminal Control and Data Heist
- Four factions and eleven recruitable roles
- A points-based squad builder with weapons, chrome and grenades
- Computer players on easy, normal and hard, able to fill any seat
- Up to 4 players, with autosave and resume

### Story campaign

Money, gear, chrome, levels and injuries carry over from job to job. You can play alone, on one PC, or online with up to 3 friends who each run their own characters. Up to 8 campaigns can be saved at once.

There are three sources of story:

| Source | What you get |
| --- | --- |
| **New contract** | A four-chapter story assembled from written pieces, different every time |
| **The Note** | A hand-written five-chapter story with three endings |
| **Written by a language model** | A new story from a model you connect |

When a story ends, the same crew can take on another one or move to the endless job board. A friend can also take the game master's seat to run the enemy, call in reinforcements, narrate and trigger events between jobs.

### Card duel

Two asymmetric decks fight over three lanes. The hacker wins by cracking two nodes. The corporation wins by filling the trace meter or holding out until the deadline. Play against the computer, on one PC with hands hidden between turns, or online.

### Rule depth

Every mode has three settings, chosen when you start a game:

| Depth | What it adds |
| --- | --- |
| **Quick Job** | Light rules, with little to track |
| **Standard Contract** | Exploding dice, ammo, overwatch, wounds, Luck and deeper hacking |
| **Full Contract** | Hit locations, armor wear, morale, and permanent death in campaigns |

In the card duel, depth sets the card pool, node strength and game length instead.

## Optional language-model game master

The whole game works without a language model. To use one, open Settings and type in the endpoint of any server with an OpenAI-compatible chat API, plus an API key if it needs one. Only the host has to set this up. For example:

| Server | Endpoint |
| --- | --- |
| OpenAI | `https://api.openai.com/v1` |
| OpenRouter | `https://openrouter.ai/api/v1` |
| Google Gemini | `https://generativelanguage.googleapis.com/v1beta/openai` |
| Ollama (local) | `http://localhost:11434/v1` |
| LM Studio (local) | `http://localhost:1234/v1` |

You also set two models, by the name your server uses:

- A **writer** model writes new stories and is called once per story, so a stronger model pays off here.
- A **game master** model narrates scenes and judges actions players type in themselves. It's called often, so a cheaper or faster one makes sense.

You can also add 1 or 3 **fallback servers**, each with its own endpoint, key and models. If a server fails, the game tries the next one in order.

Rules, dice, money and combat always stay in the game engine. Model output is checked before use, and the game falls back to its written text if every server fails.

The key is stored encrypted by the desktop app, is never passed to the game's page, and is forgotten if you change that server's endpoint. On a system without secure key storage, it's kept only until the game closes. Plain `http://` addresses are only accepted on your own PC or local network.

Scene text and crew names are sent to the servers you choose, so each provider's terms and prices apply. A model running on your own PC keeps them there.

## Online play

The host's PC runs the rules, and other players send it their moves. A small relay server connects players by join code. It passes messages between them and doesn't store them on disk or log their contents.

The game uses a default relay address, which you can change in Settings. Everyone at a table needs the same address and the same game version. To run your own relay:

```bash
cd relay
docker compose up -d --build
```

This listens on `127.0.0.1:7700`, so you'll need a reverse proxy or tunnel to reach it from outside, with `wss://` for secure connections.

## Development

```bash
npm run dev          # run in a browser at http://localhost:5199
npm test             # run the test suite
npm run typecheck    # check types
npm start            # build and run the desktop app
npm run dist:linux   # build an AppImage in release/
npm run dist:win     # build a portable .exe in release/
npm run dist         # build both
```

Windows builds can be cross-compiled on Linux. They aren't code-signed, so SmartScreen may show a warning the first time you run one (More info → Run anyway).

To check balance, this plays computer-only games and prints win rates and game length:

```bash
npx esbuild scripts/sim.ts --bundle --platform=node --outfile=/tmp/zm-sim.cjs && node /tmp/zm-sim.cjs 48
```

### Project layout

| Path | Purpose |
| --- | --- |
| `src/engine/` | Rules for all three modes, as pure functions with no interface code |
| `src/net/` | Relay client, local and online sessions, saves and the game master prompts |
| `src/ui/` | Screens, board and dice rendering, synthesized sound and translations |
| `electron/` | The desktop app, including model server calls and key storage |
| `relay/` | The join-code relay, a small Node server packaged for Docker |
| `tests/` | Rules, computer players, online play, translations and the tutorial |
| `scripts/` | Balance simulator, tutorial seed finder, icon generator and a test client |

Game state is plain JSON, with its random number generator stored inside it, so saves and online play use the same state. All player-facing text lives in the translation files, and a test checks that English and Polish have matching keys and placeholders.

`tests/tutorial.test.ts` checks every number the tutorial quotes. If a rules change breaks it, re-run `scripts/find-tutorial-seed.ts`.

### Testing a packaged build

Setting `ZM_SMOKE_TEST=1` makes the desktop app run a check using a throwaway profile, then report the result and exit. Add one of these for a different check:

- `ZM_SMOKE_CAMPAIGN=1` plays through a campaign against a pretend model server, with no key or network needed.
- `ZM_SMOKE_ONLINE=1` hosts an online table, which `scripts/remote-guest.ts` can join from another machine.

## Known limitations

- **Balance:** faction win rates vary widely by scenario and rule depth, and campaign prices and difficulty are estimates.
- **Language models:** the integration has only been tested against simulated responses, not a real server.
- **Windows:** builds since v0.1.0 haven't been run on Windows.
- **Online play:** the game hasn't been tested with players on separate networks.
- **Card duel:** online players receive the full game state, so a modified client could see the opponent's hand.
- **Tutorial:** it only teaches the basics of skirmish, not the campaign or the card duel.

## Credits and legal

Zero Margin takes inspiration from the mechanics of classic cyberpunk tabletop RPGs. Its setting, names, numbers, text and art are original. It isn't affiliated with or endorsed by the publishers of any tabletop game.

No license has been chosen yet, so all rights are reserved by default.
