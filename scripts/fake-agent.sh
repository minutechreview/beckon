#!/bin/sh
# Fake terminal agent for testing Beckon. Emits real OSC 7501 sequences:
#   working -> blocked(permission) -> waits for a line on stdin -> done | error
# An answer of y/yes/approve/1 (any case) gives `done` (exit 0); anything else
# gives `error` (exit 1). FAKE_AGENT_DELAY (seconds, default 0.1) paces output.
# Any arguments are appended to the blocked message, so a test can put the
# same sentinel in argv and in msg (SPEC §11 E5). FAKE_AGENT_ANSWER_DELAY
# (seconds, default 0) waits after reading the answer before reporting the
# next state, like a program that is slow to say the prompt was answered.

delay=${FAKE_AGENT_DELAY:-0.1}

b64() { printf '%s' "$1" | base64 | tr -d '\n'; }

# osc <body>: send one OSC 7501 report terminated by ST.
osc() { printf '\033]7501;%s\033\\' "$1"; }

osc "state=working:app=fake-agent:progress=10:msg=$(b64 'Starting up')"
sleep "$delay"
osc "state=working:app=fake-agent:progress=60:msg=$(b64 'Reading files')"
sleep "$delay"
question='Run rm -rf build/? (y/n)'
[ $# -gt 0 ] && question="$question $*"
osc "state=blocked:kind=permission:app=fake-agent:msg=$(b64 "$question")"
printf 'Run rm -rf build/? [y/N] '

IFS= read -r answer
printf '\n'
sleep "${FAKE_AGENT_ANSWER_DELAY:-0}"

case $(printf '%s' "$answer" | tr 'A-Z' 'a-z') in
	y | yes | approve | 1)
		osc "state=working:app=fake-agent:progress=90:msg=$(b64 'Cleaning')"
		sleep "$delay"
		osc "state=done:app=fake-agent:msg=$(b64 'Build directory removed')"
		exit 0
		;;
	*)
		osc "state=error:app=fake-agent:msg=$(b64 'Denied by user')"
		exit 1
		;;
esac
