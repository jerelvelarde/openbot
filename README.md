# Bidirectional turn — recordings

Evidence for CopilotKit/CopilotKit#6770, CopilotKit/Intelligence#1064 and
jerelvelarde/openbot#17. Recorded against the real CopilotKit Slack workspace
(`#openbot-channels`) with app-api, the Realtime Gateway and OpenBot running
locally, and the `@openbot` app's Event Request URL pointed at that stack for
the duration of the run.

The journey starts with a human-typed `@openbot` mention delivered over Slack's
Events API, and ends with that person's follow-up — composed in OpenBot —
landing back in the same Slack thread, attributed to them.

| File | What it is |
|---|---|
| `openbot-journey-1080p.mp4` | 1920×1080, downsampled from a 2× capture — sharpest for viewing |
| `openbot-journey-4k.mp4` | 3840×2160, native capture resolution |
| `openbot-journey-hd.gif` | 1400px wide, for inline rendering in a PR comment |
| `hd/*.png` | The five source frames at 3840×2072 |
| `openbot-full-journey-slack-to-openbot.gif` | The earlier, lower-resolution take |
