extends SceneTree

var peer: StreamPeerTCP = null
var frames := 0
var sent := false
var buffer := PackedByteArray()
var finished := false

func _process(_delta) -> bool:
	if finished:
		return false
	frames += 1
	if frames > 300:
		print("GODOT_E2E FAIL timeout")
		finished = true
		quit(1)
		return true
	if peer == null:
		peer = StreamPeerTCP.new()
		var err := peer.connect_to_host("127.0.0.1", 9090)
		if err != OK:
			print("GODOT_E2E FAIL connect ", err)
			finished = true
			quit(1)
			return true
		return false
	peer.poll()
	if peer.get_status() != StreamPeerTCP.STATUS_CONNECTED:
		return false
	if not sent:
		var request := JSON.stringify({"id": 1, "command": "eval", "params": {"code": "return 1 + 1"}})
		peer.put_data((request + "\n").to_utf8_buffer())
		sent = true
		return false
	var available := peer.get_available_bytes()
	if available > 0:
		var chunk: PackedByteArray = peer.get_data(available)[1]
		buffer.append_array(chunk)
		var text := buffer.get_string_from_utf8()
		if text.contains("\n"):
			var line := text.split("\n")[0]
			var parsed = JSON.parse_string(line)
			if parsed == null or parsed.get("result", null) != 2:
				print("GODOT_E2E FAIL eval ", line)
				finished = true
				quit(1)
				return true
			print("GODOT_E2E PASS eval result=2")
			finished = true
			quit(0)
			return true
	return false
