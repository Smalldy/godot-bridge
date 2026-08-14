[English](COVERAGE.md) | [中文](COVERAGE.zh-CN.md)

# godot-bridge vs godot-mcp — tool coverage matrix

Compared against the original [`tugcantopaloglu/godot-mcp`](https://github.com/tugcantopaloglu/godot-mcp) README (157 tools, 2026-08).

Legend:
- ✅ **native** — implemented by a godot-bridge tool (runtime `godot_command` / `godot_screenshot` / process tools / `godot_headless_op` / `godot_validate_script`)
- 🔁 **DSH-native** — the godot-mcp tool was implemented in the MCP server's own Node process as file/editor logic; DSH's built-in tools (`read`/`write`/`edit`/`glob`/`grep`/`pwsh`) already do this better

## Runtime tools — all covered by `godot_command` ✅

Every `game_*` tool maps 1:1 to an interaction-server command (the enum in `godot_command` is generated from the full `mcp_interaction_server.gd` match statement):

| MCP tool | godot_command command | | MCP tool | godot_command command |
| --- | --- | --- | --- | --- |
| game_screenshot | screenshot (godot_screenshot) | | game_raycast | raycast |
| game_click | click | | game_get_audio | get_audio |
| game_key_press | key_press | | game_spawn_node | spawn_node |
| game_mouse_move | mouse_move | | game_set_shader_param | set_shader_param |
| game_key_hold / game_key_release | key_hold / key_release | | game_audio_play / game_audio_bus | audio_play / audio_bus |
| game_scroll | scroll | | game_navigate_path | navigate_path |
| game_mouse_drag | mouse_drag | | game_tilemap | tilemap |
| game_gamepad | gamepad | | game_add_collision | add_collision |
| game_touch | touch | | game_environment | environment |
| game_input_state / game_input_action | input_state / input_action | | game_manage_group | manage_group |
| game_get_ui | get_ui_elements | | game_create_timer | create_timer |
| game_get_scene_tree | get_scene_tree | | game_set_particles | set_particles |
| game_get_node_info | get_node_info | | game_create_animation | create_animation |
| game_eval | eval | | game_serialize_state | serialize_state |
| game_get_property / game_set_property | get_property / set_property | | game_physics_body / game_create_joint | physics_body / create_joint |
| game_call_method | call_method | | game_bone_pose | bone_pose |
| game_instantiate_scene | instantiate_scene | | game_ui_theme | ui_theme |
| game_remove_node | remove_node | | game_viewport | viewport |
| game_change_scene | change_scene | | game_debug_draw | debug_draw |
| game_reparent_node | reparent_node | | game_http_request / websocket / multiplayer / rpc | http_request / websocket / multiplayer / rpc |
| game_connect/disconnect/emit/list/await_signal | connect_signal / disconnect_signal / emit_signal / list_signals / await_signal | | game_script / game_window / game_os_info | script / window / os_info |
| game_play_animation / game_tween_property | play_animation / tween_property | | game_time_scale / game_process_mode / game_world_settings | time_scale / process_mode / world_settings |
| game_pause / game_performance / game_wait | pause / get_performance / wait | | game_csg / game_multimesh / game_procedural_mesh | csg / multimesh / procedural_mesh |
| game_get_nodes_in_group / game_find_nodes_by_class | get_nodes_in_group / find_nodes_by_class | | game_light_3d / game_mesh_instance / game_gridmap | light_3d / mesh_instance / gridmap |
| game_get_errors / game_get_logs | godot_get_debug_output (process output) | | game_3d_effects / game_gi / game_path_3d / game_sky | 3d_effects / gi / path_3d / sky |
| game_get_camera / game_set_camera | get_camera / set_camera | | game_camera_attributes / game_navigation_3d / game_physics_3d | camera_attributes / navigation_3d / physics_3d |
| game_canvas / game_canvas_draw / game_light_2d | canvas / canvas_draw / light_2d | | game_parallax / game_shape_2d / game_path_2d / game_physics_2d | parallax / shape_2d / path_2d / physics_2d |
| game_animation_tree / game_animation_control / game_skeleton_ik | animation_tree / animation_control / skeleton_ik | | game_audio_effect / game_audio_bus_layout / game_audio_spatial | audio_effect / audio_bus_layout / audio_spatial |
| game_locale | locale | | game_ui_control / game_ui_text / game_ui_popup | ui_control / ui_text / ui_popup |
| game_render_settings / game_resource | render_settings / resource | | game_ui_tree / game_ui_item_list / game_ui_tabs | ui_tree / ui_item_list / ui_tabs |
| — | — | | game_ui_menu / game_ui_range | ui_menu / ui_range |

> `game_visual_shader` exists in the MCP tool list but has **no** interaction-server command (the server's `match` has no `visual_shader`); godot-bridge covers only real server commands.

## Process tools ✅

| MCP | godot-bridge |
| --- | --- |
| run_project / stop_project / get_debug_output | godot_run_project / godot_stop_project / godot_get_debug_output |

## Headless operations — `godot_headless_op` ✅ (vendored `godot_operations.gd`)

| MCP | op | | MCP | op |
| --- | --- | --- | --- | --- |
| create_scene | create_scene | | read_scene | read_scene (SCENE_JSON extracted to object) |
| add_node | add_node | | modify_scene_node | modify_node |
| load_sprite | load_sprite | | remove_scene_node | remove_node |
| export_mesh_library | export_mesh_library | | attach_script | attach_script |
| save_scene | save_scene | | create_resource | create_resource |
| get_uid | get_uid | | manage_resource | manage_resource |
| update_project_uids | resave_resources | | manage_scene_signals | manage_scene_signals |
| — | — | | manage_theme_resource | manage_theme_resource |
| — | — | | manage_scene_structure | manage_scene_structure |

`validate_script` → `godot_validate_script` ✅ (parses `SCRIPT ERROR` lines into `{message, file, line}`).

## Not duplicated — pure file/editor operations 🔁

These tools carry no Godot-specific logic; DSH's native tools cover them as-is:

| MCP | DSH equivalent |
| --- | --- |
| read_file / write_file / delete_file / create_directory | read / write / edit + pwsh |
| read_project_settings / list_project_files | read / glob |
| rename_file | pwsh (Move-Item) |
| launch_editor | pwsh (`godot -e`) |
| get_godot_version | pwsh (`godot --version`) |
| list_projects / get_project_info | glob + read project.godot |

## Godot-specific write logic (not ported yet) ⚠️

These MCP tools carry **Godot-specific format knowledge** that a generic text edit does not fully replace — DSH can still perform the equivalent edit, but the caller must know the format, or wait for a future port:

| MCP | Godot-specific part | DSH equivalent (with format knowledge) |
| --- | --- | --- |
| modify_project_settings | project.godot `[section] key=value` typed values (`PackedStringArray(...)`, `Vector2i(...)` …) and section-boundary handling | edit project.godot |
| manage_autoloads | `Name="*res://path.gd"` singleton convention (the `"*"` prefix, `res://` paths) | edit project.godot |
| manage_input_map | `InputEventKey` object serialization + `physical_keycode` mapping — ⚠️ **the MCP implementation uses the Godot 3 keycode baseline (16777216)** for special keys (ENTER=16777221, SHIFT=16777237); Godot 4 uses 4194304 (ENTER=4194309, SHIFT=4194325). The project's own dev notes document silent binding failures from this. | edit project.godot (use the Godot 4 baseline; prefer `KEY_*` constants) |
| manage_export_presets | `export_presets.cfg` section structure | write / edit export_presets.cfg |
| manage_layers / manage_plugins / manage_translations / set_main_scene | project.godot section line formats (named-layer string arrays, `[editor_plugins]`, `[internationalization]`, `run/main_scene`) | edit project.godot |
| create_project / create_csharp_script / create_script | Godot project scaffold / `.csproj` (SDK version) / GDScript / C# templates | write (+ dotnet) |
| export_project | `godot --headless --export-preset <name>` invocation | pwsh |
| validate_scripts (batch) | N × godot_validate_script (or glob + loop) | N × godot_validate_script |

## Coverage summary

| group | godot-bridge | via DSH native | Godot-specific, not ported |
| --- | --- | --- | --- |
| runtime `game_*` (~105) | ✅ 100% | — | — |
| process (3) | ✅ 100% | — | — |
| headless ops (16) + validate_script (1) | ✅ 100% | — | — |
| pure file/editor ops (11) | — | 🔁 DSH native | — |
| Godot-specific write logic (~9) | — | ⚠️ possible with format knowledge | — |

**Verdict**: every Godot-specific runtime/headless tool is ported natively. The remaining MCP tools split into pure file/editor operations the harness already does better, and a handful of Godot-specific write helpers (`manage_input_map`, `manage_export_presets`, `modify_project_settings`, templates…) that a generic edit can only replace with format knowledge — a candidate for a future `godot_project_edit` port.
