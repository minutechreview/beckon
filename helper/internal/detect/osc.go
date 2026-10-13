package detect

// oscFilter drops OSC strings (ESC ] ... BEL or ESC \) from PTY output before it
// reaches the emulator. They never change what is on screen, and the emulator
// mishandles them: a non-ASCII byte inside one (Claude Code's window titles
// start with a spinner glyph such as "✳") ends the string early, and the rest
// of the title is printed into the screen. Programs that redraw only the cells
// they changed then leave that text in place, and the screen no longer matches
// what the terminal shows. State carries across chunks: a title can be split
// between two writes.
type oscFilter struct {
	state uint8
}

const (
	oscGround uint8 = iota
	oscEsc          // saw ESC outside an OSC string
	oscIn           // inside an OSC string
	oscInEsc        // saw ESC inside an OSC string
)

// StripOSC returns a filter that drops OSC strings from successive chunks of
// output, as the detector does before its emulator sees them. Dev tools use it
// to show the screen the detector sees.
func StripOSC() func([]byte) []byte {
	var f oscFilter
	return f.apply
}

// apply returns p without OSC strings. It may return p itself.
func (f *oscFilter) apply(p []byte) []byte {
	if f.state == oscGround && !containsESC(p) {
		return p
	}
	out := make([]byte, 0, len(p))
	for _, b := range p {
		switch f.state {
		case oscGround:
			if b == 0x1b {
				f.state = oscEsc
			} else {
				out = append(out, b)
			}
		case oscEsc:
			switch b {
			case ']':
				f.state = oscIn
			case 0x1b:
				out = append(out, 0x1b) // the first ESC stands alone; this one may start something
			default:
				out = append(out, 0x1b, b)
				f.state = oscGround
			}
		case oscIn:
			switch b {
			case 0x07, 0x18, 0x1a: // BEL ends it; CAN and SUB cancel it
				f.state = oscGround
			case 0x1b:
				f.state = oscInEsc
			}
		case oscInEsc:
			switch b {
			case '\\': // ST
				f.state = oscGround
			case ']': // a new OSC string straight after an unterminated one
				f.state = oscIn
			case 0x1b:
				f.state = oscEsc
			default: // an escape sequence breaks off the string, as in a terminal
				out = append(out, 0x1b, b)
				f.state = oscGround
			}
		}
	}
	return out
}

func containsESC(p []byte) bool {
	for _, b := range p {
		if b == 0x1b {
			return true
		}
	}
	return false
}
