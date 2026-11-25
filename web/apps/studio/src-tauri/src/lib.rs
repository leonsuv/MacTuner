use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
use tauri::Emitter;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            let check_updates = MenuItemBuilder::with_id("check-updates", "Check for Updates…").build(app)?;
            let app_menu = SubmenuBuilder::new(app, "MacTuner")
                .about(None)
                .separator()
                .item(&check_updates)
                .separator()
                .services()
                .separator()
                .hide()
                .hide_others()
                .show_all()
                .separator()
                .quit()
                .build()?;

            let open_file = MenuItemBuilder::with_id("open-file", "Open BIN / XDF / A2L / OLS / Project…")
                .accelerator("CmdOrCtrl+O")
                .build(app)?;
            let open_compare = MenuItemBuilder::with_id("open-compare", "Open Comparison BIN…")
                .accelerator("CmdOrCtrl+Shift+O")
                .build(app)?;
            let save_project = MenuItemBuilder::with_id("save-project", "Save Project (.mtproj)…")
                .accelerator("CmdOrCtrl+Shift+S")
                .build(app)?;
            let export_bin = MenuItemBuilder::with_id("export-bin", "Export BIN…")
                .accelerator("CmdOrCtrl+S")
                .build(app)?;
            let export_xdf = MenuItemBuilder::with_id("export-xdf", "Export XDF Definition…").build(app)?;

            let file_menu = SubmenuBuilder::new(app, "File")
                .item(&open_file)
                .item(&open_compare)
                .separator()
                .item(&save_project)
                .item(&export_bin)
                .item(&export_xdf)
                .separator()
                .close_window()
                .build()?;

            let undo_item = MenuItemBuilder::with_id("edit-undo", "Undo")
                .accelerator("CmdOrCtrl+Z")
                .build(app)?;
            let redo_item = MenuItemBuilder::with_id("edit-redo", "Redo")
                .accelerator("CmdOrCtrl+Shift+Z")
                .build(app)?;

            let edit_menu = SubmenuBuilder::new(app, "Edit")
                .item(&undo_item)
                .item(&redo_item)
                .separator()
                .cut()
                .copy()
                .paste()
                .select_all()
                .build()?;

            let view_hex = MenuItemBuilder::with_id("view-hex", "Hex Editor")
                .accelerator("CmdOrCtrl+1")
                .build(app)?;
            let view_map = MenuItemBuilder::with_id("view-map", "Map Editor")
                .accelerator("CmdOrCtrl+2")
                .build(app)?;
            let view_compare = MenuItemBuilder::with_id("view-compare", "Multi-File Compare")
                .accelerator("CmdOrCtrl+3")
                .build(app)?;
            let view_memory = MenuItemBuilder::with_id("view-memory", "Memory Map")
                .accelerator("CmdOrCtrl+4")
                .build(app)?;
            let view_flash = MenuItemBuilder::with_id("view-flash", "Flash Preflight & Checksums")
                .accelerator("CmdOrCtrl+5")
                .build(app)?;
            let toggle_inspector = MenuItemBuilder::with_id("toggle-inspector", "Toggle Inspector")
                .accelerator("Alt+CmdOrCtrl+I")
                .build(app)?;
            let cmd_palette = MenuItemBuilder::with_id("command-palette", "Command Palette…")
                .accelerator("CmdOrCtrl+K")
                .build(app)?;

            let view_menu = SubmenuBuilder::new(app, "View")
                .item(&view_hex)
                .item(&view_map)
                .item(&view_compare)
                .item(&view_memory)
                .item(&view_flash)
                .separator()
                .item(&toggle_inspector)
                .item(&cmd_palette)
                .separator()
                .item(&PredefinedMenuItem::fullscreen(app, None)?)
                .build()?;

            let fix_cs = MenuItemBuilder::with_id("fix-checksums", "Fix Checksums").build(app)?;
            let swap_bins = MenuItemBuilder::with_id("swap-bins", "Swap Active & Comparison BIN").build(app)?;
            let tools_menu = SubmenuBuilder::new(app, "Tools")
                .item(&fix_cs)
                .item(&swap_bins)
                .build()?;

            let window_menu = SubmenuBuilder::new(app, "Window")
                .minimize()
                .maximize()
                .separator()
                .close_window()
                .build()?;

            let menu = MenuBuilder::new(app)
                .items(&[&app_menu, &file_menu, &edit_menu, &view_menu, &tools_menu, &window_menu])
                .build()?;

            app.set_menu(menu)?;
            app.on_menu_event(|app_handle, event| {
                let _ = app_handle.emit("mactuner-menu", event.id().as_ref());
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running MacTuner");
}
