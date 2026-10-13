#!/usr/bin/env bash
# Puts the terminal recording (VHS) and the phone recording (Playwright) side by side and writes
# docs/demo.gif and docs/demo.mp4. Usage: compose.sh OUT_DIR   (the directory driver.mjs wrote to)
#
# Environment (all optional):
#   DEMO_TERM_LEAD   seconds between the driver's "go" and the first frame of the terminal video (default 0.7).
#                    The terminal recording starts a little after "go" because VHS hides its setup and shows
#                    the screen a moment later; adjust if the two halves drift (the Approve tap should land
#                    just before the "y" appears in the terminal).
#   DEMO_GIF_WIDTH   width of the GIF in pixels (default 880, the width GitHub shows a README at)
#   DEMO_GIF_FPS     GIF frame rate (default 20, a whole number of centiseconds per frame)
#   DEMO_DOCS_DIR    where to write demo.gif and demo.mp4 (default: docs/ in the repository)
set -euo pipefail

out=${1:?usage: compose.sh OUT_DIR}
here=$(cd "$(dirname "$0")" && pwd)
docs=${DEMO_DOCS_DIR:-$here/../../docs}
mkdir -p "$docs"
lead=${DEMO_TERM_LEAD:-0.7}
gif_w=${DEMO_GIF_WIDTH:-880}
gif_fps=${DEMO_GIF_FPS:-20}
bg='0x010409'      # the page behind both halves; close to the terminal theme's own black
frame='0x30363d'   # a thin outline so the phone's dark screen has an edge

term=$out/terminal.mp4
phone=$out/phone.webm
for f in "$term" "$phone" "$out/timing.json"; do [ -f "$f" ] || { echo "compose: missing $f" >&2; exit 1; }; done

dim() { ffprobe -v error -select_streams v:0 -show_entries stream="$2" -of csv=p=0 "$1"; }
tw=$(dim "$term" width); th=$(dim "$term" height)
pw=$(dim "$phone" width); ph=$(dim "$phone" height)
go=$(node -e 'console.log(JSON.parse(require("fs").readFileSync(process.argv[1])).go)' "$out/timing.json")
phone_start=$(awk -v g="$go" -v l="$lead" 'BEGIN { printf "%.3f", g + l }')

pad=28; gap=28; border=2
bw=$((pw + 2 * border)); bh=$((ph + 2 * border))
inner_h=$((th > bh ? th : bh))
cw=$((pad + tw + gap + bw + pad)); ch=$((inner_h + 2 * pad))
cw=$((cw + cw % 2)); ch=$((ch + ch % 2))
ty=$(( (ch - th) / 2 )); py=$(( (ch - bh) / 2 ))

# 25 fps for the whole composite; the phone video is variable-rate, so resample it first.
graph="
color=c=${bg}:s=${cw}x${ch}:r=25[bg];
[0:v]fps=25,setpts=PTS-STARTPTS[t];
[1:v]trim=start=${phone_start},setpts=PTS-STARTPTS,fps=25,pad=${bw}:${bh}:${border}:${border}:color=${frame}[p];
[bg][t]overlay=${pad}:${ty}:shortest=1[a];
[a][p]overlay=$((pad + tw + gap)):${py}:shortest=1,format=yuv420p[full]"

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

echo "compose: ${cw}x${ch}, phone starts at ${phone_start}s"
ffmpeg -v error -y -i "$term" -i "$phone" -filter_complex "$graph" -map '[full]' \
  -c:v libx264 -preset slow -crf 20 -movflags +faststart -an "$docs/demo.mp4"

# GIF: scale once, build a palette from the frames that change (the backgrounds are static), apply it
# with light ordered dithering to keep the size down.
ffmpeg -v error -y -i "$docs/demo.mp4" \
  -vf "fps=${gif_fps},scale=${gif_w}:-2:flags=lanczos,palettegen=max_colors=256:stats_mode=diff" "$tmp/palette.png"
ffmpeg -v error -y -i "$docs/demo.mp4" -i "$tmp/palette.png" \
  -filter_complex "[0:v]fps=${gif_fps},scale=${gif_w}:-2:flags=lanczos[v];[v][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" \
  -loop 0 "$docs/demo.gif"

dur=$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$docs/demo.gif")
echo "compose: wrote $docs/demo.gif ($(du -k "$docs/demo.gif" | cut -f1) KB, ${dur}s) and demo.mp4 ($(du -k "$docs/demo.mp4" | cut -f1) KB)"
