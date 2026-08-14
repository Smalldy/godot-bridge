[English](COVERAGE.md) | **中文**

# godot-bridge vs godot-mcp — 工具覆盖对照表

对照原版 [`tugcantopaloglu/godot-mcp`](https://github.com/tugcantopaloglu/godot-mcp) README（157 个工具，2026-08）。

图例：
- ✅ **原生实现** — 由 godot-bridge 工具直接提供（运行时 `godot_command` / `godot_screenshot` / 进程工具 / `godot_headless_op` / `godot_validate_script`）
- 🔁 **DSH 原生等效** — 该 godot-mcp 工具在 MCP 服务器自己的 Node 进程里实现为文件/编辑器逻辑；DSH 内置工具（`read`/`write`/`edit`/`glob`/`grep`/`pwsh`）已经做得更好
- ⚠️ **部分** — 附注说明

## 运行时工具 — 全部由 `godot_command` 覆盖 ✅

每个 `game_*` 工具 1:1 映射到一个交互服务器命令（`godot_command` 的枚举直接取自 `mcp_interaction_server.gd` 的完整 match 语句）：

| MCP 工具 | godot_command 命令 | | MCP 工具 | godot_command 命令 |
| --- | --- | --- | --- | --- |
| game_screenshot | screenshot（godot_screenshot） | | game_raycast | raycast |
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
| game_get_errors / game_get_logs | godot_get_debug_output（进程输出） | | game_3d_effects / game_gi / game_path_3d / game_sky | 3d_effects / gi / path_3d / sky |
| game_get_camera / game_set_camera | get_camera / set_camera | | game_camera_attributes / game_navigation_3d / game_physics_3d | camera_attributes / navigation_3d / physics_3d |
| game_canvas / game_canvas_draw / game_light_2d | canvas / canvas_draw / light_2d | | game_parallax / game_shape_2d / game_path_2d / game_physics_2d | parallax / shape_2d / path_2d / physics_2d |
| game_animation_tree / game_animation_control / game_skeleton_ik | animation_tree / animation_control / skeleton_ik | | game_audio_effect / game_audio_bus_layout / game_audio_spatial | audio_effect / audio_bus_layout / audio_spatial |
| game_locale | locale | | game_ui_control / game_ui_text / game_ui_popup | ui_control / ui_text / ui_popup |
| game_render_settings / game_resource | render_settings / resource | | game_ui_tree / game_ui_item_list / game_ui_tabs | ui_tree / ui_item_list / ui_tabs |
| — | — | | game_ui_menu / game_ui_range | ui_menu / ui_range |

> `game_visual_shader` 存在于 MCP 工具列表，但**没有**对应的交互服务器命令（服务器 match 里没有 `visual_shader`）；godot-bridge 只覆盖真实存在的服务器命令。

## 进程工具 ✅

| MCP | godot-bridge |
| --- | --- |
| run_project / stop_project / get_debug_output | godot_run_project / godot_stop_project / godot_get_debug_output |

## headless 操作 — `godot_headless_op` ✅（内置 `godot_operations.gd`）

| MCP | op | | MCP | op |
| --- | --- | --- | --- | --- |
| create_scene | create_scene | | read_scene | read_scene（SCENE_JSON 提取为对象） |
| add_node | add_node | | modify_scene_node | modify_node |
| load_sprite | load_sprite | | remove_scene_node | remove_node |
| export_mesh_library | export_mesh_library | | attach_script | attach_script |
| save_scene | save_scene | | create_resource | create_resource |
| get_uid | get_uid | | manage_resource | manage_resource |
| update_project_uids | resave_resources | | manage_scene_signals | manage_scene_signals |
| — | — | | manage_theme_resource | manage_theme_resource |
| — | — | | manage_scene_structure | manage_scene_structure |

`validate_script` → `godot_validate_script` ✅（把 `SCRIPT ERROR` 行解析为 `{message, file, line}`）。

## 不重复实现 — MCP 里是 Node 侧文件/编辑器逻辑 🔁

DSH 原生文件工具已覆盖，godot-bridge 刻意不重复：

| MCP | DSH 等效 |
| --- | --- |
| read_file / write_file / delete_file / create_directory | read / write / edit + pwsh |
| read_project_settings / modify_project_settings | read / edit project.godot |
| list_project_files | glob |
| rename_file | pwsh（Move-Item） |
| create_project / create_csharp_script | write（+ dotnet） |
| manage_autoloads / manage_input_map / manage_export_presets / manage_layers / manage_plugins / set_main_scene / manage_translations | edit project.godot |
| manage_shader / create_script | write |
| validate_scripts（批量） | N × godot_validate_script（或 glob + 循环） |
| export_project | pwsh（`godot --headless --export-preset …`） |
| launch_editor | pwsh（`godot -e`） |
| get_godot_version | pwsh（`godot --version`） |
| list_projects / get_project_info | glob + read project.godot |

## 覆盖汇总

| 组 | godot-bridge | 经 DSH 原生 | 未覆盖 |
| --- | --- | --- | --- |
| 运行时 `game_*`（约 105） | ✅ 100% | — | — |
| 进程（3） | ✅ 100% | — | — |
| headless 操作（16）+ validate_script（1） | ✅ 100% | — | — |
| Node 侧文件/编辑器（约 25） | — | 🔁 DSH 原生 | — |

**结论**：所有 Godot 特有工具都已原生移植；其余只是 harness 本就做得更好的文件/编辑器操作。
