#!/usr/bin/env -S godot --headless --script
extends SceneTree
## Static-checks a single GDScript file for compile errors.
##
## This intentionally does NOT use Godot's `--check-only --script <path>` CLI
## mode. That mode parses/compiles the target script from `Object._init()`,
## which runs *before* Main::start() instantiates project autoload singletons
## and adds them as children of the scene root. At that point only whichever
## autoload the engine happens to resolve first (a side effect of internal
## hashmap iteration order, not file order) is visible as a global identifier,
## so every other autoload reference is misreported as
## "Compile Error: Identifier not found: <Name>".
##
## `_initialize()` on a SceneTree subclass runs after autoloads have been
## added to `root`, so resolving the target script's global identifiers here
## sees every autoload correctly. We still perform a real, fresh
## parse+analyze+compile (not just a resolvability check) via
## ResourceLoader.load(), so genuine syntax/type errors are reported exactly
## like before via the engine's standard
## "SCRIPT ERROR: ... \n   at: ... (res://path:line)" console output.

func _initialize():
	var args = OS.get_cmdline_args()
	var script_index = args.find("--script")
	var target_index = script_index + 2

	if script_index == -1 or args.size() <= target_index:
		printerr("SCRIPT ERROR: usage: godot --headless --path <project> --script validate_script.gd <res://path/to/script.gd>")
		quit(1)
		return

	var target = args[target_index]

	# CACHE_MODE_IGNORE forces a fresh parse/analyze/compile pass instead of
	# reusing whatever ResourceCache entry autoload bootstrap may have left
	# behind for this same path, so we always check the current file content.
	ResourceLoader.load(target, "GDScript", ResourceLoader.CACHE_MODE_IGNORE)

	quit()
