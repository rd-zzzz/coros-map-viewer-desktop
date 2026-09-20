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
    }

    Ok(result)
}

#[tauri::command]
fn read_file_slice(path: String, offset: u64, length: u64) -> Result<Vec<u8>, String> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = fs::File::open(&path).map_err(|e| format!("open {}: {}", path, e))?;
    let file_len = file.metadata().map_err(|e| format!("stat {}: {}", path, e))?.len();
    let end = (offset + length).min(file_len);
    if offset >= file_len {
        return Ok(Vec::new());
    }
    let actual_len = end - offset;
    file.seek(SeekFrom::Start(offset))
        .map_err(|e| format!("seek {}: {}", path, e))?;
    let mut buf = vec![0u8; actual_len as usize];
    file.read_exact(&mut buf)
        .map_err(|e| format!("read {} at {}+{}: {}", path, offset, length, e))?;
    Ok(buf)
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
        .invoke_handler(tauri::generate_handler![
            read_path_as_files,
            read_file_slice
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
