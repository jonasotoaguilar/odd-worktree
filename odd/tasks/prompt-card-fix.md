# prompt-card-fix

Two defects in the shipped prompt card (`lib/user-prompt-card.js`): a restored session keeps Pi's plain prompt until something else forces a frame, and the card's heading lost the timestamp the design always had.
Branch `fix/prompt-card-timestamp-repaint`, worktree `prompt-card-fix`. This package only; the bridge is not modified.

## Specs

- S1. The heading carries the message's clock next to the name, in grey: `✿ You · 14:32` — the title in `accent`, the separator and the clock in the `muted`/`dim` role. The user asked: "y lo habiamos disenados, al lado de yout en gris" and "You · timestamp".
- S2. A session restored from history paints the card for prompts already on screen, without waiting for unrelated input. The user asked: "en sesiones antiguas no repinta los campos de texto de mensajes/input ... pero en nuevas si lo hace y repinta bien cambiar".
- S3. Nothing else changes: the gate, the fail-closed answers, the accent frame, the two live reads, the OSC 133 markers and the body paint stay exactly as shipped in 3.11.0.

## Tasks

- [x] T1 (S1-S3) route: worker. Timestamp in the heading + a repaint request after a successful install, with tests. Commit: `ceab167`

## Log

- L1: "encontre unos problemas" — "el primero es que en sesiones antiguas no repinta los campos de texto de mensajes/input", "pero en nuevas si lo hace y repinta bien cambiar".
- L2: "el segun es que como se ve en la imagen, falto el time stamp", then "y lo habiamos disenados, al lado de yout en gris, nose si te falto o quedo mal", then "You · timestamp".
