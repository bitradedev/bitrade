# Homepage and Agent motion · 2026-10-15

The user requested the latest Agent design from [their shared preview](https://chatgpt.com/s/cx_6ad065322e748191a02202fadbc0a60f), removal of the repeated standalone trade journal and slightly stronger background separation across the homepage.

- The three independent character files already match the preview byte-for-byte. The newer workstation mouse group, irregular mouse/typing controller, hand targets, lighter gaze/blink/posture and wall-clock work cadence are integrated. Automatic entry greetings are removed. Existing 30 FPS limiting, low-power rendering, offscreen suspension, reduced-motion/global pause, theme updates, WebGL fallback and disposal remain. Mouse/keyboard motion illustrates the Agent character; it does not invent real trading activity.
- The homepage's standalone journal, aggregate strip and associated navigation links are removed. Its DOM rendering and outage handling no longer expect the deleted container. Confirmed trade records remain in the selected Agent's workstation sidebar, details and Owner account. The preview's sample transactions were not imported.
- Full-width fog-blue, blue-gray and navy sections now separate the hero, Agent arena, ranking, strategy explanation, connection steps, ecosystem information, FAQ and final call to action. Light/dark palettes, Chinese/English, mobile wrapping and entrance animations remain. Account pages and the standalone scroll introduction keep their layouts.
- Public asset versions are advanced. The rebuilt Agent desk is reproducible from the checked-in source and existing locked Three.js dependency.

Validation: 110 product checks pass, including bilingual account/record projection and outage behavior without the removed journal container. A deterministic five-minute motion run for each variant observes mouse movement and typing within the first twelve seconds, frequent pointer movement, short typing bursts, rests and no automatic greeting. Local browser inspection covers all three real WebGL models, advancing frames, mouse and keyboard modes, light Chinese and dark English, 390-pixel mobile width without horizontal overflow, and absence of the standalone journal. Sampled mouse/observe poses reported wrist-target error 0.000; a keyboard pose reported 0.009. No browser console errors were observed.

This release replaces frontend assets only. The running trading service, 30% new-order paper slippage policy and financial records are outside the change.

## Released

Commit `021002e5b312a7d93fe7521a6d2abc813916e64a` passed the [complete GitHub workflow](https://github.com/bitradedev/bitrade/actions/runs/38689265571), including a reproducible Agent desk build. The earlier pending slippage-acceptance documentation was also successfully pushed with this release.

The five public files were installed on the VPS after archive and per-file hash checks. Previous assets and the manifest are preserved at `/opt/bitrade/releases/20261015-home-021002e`. The backend bundle hash and running service PID were identical before and after installation; the service was not restarted. No database operation is part of this static deployment.

Cloudflare version `bc5c2ca8-61f8-4596-9718-d5fe054cf55f` publishes the same assets with unchanged routes and bindings. At 05:58:08Z, `/home`, versioned `home.js`, `app.js`, `agent-desk.js` and `landing.css` all returned 200 and matched local bytes. Agent desk SHA-256 is `717e6aa3fc4017259b06866ae72f24ce19024ab05029e1fb4effac9d8b098510`. Runtime/public APIs returned 200 with three real Agents, a connected chain and live trading false. Ignored evidence is `.cloud-test-build/home-refresh-live-021002e.json`, the build/deploy logs and `.cloud-test-build/verify-new-agent-motion.mjs`.

Refreshing the existing production browser tab timed out in the browser tool, including a later bounded DOM read. Therefore production visual reinspection is not claimed; visual checks above used the exact local release with read-only production data, while production acceptance uses actual resource hashes and API responses. No repeated deployment was performed because of this browser-tool limitation. The existing paused automation remains paused.
