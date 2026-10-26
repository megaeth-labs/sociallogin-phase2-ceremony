# Collectible spacing and completion copy

Source: `b8033403f08dc79208bd089b0bad8b6bbb8f1798`.
Deployment: `dpl_FarA9QQJghcvSzXyMtKqsgVutXYy`.
[Immutable deployment](https://zklogin-phase2-ceremony-7zhxd1185-mega-eth.vercel.app).

The collectible page now groups the connected address and Disconnect button in
a labeled wallet row, uses consistent gaps between claim controls, and separates
mint status from its button. Heading wrapping avoids an isolated final word.
The completion page removes the requested “Only one honest participant is needed.
You might be that one.” sentence, its unused copy type field and styling.

The wallet header/handshake fix, consent requirement and mint behavior are
unchanged. This is a CSS/layout/copy update; no contract or acceptance-policy
changes are involved.

Build, typecheck, full tests, e2e and whitespace checks passed. Chrome screenshots
were inspected at desktop and 390px mobile widths, including the cancelled-mint
state and wrapped wallet address. The mobile page has no horizontal overflow.
Browser validation uses the actual published npm SDK with simulated ceremony
and wallet responses; no contribution or mint transaction was performed.
Full-artifact and Safari/Firefox tests were not repeated for this visual change.

All 37 browser assets matched the independent Linux AMD64 build. Root-signed
release authorization and immutable archive references are recorded alongside
this file. The coordinator was drained and restarted only to reload authorization;
its image, signed manifest and accepted ceremony history remain unchanged. Health
checks confirmed the original manifest and accepted head at generation 4.

The deployment was promoted to the stable rehearsal URL. The live Chrome check
passed with the actual npm SDK and simulated wallet/ceremony responses, including
explicit approval, confirmed and recovered claim UI, route-scoped CSP and
desktop/mobile layouts. No live mint transaction was sent.
