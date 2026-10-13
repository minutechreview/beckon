package label

import "bytes"

// maxTitle is the longest title kept; a longer OSC string is skipped.
const maxTitle = 1024

// Scanner finds window titles (OSC 0 and OSC 2) in a program's output. Feed
// it successive chunks: a title split between two writes is still found. It
// only reads; the output itself passes through untouched.
type Scanner struct {
	state uint8
	num   []byte // the OSC number, up to its ';'
	buf   []byte // the title so far
	skip  bool   // not a title, or too long: wait for the end
}

const (
	scanGround  uint8 = iota
	scanEsc           // saw ESC
	scanNum           // after ESC ], reading the number
	scanBody          // inside the string
	scanBodyEsc       // saw ESC inside the string
)

// Feed scans p and calls fn with each complete title, in order.
func (s *Scanner) Feed(p []byte, fn func(title string)) {
	for len(p) > 0 {
		if s.state == scanGround {
			i := bytes.IndexByte(p, 0x1b)
			if i < 0 {
				return
			}
			p = p[i+1:]
			s.state = scanEsc
			continue
		}
		b := p[0]
		p = p[1:]
		switch s.state {
		case scanEsc:
			switch b {
			case ']':
				s.state, s.num, s.buf, s.skip = scanNum, s.num[:0], s.buf[:0], false
			case 0x1b:
			default:
				s.state = scanGround
			}
		case scanNum:
			switch {
			case b >= '0' && b <= '9' && len(s.num) < 8:
				s.num = append(s.num, b)
			case b == ';':
				n := string(s.num)
				s.skip = n != "0" && n != "2"
				s.state = scanBody
			default: // malformed, or ended before any text: no title
				s.skip = true
				s.state = scanBody
				s.body(b, fn)
			}
		case scanBody:
			s.body(b, fn)
		case scanBodyEsc:
			switch b {
			case '\\': // ST
				s.end(fn)
			case ']':
				s.state, s.num, s.buf, s.skip = scanNum, s.num[:0], s.buf[:0], false
			default: // an escape sequence breaks off the string, as in a terminal
				s.state = scanGround
				if b == 0x1b {
					s.state = scanEsc
				}
			}
		}
	}
}

func (s *Scanner) body(b byte, fn func(string)) {
	switch b {
	case 0x07: // BEL
		s.end(fn)
	case 0x18, 0x1a: // CAN and SUB cancel the string
		s.state = scanGround
	case 0x1b:
		s.state = scanBodyEsc
	default:
		if s.skip {
			return
		}
		if len(s.buf) >= maxTitle {
			s.skip = true
			return
		}
		s.buf = append(s.buf, b)
	}
}

func (s *Scanner) end(fn func(string)) {
	s.state = scanGround
	if !s.skip {
		fn(string(s.buf))
	}
}
