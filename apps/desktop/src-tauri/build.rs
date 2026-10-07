/// Every command the app defines is listed here, so each needs an explicit
/// permission in a capability (M34, ADR 0031). Without this list, any window
/// with IPC could call any of them; with it, the host commands reach only the
/// local Folders window.
fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "connect",
            "forget",
            "host_state",
            "host_add_folder",
            "host_policy",
            "host_remove",
            "host_stop",
            "open_folders",
        ]),
    ))
    .expect("failed to build the Tauri context");
}
