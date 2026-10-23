extends SceneTree

# Headless test for the local-debugger guard (issue #13). Run with:
#   godot_run_headless --script scripts/test/eval_guard.gd
# It never launches a game: it loads the server script and calls its pure
# predicate, so the refusal path is proven without an interactive debugger.

func _init() -> void:
	var failures: int = 0
	var server = load("res://plugin/mcp_interaction_server.gd")
	if server == null:
		push_error("eval_guard: could not load res://plugin/mcp_interaction_server.gd")
		quit(1)
		return
	if not server.is_local_debugger(["-d", "--path", "x"]):
		failures += 1
		push_error("eval_guard: -d must enable the local debugger guard")
	if not server.is_local_debugger(["--debug"]):
		failures += 1
		push_error("eval_guard: --debug must enable the local debugger guard")
	if server.is_local_debugger([]):
		failures += 1
		push_error("eval_guard: an empty command line must not enable the guard")
	if server.is_local_debugger(["--path", "x"]):
		failures += 1
		push_error("eval_guard: --path alone must not enable the guard")
	# Godot consumes -d before the script sees the command line, so the bridge
	# passes GODOT_BRIDGE_DEBUGGER=1 in the spawn environment instead.
	if not server.is_local_debugger([], "1"):
		failures += 1
		push_error("eval_guard: GODOT_BRIDGE_DEBUGGER=1 must enable the guard")
	if server.is_local_debugger([], "0"):
		failures += 1
		push_error("eval_guard: GODOT_BRIDGE_DEBUGGER=0 must not enable the guard")
	var constants: Dictionary = server.get_script_constant_map()
	if not constants.has("EVAL_DEBUGGER_REFUSAL"):
		failures += 1
		push_error("eval_guard: EVAL_DEBUGGER_REFUSAL is missing")
	elif String(constants["EVAL_DEBUGGER_REFUSAL"]).find("godot_run_headless --script") < 0:
		failures += 1
		push_error("eval_guard: the refusal must point at godot_run_headless --script")
	if failures == 0:
		print("eval_guard: PASS (is_local_debugger + EVAL_DEBUGGER_REFUSAL)")
	quit(1 if failures > 0 else 0)
