#!/bin/sh
# A stand-in for a coding agent, for the README demo (scripts/demo/record.sh). It prints what a coding agent
# prints (reading files, an edit, then a permission prompt for a shell command) and reports its state with real
# OSC 7501 sequences, so Beckon sees it as the app "code-agent": working, then blocked (permission) until it
# reads an answer on stdin, then working and done. It runs nothing and touches no files.
# DEMO_STEP (seconds, default 0.9) paces the output before the prompt, DEMO_AFTER_STEP (0.3) after the answer.

step=${DEMO_STEP:-0.9}
after=${DEMO_AFTER_STEP:-0.3}
cmd='rm -rf dist && npm run build'

b64() { printf '%s' "$1" | base64 | tr -d '\n'; }
osc() { printf '\033]7501;%s\033\\' "$1"; }

bold='\033[1m'
dim='\033[2m'
red='\033[31m'
green='\033[32m'
cyan='\033[36m'
reset='\033[0m'

printf "${bold}${cyan}●${reset} ${bold}Fix the failing login test${reset}\n\n"

osc "state=working:app=code-agent:progress=10:msg=$(b64 'Reading src/auth/session.ts')"
printf "${bold}●${reset} Read(src/auth/session.ts)\n"
sleep "$step"

osc "state=working:app=code-agent:progress=35:msg=$(b64 'Reading tests/login.test.ts')"
printf "${bold}●${reset} Read(tests/login.test.ts)\n"
sleep "$step"

osc "state=working:app=code-agent:progress=60:msg=$(b64 'Editing src/auth/session.ts')"
printf "${bold}●${reset} Update(src/auth/session.ts)\n"
printf "  ${dim}⎿  Updated with 1 addition and 1 removal${reset}\n"
printf "     ${red}-  if (expiresAt < now) return null${reset}\n"
printf "     ${green}+  if (expiresAt <= now) return null${reset}\n"
sleep "$step"

osc "state=blocked:kind=permission:app=code-agent:msg=$(b64 "Run $cmd?")"
printf "\n${bold}●${reset} Bash(%s)\n" "$cmd"
printf "  ${dim}⎿  Waiting for permission...${reset}\n\n"
printf "  ${bold}Allow this command?${reset} [y/N] "

IFS= read -r answer
printf '\n'

case $(printf '%s' "$answer" | tr 'A-Z' 'a-z') in
	y | yes)
		osc "state=working:app=code-agent:progress=85:msg=$(b64 'Running npm run build')"
		printf "\n${green}✓${reset} Approved\n"
		printf "  ${dim}⎿  npm run build${reset}\n"
		sleep "$after"
		printf "  ${dim}⎿  42 tests passed${reset}\n"
		sleep "$after"
		osc "state=done:app=code-agent:msg=$(b64 'Login test fixed, build passes')"
		printf "\n${bold}${green}●${reset} Done. Login test fixed, build passes.\n"
		exit 0
		;;
	*)
		osc "state=error:app=code-agent:msg=$(b64 'Command denied')"
		printf "\n${red}✗${reset} Denied\n"
		exit 1
		;;
esac
