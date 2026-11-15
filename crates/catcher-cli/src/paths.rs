// Path helpers that print like Node's path.join / os.homedir, so messages show the same paths as the TS CLI.

use std::path::PathBuf;

/// `os.homedir()`: $HOME (USERPROFILE on Windows), else the platform answer.
pub fn home_dir() -> String {
    let var = if cfg!(windows) { "USERPROFILE" } else { "HOME" };
    match std::env::var(var) {
        Ok(h) if !h.is_empty() => h,
        _ => std::env::home_dir()
            .map(|p| p.to_string_lossy().into_owned())
            .unwrap_or_default(),
    }
}

/// Environment variable that counts only when set and non-empty (JS `process.env.X || …`).
pub fn env_nonempty(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|v| !v.is_empty())
}

/// `path.join(...)`
#[cfg(not(windows))]
pub fn join(parts: &[&str]) -> String {
    let joined: Vec<&str> = parts.iter().copied().filter(|p| !p.is_empty()).collect();
    if joined.is_empty() {
        return ".".into();
    }
    normalize(&joined.join("/"))
}

#[cfg(windows)]
pub fn join(parts: &[&str]) -> String {
    let mut p = PathBuf::new();
    for part in parts.iter().filter(|p| !p.is_empty()) {
        p.push(part);
    }
    p.to_string_lossy().into_owned()
}

/// `path.posix.normalize`
#[cfg(not(windows))]
fn normalize(path: &str) -> String {
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/');
    let mut out: Vec<&str> = Vec::new();
    for seg in path.split('/') {
        match seg {
            "" | "." => {}
            ".." => {
                if out.last().is_some_and(|s| *s != "..") {
                    out.pop();
                } else if !absolute {
                    out.push("..");
                }
            }
            s => out.push(s),
        }
    }
    let mut s = out.join("/");
    if s.is_empty() && !absolute {
        s.push('.');
    }
    if trailing && !s.is_empty() {
        s.push('/');
    }
    if absolute {
        s.insert(0, '/');
    }
    s
}

/// `path.dirname` for the paths this CLI builds (always absolute or relative files, never roots).
pub fn dirname(path: &str) -> PathBuf {
    PathBuf::from(path)
        .parent()
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

#[cfg(all(test, not(windows)))]
mod tests {
    use super::*;

    #[test]
    fn joins_like_node() {
        assert_eq!(join(&["/a/b/", "profiles", "x"]), "/a/b/profiles/x");
        assert_eq!(join(&["./x/", "y"]), "x/y");
        assert_eq!(join(&["../a", "..", "..", "b"]), "../../b");
        assert_eq!(join(&["/", "..", "a"]), "/a");
        assert_eq!(join(&["a", ""]), "a");
    }
}
