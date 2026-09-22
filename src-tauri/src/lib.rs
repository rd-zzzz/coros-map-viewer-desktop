use std::fs;
use std::path::PathBuf;

// O3: read_file_bytes 已移除——前端从不调用，按需切片由 read_file_slice 承担。

#[tauri::command]
fn read_path_as_files(path: String) -> Result<Vec<String>, String> {
    let p = PathBuf::from(&path);
    let mut result = Vec::new();

    if p.is_file() {
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        let lower = name.to_lowercase();
        if lower.ends_with(".t") || lower.ends_with(".pmtiles") {
            result.push(path);
        }
    } else if p.is_dir() {
        scan_dir(&p, &mut result)?;
    } else {
        // P1-8: 路径不存在 / 无权限 / 既非文件也非目录时，原来静默返回空数组，
        // 前端据此判定「没有可索引文件」，用户看到的只是「拖入后毫无反应」。
        // 显式报错，让前端能把原因写进调试日志。
        return Err(format!("无法访问（不存在，或不是文件/目录）: {}", path));
    }

    Ok(result)
}

// P1-1: 返回 base64 字符串而非 Vec<u8>。Vec<u8> 经 serde 序列化成 JSON 数字数组，
// 实测 40 KB 二进制膨胀到 3.56x（145 KB 文本）、序列化+解析约 1.4 ms/瓦片；
// base64 只有 1.33x、约 0.075 ms，差约 19 倍。前端用 atob 还原。
#[tauri::command]
fn read_file_slice(path: String, offset: u64, length: u64) -> Result<String, String> {
    use base64::Engine;
    use std::io::{Read, Seek, SeekFrom};
    let mut file = fs::File::open(&path).map_err(|e| format!("open {}: {}", path, e))?;
    let file_len = file.metadata().map_err(|e| format!("stat {}: {}", path, e))?.len();
    // P1-4: saturating_add 防止 offset + length 在 u64 下溢出回绕（release 无溢出检查，
    // 回绕会让 min() 取到巨大值并触发 vec![0u8; 巨大] 的内存分配）
    let end = offset.saturating_add(length).min(file_len);
    if offset >= file_len {
        return Ok(String::new());
    }
    let actual_len = end - offset;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("seek {}: {}", path, e))?;
    let mut buf = vec![0u8; actual_len as usize];
    file.read_exact(&mut buf)
        .map_err(|e| format!("read {} at {}+{}: {}", path, offset, length, e))?;
    Ok(base64::engine::general_purpose::STANDARD.encode(&buf))
}

// P9: 报告是否为 debug 构建。release 包据此隐藏调试入口，dev 模式保持可见。
#[tauri::command]
fn is_debug_build() -> bool {
    cfg!(debug_assertions)
}

fn scan_dir(dir: &PathBuf, out: &mut Vec<String>) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|e| format!("read_dir {:?}: {}", dir, e))?;
    for entry in entries {
        let entry = entry.map_err(|e| format!("entry error: {}", e))?;
        // M4: file_type() 不跟随符号链接，跳过 symlink/junction，防止链接指回祖先造成无限递归
        let ft = entry.file_type().map_err(|e| format!("file_type error: {}", e))?;
        if ft.is_symlink() {
            continue;
        }
        let p = entry.path();
        if ft.is_file() {
            let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
            let lower = name.to_lowercase();
            if lower.ends_with(".t") || lower.ends_with(".pmtiles") {
                out.push(p.to_string_lossy().to_string());
            }
        } else if ft.is_dir() {
            scan_dir(&p, out)?;
        }
    }
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            read_path_as_files,
            read_file_slice,
            is_debug_build
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
