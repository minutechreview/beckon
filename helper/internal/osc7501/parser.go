package osc7501

import "bytes"

var prefix = []byte("\x1b]7501;")

const (
	termST  = "\x1b\\"
	termBEL = "\x07"
)

type pstate uint8

const (
	stGround  pstate = iota
	stPrefix         // matching ESC ] 7 5 0 1 ;
	stBody           // inside the body of an OSC 7501 sequence
	stBodyEsc        // saw ESC inside the body
)

// Parser is a streaming OSC 7501 scanner. Feed it the child's output; it
// returns the bytes to forward to the outer terminal plus any events.
//
// Forwarding is byte-for-byte, with two differences: the feature query is
// removed, and bytes that might still turn out to be an OSC 7501 sequence are
// held back until the sequence ends (or turns out not to be one). Use
// Pending/Flush to release held bytes if the stream goes quiet.
//
// A Parser is not safe for concurrent use.
type Parser struct {
	// OnDiscard, if set, is called with the reason whenever a well-formed
	// sequence is dropped (for debug logging only).
	OnDiscard func(reason string)

	state pstate
	held  []byte
}

// Feed processes data, appending forwardable bytes to dst. Events are
// returned in stream order.
func (p *Parser) Feed(dst, data []byte) ([]byte, []Event) {
	var events []Event
	i := 0
	for i < len(data) {
		switch p.state {
		case stGround:
			j := bytes.IndexByte(data[i:], 0x1b)
			if j < 0 {
				return append(dst, data[i:]...), events
			}
			dst = append(dst, data[i:i+j]...)
			i += j + 1
			p.held = append(p.held[:0], 0x1b)
			p.state = stPrefix

		case stPrefix:
			b := data[i]
			if b != prefix[len(p.held)] {
				// Not an OSC 7501 sequence: release and rescan b from ground.
				dst = append(dst, p.held...)
				p.held = p.held[:0]
				p.state = stGround
				continue
			}
			p.held = append(p.held, b)
			i++
			if len(p.held) == len(prefix) {
				p.state = stBody
			}

		case stBody:
			b := data[i]
			i++
			switch b {
			case 0x07:
				dst, events = p.finish(dst, events, termBEL)
			case 0x1b:
				p.held = append(p.held, b)
				p.state = stBodyEsc
			case 0x18, 0x1a: // CAN, SUB cancel the sequence
				dst = append(dst, p.held...)
				dst = append(dst, b)
				p.reset()
			default:
				p.held = append(p.held, b)
			}
			dst = p.checkOverflow(dst)

		case stBodyEsc:
			if data[i] == '\\' {
				i++
				dst, events = p.finish(dst, events, termST)
				continue
			}
			// ESC not followed by '\': the sequence is aborted and this ESC
			// starts something new. Rescan the byte after it from stPrefix.
			dst = append(dst, p.held[:len(p.held)-1]...)
			p.held = append(p.held[:0], 0x1b)
			p.state = stPrefix
		}
	}
	return dst, events
}

// checkOverflow bounds the held buffer: a sequence that can no longer fit in
// MaxSequence is released unparsed (and therefore discarded).
func (p *Parser) checkOverflow(dst []byte) []byte {
	if p.state != stGround && len(p.held) >= MaxSequence+2 {
		p.discard("sequence too long")
		dst = append(dst, p.held...)
		p.reset()
	}
	return dst
}

// finish handles a terminated OSC 7501 sequence. For ST the held buffer
// already ends with the ESC.
func (p *Parser) finish(dst []byte, events []Event, term string) ([]byte, []Event) {
	defer p.reset()
	// Total length is the held bytes plus one: BEL, or the '\' after the
	// held ESC.
	total := len(p.held) + 1
	bodyEnd := len(p.held)
	if term == termST {
		bodyEnd--
	}
	body := trimWS(p.held[len(prefix):bodyEnd])

	if len(body) == 1 && body[0] == '?' {
		return dst, append(events, Event{Query: true, Terminator: term})
	}

	// Everything except the query is forwarded unchanged.
	dst = append(dst, p.held...)
	if term == termST {
		dst = append(dst, '\\')
	} else {
		dst = append(dst, 0x07)
	}

	if total > MaxSequence {
		p.discard("sequence too long")
		return dst, events
	}
	r, reason := ParseBody(p.held[len(prefix):bodyEnd])
	if reason != "" {
		p.discard(reason)
		return dst, events
	}
	return dst, append(events, Event{Report: r})
}

func (p *Parser) discard(reason string) {
	if p.OnDiscard != nil {
		p.OnDiscard(reason)
	}
}

func (p *Parser) reset() {
	p.held = p.held[:0]
	p.state = stGround
}

// Pending reports whether bytes are currently held back.
func (p *Parser) Pending() bool { return p.state != stGround }

// Flush appends any held-back bytes to dst and resets the parser to ground.
func (p *Parser) Flush(dst []byte) []byte {
	dst = append(dst, p.held...)
	p.reset()
	return dst
}
