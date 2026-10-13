package main

import (
	"bufio"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"

	"golang.org/x/term"

	"beckoncli.com/helper/internal/setup"
)

func cmdSetup(args []string) int {
	env, err := setup.OSEnv()
	if err != nil {
		fmt.Fprintf(os.Stderr, "beckon: setup: %v\n", err)
		return 1
	}
	return runSetup(args, env, os.Stdin, term.IsTerminal(int(os.Stdin.Fd())), os.Stdout, os.Stderr)
}

// runSetup is "beckon setup" with its environment passed in, for tests.
func runSetup(args []string, env setup.Env, in io.Reader, interactive bool, out, errw io.Writer) int {
	fs := flag.NewFlagSet("setup", flag.ContinueOnError)
	fs.SetOutput(errw)
	fs.Usage = func() { fmt.Fprint(errw, usage) }
	only := fs.String("agent", "", "comma-separated agents to set up")
	project := fs.String("project", "", "a project's root directory")
	remove := fs.Bool("remove", false, "take the hooks out again")
	dryRun := fs.Bool("dry-run", false, "show what would change")
	yes := fs.Bool("yes", false, "do not ask before changing files")
	if err := fs.Parse(args); err != nil {
		if errors.Is(err, flag.ErrHelp) {
			return 0
		}
		return 2
	}
	if fs.NArg() > 0 {
		fs.Usage()
		return 2
	}
	opt := setup.Options{Remove: *remove}
	if *project != "" {
		dir, err := filepath.Abs(*project)
		if err == nil {
			var fi os.FileInfo
			if fi, err = os.Stat(dir); err == nil && !fi.IsDir() {
				err = errors.New("not a directory")
			}
		}
		if err != nil {
			fmt.Fprintf(errw, "beckon: setup: --project %s: %v\n", *project, err)
			return 2
		}
		opt.Project = dir
	}

	var agents, missing []setup.Agent
	switch {
	case *only != "":
		for _, n := range strings.Split(*only, ",") {
			a, ok := setup.Lookup(strings.TrimSpace(n))
			if !ok {
				fmt.Fprintf(errw, "beckon: setup: unknown agent %q (one of: %s)\n", n, agentNames())
				return 2
			}
			agents = append(agents, a)
		}
	case *remove:
		// Hooks can outlive the agent: look at every agent's file.
		agents = setup.Agents
	default:
		for _, a := range setup.Agents {
			if a.Installed(env) {
				agents = append(agents, a)
			} else {
				missing = append(missing, a)
			}
		}
	}
	if len(agents) == 0 {
		fmt.Fprintf(out, "No coding agents found. Name one with --agent (%s).\n", agentNames())
		return 0
	}

	steps := setup.Plan(env, agents, opt)
	pending, failed := 0, 0
	tw := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	for _, st := range steps {
		what := ""
		switch {
		case st.Err != nil && *remove:
			what = fmt.Sprintf("cannot read: %v; remove the hooks by hand", st.Err)
			failed++
		case st.Err != nil:
			what = fmt.Sprintf("cannot merge: %v; add the hooks by hand (docs/agents.md)", st.Err)
			failed++
		case st.Action == setup.Unsupported:
			what = "no project config: set it up without --project"
		case st.Action == setup.Unchanged && *remove:
			what = "not set up"
		case st.Action == setup.Unchanged:
			what = "already set up"
		case st.Action == setup.Create:
			what = "create"
			pending++
		case st.Action == setup.Update && *remove:
			what = "remove hooks"
			pending++
		case st.Action == setup.Update:
			what = "add hooks"
			pending++
		case st.Action == setup.Delete:
			what = "delete"
			pending++
		}
		path := "-"
		if st.Path != "" {
			path = setup.Tilde(env, st.Path)
		}
		fmt.Fprintf(tw, "  %s\t%s\t%s\n", st.Agent.Title, path, what)
	}
	tw.Flush()
	if len(missing) > 0 {
		titles := make([]string, len(missing))
		for i, a := range missing {
			titles[i] = a.Title
		}
		fmt.Fprintf(out, "Not found: %s.\n", strings.Join(titles, ", "))
	}
	if pending == 0 || *dryRun {
		return exitFor(failed)
	}

	if !*yes {
		if !interactive {
			fmt.Fprintln(errw, "beckon: setup: not a terminal; run again with --yes to make these changes")
			return 1
		}
		fmt.Fprint(out, "Make these changes? [Y/n] ")
		line, _ := bufio.NewReader(in).ReadString('\n')
		switch strings.ToLower(strings.TrimSpace(line)) {
		case "", "y", "yes":
		default:
			fmt.Fprintln(out, "Nothing changed.")
			return exitFor(failed)
		}
	}

	var notes []string
	for _, st := range steps {
		if st.Err != nil || st.Action == setup.Unchanged || st.Action == setup.Unsupported {
			continue
		}
		backup, err := setup.Apply(st)
		if err != nil {
			fmt.Fprintf(errw, "beckon: setup: %s: %v\n", st.Agent.Title, err)
			failed++
			continue
		}
		path := setup.Tilde(env, st.Path)
		switch {
		case st.Action == setup.Create:
			fmt.Fprintf(out, "Created %s\n", path)
		case st.Action == setup.Delete:
			fmt.Fprintf(out, "Deleted %s (previous version in %s)\n", path, setup.Tilde(env, backup))
		case *remove:
			fmt.Fprintf(out, "Removed the hooks from %s (previous version in %s)\n", path, setup.Tilde(env, backup))
		default:
			fmt.Fprintf(out, "Updated %s (previous version in %s)\n", path, setup.Tilde(env, backup))
		}
		note := st.Agent.Note
		if opt.Project != "" && st.Agent.ProjectNote != "" {
			note = st.Agent.ProjectNote
		}
		if !*remove && note != "" {
			notes = append(notes, st.Agent.Title+": "+note)
		}
	}
	if *remove {
		return exitFor(failed)
	}
	if opt.Project != "" {
		notes = append(notes, "These files are part of the project. Commit them only if everyone who works on it has beckon installed: elsewhere the agent reports a failed hook.")
	}
	if _, err := env.LookPath("beckon"); err != nil {
		notes = append(notes, `"beckon" is not on your PATH. The hooks run "beckon hook", so add the directory it is in (the installer uses ~/.local/bin).`)
	}
	for _, n := range notes {
		fmt.Fprintln(out, n)
	}
	return exitFor(failed)
}

func exitFor(failed int) int {
	if failed > 0 {
		return 1
	}
	return 0
}

func agentNames() string {
	names := make([]string, len(setup.Agents))
	for i, a := range setup.Agents {
		names[i] = a.Name
	}
	return strings.Join(names, ", ")
}
