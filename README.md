# omp-image-render

Show images and play videos inside the [omp](https://omp.sh) terminal.

The agent can show you what it made: screenshots, design directions, charts,
screen recordings, and before/after QA runs. The pictures draw in the terminal
with the kitty graphics protocol. The model gets only a one-line text
confirmation, so a picture costs no model tokens.

## Features

- **Inline picture card.** A frame with the title, the image count, the version,
  and the pixel size. The picture is centered in the card.
- **Side by side and grids.** Two or three images show side by side. Four or more
  images form a grid (2×2 for four, three columns up to nine).
- **Before and after.** Give an old image or an old recording as `compare`. It
  shows on the left.
- **Video player.** A full-screen player with a timeline, change markers, test
  checks that show their result when playback reaches them, and a synced
  before/after view.
- **Version history.** Work with the same title is kept as versions. Step through
  them in the player, or pick any version with `/media`.
- **Local only.** No network calls, no telemetry, no auto-update.

## Requirements

- omp (tested with 18.6)
- A terminal that supports the kitty graphics protocol: Ghostty, kitty, WezTerm,
  or Warp
- `ffmpeg` and `ffprobe` on `PATH` (`brew install ffmpeg` on macOS)
- macOS for `/img view` (Preview), `/img copy` (`pbcopy`), and the player's
  QuickTime key. The rest is platform-neutral.

## Install

```sh
git clone https://github.com/rambaarde/omp-image-render.git ~/src/omp-image-render
mkdir -p ~/.omp/agent/extensions
ln -s ~/src/omp-image-render ~/.omp/agent/extensions/omp-image-render
```

Start a new omp session. omp loads extensions at startup.

## Use

### Tools for the agent

| Tool | Parameters |
|---|---|
| `show_image` | `paths` (one or more images), `title`, `compare` (old image) |
| `show_video` | `path`, `compare` (old recording), `title`, `url`, `changes` (`[{ title, at }]`), `summary` (`[{ label, ok, passed, total, at }]`) |

Example prompts:

- "Give me four directions for the hero section and show them side by side."
- "Fix the pricing toggle, record the old and new flow with Playwright, and show me before and after."

### Commands

| Command | Action |
|---|---|
| `/img <path> [more paths]` | Show images in the transcript |
| `/img view` | Open the latest picture in Preview |
| `/img save` | Copy the latest picture to `~/Downloads` as `<title> <date>.png` |
| `/img copy` | Copy the path of the latest picture |
| `/video <path> [--compare <old>]` | Play a video. With no path, replay the latest video |
| `/media` | Pick any saved picture or video version |

### Player keys

| Key | Action |
|---|---|
| `space` | Play or pause |
| `←` / `→` | Seek 5 seconds |
| `,` / `.` | Step one frame |
| `1`–`9` | Jump to change 1–9 |
| `[` / `]` | Previous or next version |
| `o` | Open in QuickTime Player |
| `s` | Save the video to `~/Downloads` |
| `q` / `esc` | Close |

## Terminal multiplexers

omp turns images off inside some multiplexers, because it cannot know whether
the multiplexer passes kitty graphics through.

- **Herdr:** enable the experimental support in `~/.config/herdr/config.toml`,
  then detach and attach the client once:

  ```toml
  [experimental]
  kitty_graphics = true
  ```

  Then force the protocol for omp inside Herdr panes, for example in `~/.zshrc`:

  ```sh
  [[ -n $HERDR_PANE_ID ]] && export PI_FORCE_IMAGE_PROTOCOL=kitty
  ```

- **tmux:** not tested.

If you see an empty card, the terminal or the multiplexer drops the picture. If
you see a text line such as `[Image: … 1280x800]`, omp has images turned off.

## Limits

- Videos are cut into PNG frames: at most 12 frames per second, 1280 pixels wide,
  and 900 frames. A clip longer than 75 seconds plays at a lower frame rate.
- Each video frame is a full picture sent to the terminal (about 1.3 MB/s for a
  1280-pixel before/after clip).
- The cache is in `~/.cache/omp-image-render`. Entries older than 7 days are
  deleted, and the cache is kept under 1 GB.

## Credits

Inspired by [claude-show-your-work](https://github.com/iamumeransari/claude-show-your-work),
a Claude Code plugin. This is a separate implementation for omp's extension API.

## License

[MIT](LICENSE)
