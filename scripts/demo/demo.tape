# The terminal half of the README demo. record.sh runs this with VHS (https://github.com/charmbracelet/vhs);
# driver.mjs sets DEMO_BIN, DEMO_WORK, DEMO_READY and DEMO_GO and drives the phone half at the same time.
Output terminal.mp4

Set Shell bash
Set FontSize 18
Set Width 620
Set Height 560
Set Padding 22
Set Theme "GitHub Dark"
Set WindowBar Colorful
Set BorderRadius 10
Set Margin 0
Set TypingSpeed 45ms
Set Framerate 25
Set CursorBlink false

# Hidden setup: neutral prompt, PATH with the freshly built helper, then wait for the driver's "go" so that
# the phone recording starts at the same moment as this one.
Hide
Type `export PS1='$ ' BASH_SILENCE_DEPRECATION_WARNING=1 PATH="$DEMO_BIN:$PATH"; cd "$DEMO_WORK"; clear` Enter
Type `touch "$DEMO_READY"; until [ -e "$DEMO_GO" ]; do sleep 0.05; done; echo GO_$((1+1)); sleep 0.3; clear` Enter
Wait+Screen@60s /GO_2/
Sleep 600ms
Show

Sleep 200ms
Type "beckon run -- code-agent"
Sleep 300ms
Enter

# The agent blocks; the phone taps Approve; the story ends at "Done".
Wait+Screen@90s /Done/
Sleep 5s
