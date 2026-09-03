# MoxScore Agent Mode

Commander deck health analyzer with a supervised WebMCP loop at `/agent`.

**Live:** https://moxscore.com/agent

Three tools only: `analyze_deck`, `propose_changes`, `apply_changes`. The Analyze button and `analyze_deck` share one function; Accept and `apply_changes` share one function. `apply_changes` mutates the deck only when `confirm` is `true`.

To run **Locally:** 

```bash
npm ci
npm run dev
```

Open http://127.0.0.1:5173/agent

MIT licensed. See `LICENSE`.
